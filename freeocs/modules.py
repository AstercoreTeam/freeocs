"""Module host: lifecycle, status, actions, panels and page-agent RPC."""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .events import EventBus
from .packages import Package, PackageManager
from .sdk import Module, ModuleError

logger = logging.getLogger("freeocs.modules")


@dataclass(slots=True)
class RegisteredModule:
    package: Package
    module: Module
    available: bool = True
    missing: list[str] | None = None

    @property
    def id(self) -> str:
        return self.package.manifest.id


class ModuleHost:
    def __init__(
        self,
        packages: PackageManager,
        events: EventBus,
        asset_url: Callable[[str, str], str],
    ) -> None:
        self.packages = packages
        self.events = events
        self.asset_url = asset_url
        self._lock = threading.RLock()
        self._modules: dict[str, RegisteredModule] = {}

    # -- construction ------------------------------------------------------
    def load(self) -> None:
        with self._lock:
            self._modules.clear()
            for package in self.packages.modules():
                module = package.module
                if module is None:
                    continue
                module.id = package.manifest.id if not module.id else module.id
                module.name = package.manifest.name if not module.name else module.name
                available = package.status == "ready"
                self._modules[package.manifest.id] = RegisteredModule(
                    package=package,
                    module=module,
                    available=available,
                    missing=list(package.missing),
                )

    def get(self, module_id: str) -> RegisteredModule | None:
        return self._modules.get(module_id)

    def modules(self) -> list[RegisteredModule]:
        return list(self._modules.values())

    # -- info --------------------------------------------------------------
    def public(self, module_id: str) -> dict[str, Any]:
        entry = self._require(module_id)
        package = entry.package
        module = entry.module
        manifest = package.manifest
        panels = self.panels(module_id)
        actions: list[dict[str, Any]] = []
        try:
            actions = list(module.actions() or [])
        except Exception as exc:  # noqa: BLE001
            logger.warning("模块 %s actions() 失败: %s", module_id, exc)
        return {
            "id": module_id,
            "name": manifest.name,
            "version": manifest.version,
            "description": manifest.description,
            "platform": manifest.platform,
            "icon": manifest.icon,
            "enabled": package.enabled,
            "available": entry.available,
            "missing": entry.missing or [],
            "status": package.status,
            "load_error": package.load_error,
            "requires": manifest.requires,
            "provides": manifest.provides,
            "web": manifest.web,
            "page_agents": manifest.page_agents,
            "actions": actions,
            "panels": panels,
            "state": self.state(module_id),
        }

    def list_public(self) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for entry in self.modules():
            try:
                result.append(self.public(entry.id))
            except Exception:
                continue
        return result

    def panels(self, module_id: str) -> list[dict[str, Any]]:
        entry = self._require(module_id)
        package = entry.package
        manifest = package.manifest
        try:
            custom = entry.module.panels() or []
        except Exception:
            custom = []
        panels = custom or manifest.panels
        result: list[dict[str, Any]] = []
        for panel in panels:
            panel_id = str(panel.get("id", ""))
            entry_path = str(panel.get("entry", "")).removeprefix("web/")
            if not panel_id or not entry_path:
                continue
            styles = panel.get("styles") or []
            result.append(
                {
                    "id": panel_id,
                    "title": str(panel.get("title", panel_id)),
                    "order": int(panel.get("order", 100) or 100),
                    "js_url": self.asset_url(package.manifest.id, entry_path),
                    "css_urls": [
                        self.asset_url(package.manifest.id, str(item).removeprefix("web/"))
                        for item in styles
                    ],
                }
            )
        result.sort(key=lambda item: item["order"])
        return result

    # -- lifecycle ---------------------------------------------------------
    def start(self, module_id: str) -> dict[str, Any]:
        entry = self._require(module_id)
        if not entry.available:
            raise ModuleError(
                "模块不可用，缺少能力：" + (", ".join(entry.missing) or "未知")
            )
        try:
            entry.module.start()
        except Exception as exc:  # noqa: BLE001 - module boundary
            logger.exception("模块启动失败 %s", module_id)
            self.events.emit(module_id, "log", "error", f"启动失败：{exc}")
            raise ModuleError(f"启动失败：{exc}") from exc
        self.events.emit(module_id, "log", "info", "已请求启动")
        return {"ok": True, "state": self.state(module_id)}

    def stop(self, module_id: str) -> dict[str, Any]:
        entry = self._require(module_id)
        try:
            entry.module.stop()
        except Exception as exc:  # noqa: BLE001
            logger.exception("模块停止失败 %s", module_id)
            raise ModuleError(f"停止失败：{exc}") from exc
        self.events.emit(module_id, "log", "info", "已请求停止")
        return {"ok": True, "state": self.state(module_id)}

    def invoke(
        self, module_id: str, action: str, payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        entry = self._require(module_id)
        if action == "start":
            return self.start(module_id)
        if action == "stop":
            return self.stop(module_id)
        try:
            result = entry.module.invoke(action, payload or {})
        except Exception as exc:  # noqa: BLE001
            logger.exception("模块动作失败 %s/%s", module_id, action)
            raise ModuleError(f"动作失败：{exc}") from exc
        return result if isinstance(result, dict) else {"ok": True, "data": result}

    def state(self, module_id: str) -> dict[str, Any]:
        entry = self._require(module_id)
        try:
            state = entry.module.status() or {}
        except Exception as exc:  # noqa: BLE001
            state = {"running": False, "state": "error", "message": f"状态读取失败：{exc}"}
        state.setdefault("running", False)
        state.setdefault("state", "idle")
        state.setdefault("message", "")
        state.setdefault("progress", {"current": 0, "total": 0, "label": ""})
        state.setdefault("stats", {})
        state.setdefault("extra", {})
        state.setdefault("updated_at", "")
        state["available"] = entry.available
        state["missing"] = entry.missing or []
        return state

    def handle_agent_request(self, module_id: str, method: str, payload: dict[str, Any]) -> Any:
        entry = self._require(module_id)
        if not entry.available:
            raise ModuleError(
                "模块不可用，缺少能力：" + (", ".join(entry.missing) or "未知")
            )
        return entry.module.handle_agent_request(method, payload)

    # -- settings ----------------------------------------------------------
    def notify_settings_changed(self, package_id: str) -> None:
        entry = self._modules.get(package_id)
        if entry is None:
            return
        try:
            values = self.packages.settings.package_values(package_id)
            entry.module.on_settings_changed(values)
        except Exception:
            logger.exception("模块设置回调失败 %s", package_id)

    # -- housekeeping ------------------------------------------------------
    def close(self) -> None:
        for entry in list(self._modules.values()):
            try:
                entry.module.stop()
            except Exception:
                pass

    def _require(self, module_id: str) -> RegisteredModule:
        entry = self._modules.get(module_id)
        if entry is None:
            raise ModuleError(f"未知模块：{module_id}")
        return entry
