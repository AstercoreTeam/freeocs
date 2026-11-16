"""Capability registry and provider binding."""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Any

from .sdk import CapabilityMissing, CapabilityUnbound

CORE_PACKAGE = "__core__"


@dataclass(slots=True)
class ProviderRecord:
    capability: str
    package_id: str
    provider: Any
    title: str = ""
    description: str = ""
    version: int = 1
    builtin: bool = False

    def public(self) -> dict[str, Any]:
        return {
            "capability": self.capability,
            "package_id": self.package_id,
            "title": self.title or self.package_id,
            "description": self.description,
            "version": self.version,
            "builtin": self.builtin,
        }


@dataclass(slots=True)
class RequirementStatus:
    required: list[str] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    provided: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.missing


class CapabilityRegistry:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._providers: dict[str, list[ProviderRecord]] = {}
        self._bindings: dict[str, str] = {}

    # -- registration ------------------------------------------------------
    def register_core(
        self,
        capability: str,
        provider: Any,
        *,
        title: str = "",
        description: str = "",
        version: int = 1,
    ) -> None:
        self._add(ProviderRecord(capability, CORE_PACKAGE, provider, title, description, version, True))

    def register_provider(
        self,
        package_id: str,
        capability: str,
        provider: Any,
        *,
        title: str = "",
        description: str = "",
        version: int = 1,
        builtin: bool = False,
    ) -> None:
        self._add(
            ProviderRecord(capability, package_id, provider, title, description, version, builtin)
        )

    def _add(self, record: ProviderRecord) -> None:
        with self._lock:
            items = self._providers.setdefault(record.capability, [])
            # Replace an existing provider from the same package (reload/tests).
            items[:] = [
                item
                for item in items
                if not (item.package_id == record.package_id and item.capability == record.capability)
            ]
            items.append(record)

    def unregister_package(self, package_id: str) -> None:
        with self._lock:
            for capability in list(self._providers):
                self._providers[capability] = [
                    item for item in self._providers[capability] if item.package_id != package_id
                ]
                if not self._providers[capability]:
                    self._providers.pop(capability, None)
            for capability, bound in list(self._bindings.items()):
                if bound == package_id:
                    self._bindings.pop(capability, None)

    # -- binding -----------------------------------------------------------
    def set_binding(self, capability: str, package_id: str | None) -> None:
        with self._lock:
            if package_id:
                self._bindings[capability] = package_id
            else:
                self._bindings.pop(capability, None)

    def apply_bindings(self, bindings: dict[str, str]) -> None:
        with self._lock:
            for capability, package_id in bindings.items():
                if isinstance(capability, str) and isinstance(package_id, str) and package_id:
                    self._bindings[capability] = package_id

    def binding(self, capability: str) -> str:
        with self._lock:
            return self._bindings.get(capability, "")

    def bindings(self) -> dict[str, str]:
        with self._lock:
            return dict(self._bindings)

    def active_record(self, capability: str) -> ProviderRecord | None:
        with self._lock:
            items = list(self._providers.get(capability, []))
            if not items:
                return None
            bound = self._bindings.get(capability)
            if bound:
                for item in items:
                    if item.package_id == bound:
                        return item
            # Prefer core, then builtin, then registration order.
            items.sort(key=lambda item: (not item.builtin, item.package_id))
            return items[0]

    # -- access ------------------------------------------------------------
    def require(self, capability: str, *, consumer: str = "") -> Any:
        record = self.active_record(capability)
        if record is not None:
            return record.provider
        with self._lock:
            providers = self._providers.get(capability, [])
        suffix = f"（模块 {consumer} 需要）" if consumer else ""
        if providers:
            raise CapabilityUnbound(f"能力 {capability} 未绑定到可用提供者{suffix}")
        raise CapabilityMissing(f"缺少能力 {capability}{suffix}，请安装并启用对应插件")

    def optional(self, capability: str, *, consumer: str = "") -> Any | None:
        try:
            return self.require(capability, consumer=consumer)
        except (CapabilityMissing, CapabilityUnbound):
            return None

    def get(self, capability: str) -> Any | None:
        record = self.active_record(capability)
        return record.provider if record else None

    def providers(self, capability: str) -> list[dict[str, Any]]:
        with self._lock:
            items = list(self._providers.get(capability, []))
            active = self.active_record(capability)
        return [
            {**item.public(), "active": active is not None and item.package_id == active.package_id}
            for item in items
        ]

    def all_providers(self) -> dict[str, list[dict[str, Any]]]:
        with self._lock:
            capabilities = sorted(self._providers)
        return {capability: self.providers(capability) for capability in capabilities}

    def capabilities(self) -> list[str]:
        with self._lock:
            return sorted(self._providers)

    def requirement_status(self, required: list[str]) -> RequirementStatus:
        status = RequirementStatus(required=list(required))
        for capability in required:
            if self.active_record(capability) is not None:
                status.provided.append(capability)
            else:
                status.missing.append(capability)
        return status

    def close(self) -> None:
        with self._lock:
            for items in self._providers.values():
                for item in items:
                    close = getattr(item.provider, "close", None)
                    if callable(close):
                        try:
                            close()
                        except Exception:
                            pass
            self._providers.clear()
            self._bindings.clear()
