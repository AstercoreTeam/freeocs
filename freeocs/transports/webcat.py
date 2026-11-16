"""Browser bridge: long-poll queue between the extension and Python modules."""

from __future__ import annotations

import queue
import threading
import time
import uuid
from typing import Any

from ..sdk import BridgeError


class WebcatBridge:
    def __init__(self, *, poll_timeout: float = 25.0) -> None:
        self._tasks: queue.Queue[dict[str, Any]] = queue.Queue()
        self._pending: dict[str, dict[str, Any]] = {}
        self._lock = threading.RLock()
        self._last_poll = 0.0
        self._last_seen = 0.0
        self._extension_info: dict[str, Any] = {}
        self._poll_timeout = poll_timeout
        self._closed = False

    # -- extension side ----------------------------------------------------
    def register(self, info: dict[str, Any]) -> None:
        with self._lock:
            self._extension_info = {
                "browser": str(info.get("browser", "") or ""),
                "version": str(info.get("version", "") or ""),
                "extension_id": str(info.get("extension_id", "") or ""),
            }
            self._last_seen = time.time()
            self._last_poll = self._last_seen

    def poll(self, timeout: float | None = None) -> dict[str, Any]:
        wait = max(0.1, min(float(timeout if timeout is not None else self._poll_timeout), 30.0))
        with self._lock:
            self._last_poll = time.time()
            self._last_seen = self._last_poll
        try:
            task = self._tasks.get(timeout=wait)
        except queue.Empty:
            return {}
        return task

    def complete(self, payload: dict[str, Any]) -> bool:
        task_id = str(payload.get("id", ""))
        if not task_id:
            return False
        with self._lock:
            slot = self._pending.get(task_id)
            if slot is None:
                return False
            slot["payload"] = payload
            slot["event"].set()
        return True

    # -- Python side -------------------------------------------------------
    def enqueue(self, action: str, args: dict[str, Any], *, timeout: float = 15.0) -> Any:
        if self._closed:
            raise BridgeError("浏览器中继已关闭")
        task_id = uuid.uuid4().hex
        event = threading.Event()
        slot: dict[str, Any] = {"event": event, "payload": None}
        with self._lock:
            self._pending[task_id] = slot
        self._tasks.put({"id": task_id, "action": action, "args": args})
        if not event.wait(timeout=max(1.0, float(timeout))):
            with self._lock:
                self._pending.pop(task_id, None)
            if not self.connected:
                raise BridgeError("浏览器扩展未连接，请先安装/启用扩展并打开目标页面")
            raise BridgeError(f"浏览器扩展响应超时（{timeout}s）")
        with self._lock:
            self._pending.pop(task_id, None)
        payload = slot.get("payload") or {}
        if not payload.get("ok", False):
            raise BridgeError(str(payload.get("error", "浏览器操作失败")))
        return payload.get("result")

    def call(self, method: str, *args: Any, timeout: float = 15.0) -> Any:
        return self.enqueue("dom.call", {"method": method, "args": list(args)}, timeout=timeout)

    def page_info(self, *, timeout: float = 15.0) -> dict[str, Any]:
        return self.enqueue("page.info", {}, timeout=timeout) or {}

    def navigate(self, url: str, *, timeout: float = 15.0) -> dict[str, Any]:
        return self.enqueue("page.navigate", {"url": url}, timeout=timeout) or {}

    def list_tabs(self, *, timeout: float = 15.0) -> list[dict[str, Any]]:
        return self.enqueue("tabs.list", {}, timeout=timeout) or []

    def activate(self, url_pattern: str, *, timeout: float = 15.0) -> dict[str, Any]:
        return self.enqueue("tabs.activate", {"url_pattern": url_pattern}, timeout=timeout) or {}

    def set_target(self, tab_id: int | str, *, timeout: float = 5.0) -> dict[str, Any]:
        return self.enqueue("tabs.target", {"tab_id": tab_id}, timeout=timeout) or {}

    # -- status ------------------------------------------------------------
    @property
    def connected(self) -> bool:
        with self._lock:
            last = max(self._last_poll, self._last_seen)
        return bool(last and time.time() - last < 60)

    def status(self) -> dict[str, Any]:
        with self._lock:
            now = time.time()
            return {
                "connected": self.connected,
                "last_poll": self._last_poll,
                "last_seen": self._last_seen,
                "seconds_since_poll": round(now - self._last_poll, 1) if self._last_poll else None,
                "extension": dict(self._extension_info),
                "pending": len(self._pending),
                "queued": self._tasks.qsize(),
            }

    def close(self) -> None:
        self._closed = True
        with self._lock:
            for slot in self._pending.values():
                slot["payload"] = {"ok": False, "error": "bridge closed"}
                slot["event"].set()
            self._pending.clear()
