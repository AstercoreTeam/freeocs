"""Public SDK for FreeOCS packages.

Only this module is stable across ``api_version`` 1.  Packages import types,
protocols, the base ``Module`` class and ``PackageContext`` from here.
"""

from __future__ import annotations

import json
import threading
import time
import traceback
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol

API_VERSION = 1

# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class FreeOCSError(Exception):
    """Base class for all framework errors."""

    code = "FREEOCS_ERROR"


class PackageError(FreeOCSError):
    code = "PKG_ERROR"


class CapabilityError(FreeOCSError):
    code = "CAPABILITY_ERROR"


class CapabilityMissing(CapabilityError):
    code = "CAPABILITY_MISSING"


class CapabilityUnbound(CapabilityError):
    code = "CAPABILITY_UNBOUND"


class ProviderError(FreeOCSError):
    code = "PROVIDER_ERROR"

    def __init__(
        self,
        message: str,
        *,
        provider: str = "",
        status: int | None = None,
        retryable: bool = False,
        detail: str = "",
    ) -> None:
        super().__init__(message)
        self.provider = provider
        self.status = status
        self.retryable = retryable
        self.detail = detail


class ModuleError(FreeOCSError):
    code = "MODULE_ERROR"


class SettingsError(FreeOCSError):
    code = "SETTINGS_ERROR"


class BridgeError(FreeOCSError):
    code = "BRIDGE_ERROR"


class AdbError(FreeOCSError):
    code = "ADB_ERROR"

    def __init__(
        self,
        message: str,
        *,
        command: str = "",
        returncode: int | None = None,
        stderr: str = "",
    ) -> None:
        super().__init__(message)
        self.command = command
        self.returncode = returncode
        self.stderr = stderr


class UserCancelled(FreeOCSError):
    code = "USER_CANCELLED"


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class ChatResult:
    message: dict[str, Any]
    finish_reason: str = ""
    usage: dict[str, Any] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class ChoiceAnswer:
    index: int
    letter: str
    text: str
    explanation: str = ""
    raw: str = ""


@dataclass(slots=True)
class Transcript:
    text: str
    language: str = ""
    duration: float = 0.0
    segments: list[dict[str, Any]] = field(default_factory=list)


@dataclass(slots=True)
class OCRBlock:
    text: str
    box: tuple[float, float, float, float]
    confidence: float = 0.0


@dataclass(slots=True)
class OCRResult:
    text: str
    blocks: list[OCRBlock] = field(default_factory=list)


@dataclass(slots=True)
class AudioResult:
    data: bytes
    mime: str = "audio/wav"
    ext: str = "wav"
    duration: float = 0.0


# ---------------------------------------------------------------------------
# Capability protocols
# ---------------------------------------------------------------------------


class LLMProvider(Protocol):
    def chat(
        self,
        messages: Sequence[dict[str, Any]],
        *,
        tools: Sequence[dict[str, Any]] | None = None,
        tool_choice: str | dict[str, Any] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        response_format: dict[str, Any] | None = None,
        timeout: float | None = None,
    ) -> ChatResult: ...

    def close(self) -> None: ...


class ChoiceAnswerProvider(Protocol):
    def answer_choice(
        self,
        question: str,
        options: Sequence[str],
        *,
        context: str = "",
        timeout: float | None = None,
    ) -> ChoiceAnswer: ...


class ASRProvider(Protocol):
    def transcribe(
        self,
        audio: bytes,
        *,
        filename: str = "audio.wav",
        language: str | None = None,
    ) -> Transcript: ...


class OCRProvider(Protocol):
    def extract(
        self,
        image: bytes,
        *,
        language: str | None = None,
    ) -> OCRResult: ...


class TTSProvider(Protocol):
    def synthesize(
        self,
        text: str,
        *,
        voice: str | None = None,
        language: str | None = None,
        output_format: str = "wav",
    ) -> AudioResult: ...


class WebBridge(Protocol):
    def status(self) -> dict[str, Any]: ...
    def call(self, method: str, *args: Any, timeout: float = 15.0) -> Any: ...
    def page_info(self) -> dict[str, Any]: ...
    def navigate(self, url: str) -> dict[str, Any]: ...
    def list_tabs(self) -> list[dict[str, Any]]: ...
    def activate(self, url_pattern: str) -> dict[str, Any]: ...


class AdbManager(Protocol):
    def list_devices(self) -> list[dict[str, Any]]: ...
    def connect(self, serial: str | None = None) -> Any: ...


# ---------------------------------------------------------------------------
# Settings views
# ---------------------------------------------------------------------------


class ScopedSettings:
    """Read-only view of a package's settings (``packages.<id>``)."""

    def __init__(self, getter: Callable[[], dict[str, Any]]) -> None:
        self._getter = getter

    def all(self) -> dict[str, Any]:
        return dict(self._getter())

    def get(self, key: str, default: Any = None) -> Any:
        return self._getter().get(key, default)

    def has(self, key: str) -> bool:
        return key in self._getter()


class CoreSettings:
    """Read-only view of framework settings (``llm``, ``android``, ...)."""

    def __init__(self, getter: Callable[[str, str, Any], Any]) -> None:
        self._getter = getter

    def get(self, section: str, key: str, default: Any = None) -> Any:
        return self._getter(section, key, default)


# ---------------------------------------------------------------------------
# Package context
# ---------------------------------------------------------------------------


class PackageContext:
    """Object passed to a package's ``setup(api)`` function."""

    def __init__(
        self,
        *,
        package_id: str,
        package_version: str,
        package_type: str,
        package_dir: Path,
        data_dir: Path,
        app_version: str,
        http_base_url: str,
        settings: ScopedSettings,
        core_settings: CoreSettings,
        web: WebBridge | None,
        adb: AdbManager | None,
        capabilities: Any,
        events: Any,
        provide: Callable[[str, Any], None],
        register_settings: Callable[[dict[str, Any]], None],
        register_module: Callable[[Any], None],
        asset_url: Callable[[str], str],
        download: Callable[..., bytes],
    ) -> None:
        self.package_id = package_id
        self.package_version = package_version
        self.package_type = package_type
        self.package_dir = package_dir
        self.data_dir = data_dir
        self.app_version = app_version
        self.http_base_url = http_base_url
        self.settings = settings
        self.core_settings = core_settings
        self.web = web
        self.adb = adb
        self._capabilities = capabilities
        self._events = events
        self._provide = provide
        self._register_settings = register_settings
        self._register_module = register_module
        self._asset_url = asset_url
        self._download = download

    # -- capability access -------------------------------------------------
    def require(self, capability_id: str) -> Any:
        return self._capabilities.require(capability_id, consumer=self.package_id)

    def optional(self, capability_id: str) -> Any | None:
        return self._capabilities.optional(capability_id, consumer=self.package_id)

    def provide(self, capability_id: str, provider: Any) -> None:
        self._provide(capability_id, provider)

    # -- registration ------------------------------------------------------
    def register_settings(self, section: dict[str, Any]) -> None:
        self._register_settings(section)

    def register_module(self, module: Module) -> None:
        self._register_module(module)

    # -- resources ---------------------------------------------------------
    def asset_url(self, relative_path: str) -> str:
        return self._asset_url(relative_path)

    def download(
        self,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        timeout: float = 180.0,
        max_bytes: int = 200_000_000,
    ) -> bytes:
        return self._download(url, headers=headers, timeout=timeout, max_bytes=max_bytes)

    # -- events ------------------------------------------------------------
    def log(self, level: str, message: str, **data: Any) -> None:
        self._events.emit(self.package_id, "log", level, message, data or None)

    def emit(
        self,
        event_type: str,
        data: dict[str, Any] | None = None,
        *,
        level: str = "info",
        message: str = "",
    ) -> None:
        self._events.emit(self.package_id, event_type, level, message, data)


ModuleContext = PackageContext


# ---------------------------------------------------------------------------
# Module base
# ---------------------------------------------------------------------------


class Module:
    """Base class for application modules.

    ``start``/``stop``/``invoke`` must return quickly.  Long-running work
    belongs in a worker thread (see :class:`ModuleRunner`).
    """

    id: str = ""
    name: str = ""

    def __init__(self, ctx: ModuleContext) -> None:
        self.ctx = ctx

    def start(self) -> None:
        raise NotImplementedError

    def stop(self) -> None:
        raise NotImplementedError

    def status(self) -> dict[str, Any]:
        return {"running": False, "state": "idle", "message": "空闲"}

    def actions(self) -> list[dict[str, Any]]:
        return []

    def invoke(self, action: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        raise ModuleError(f"模块 {self.id} 不支持动作：{action}")

    def on_settings_changed(self, values: dict[str, Any]) -> None:
        return None

    def handle_agent_request(self, method: str, payload: dict[str, Any]) -> Any:
        raise ModuleError(f"模块 {self.id} 没有页面 Agent 接口：{method}")

    def panels(self) -> list[dict[str, Any]]:
        return []


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


class ModuleRunner:
    """Small thread/status helper for modules.

    Usage::

        self.runner.start(self._loop, initial_message="启动中…")
        while not stop_event.wait(0.5):
            self.runner.set_message("运行中")
    """

    def __init__(self, module: Module) -> None:
        self.module = module
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._state: dict[str, Any] = {
            "running": False,
            "state": "idle",
            "message": "等待开始",
            "progress": {"current": 0, "total": 0, "label": ""},
            "stats": {},
            "updated_at": _now_iso(),
            "extra": {},
        }

    # -- lifecycle ---------------------------------------------------------
    def start(self, target: Callable[[threading.Event], None], *, initial_message: str = "") -> bool:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return False
            self._stop = threading.Event()
            self._state.update(
                running=True,
                state="running",
                message=initial_message or "运行中",
                updated_at=_now_iso(),
            )
            self._thread = threading.Thread(
                target=self._wrap, args=(target, self._stop), daemon=True,
                name=f"module-{self.module.id}",
            )
            self._thread.start()
            return True

    def _wrap(self, target: Callable[[threading.Event], None], stop_event: threading.Event) -> None:
        try:
            target(stop_event)
        except Exception as exc:  # noqa: BLE001 - module boundary
            traceback.print_exc()
            with self._lock:
                self._state.update(
                    running=False,
                    state="error",
                    message=f"错误：{exc}",
                    updated_at=_now_iso(),
                )
        else:
            with self._lock:
                previous = self._state.get("state")
                final_state = previous if previous in {"waiting", "error"} else "idle"
                self._state.update(
                    running=False,
                    state=final_state,
                    message=self._state.get("message") or "已结束",
                    updated_at=_now_iso(),
                )

    def stop(self, message: str = "正在停止…") -> None:
        self._stop.set()
        with self._lock:
            self._state.update(message=message, state="stopping", updated_at=_now_iso())

    def join(self, timeout: float = 5.0) -> None:
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=timeout)
        if thread is not None and not thread.is_alive():
            with self._lock:
                self._state["running"] = False
                if self._state.get("state") == "stopping":
                    self._state.update(state="idle", message="已停止", updated_at=_now_iso())

    # -- state -------------------------------------------------------------
    @property
    def running(self) -> bool:
        thread = self._thread
        return bool(thread is not None and thread.is_alive())

    @property
    def stop_event(self) -> threading.Event:
        return self._stop

    def status(self) -> dict[str, Any]:
        with self._lock:
            data = dict(self._state)
            data["progress"] = dict(self._state.get("progress") or {})
            data["stats"] = dict(self._state.get("stats") or {})
            data["extra"] = dict(self._state.get("extra") or {})
            data["running"] = self.running
            return data

    def set_message(self, message: str, *, state: str | None = None) -> None:
        with self._lock:
            self._state["message"] = message
            if state:
                self._state["state"] = state
            self._state["updated_at"] = _now_iso()

    def set_progress(self, current: int | None = None, total: int | None = None,
                     label: str | None = None) -> None:
        with self._lock:
            progress = dict(self._state.get("progress") or {})
            if current is not None:
                progress["current"] = current
            if total is not None:
                progress["total"] = total
            if label is not None:
                progress["label"] = label
            self._state["progress"] = progress
            self._state["updated_at"] = _now_iso()

    def add_stat(self, key: str, delta: int = 1) -> None:
        with self._lock:
            stats = dict(self._state.get("stats") or {})
            stats[key] = int(stats.get(key, 0)) + delta
            self._state["stats"] = stats
            self._state["updated_at"] = _now_iso()

    def set_extra(self, **values: Any) -> None:
        with self._lock:
            extra = dict(self._state.get("extra") or {})
            extra.update(values)
            self._state["extra"] = extra
            self._state["updated_at"] = _now_iso()

    def fail(self, message: str) -> None:
        with self._lock:
            self._state.update(
                running=False, state="error", message=message, updated_at=_now_iso()
            )

    def wait(self, seconds: float) -> bool:
        """Sleep unless stopped; returns True when the stop event is set."""
        return self._stop.wait(max(0.0, seconds))


# ---------------------------------------------------------------------------
# Misc helpers
# ---------------------------------------------------------------------------


def parse_json_object(text: str) -> dict[str, Any]:
    """Parse a JSON object, tolerating ```json fences and surrounding prose."""
    candidate = (text or "").strip()
    if candidate.startswith("```"):
        candidate = candidate.strip("`")
        if candidate.lower().startswith("json"):
            candidate = candidate[4:]
    try:
        value = json.loads(candidate)
        return value if isinstance(value, dict) else {}
    except json.JSONDecodeError:
        start = candidate.find("{")
        end = candidate.rfind("}")
        if 0 <= start < end:
            try:
                value = json.loads(candidate[start:end + 1])
                return value if isinstance(value, dict) else {}
            except json.JSONDecodeError:
                return {}
    return {}


def coerce_str(value: Any, default: str = "") -> str:
    return value if isinstance(value, str) else default


def iter_seconds(min_seconds: float, max_seconds: float) -> Iterable[float]:
    """Utility for modules that need a deterministic delay range in tests."""
    if max_seconds <= min_seconds:
        yield max(0.0, min_seconds)
        return
    yield max(0.0, min_seconds)
    yield max(0.0, max_seconds)


def sleep_seconds(seconds: float) -> None:
    time.sleep(max(0.0, seconds))
