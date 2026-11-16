# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

"""Application assembly and pywebview lifecycle."""

from __future__ import annotations

import logging
import os
import shutil
import sys
from pathlib import Path
from typing import Any

from . import __version__
from .capabilities import CapabilityRegistry
from .config import SettingsStore
from .events import EventBus
from .logging_setup import setup_logging
from .modules import ModuleHost
from .packages import PackageManager
from .paths import AppPaths, build_paths
from .server import LocalServer
from .transports.adb import AdbManager
from .transports.browser_bridge import BrowserBridge
from .usage import UsageStore

logger = logging.getLogger("freeocs.app")


class Application:
    def __init__(
        self,
        *,
        portable: bool = False,
        port: int | None = None,
        dev: bool = False,
        log_level: str | None = None,
    ) -> None:
        self.dev = dev
        self.paths: AppPaths = build_paths(portable=portable).ensure()
        self.settings = SettingsStore(self.paths.settings_file)
        level = log_level or str(self.settings.core_get("ui", "log_level", "info"))
        setup_logging(self.paths.log_file, level)
        self.events = EventBus()
        self.usage = UsageStore(self.paths.data_dir / "usage.json", self.settings)
        self.registry = CapabilityRegistry()
        self.registry.set_usage(self.usage)
        self.registry.apply_bindings(self.settings.capability_bindings())
        self.adb = AdbManager(self.settings)
        self.web = BrowserBridge()
        self.registry.register_core(
            "android.adb", self.adb, title="ADB", description="Android 调试桥"
        )
        self.registry.register_core(
            "web.bridge", self.web, title="浏览器中继", description="浏览器扩展中继"
        )

        configured_port = (
            int(port) if port is not None else int(self.settings.core_get("bridge", "port", 8765))
        )
        self.server = LocalServer(configured_port, events=self.events, bridge=self.web)
        self.server.start()
        self.http_base_url = self.server.base_url

        self.packages = PackageManager(
            self.paths,
            self.settings,
            self.events,
            self.registry,
            http_base_url=self.http_base_url,
        )
        self.modules: ModuleHost | None = None
        self._ui_api: Any = None
        self._window: Any = None
        self._prepare_extensions()
        logger.info("FreeOCS %s 启动，数据目录 %s", __version__, self.paths.data_dir)

    def _prepare_extensions(self) -> None:
        """Copy built extension directories into the data dir for "load unpacked"."""
        for browser in ("chromium", "firefox"):
            dist = self.paths.extension_dist_dir / browser
            target = self.paths.extension_dir / browser
            source_manifest = self.paths.repo / "extension" / browser / "manifest.json"
            shared = self.paths.repo / "extension" / "shared"
            try:
                target.mkdir(parents=True, exist_ok=True)
                if dist.is_dir() and (dist / "manifest.json").is_file():
                    shutil.copytree(dist, target, dirs_exist_ok=True)
                elif source_manifest.is_file() and shared.is_dir():
                    shutil.copytree(shared, target, dirs_exist_ok=True)
                    shutil.copy2(source_manifest, target / "manifest.json")
                else:
                    logger.warning("扩展资源缺失：%s", browser)
                    continue
                # Browser loaders (and snap home interfaces) prefer world-readable
                # extension assets; 600 files from zip/copy are needlessly strict.
                for path in [target, *target.rglob("*")]:
                    try:
                        path.chmod(0o755 if path.is_dir() else 0o644)
                    except OSError:
                        pass
                logger.info("浏览器扩展已准备：%s", target)
            except OSError as exc:
                logger.warning("准备浏览器扩展失败 %s: %s", browser, exc)

    # -- lifecycle ---------------------------------------------------------
    def load_packages(self) -> None:
        self.packages.load_all()
        self._apply_preferred_capabilities()
        self.modules = ModuleHost(self.packages, self.events, self.packages.asset_url)
        self.modules.load()
        self.server.packages = self.packages
        self.server.modules = self.modules
        self.events.emit("", "log", "info", "框架已就绪")

    def _apply_preferred_capabilities(self) -> None:
        """Local-first defaults when the user has not bound a capability yet."""
        preferred = {
            "media.asr": "asr_whisper",
            "media.tts": "tts_system",
            "media.ocr": "ocr_rapid",
        }
        current = self.settings.capability_bindings()
        for capability, package_id in preferred.items():
            if current.get(capability):
                continue
            providers = {item["package_id"] for item in self.registry.providers(capability)}
            if package_id in providers:
                self.registry.set_binding(capability, package_id)

    def create_ui_api(self) -> Any:
        from .api import UiApi

        self._ui_api = UiApi(self)
        return self._ui_api

    def run(self) -> None:
        import webview

        self.load_packages()
        api = self.create_ui_api()
        web_dir = self.paths.web_dir
        if not (web_dir / "index.html").is_file():
            raise RuntimeError(f"前端资源不存在：{web_dir / 'index.html'}")
        self._window = webview.create_window(
            "FreeOCS - 学习助手",
            str(web_dir / "index.html"),
            js_api=api,
            width=1240,
            height=780,
            min_size=(960, 600),
        )
        try:
            storage = self.paths.cache_dir / "webview"
            storage.mkdir(parents=True, exist_ok=True)
            start_kwargs: dict[str, Any] = {
                "http_server": True,
                "debug": self.dev,
                "private_mode": False,
                "storage_path": str(storage),
                "icon": str(web_dir / "favicon.ico") if (web_dir / "favicon.ico").is_file() else None,
            }
            # pywebview may try Qt first even when only GTK/WebKit2 is installed.
            # Force the Linux backend so the window actually opens.
            if sys.platform.startswith("linux"):
                start_kwargs["gui"] = "gtk"
            webview.start(**start_kwargs)
        finally:
            self.shutdown()

    def shutdown(self) -> None:
        try:
            if self.modules is not None:
                self.modules.close()
        except Exception:
            logger.exception("关闭模块失败")
        try:
            self.registry.close()
        except Exception:
            pass
        try:
            self.web.close()
        except Exception:
            pass
        try:
            self.server.stop()
        except Exception:
            logger.exception("关闭本地服务失败")
        logger.info("FreeOCS 已退出")

    # -- info --------------------------------------------------------------
    def app_info(self) -> dict[str, Any]:
        return {
            "name": "FreeOCS",
            "version": __version__,
            "python": sys.version.split()[0],
            "platform": sys.platform,
            "dev": self.dev,
            "portable": self.paths.portable,
            "data_dir": str(self.paths.data_dir),
            "config_dir": str(self.paths.config_dir),
            "log_file": str(self.paths.log_file),
            "web_dir": str(self.paths.web_dir),
            "packages_dir": str(self.paths.packages_dir),
            "extension_dir": str(self.paths.extension_dir),
            "http_base_url": self.http_base_url,
            "pid": os.getpid(),
        }

    def home(self) -> dict[str, Any]:
        packages = self.packages.list_packages()
        modules = self.modules.list_public() if self.modules else []
        running = [item for item in modules if item.get("state", {}).get("running")]
        llm = self.settings.summary()["llm"]
        bridge = self.server.bridge_status()
        return {
            "ok": True,
            "app": self.app_info(),
            "llm": llm,
            "bridge": bridge,
            "packages": {
                "total": len(packages),
                "enabled": len([item for item in packages if item.get("enabled")]),
                "modules": len([item for item in packages if item.get("type") != "plugin"]),
            },
            "modules": {
                "total": len(modules),
                "running": len(running),
                "items": modules,
            },
            "events": self.events.since(0, limit=12)["events"],
            "usage": self.usage.summary(),
        }

    def bridge_status(self) -> dict[str, Any]:
        data = self.server.bridge_status()
        data["server"] = self.http_base_url
        data["extension_dir"] = str(self.paths.extension_dir)
        data["web"] = self.web.status()
        return data


def create_app(**kwargs: Any) -> Application:
    app = Application(**kwargs)
    app.load_packages()
    return app


__all__ = ["Application", "Path", "create_app"]
