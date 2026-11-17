# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

"""Local JSONL audit trail for every LLM call."""

from __future__ import annotations

import json
import os
import re
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

_SECRET = re.compile(r"\bsk-[A-Za-z0-9_-]{8,}\b")
_MAX_TEXT = 200_000


def _clean(value: Any, limit: int = _MAX_TEXT) -> Any:
    if isinstance(value, str):
        value = _SECRET.sub("sk-***", value)
        if len(value) > limit:
            return value[:limit] + "\n…（已截断）"
        return value
    if isinstance(value, list):
        return [_clean(item, limit) for item in value]
    if isinstance(value, dict):
        return {str(key): _clean(item, limit) for key, item in value.items()}
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return str(value)


class AICallStore:
    def __init__(self, root: Path, settings: Any) -> None:
        self.root = root
        self.settings = settings
        self._lock = threading.Lock()
        self.root.mkdir(parents=True, exist_ok=True)

    def enabled(self) -> bool:
        try:
            return bool(self.settings.core_get("usage", "save_ai_calls", True))
        except Exception:
            return True

    def record(
        self,
        *,
        source: str,
        model: str,
        messages: Any,
        kwargs: dict[str, Any],
        response: Any = None,
        error: str = "",
        latency_ms: float = 0.0,
        ok: bool = True,
    ) -> None:
        if not self.enabled():
            return
        message = getattr(response, "message", {}) if response is not None else {}
        usage = getattr(response, "usage", {}) if response is not None else {}
        raw = getattr(response, "raw", {}) if response is not None else {}
        payload = {
            "ts": datetime.now().astimezone().isoformat(timespec="milliseconds"),
            "ok": bool(ok),
            "source": source or "unknown",
            "model": model or "",
            "latency_ms": round(float(latency_ms or 0), 1),
            "request": {"messages": _clean(messages), "options": _clean(kwargs)},
            "response": {
                "message": _clean(message),
                "finish_reason": getattr(response, "finish_reason", "") if response is not None else "",
                "usage": _clean(usage),
                "raw": _clean(raw),
            },
            "error": _clean(error),
        }
        # One JSON object per line, grouped by local day; easy to tail/analyze.
        path = self.root / f"{datetime.now().strftime('%Y-%m-%d')}.jsonl"
        try:
            line = json.dumps(payload, ensure_ascii=False, default=str)
            with self._lock:
                with path.open("a", encoding="utf-8") as handle:
                    handle.write(line + "\n")
                try:
                    os.chmod(path, 0o600)
                except OSError:
                    pass
        except (OSError, TypeError, ValueError):
            # Logging must never break the user's request.
            return

    def list(self, limit: int = 200) -> list[dict[str, Any]]:
        files = sorted(self.root.glob("*.jsonl"), reverse=True)
        records: list[dict[str, Any]] = []
        for path in files:
            try:
                lines = path.read_text(encoding="utf-8").splitlines()
            except OSError:
                continue
            for line in reversed(lines):
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(item, dict):
                    records.append(item)
                if len(records) >= max(1, min(int(limit or 200), 2000)):
                    return records
        return records

    def stats(self, limit: int = 500) -> dict[str, Any]:
        records = self.list(limit)
        calls = len(records)
        errors = sum(1 for item in records if not item.get("ok"))
        latency = [float(item.get("latency_ms") or 0) for item in records if item.get("latency_ms")]
        return {
            "calls": calls,
            "errors": errors,
            "avg_latency_ms": round(sum(latency) / len(latency), 1) if latency else 0,
            "folder": str(self.root),
        }

    def path_for_today(self) -> Path:
        return self.root / f"{datetime.now().strftime('%Y-%m-%d')}.jsonl"
