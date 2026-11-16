"""Logging helpers shared by the framework and packages."""

from __future__ import annotations

import logging
import re
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

_SECRET_KEYS = {
    "api_key",
    "apikey",
    "password",
    "token",
    "authorization",
    "cookie",
    "secret",
    "access_key",
}
_SECRET_RE = re.compile(
    r"(?i)(api[_-]?key|password|token|authorization|cookie|secret)\s*[:=]\s*['\"]?([^'\"\s,}]+)"
)


def redact(value: Any, *, _depth: int = 0) -> Any:
    """Recursively mask secret-looking keys.  Never raises."""
    if _depth > 6:
        return "<max-depth>"
    if isinstance(value, dict):
        result: dict[Any, Any] = {}
        for key, item in value.items():
            if isinstance(key, str) and key.lower() in _SECRET_KEYS:
                result[key] = "***" if item else ""
            else:
                result[key] = redact(item, _depth=_depth + 1)
        return result
    if isinstance(value, (list, tuple)):
        return [redact(item, _depth=_depth + 1) for item in value]
    if isinstance(value, str):
        return _SECRET_RE.sub(lambda m: f"{m.group(1)}=***", value)
    return value


class _RedactFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = _SECRET_RE.sub(lambda m: f"{m.group(1)}=***", record.msg)
        if record.args:
            record.args = tuple(redact(arg) for arg in record.args)
        return True


def setup_logging(log_file: Path, level: str = "info") -> logging.Logger:
    log_file.parent.mkdir(parents=True, exist_ok=True)
    root = logging.getLogger()
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
    root.handlers.clear()

    formatter = logging.Formatter(
        "%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    file_handler = RotatingFileHandler(
        log_file, maxBytes=2_000_000, backupCount=5, encoding="utf-8"
    )
    file_handler.setFormatter(formatter)
    file_handler.addFilter(_RedactFilter())

    console = logging.StreamHandler()
    console.setFormatter(formatter)
    console.addFilter(_RedactFilter())

    root.addHandler(file_handler)
    root.addHandler(console)
    return logging.getLogger("freeocs")
