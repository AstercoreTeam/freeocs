"""pywebview ``js_api`` exposed to the local frontend."""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from typing import Any

from .packages import validate_archive
from .sdk import ModuleError, SettingsError

logger = logging.getLogger("freeocs.api")

NAV = [
    {"id": "home", "title": "首页"},
    {"id": "apps", "title": "应用与插件"},
    {"id": "guide", "title": "操作指南"},
    {"id": "settings", "title": "设置"},
    {"id": "logs", "title": "日志"},
]


class UiApi:
    def __init__(self, app: Any) -> None:
        self.app = app

    # -- helpers -----------------------------------------------------------
    @staticmethod
    def _ok(**values: Any) -> dict[str, Any]:
        return {"ok": True, **values}

    @staticmethod
    def _fail(exc: Any, code: str = "") -> dict[str, Any]:
        message = str(exc) or exc.__class__.__name__
        logger.warning("UI API 错误：%s", message)
        return {"ok": False, "error": message, "code": code or getattr(exc, "code", "")}

    # -- bootstrap ---------------------------------------------------------
    def get_bootstrap(self) -> dict[str, Any]:
        try:
            app = self.app
            settings = app.settings
            modules = app.modules.list_public() if app.modules else []
            return self._ok(
                app=app.app_info(),
                nav=NAV,
                packages=app.packages.list_packages(),
                modules=modules,
                bridge=app.bridge_status(),
                settings=settings.summary(),
                last_seq=app.events.last_seq,
                ui=settings.section_values("ui", mask=True),
            )
        except Exception as exc:  # noqa: BLE001
            return self._fail(exc)

    def get_nav(self) -> dict[str, Any]:
        return self._ok(nav=NAV)

    def get_app_info(self) -> dict[str, Any]:
        return self._ok(app=self.app.app_info())

    def get_home(self) -> dict[str, Any]:
        try:
            return self.app.home()
        except Exception as exc:  # noqa: BLE001
            return self._fail(exc)

    # -- packages ----------------------------------------------------------
    def list_packages(self) -> dict[str, Any]:
        try:
            return self._ok(packages=self.app.packages.list_packages())
        except Exception as exc:  # noqa: BLE001
            return self._fail(exc)

    def set_package_enabled(self, package_id: str, enabled: bool) -> dict[str, Any]:
        try:
            return self._ok(**self.app.packages.set_enabled(str(package_id), bool(enabled)))
        except Exception as exc:  # noqa: BLE001
            return self._fail(exc)

    def install_package_dialog(self) -> dict[str, Any]:
        try:
            import webview

            windows = webview.windows
            if not windows:
                raise RuntimeError("窗口尚未就绪")
            result = windows[0].create_file_dialog(
                webview.OPEN_DIALOG,
                allow_multiple=False,
                file_types=("FreeOCS 包 (*.focpkg;*.zip)", "所有文件 (*.*)"),
            )
            if not result:
                return self._ok(cancelled=True)
            path = result[0] if isinstance(result, (list, tuple)) else result
            return self._ok(path=str(path))
        except Exception as exc:  # noqa: BLE001
            return self._fail(exc)

    def inspect_package(self, path: str) -> dict[str, Any]:
        try:
            info = validate_archive(Path(path))
            manifest = info.manifest
            return self._ok(
                package={
                    "id": manifest.id,
                    "name": manifest.name,
                    "version": manifest.version,
                    "type": manifest.type,
                    "description": manifest.description,
                    "author": manifest.author,
                    "requires": manifest.requires,
                    "optional_requires": manifest.optional_requires,
                    "provides": manifest.provides,
                    "dependencies": manifest.dependencies,
                    "sha256": info.sha256,
                    "size": info.size,
                }
            )
        except Exception as exc:  # noqa: BLE001
            return self._fail(exc)

    def install_package(self, path: str, install_dependencies: bool = False) -> dict[str, Any]:
        try:
            return self._ok(
                **self.app.packages.install_zip(
                    Path(path), install_dependencies=bool(install_dependencies)
                )
            )
        except Exception as exc:  # noqa: BLE001
            return self._fail(exc)

    def uninstall_package(self, package_id: str) -> dict[str, Any]:
        try:
            return self._ok(**self.app.packages.uninstall(str(package_id)))
        except Exception as exc:  # noqa: BLE001
            return self._fail(exc)

    # -- modules -----------------------------------------------------------
    def list_modules(self) -> dict[str, Any]:
        try:
            modules = self.app.modules.list_public() if self.app.modules else []
            return self._ok(modules=modules)
        except Exception as exc:  # noqa: BLE001
            return self._fail(exc)

    def get_module(self, module_id: str) -> dict[str, Any]:
        try:
            if self.app.modules is None:
                raise ModuleError("模块系统未初始化")
            return self._ok(module=self.app.modules.public(str(module_id)))
        except Exception as exc:  # noqa: BLE001
            return self._fail(exc)

    def get_module_state(self, module_id: str) -> dict[str, Any]:
        try:
            if self.app.modules is None:
                raise ModuleError("模块系统未初始化")
            return self._ok(state=self.app.modules.state(str(module_id)))
        except Exception as exc:  # noqa: BLE001
            return self._fail(exc)

    def get_module_panels(self, module_id: str) -> dict[str, Any]:
        try:
            if self.app.modules is None:
                raise ModuleError("模块系统未初始化")
            return self._ok(panels=self.app.modules.panels(str(module_id)))
        except Exception as exc:  # noqa: BLE001
            return self._fail(exc)

    def module_start(self, module_id: str) -> dict[str, Any]:
        try:
            if self.app.modules is None:
                raise ModuleError("模块系统未初始化")
            return self._ok(**self.app.modules.start(str(module_id)))
        except Exception as exc:  # noqa: BLE001
            return self._fail(exc)

    def module_stop(self, module_id: str) -> dict[str, Any]:
        try:
            if self.app.modules is None:
                raise ModuleError("模块系统未初始化")
            return self._ok(**self.app.modules.stop(str(module_id)))
        except Exception as exc:  # noqa: BLE001
            return self._fail(exc)

    def module_invoke(
        self, module_id: str, action: str, payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        try:
            if self.app.modules is None:
                raise ModuleError("模块系统未初始化")
            return self._ok(
                **self.app.modules.invoke(str(module_id), str(action), payload or {})
            )
        except Exception as exc:  # noqa: BLE001
            return self._fail(exc)

    # -- settings ----------------------------------------------------------
    def _capability_section(self) -> dict[str, Any]:
        registry = self.app.registry
        fields: list[dict[str, Any]] = []
        for capability in registry.capabilities():
            providers = registry.providers(capability)
            if not providers:
                continue
            active = next((item for item in providers if item.get("active")), providers[0])
            fields.append(
                {
                    "key": capability,
                    "label": capability,
                    "type": "select",
                    "default": active.get("package_id", ""),
                    "options": [
                        {
                            "value": item.get("package_id", ""),
                            "label": f"{item.get('title') or item.get('package_id')} "
                            f"({item.get('package_id')})",
                        }
                        for item in providers
                    ],
                    "help": "同一能力有多个提供者时，选择当前使用的一个。",
                }
            )
        if not fields:
            fields.append(
                {
                    "key": "_info",
                    "label": "尚未加载能力提供者",
                    "type": "info",
                    "default": "",
                }
            )
        return {
            "id": "capabilities",
            "title": "能力绑定",
            "description": "选择同一能力使用哪个插件提供者。",
            "group": "capability",
            "order": 100,
            "fields": fields,
        }

    def get_settings_schema(self) -> dict[str, Any]:
        try:
            sections = self.app.settings.schema()
            sections.append(self._capability_section())
            sections.sort(key=lambda item: (int(item.get("order", 500)), str(item.get("id"))))
            return self._ok(sections=sections)
        except Exception as exc:  # noqa: BLE001
            return self._fail(exc)

    def get_settings_values(self) -> dict[str, Any]:
        try:
            values = self.app.settings.public_values()
            values["capabilities"] = self.app.settings.capability_bindings()
            return self._ok(values=values)
        except Exception as exc:  # noqa: BLE001
            return self._fail(exc)

    def save_settings(self, section_id: str, values: dict[str, Any]) -> dict[str, Any]:
        try:
            if not isinstance(values, dict):
                raise SettingsError("设置值必须是对象")
            if section_id == "capabilities":
                saved = self.app.settings.save_section("capabilities", values)
                for capability in self.app.registry.capabilities():
                    self.app.registry.set_binding(capability, values.get(capability) or None)
                return self._ok(saved=saved)
            saved = self.app.settings.save_section(str(section_id), values)
            section = self.app.settings.section(str(section_id)) or {}
            package_id = section.get("package_id")
            if package_id and self.app.modules is not None:
                self.app.modules.notify_settings_changed(str(package_id))
            needs_restart = section_id == "bridge"
            return self._ok(saved=saved, needs_restart=needs_restart)
        except Exception as exc:  # noqa: BLE001
            return self._fail(exc)

    def reset_settings(self, section_id: str) -> dict[str, Any]:
        try:
            if section_id == "capabilities":
                self.app.settings.save_section("capabilities", {})
                return self._ok(saved={})
            return self._ok(saved=self.app.settings.reset_section(str(section_id)))
        except Exception as exc:  # noqa: BLE001
            return self._fail(exc)

    def test_llm(self) -> dict[str, Any]:
        started = time.perf_counter()
        try:
            llm = self.app.registry.require("llm.chat", consumer="settings")
            result = llm.chat(
                [
                    {"role": "system", "content": "只回复两个字母：OK"},
                    {"role": "user", "content": "ping"},
                ],
                temperature=0,
                max_tokens=8,
                timeout=30,
            )
            message = result.message or {}
            content = message.get("content") or ""
            return self._ok(
                content=str(content)[:200],
                model=self.app.settings.core_get("llm", "model"),
                latency_ms=round((time.perf_counter() - started) * 1000),
            )
        except Exception as exc:  # noqa: BLE001
            return self._fail(exc)

    # -- events / diagnostics ---------------------------------------------
    def get_events(self, after_seq: int = 0, limit: int = 200) -> dict[str, Any]:
        try:
            data = self.app.events.since(int(after_seq or 0), limit=int(limit or 200))
            return self._ok(**data)
        except Exception as exc:  # noqa: BLE001
            return self._fail(exc)

    def clear_events(self) -> dict[str, Any]:
        self.app.events.clear()
        return self._ok()

    def get_bridge_status(self) -> dict[str, Any]:
        return self._ok(bridge=self.app.bridge_status())

    def refresh_android_devices(self) -> dict[str, Any]:
        try:
            devices = self.app.adb.list_devices()
            return self._ok(devices=devices, adb=self.app.adb.adb_path)
        except Exception as exc:  # noqa: BLE001
            return self._ok(devices=[], error=str(exc), adb="")

    def get_guide_data(self) -> dict[str, Any]:
        app = self.app
        browsers = []
        for name, executable in (
            ("Chrome", "google-chrome"),
            ("Chromium", "chromium"),
            ("Chromium", "chromium-browser"),
            ("Edge", "microsoft-edge"),
            ("Brave", "brave-browser"),
            ("Firefox", "firefox"),
        ):
            path = shutil.which(executable)
            if path and not any(item["name"] == name for item in browsers):
                browsers.append({"name": name, "path": path})
        return self._ok(
            extension_dir=str(app.paths.extension_dir),
            chromium_dir=str(app.paths.extension_dir / "chromium"),
            firefox_dir=str(app.paths.extension_dir / "firefox"),
            data_dir=str(app.paths.data_dir),
            config_dir=str(app.paths.config_dir),
            log_file=str(app.paths.log_file),
            server_url=app.http_base_url,
            browsers=browsers,
            platform=sys.platform,
        )

    # -- OS helpers --------------------------------------------------------
    def open_path(self, path: str) -> dict[str, Any]:
        try:
            target = Path(str(path)).expanduser().resolve()
            if not target.exists():
                raise FileNotFoundError(f"路径不存在：{target}")
            if sys.platform == "win32":
                os.startfile(str(target))  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                subprocess.Popen(["open", str(target)])
            else:
                subprocess.Popen(["xdg-open", str(target)])
            return self._ok(path=str(target))
        except Exception as exc:  # noqa: BLE001
            return self._fail(exc)

    def open_external(self, url: str) -> dict[str, Any]:
        try:
            value = str(url or "").strip()
            if not value.startswith(("http://", "https://")):
                raise ValueError("只允许打开 http(s) 链接")
            webbrowser.open(value)
            return self._ok(url=value)
        except Exception as exc:  # noqa: BLE001
            return self._fail(exc)

    def _choose(self, dialog: Any) -> dict[str, Any]:
        import webview

        if not webview.windows:
            raise RuntimeError("窗口尚未就绪")
        result = webview.windows[0].create_file_dialog(dialog)
        if not result:
            return self._ok(cancelled=True)
        path = result[0] if isinstance(result, (list, tuple)) else result
        return self._ok(path=str(path))

    def choose_directory(self) -> dict[str, Any]:
        try:
            import webview

            return self._choose(webview.FOLDER_DIALOG)
        except Exception as exc:  # noqa: BLE001
            return self._fail(exc)

    def choose_file(self) -> dict[str, Any]:
        try:
            import webview

            return self._choose(webview.OPEN_DIALOG)
        except Exception as exc:  # noqa: BLE001
            return self._fail(exc)
