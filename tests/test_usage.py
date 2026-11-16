from __future__ import annotations

import pytest

from freeocs.capabilities import CapabilityRegistry
from freeocs.config import SettingsStore
from freeocs.sdk import ChatResult, ProviderError
from freeocs.usage import MeteredLLM, UsageStore


class FakeLLM:
    def __init__(self) -> None:
        self.calls = 0

    def chat(self, messages, **kwargs):
        self.calls += 1
        return ChatResult(
            message={"role": "assistant", "content": "ok"},
            usage={"prompt_tokens": 600_000, "completion_tokens": 400_000, "total_tokens": 1_000_000},
            raw={"model": "fake-model"},
        )


def make_usage(tmp_path, price=2.0, limit=0.0) -> UsageStore:
    settings = SettingsStore(tmp_path / "settings.json")
    settings.save_section("usage", {"price_per_million": price, "monthly_limit": limit})
    return UsageStore(tmp_path / "usage.json", settings)


def test_usage_records_cost_and_persists(tmp_path) -> None:
    usage = make_usage(tmp_path, price=2.0, limit=10.0)
    usage.record({"prompt_tokens": 600_000, "completion_tokens": 400_000, "total_tokens": 1_000_000}, model="m", source="test")
    summary = usage.summary()
    assert summary["month_tokens"] == 1_000_000
    assert summary["month_cost"] == pytest.approx(2.0)
    assert summary["remaining"] == pytest.approx(8.0)
    assert summary["total_calls"] == 1

    reloaded = UsageStore(tmp_path / "usage.json", usage.settings)
    assert reloaded.summary()["total_tokens"] == 1_000_000


def test_limit_blocks_next_call(tmp_path) -> None:
    usage = make_usage(tmp_path, price=2.0, limit=2.0)
    usage.record({"total_tokens": 1_000_000}, model="m")
    with pytest.raises(ProviderError):
        usage.ensure_allowed()


def test_registry_wraps_llm_chat(tmp_path) -> None:
    usage = make_usage(tmp_path, price=1.0, limit=0)
    registry = CapabilityRegistry()
    registry.set_usage(usage)
    registry.register_provider("fake", "llm.chat", FakeLLM())
    metered = registry.require("llm.chat", consumer="ucampus")
    assert isinstance(metered, MeteredLLM)
    metered.chat([{"role": "user", "content": "hi"}])
    assert usage.summary()["total_tokens"] == 1_000_000
    assert usage.summary()["total_calls"] == 1


def test_metered_llm_records_usage(tmp_path) -> None:
    usage = make_usage(tmp_path, price=1.0, limit=0)
    provider = FakeLLM()
    metered = MeteredLLM(provider, usage, consumer="ucampus")
    metered.chat([{"role": "user", "content": "hi"}])
    assert provider.calls == 1
    summary = usage.summary()
    assert summary["total_tokens"] == 1_000_000
    assert summary["month_cost"] == pytest.approx(1.0)
    assert summary["by_model"][0]["model"] == "fake-model"
