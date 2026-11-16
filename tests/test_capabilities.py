from __future__ import annotations

import pytest

from freeocs.capabilities import CapabilityRegistry
from freeocs.sdk import CapabilityMissing


class FakeProvider:
    def __init__(self, name: str) -> None:
        self.name = name

    def chat(self, *args, **kwargs):
        return self.name


def test_binding_and_fallback() -> None:
    registry = CapabilityRegistry()
    registry.register_provider("p1", "llm.chat", FakeProvider("one"), title="P1")
    registry.register_provider("p2", "llm.chat", FakeProvider("two"), title="P2")
    assert registry.active_record("llm.chat").package_id == "p1"
    registry.set_binding("llm.chat", "p2")
    assert registry.require("llm.chat").name == "two"
    registry.unregister_package("p2")
    assert registry.require("llm.chat").name == "one"


def test_missing_and_status() -> None:
    registry = CapabilityRegistry()
    status = registry.requirement_status(["llm.chat", "media.tts"])
    assert status.missing == ["llm.chat", "media.tts"]
    with pytest.raises(CapabilityMissing):
        registry.require("llm.chat", consumer="demo")
    registry.register_provider("p", "llm.chat", FakeProvider("one"))
    status = registry.requirement_status(["llm.chat", "media.tts"])
    assert status.provided == ["llm.chat"]
    assert status.missing == ["media.tts"]


def test_core_provider_preferred() -> None:
    registry = CapabilityRegistry()
    registry.register_provider("plugin", "media.tts", FakeProvider("plugin"))
    registry.register_core("media.tts", FakeProvider("core"), title="Core")
    assert registry.require("media.tts").name == "core"


def test_provider_metadata() -> None:
    registry = CapabilityRegistry()
    registry.register_provider("p1", "media.tts", FakeProvider("one"), title="One")
    registry.register_provider("p2", "media.tts", FakeProvider("two"), title="Two")
    items = registry.providers("media.tts")
    assert [item["package_id"] for item in items] == ["p1", "p2"]
    assert any(item["active"] for item in items)
