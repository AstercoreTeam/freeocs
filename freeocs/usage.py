"""Token usage accounting and spending limits for LLM calls."""

from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from .sdk import ProviderError

USAGE_VERSION = 1
PRICE_SECTION = "usage"
PRICE_KEY = "price_per_million"
LIMIT_KEY = "monthly_limit"


def _as_int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _month_key(ts: float | None = None) -> str:
    return datetime.fromtimestamp(ts or time.time()).strftime("%Y-%m")


class UsageStore:
    """Persist token totals and enforce a monthly spend limit.

    Only token counts are stored; cost is calculated with the current
    ``usage.price_per_million`` setting.  This means changing the unit price
    immediately updates displayed cost and the remaining budget.
    """

    def __init__(self, path: Path, settings: Any) -> None:
        self.path = path
        self.settings = settings
        self._lock = threading.RLock()
        self._data = self._load()

    # -- persistence -------------------------------------------------------
    def _empty(self) -> dict[str, Any]:
        return {
            "version": USAGE_VERSION,
            "totals": {"prompt": 0, "completion": 0, "total": 0, "calls": 0},
            "months": {},
            "models": {},
            "recent": [],
        }

    def _load(self) -> dict[str, Any]:
        data = self._empty()
        if not self.path.is_file():
            return data
        try:
            loaded = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return data
        if not isinstance(loaded, dict):
            return data
        for key in ("totals", "months", "models"):
            value = loaded.get(key)
            if isinstance(value, dict):
                data[key] = value
        recent = loaded.get("recent")
        if isinstance(recent, list):
            data["recent"] = recent[-50:]
        return data

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(self._data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, self.path)

    # -- pricing -----------------------------------------------------------
    def price_per_million(self) -> float:
        try:
            return max(0.0, float(self.settings.core_get(PRICE_SECTION, PRICE_KEY, 0) or 0))
        except (TypeError, ValueError):
            return 0.0

    def monthly_limit(self) -> float:
        try:
            return max(0.0, float(self.settings.core_get(PRICE_SECTION, LIMIT_KEY, 0) or 0))
        except (TypeError, ValueError):
            return 0.0

    def cost(self, tokens: int) -> float:
        return max(0, tokens) / 1_000_000 * self.price_per_million()

    # -- recording ---------------------------------------------------------
    def record(
        self,
        usage: dict[str, Any],
        *,
        model: str = "",
        source: str = "",
    ) -> None:
        if not isinstance(usage, dict):
            return
        prompt = _as_int(usage.get("prompt_tokens") or usage.get("input_tokens"))
        completion = _as_int(usage.get("completion_tokens") or usage.get("output_tokens"))
        total = _as_int(usage.get("total_tokens")) or prompt + completion
        if total <= 0:
            return
        now = time.time()
        month = _month_key(now)
        with self._lock:
            self._add(self._data["totals"], prompt, completion, total, 1)
            self._add(self._data["months"].setdefault(month, self._blank()), prompt, completion, total, 1)
            model_key = model or "unknown"
            self._add(self._data["models"].setdefault(model_key, self._blank()), prompt, completion, total, 1)
            self._data["recent"].append(
                {
                    "ts": now,
                    "month": month,
                    "model": model_key,
                    "source": source,
                    "prompt": prompt,
                    "completion": completion,
                    "total": total,
                }
            )
            self._data["recent"] = self._data["recent"][-50:]
            self._save()

    @staticmethod
    def _blank() -> dict[str, int]:
        return {"prompt": 0, "completion": 0, "total": 0, "calls": 0}

    @staticmethod
    def _add(bucket: dict[str, Any], prompt: int, completion: int, total: int, calls: int) -> None:
        bucket["prompt"] = _as_int(bucket.get("prompt")) + prompt
        bucket["completion"] = _as_int(bucket.get("completion")) + completion
        bucket["total"] = _as_int(bucket.get("total")) + total
        bucket["calls"] = _as_int(bucket.get("calls")) + calls

    # -- limit -------------------------------------------------------------
    def month_usage(self, month: str | None = None) -> dict[str, int]:
        with self._lock:
            value = self._data["months"].get(month or _month_key(), {})
            return {
                "prompt": _as_int(value.get("prompt")),
                "completion": _as_int(value.get("completion")),
                "total": _as_int(value.get("total")),
                "calls": _as_int(value.get("calls")),
            }

    def ensure_allowed(self) -> None:
        """Raise before a call when the current month's budget is exhausted."""
        limit = self.monthly_limit()
        price = self.price_per_million()
        if limit <= 0 or price <= 0:
            return
        spent = self.cost(self.month_usage()["total"])
        if spent >= limit:
            raise ProviderError(
                f"本月模型消费已达限额：{spent:.4f} / {limit:.2f} 元。"
                "请到设置 → Token 消耗中提高限额或等待下月。",
                provider="usage",
            )

    # -- summary -----------------------------------------------------------
    def summary(self) -> dict[str, Any]:
        price = self.price_per_million()
        limit = self.monthly_limit()
        with self._lock:
            totals = dict(self._data["totals"])
            months = dict(self._data["months"])
            models = dict(self._data["models"])
            recent = list(self._data["recent"][-10:])
        month = _month_key()
        month_data = {
            "prompt": _as_int(months.get(month, {}).get("prompt")),
            "completion": _as_int(months.get(month, {}).get("completion")),
            "total": _as_int(months.get(month, {}).get("total")),
            "calls": _as_int(months.get(month, {}).get("calls")),
        }
        total_tokens = _as_int(totals.get("total"))
        month_tokens = month_data["total"]
        month_cost = self.cost(month_tokens)
        total_cost = self.cost(total_tokens)
        remaining = max(0.0, limit - month_cost) if limit > 0 else None
        by_model = []
        for model, value in models.items():
            tokens = _as_int(value.get("total"))
            by_model.append(
                {
                    "model": model,
                    "tokens": tokens,
                    "calls": _as_int(value.get("calls")),
                    "cost": self.cost(tokens),
                }
            )
        by_model.sort(key=lambda item: item["tokens"], reverse=True)
        return {
            "price_per_million": price,
            "monthly_limit": limit,
            "currency": "CNY",
            "total_tokens": total_tokens,
            "total_prompt_tokens": _as_int(totals.get("prompt")),
            "total_completion_tokens": _as_int(totals.get("completion")),
            "total_cost": total_cost,
            "total_calls": _as_int(totals.get("calls")),
            "month": month,
            "month_tokens": month_tokens,
            "month_prompt_tokens": month_data["prompt"],
            "month_completion_tokens": month_data["completion"],
            "month_cost": month_cost,
            "month_calls": month_data["calls"],
            "remaining": remaining,
            "limit_reached": bool(limit > 0 and price > 0 and month_cost >= limit),
            "by_model": by_model[:8],
            "recent": recent,
        }

    def wrap(self, provider: Any, *, consumer: str = "") -> Any:
        if isinstance(provider, MeteredLLM):
            return provider
        return MeteredLLM(provider, self, consumer=consumer)


class MeteredLLM:
    """Proxy around the bound ``llm.chat`` provider."""

    def __init__(self, provider: Any, usage: UsageStore, *, consumer: str = "") -> None:
        self._provider = provider
        self._usage = usage
        self._consumer = consumer

    def chat(self, messages: Any, **kwargs: Any) -> Any:
        self._usage.ensure_allowed()
        result = self._provider.chat(messages, **kwargs)
        raw = getattr(result, "raw", {}) or {}
        model = str(raw.get("model", "") or "") if isinstance(raw, dict) else ""
        self._usage.record(
            getattr(result, "usage", {}) or {},
            model=model,
            source=self._consumer,
        )
        return result

    def __getattr__(self, name: str) -> Any:
        return getattr(self._provider, name)

    def close(self) -> None:
        close = getattr(self._provider, "close", None)
        if callable(close):
            close()
