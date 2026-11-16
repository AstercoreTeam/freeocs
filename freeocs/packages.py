"""Package discovery, validation, installation and in-process loading."""

from __future__ import annotations

import hashlib
import importlib
import importlib.util
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import uuid
import zipfile
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

from . import APP_NAME, __version__
from .capabilities import CapabilityRegistry
from .config import SettingsStore
from .events import EventBus
from .paths import AppPaths
from .sdk import (
    CoreSettings,
    Module,
    PackageContext,
    PackageError,
    ScopedSettings,
)

logger = logging.getLogger("freeocs.packages")

_ID_RE = re.compile(r"^[a-z][a-z0-9_-]{1,63}$")
_VERSION_RE = re.compile(r"^\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?$")
_MAX_ENTRIES = 5000
_MAX_UNCOMPRESSED = 200 * 1024 * 1024


def _as_str_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if isinstance(item, (str, int, float))]


@dataclass(slots=True)
class Manifest:
    schema_version: int
    api_version: int
    id: str
    name: str
    version: str
    type: str
    description: str = ""
    author: str = ""
    license: str = ""
    homepage: str = ""
    icon: str = ""
    entry: str = ""
    platform: str = "any"
    requires: list[str] = field(default_factory=list)
    optional_requires: list[str] = field(default_factory=list)
    provides: dict[str, dict[str, Any]] = field(default_factory=dict)
    dependencies: list[str] = field(default_factory=list)
    min_app_version: str = ""
    web: dict[str, Any] = field(default_factory=dict)
    page_agents: list[dict[str, Any]] = field(default_factory=list)
    panels: list[dict[str, Any]] = field(default_factory=list)
    settings: list[dict[str, Any]] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Any) -> Manifest:
        if not isinstance(data, dict):
            raise PackageError("manifest 顶层必须是对象")
        schema_version = data.get("schema_version", 1)
        api_version = data.get("api_version", 1)
        if schema_version != 1:
            raise PackageError(f"不支持的 schema_version：{schema_version}")
        if api_version != 1:
            raise PackageError(f"不支持的 api_version：{api_version}")
        package_id = str(data.get("id", "")).strip()
        if not _ID_RE.match(package_id):
            raise PackageError(f"非法包 id：{package_id!r}")
        name = str(data.get("name", "")).strip()
        if not name:
            raise PackageError("manifest 缺少 name")
        version = str(data.get("version", "")).strip()
        if not _VERSION_RE.match(version):
            raise PackageError(f"非法版本号：{version!r}")
        type_ = str(data.get("type", "")).strip()
        if type_ not in {"plugin", "module", "bundle"}:
            raise PackageError(f"非法包类型：{type_!r}")
        entry = str(data.get("entry", "")).strip()
        if not entry or ":" not in entry:
            raise PackageError("manifest.entry 必须形如 'main:setup'")
        module_path, _, attr = entry.partition(":")
        if ".." in module_path or not all(part.isidentifier() for part in module_path.split(".")):
            raise PackageError(f"非法 entry：{entry!r}")
        if not attr.isidentifier():
            raise PackageError(f"非法 entry 属性：{attr!r}")

        provides_raw = data.get("provides") or {}
        if not isinstance(provides_raw, dict):
            raise PackageError("manifest.provides 必须是对象")
        provides: dict[str, dict[str, Any]] = {}
        for capability, meta in provides_raw.items():
            if not isinstance(capability, str) or not capability:
                raise PackageError("provides 的能力 ID 非法")
            provides[capability] = meta if isinstance(meta, dict) else {}

        settings = data.get("settings") or []
        if not isinstance(settings, list):
            raise PackageError("manifest.settings 必须是数组")
        page_agents = data.get("page_agents") or []
        panels = data.get("panels") or []
        if not isinstance(page_agents, list) or not isinstance(panels, list):
            raise PackageError("manifest.page_agents/panels 必须是数组")
        web = data.get("web") or {}
        if not isinstance(web, dict):
            raise PackageError("manifest.web 必须是对象")

        return cls(
            schema_version=int(schema_version),
            api_version=int(api_version),
            id=package_id,
            name=name,
            version=version,
            type=type_,
            description=str(data.get("description", "") or ""),
            author=str(data.get("author", "") or ""),
            license=str(data.get("license", "") or ""),
            homepage=str(data.get("homepage", "") or ""),
            icon=str(data.get("icon", "") or ""),
            entry=entry,
            platform=str(data.get("platform", "any") or "any"),
            requires=_as_str_list(data.get("requires")),
            optional_requires=_as_str_list(data.get("optional_requires")),
            provides=provides,
            dependencies=_as_str_list(data.get("dependencies")),
            min_app_version=str(data.get("min_app_version", "") or ""),
            web=web,
            page_agents=[item for item in page_agents if isinstance(item, dict)],
            panels=[item for item in panels if isinstance(item, dict)],
            settings=[item for item in settings if isinstance(item, dict)],
            raw=data,
        )

    @property
    def entry_module(self) -> str:
        return self.entry.partition(":")[0]

    @property
    def entry_attr(self) -> str:
        return self.entry.partition(":")[2]


@dataclass(slots=True)
class Package:
    manifest: Manifest
    root: Path
    source: str  # builtin | installed | dev
    builtin: bool = False
    enabled: bool = True
    load_error: str = ""
    status: str = "discovered"
    missing: list[str] = field(default_factory=list)
    module: Module | None = None
    context: PackageContext | None = None

    @property
    def id(self) -> str:
        return self.manifest.id

    @property
    def web_dir(self) -> Path:
        return self.root / "web"

    def public(self) -> dict[str, Any]:
        manifest = self.manifest
        return {
            "id": manifest.id,
            "name": manifest.name,
            "version": manifest.version,
            "type": manifest.type,
            "description": manifest.description,
            "author": manifest.author,
            "license": manifest.license,
            "homepage": manifest.homepage,
            "icon": manifest.icon,
            "platform": manifest.platform,
            "enabled": self.enabled,
            "builtin": self.builtin,
            "source": self.source,
            "status": self.status,
            "load_error": self.load_error,
            "missing": list(self.missing),
            "requires": list(manifest.requires),
            "optional_requires": list(manifest.optional_requires),
            "provides": manifest.provides,
            "dependencies": list(manifest.dependencies),
            "page_agents": manifest.page_agents,
            "panels": manifest.panels,
            "settings": [str(item.get("id", "")) for item in manifest.settings],
            "web": manifest.web,
            "has_module": self.module is not None,
        }


@dataclass(slots=True)
class ArchiveInfo:
    path: Path
    manifest: Manifest
    sha256: str
    size: int


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_zip_name(name: str) -> bool:
    if not name or name.startswith("/") or name.startswith("\\"):
        return False
    normalized = name.replace("\\", "/").rstrip("/")
    if not normalized:
        return False
    parts = normalized.split("/")
    return not any(part in {"..", ""} for part in parts)


def validate_archive(path: Path) -> ArchiveInfo:
    path = Path(path)
    if not path.is_file():
        raise PackageError(f"文件不存在：{path}")
    if path.suffix.lower() not in {".focpkg", ".zip"}:
        raise PackageError("只支持 .focpkg 或 .zip 包")
    try:
        archive = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as exc:
        raise PackageError(f"不是合法的 zip 包：{exc}") from exc
    with archive:
        infos = archive.infolist()
        if len(infos) > _MAX_ENTRIES:
            raise PackageError(f"包内文件过多（>{_MAX_ENTRIES}）")
        total = 0
        names: set[str] = set()
        for info in infos:
            if not _safe_zip_name(info.filename):
                raise PackageError(f"包内路径不安全：{info.filename}")
            mode = info.external_attr >> 16
            if mode and (mode & 0o170000) == 0o120000:
                raise PackageError(f"包内不允许符号链接：{info.filename}")
            total += max(0, info.file_size)
            if total > _MAX_UNCOMPRESSED:
                raise PackageError("解压后体积超过 200 MB")
            names.add(info.filename)
        if "manifest.json" not in names:
            raise PackageError("包根目录缺少 manifest.json")
        try:
            manifest = Manifest.from_dict(json.loads(archive.read("manifest.json").decode("utf-8")))
        except UnicodeDecodeError as exc:
            raise PackageError("manifest.json 不是 UTF-8") from exc
        except json.JSONDecodeError as exc:
            raise PackageError(f"manifest.json 不是合法 JSON：{exc}") from exc
        entry_file = f"backend/{manifest.entry_module.replace('.', '/')}.py"
        if entry_file not in names:
            raise PackageError(f"entry 文件不存在：{entry_file}")
        if "backend/__init__.py" not in names:
            raise PackageError("缺少 backend/__init__.py")
        for agent in manifest.page_agents:
            entry = str(agent.get("entry", ""))
            if not entry or f"web/{entry.removeprefix('web/')}" not in names:
                raise PackageError(f"page_agent 文件不存在：{entry}")
        for panel in manifest.panels:
            entry = str(panel.get("entry", ""))
            if not entry or f"web/{entry.removeprefix('web/')}" not in names:
                raise PackageError(f"panel 文件不存在：{entry}")
    return ArchiveInfo(path=path, manifest=manifest, sha256=_sha256(path), size=path.stat().st_size)


class PackageManager:
    def __init__(
        self,
        paths: AppPaths,
        settings: SettingsStore,
        events: EventBus,
        registry: CapabilityRegistry,
        *,
        http_base_url: str = "",
        web: Any = None,
        adb: Any = None,
    ) -> None:
        self.paths = paths
        self.settings = settings
        self.events = events
        self.registry = registry
        self.http_base_url = http_base_url
        self.web = web
        self.adb = adb
        self._lock = threading.RLock()
        self.packages: dict[str, Package] = {}
        self._modules: list[Package] = []
        self._loaded = False
        self._registry_data: dict[str, Any] = {"disabled": [], "installed": {}}
        self._load_registry()

    # -- registry file -----------------------------------------------------
    def _load_registry(self) -> None:
        try:
            if self.paths.registry_file.is_file():
                data = json.loads(self.paths.registry_file.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    self._registry_data.update(data)
        except (OSError, json.JSONDecodeError):
            pass
        if not isinstance(self._registry_data.get("disabled"), list):
            self._registry_data["disabled"] = []
        if not isinstance(self._registry_data.get("installed"), dict):
            self._registry_data["installed"] = {}

    def _save_registry(self) -> None:
        self.paths.packages_dir.mkdir(parents=True, exist_ok=True)
        tmp = self.paths.registry_file.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(self._registry_data, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        os.replace(tmp, self.paths.registry_file)

    # -- discovery ---------------------------------------------------------
    def _source_mode(self) -> bool:
        mode = os.environ.get("FREEOCS_PACKAGES", "").strip().lower()
        if mode == "source":
            return True
        if mode == "dist":
            return False
        return not any(self.paths.packages_dist_dir.glob("*.focpkg"))

    def discover(self) -> list[Package]:
        packages: dict[str, Package] = {}
        if self._source_mode():
            source_root = self.paths.packages_src_dir
            if source_root.is_dir():
                for directory in sorted(source_root.iterdir()):
                    if not directory.is_dir() or directory.name.startswith((".", "_")):
                        continue
                    manifest_file = directory / "manifest.json"
                    if not manifest_file.is_file():
                        continue
                    try:
                        manifest = Manifest.from_dict(
                            json.loads(manifest_file.read_text(encoding="utf-8"))
                        )
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("跳过无效内置包 %s: %s", directory.name, exc)
                        continue
                    packages[manifest.id] = Package(manifest, directory, "dev", True)
        else:
            for archive_path in sorted(self.paths.packages_dist_dir.glob("*.focpkg")):
                try:
                    info = validate_archive(archive_path)
                except PackageError as exc:
                    logger.warning("跳过无效包 %s: %s", archive_path.name, exc)
                    continue
                root = self._extract_builtin(info)
                packages[info.manifest.id] = Package(info.manifest, root, "builtin", True)

        # Installed packages: <data>/packages/<id>/<version>
        packages_root = self.paths.packages_dir
        if packages_root.is_dir():
            for directory in sorted(packages_root.iterdir()):
                if not directory.is_dir() or directory.name.startswith("."):
                    continue
                current_file = directory / "current"
                version = ""
                if current_file.is_file():
                    version = current_file.read_text(encoding="utf-8").strip()
                if not version:
                    versions = [p.name for p in directory.iterdir() if p.is_dir()]
                    version = sorted(versions)[-1] if versions else ""
                root = directory / version if version else directory
                manifest_file = root / "manifest.json"
                if not manifest_file.is_file():
                    continue
                try:
                    manifest = Manifest.from_dict(
                        json.loads(manifest_file.read_text(encoding="utf-8"))
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning("跳过无效安装包 %s: %s", directory.name, exc)
                    continue
                if manifest.id in packages:
                    logger.warning("外部包 %s 与内置包重名，忽略外部包", manifest.id)
                    continue
                packages[manifest.id] = Package(manifest, root, "installed", False)

        disabled = set(str(item) for item in self._registry_data.get("disabled", []))
        for item in packages.values():
            item.enabled = item.id not in disabled
        self.packages = packages
        return list(packages.values())

    def _extract_builtin(self, info: ArchiveInfo) -> Path:
        target = self.paths.builtin_cache_dir / f"{info.manifest.id}-{info.manifest.version}"
        stamp = target / ".sha256"
        if stamp.is_file() and stamp.read_text(encoding="utf-8").strip() == info.sha256:
            return target
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
        staging = self.paths.builtin_cache_dir / f".staging-{uuid.uuid4().hex}"
        staging.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(info.path) as archive:
            self._safe_extract(archive, staging)
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(staging, target)
        (target / ".sha256").write_text(info.sha256, encoding="utf-8")
        return target

    @staticmethod
    def _safe_extract(archive: zipfile.ZipFile, destination: Path) -> None:
        for info in archive.infolist():
            if not _safe_zip_name(info.filename):
                raise PackageError(f"包内路径不安全：{info.filename}")
            target = (destination / info.filename).resolve()
            if destination.resolve() not in target.parents and target != destination.resolve():
                raise PackageError(f"包内路径越界：{info.filename}")
        archive.extractall(destination)

    # -- loading -----------------------------------------------------------
    def load_all(self) -> list[Package]:
        with self._lock:
            if self._loaded:
                return list(self.packages.values())
            self.discover()
            order = {"plugin": 0, "bundle": 1, "module": 2}
            items = sorted(self.packages.values(), key=lambda p: (order.get(p.manifest.type, 9), p.id))
            for package in items:
                if not package.enabled:
                    package.status = "disabled"
                    continue
                self._load_package(package)
            self._resolve_dependencies()
            self._loaded = True
            self.events.emit(
                "", "log", "success",
                f"已加载 {len([p for p in items if p.status in {'ready', 'unavailable'}])} 个包",
            )
            return list(self.packages.values())

    def _load_package(self, package: Package) -> None:
        manifest = package.manifest
        try:
            self._register_manifest_settings(package)
            setup = self._import_setup(package)
            context = self._make_context(package)
            package.context = context
            setup(context)
            package.status = "ready"
            logger.info("已加载包 %s %s", manifest.id, manifest.version)
        except Exception as exc:  # noqa: BLE001 - package boundary
            package.load_error = f"{type(exc).__name__}: {exc}"
            package.status = "error"
            logger.exception("加载包失败 %s", manifest.id)
            self.events.emit(
                manifest.id, "log", "error", f"加载失败：{exc}"
            )

    def _register_manifest_settings(self, package: Package) -> None:
        for section in package.manifest.settings:
            self.settings.register_package_section(package.id, package.manifest.type, section)

    def _import_setup(self, package: Package) -> Callable[[PackageContext], None]:
        backend = package.root / "backend"
        init_file = backend / "__init__.py"
        if not init_file.is_file():
            raise PackageError("缺少 backend/__init__.py")
        module_name = f"freeocs_pkg_{package.id}"
        spec = importlib.util.spec_from_file_location(
            module_name, init_file, submodule_search_locations=[str(backend)]
        )
        if spec is None or spec.loader is None:
            raise PackageError("无法创建包模块")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        entry_module = importlib.import_module(
            f"{module_name}.{package.manifest.entry_module}"
        )
        setup = getattr(entry_module, package.manifest.entry_attr, None)
        if not callable(setup):
            raise PackageError(f"entry 不是可调用对象：{package.manifest.entry}")
        return setup

    def _make_context(self, package: Package) -> PackageContext:
        manifest = package.manifest
        data_dir = self.paths.package_data(package.id)
        return PackageContext(
            package_id=package.id,
            package_version=manifest.version,
            package_type=manifest.type,
            package_dir=package.root,
            data_dir=data_dir,
            app_version=__version__,
            http_base_url=self.http_base_url,
            settings=ScopedSettings(lambda: self.settings.package_values(package.id)),
            core_settings=CoreSettings(self.settings.core_get),
            web=self.web,
            adb=self.adb,
            capabilities=self.registry,
            events=self.events,
            provide=lambda capability, provider: self._provide(package, capability, provider),
            register_settings=lambda section: self.settings.register_package_section(
                package.id, manifest.type, section
            ),
            register_module=lambda module: self._register_module(package, module),
            asset_url=lambda rel: self.asset_url(package.id, rel),
            download=self._download,
        )

    def _provide(self, package: Package, capability: str, provider: Any) -> None:
        if capability not in package.manifest.provides:
            raise PackageError(
                f"包 {package.id} 未在 manifest.provides 中声明能力 {capability}"
            )
        meta = package.manifest.provides.get(capability) or {}
        self.registry.register_provider(
            package.id,
            capability,
            provider,
            title=str(meta.get("title", "")),
            description=str(meta.get("description", "")),
            version=int(meta.get("version", 1) or 1),
            builtin=package.builtin,
        )

    def _register_module(self, package: Package, module: Module) -> None:
        if not isinstance(module, Module):
            raise PackageError("register_module 需要 Module 子类实例")
        if package.module is not None:
            raise PackageError(f"包 {package.id} 重复注册模块")
        package.module = module
        self._modules.append(package)

    def _resolve_dependencies(self) -> None:
        for package in self.packages.values():
            if package.status in {"disabled", "error"}:
                continue
            status = self.registry.requirement_status(package.manifest.requires)
            package.missing = status.missing
            if status.missing:
                package.status = "unavailable"
                self.events.emit(
                    package.id, "log", "warn",
                    "缺少能力：" + ", ".join(status.missing),
                )
            else:
                package.status = "ready"

    # -- public info -------------------------------------------------------
    def list_packages(self) -> list[dict[str, Any]]:
        return [package.public() for package in self.packages.values()]

    def get_package(self, package_id: str) -> Package | None:
        return self.packages.get(package_id)

    def modules(self) -> list[Package]:
        return [package for package in self._modules if package.module is not None]

    def set_enabled(self, package_id: str, enabled: bool) -> dict[str, Any]:
        package = self.packages.get(package_id)
        if package is None:
            raise PackageError(f"未知包：{package_id}")
        disabled = [str(item) for item in self._registry_data.get("disabled", [])]
        if enabled:
            disabled = [item for item in disabled if item != package_id]
        elif package_id not in disabled:
            disabled.append(package_id)
        self._registry_data["disabled"] = disabled
        self._save_registry()
        package.enabled = enabled
        return {
            "ok": True,
            "needs_restart": True,
            "package": package.public(),
        }

    # -- asset URLs --------------------------------------------------------
    def asset_url(self, package_id: str, relative_path: str) -> str:
        package = self.packages.get(package_id)
        if package is None or not self.http_base_url:
            return ""
        rel = relative_path.replace("\\", "/").lstrip("/")
        if rel.startswith("web/"):
            rel = rel[4:]
        if not rel or ".." in Path(rel).parts:
            raise PackageError(f"非法资源路径：{relative_path}")
        return (
            f"{self.http_base_url.rstrip('/')}/packages/"
            f"{package.manifest.id}/{package.manifest.version}/web/{rel}"
        )

    def resolve_asset(self, package_id: str, version: str, relative_path: str) -> Path | None:
        package = self.packages.get(package_id)
        if package is None:
            return None
        web = package.web_dir.resolve()
        relative = relative_path.replace("\\", "/").lstrip("/")
        if relative.startswith("web/"):
            relative = relative[4:]
        target = (web / relative).resolve()
        if target != web and web not in target.parents:
            return None
        if not target.is_file():
            return None
        return target

    def find_page_agent(self, package_id: str, agent_id: str) -> Path | None:
        package = self.packages.get(package_id)
        if package is None:
            return None
        for agent in package.manifest.page_agents:
            if str(agent.get("id", "")) == agent_id:
                entry = str(agent.get("entry", "")).removeprefix("web/")
                return self.resolve_asset(package_id, package.manifest.version, entry)
        return None

    def matching_page_agents(self, url: str) -> list[dict[str, Any]]:
        """Return agent descriptors whose match pattern covers ``url``."""
        found: list[dict[str, Any]] = []
        for package in self.packages.values():
            if not package.enabled or package.status not in {"ready", "unavailable"}:
                continue
            if package.manifest.type not in {"module", "bundle"}:
                continue
            for agent in package.manifest.page_agents:
                matches = agent.get("matches") or []
                if any(_match_pattern(str(pattern), url) for pattern in matches):
                    path = self.find_page_agent(package.id, str(agent.get("id", "")))
                    if path is not None:
                        found.append(
                            {
                                "id": str(agent.get("id", "")),
                                "package": package.id,
                                "matches": matches,
                                "path": path,
                            }
                        )
        return found

    # -- install/uninstall -------------------------------------------------
    def install_zip(
        self,
        archive_path: Path,
        *,
        install_dependencies: bool = False,
    ) -> dict[str, Any]:
        info = validate_archive(Path(archive_path))
        manifest = info.manifest
        package_root = self.paths.packages_dir / manifest.id
        target = package_root / manifest.version
        if target.exists():
            raise PackageError(f"版本已存在：{manifest.id} {manifest.version}")
        staging = self.paths.packages_dir / f".staging-{uuid.uuid4().hex}"
        staging.mkdir(parents=True, exist_ok=True)
        try:
            with zipfile.ZipFile(info.path) as archive:
                self._safe_extract(archive, staging)
            if install_dependencies and manifest.dependencies:
                self._install_dependencies(manifest.dependencies)
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                shutil.rmtree(target)
            os.replace(staging, target)
            current = package_root / "current"
            current.write_text(manifest.version, encoding="utf-8")
            installed = dict(self._registry_data.get("installed") or {})
            installed[manifest.id] = {
                "version": manifest.version,
                "sha256": info.sha256,
                "installed_at": datetime.now().astimezone().isoformat(),
            }
            self._registry_data["installed"] = installed
            self._save_registry()
            self.events.emit(manifest.id, "log", "success", f"已安装 {manifest.name} {manifest.version}")
            return {
                "ok": True,
                "needs_restart": True,
                "package": {
                    "id": manifest.id,
                    "name": manifest.name,
                    "version": manifest.version,
                    "sha256": info.sha256,
                },
            }
        finally:
            shutil.rmtree(staging, ignore_errors=True)

    @staticmethod
    def _install_dependencies(dependencies: list[str]) -> None:
        commands: list[list[str]] = []
        if importlib.util.find_spec("pip") is not None:
            commands.append([sys.executable, "-m", "pip", "install", "--no-input"])
        uv = shutil.which("uv")
        if uv:
            commands.append([uv, "pip", "install", "--python", sys.executable])
        if not commands:
            raise PackageError("当前环境没有 pip/uv，无法安装包依赖")
        last_error = ""
        for prefix in commands:
            try:
                result = subprocess.run(
                    [*prefix, *dependencies],
                    capture_output=True,
                    text=True,
                    timeout=600,
                    check=False,
                )
            except (OSError, subprocess.TimeoutExpired) as exc:
                last_error = str(exc)
                continue
            if result.returncode == 0:
                return
            last_error = (result.stderr or result.stdout or "").strip()[-2000:]
        raise PackageError(f"安装依赖失败：{last_error}")

    def uninstall(self, package_id: str) -> dict[str, Any]:
        package = self.packages.get(package_id)
        if package is None:
            raise PackageError(f"未知包：{package_id}")
        if package.builtin:
            raise PackageError("内置包不能卸载，只能禁用")
        root = self.paths.packages_dir / package_id
        if root.exists():
            shutil.rmtree(root)
        installed = dict(self._registry_data.get("installed") or {})
        installed.pop(package_id, None)
        self._registry_data["installed"] = installed
        self._save_registry()
        self.packages.pop(package_id, None)
        return {"ok": True, "needs_restart": True}

    # -- context helpers ---------------------------------------------------
    def _download(
        self,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        timeout: float = 180.0,
        max_bytes: int = 200_000_000,
    ) -> bytes:
        if not url.startswith(("http://", "https://")):
            raise PackageError("只支持 http(s) 下载")
        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            with client.stream("GET", url, headers=headers or {}) as response:
                response.raise_for_status()
                chunks: list[bytes] = []
                total = 0
                for chunk in response.iter_bytes():
                    total += len(chunk)
                    if total > max_bytes:
                        raise PackageError(f"下载内容超过 {max_bytes} 字节")
                    chunks.append(chunk)
                return b"".join(chunks)

    def close(self) -> None:
        for package in self.packages.values():
            module = package.module
            if module is not None:
                try:
                    module.stop()
                except Exception:
                    pass


def _match_pattern(pattern: str, url: str) -> bool:
    """Small subset of Chrome match patterns: scheme://host/path with *."""
    if not pattern:
        return False
    regex = re.escape(pattern)
    regex = regex.replace(r"\*", ".*")
    return re.match(f"^{regex}$", url) is not None


__all__ = [
    "APP_NAME",
    "ArchiveInfo",
    "Manifest",
    "Package",
    "PackageManager",
    "validate_archive",
]
