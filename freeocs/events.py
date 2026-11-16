# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

"""Thread-safe event stream consumed by the pywebview UI."""

from __future__ import annotations

import threading
from collections import deque
from datetime import datetime
from typing import Any

from .logging_setup import redact


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


class EventBus:
    def __init__(self, maxlen: int = 2000) -> None:
        self._lock = threading.Lock()
        self._events: deque[dict[str, Any]] = deque(maxlen=maxlen)
        self._seq = 0

    def emit(
        self,
        package: str = "",
        event_type: str = "log",
        level: str = "info",
        message: str = "",
        data: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            self._seq += 1
            event = {
                "seq": self._seq,
                "ts": _now(),
                "package": package,
                "type": event_type,
                "level": level,
                "message": message,
                "data": redact(data) if data else {},
            }
            self._events.append(event)
            return dict(event)

    def since(self, after_seq: int = 0, limit: int = 200) -> dict[str, Any]:
        with self._lock:
            events = [dict(item) for item in self._events if item["seq"] > after_seq]
            last_seq = self._seq
        if limit > 0:
            events = events[-limit:]
        return {"events": events, "last_seq": last_seq}

    def clear(self) -> None:
        with self._lock:
            self._events.clear()

    @property
    def last_seq(self) -> int:
        with self._lock:
            return self._seq
