# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

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
HIT_KEY = "cache_hit_price_per_million"
MISS_KEY = "cache_miss_price_per_million"
OUTPUT_KEY = "output_price_per_million"
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

    Input tokens are split into cache-hit and cache-miss buckets when the
    provider returns cache details.  Only token counts are stored; cost is
    calculated with the current pricing settings so changing prices updates
    the displayed cost and the remaining budget immediately.
    """

    def __init__(self, path: Path, settings: Any) -> None:
        self.path = path
        self.settings = settings
        self._lock = threading.RLock()
        self._data = self._load()
        self.call_store: Any = None

    # -- persistence -------------------------------------------------------
    def _empty(self) -> dict[str, Any]:
        return {
            "version": USAGE_VERSION,
            "totals": self._blank(),
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
    def _price(self, key: str, default: float = 0.0) -> float:
        try:
            return max(0.0, float(self.settings.core_get(PRICE_SECTION, key, default) or 0))
        except (TypeError, ValueError):
            return 0.0

    def price_per_million(self) -> float:
        """Legacy uniform price; used as a fallback for the three prices."""
        return self._price(PRICE_KEY)

    def prices(self) -> dict[str, float]:
        legacy = self.price_per_million()
        hit = self._price(HIT_KEY, legacy) or legacy
        miss = self._price(MISS_KEY, legacy) or legacy
        output = self._price(OUTPUT_KEY, miss) or miss or legacy
        return {
            "legacy": legacy,
            "cache_hit": hit,
            "cache_miss": miss,
            "output": output,
        }

    def monthly_limit(self) -> float:
        return self._price(LIMIT_KEY)

    def cost(self, hit_tokens: int, miss_tokens: int, output_tokens: int) -> float:
        prices = self.prices()
        return (
            max(0, hit_tokens) * prices["cache_hit"]
            + max(0, miss_tokens) * prices["cache_miss"]
            + max(0, output_tokens) * prices["output"]
        ) / 1_000_000

    # -- recording ---------------------------------------------------------
    @staticmethod
    def _cache_split(usage: dict[str, Any], prompt: int, completion: int, total: int) -> tuple[int, int]:
        details = usage.get("prompt_tokens_details")
        details = details if isinstance(details, dict) else {}
        hit = _as_int(
            details.get("cached_tokens")
            or usage.get("prompt_cache_hit_tokens")
            or usage.get("cache_read_input_tokens")
        )
        miss = _as_int(
            usage.get("prompt_cache_miss_tokens")
            or usage.get("cache_creation_input_tokens")
        )
        if hit > prompt:
            hit = prompt
        if miss <= 0:
            miss = max(0, prompt - hit)
        elif hit + miss < prompt:
            miss = max(0, prompt - hit)
        # Providers that return only total_tokens (or an extra unclassified
        # amount) still need to be billable.
        accounted = hit + miss + completion
        if total > accounted:
            miss += total - accounted
        return hit, miss

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
        hit, miss = self._cache_split(usage, prompt, completion, total)
        now = time.time()
        month = _month_key(now)
        with self._lock:
            self._add(self._data["totals"], prompt, completion, total, hit, miss, 1)
            self._add(
                self._data["months"].setdefault(month, self._blank()),
                prompt, completion, total, hit, miss, 1,
            )
            model_key = model or "unknown"
            self._add(
                self._data["models"].setdefault(model_key, self._blank()),
                prompt, completion, total, hit, miss, 1,
            )
            self._data["recent"].append(
                {
                    "ts": now,
                    "month": month,
                    "model": model_key,
                    "source": source,
                    "prompt": prompt,
                    "completion": completion,
                    "cache_hit": hit,
                    "cache_miss": miss,
                    "total": total,
                }
            )
            self._data["recent"] = self._data["recent"][-50:]
            self._save()

    @staticmethod
    def _blank() -> dict[str, int]:
        return {
            "prompt": 0,
            "completion": 0,
            "cache_hit": 0,
            "cache_miss": 0,
            "total": 0,
            "calls": 0,
        }

    @staticmethod
    def _add(
        bucket: dict[str, Any],
        prompt: int,
        completion: int,
        total: int,
        hit: int,
        miss: int,
        calls: int,
    ) -> None:
        bucket["prompt"] = _as_int(bucket.get("prompt")) + prompt
        bucket["completion"] = _as_int(bucket.get("completion")) + completion
        bucket["cache_hit"] = _as_int(bucket.get("cache_hit")) + hit
        bucket["cache_miss"] = _as_int(bucket.get("cache_miss")) + miss
        bucket["total"] = _as_int(bucket.get("total")) + total
        bucket["calls"] = _as_int(bucket.get("calls")) + calls

    @staticmethod
    def _bucket(value: dict[str, Any]) -> dict[str, int]:
        prompt = _as_int(value.get("prompt"))
        completion = _as_int(value.get("completion"))
        hit = _as_int(value.get("cache_hit"))
        miss = _as_int(value.get("cache_miss"))
        total = _as_int(value.get("total"))
        if hit > prompt:
            hit = prompt
        if miss <= 0 and prompt > 0:
            miss = max(0, prompt - hit)
        accounted = hit + miss + completion
        if total > accounted:
            miss += total - accounted
        elif total > 0 and accounted == 0:
            miss = total
        return {
            "prompt": prompt,
            "completion": completion,
            "cache_hit": hit,
            "cache_miss": miss,
            "total": total or accounted,
            "calls": _as_int(value.get("calls")),
        }

    # -- limit -------------------------------------------------------------
    def month_usage(self, month: str | None = None) -> dict[str, int]:
        with self._lock:
            value = self._data["months"].get(month or _month_key(), {})
            return self._bucket(value)

    def ensure_allowed(self) -> None:
        """Raise before a call when the current month's budget is exhausted."""
        limit = self.monthly_limit()
        if limit <= 0 or not any(self.prices().values()):
            return
        month = self.month_usage()
        spent = self.cost(month["cache_hit"], month["cache_miss"], month["completion"])
        if spent >= limit:
            raise ProviderError(
                f"本月模型消费已达限额：{spent:.4f} / {limit:.2f} 元。"
                "请到设置 → Token 消耗中提高限额或等待下月。",
                provider="usage",
            )

    # -- summary -----------------------------------------------------------
    def summary(self) -> dict[str, Any]:
        prices = self.prices()
        limit = self.monthly_limit()
        with self._lock:
            totals = self._bucket(self._data["totals"])
            months = dict(self._data["months"])
            models = dict(self._data["models"])
            recent = list(self._data["recent"][-10:])
        month = _month_key()
        month_data = self._bucket(months.get(month, {}))
        month_hit = month_data["cache_hit"]
        month_miss = month_data["cache_miss"]
        month_output = month_data["completion"]
        month_cost = self.cost(month_hit, month_miss, month_output)
        total_cost = self.cost(
            totals["cache_hit"], totals["cache_miss"], totals["completion"]
        )
        remaining = max(0.0, limit - month_cost) if limit > 0 else None
        by_model = []
        for model, value in models.items():
            bucket = self._bucket(value)
            by_model.append(
                {
                    "model": model,
                    "tokens": bucket["total"],
                    "cache_hit": bucket["cache_hit"],
                    "cache_miss": bucket["cache_miss"],
                    "completion": bucket["completion"],
                    "calls": bucket["calls"],
                    "cost": self.cost(
                        bucket["cache_hit"], bucket["cache_miss"], bucket["completion"]
                    ),
                }
            )
        by_model.sort(key=lambda item: item["tokens"], reverse=True)
        return {
            "price_per_million": prices["legacy"],
            "cache_hit_price_per_million": prices["cache_hit"],
            "cache_miss_price_per_million": prices["cache_miss"],
            "output_price_per_million": prices["output"],
            "monthly_limit": limit,
            "currency": "CNY",
            "total_tokens": totals["total"],
            "total_prompt_tokens": totals["prompt"],
            "total_completion_tokens": totals["completion"],
            "total_cache_hit_tokens": totals["cache_hit"],
            "total_cache_miss_tokens": totals["cache_miss"],
            "total_cost": total_cost,
            "total_calls": totals["calls"],
            "month": month,
            "month_tokens": month_data["total"],
            "month_prompt_tokens": month_data["prompt"],
            "month_completion_tokens": month_output,
            "month_cache_hit_tokens": month_hit,
            "month_cache_miss_tokens": month_miss,
            "month_cost": month_cost,
            "month_calls": month_data["calls"],
            "remaining": remaining,
            "limit_reached": bool(limit > 0 and any(prices.values()) and month_cost >= limit),
            "by_model": by_model[:8],
            "recent": recent,
        }

    def attach_call_store(self, store: Any) -> None:
        self.call_store = store

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
        started = time.perf_counter()
        call_store = getattr(self._usage, "call_store", None)
        try:
            self._usage.ensure_allowed()
            result = self._provider.chat(messages, **kwargs)
            raw = getattr(result, "raw", {}) or {}
            model = str(raw.get("model", "") or "") if isinstance(raw, dict) else ""
            self._usage.record(
                getattr(result, "usage", {}) or {},
                model=model,
                source=self._consumer,
            )
            if call_store is not None:
                call_store.record(
                    source=self._consumer,
                    model=model,
                    messages=messages,
                    kwargs=kwargs,
                    response=result,
                    latency_ms=(time.perf_counter() - started) * 1000,
                )
            return result
        except Exception as exc:
            if call_store is not None:
                call_store.record(
                    source=self._consumer,
                    model="",
                    messages=messages,
                    kwargs=kwargs,
                    error=str(exc),
                    latency_ms=(time.perf_counter() - started) * 1000,
                    ok=False,
                )
            raise

    def __getattr__(self, name: str) -> Any:
        return getattr(self._provider, name)

    def close(self) -> None:
        close = getattr(self._provider, "close", None)
        if callable(close):
            close()
