# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import os
from pathlib import Path

import pytest

from freeocs.config import SettingsStore
from freeocs.sdk import SettingsError


def test_defaults_and_sections(tmp_path: Path) -> None:
    store = SettingsStore(tmp_path / "settings.json")
    assert store.core_get("llm", "model") == "deepseek-chat"
    assert store.section_values("llm")["provider_mode"] == "cloud"
    ids = [section["id"] for section in store.schema()]
    assert ids[:5] == ["legal", "ui", "llm", "usage", "bridge"]
    assert "android" in ids
    assert store.core_get("usage", "price_per_million") == 0.0
    assert store.core_get("usage", "cache_hit_price_per_million") == 0.0
    assert store.core_get("usage", "cache_miss_price_per_million") == 0.0
    assert store.core_get("usage", "output_price_per_million") == 0.0
    assert store.core_get("usage", "monthly_limit") == 0.0


def test_save_and_mask_secret(tmp_path: Path) -> None:
    store = SettingsStore(tmp_path / "settings.json")
    store.save_section("llm", {"api_key": "sk-test", "model": "demo"})
    assert store.core_get("llm", "api_key") == "sk-test"
    public = store.section_values("llm", mask=True)
    assert public["api_key"] == ""
    assert public["__has_value"]["api_key"] is True
    assert public["model"] == "demo"


def test_empty_password_preserves_and_null_clears(tmp_path: Path) -> None:
    store = SettingsStore(tmp_path / "settings.json")
    store.save_section("llm", {"api_key": "sk-test"})
    store.save_section("llm", {"api_key": ""})
    assert store.core_get("llm", "api_key") == "sk-test"
    store.save_section("llm", {"api_key": None})
    assert store.core_get("llm", "api_key") == ""


def test_ollama_configuration_does_not_require_api_key(tmp_path: Path) -> None:
    store = SettingsStore(tmp_path / "settings.json")
    store.save_section(
        "llm",
        {
            "provider_mode": "ollama",
            "base_url": "http://localhost:11434/v1",
            "model": "qwen2.5vl:7b",
        },
    )

    summary = store.summary()["llm"]
    assert summary["configured"] is True
    assert summary["provider_mode"] == "ollama"

    store.save_section("llm", {"provider_mode": "cloud"})
    assert store.summary()["llm"]["configured"] is False


def test_validation(tmp_path: Path) -> None:
    store = SettingsStore(tmp_path / "settings.json")
    with pytest.raises(SettingsError):
        store.save_section("llm", {"temperature": 99})
    with pytest.raises(SettingsError):
        store.save_section("llm", {"base_url": ""})


def test_package_section(tmp_path: Path) -> None:
    store = SettingsStore(tmp_path / "settings.json")
    store.register_package_section(
        "demo",
        "module",
        {
            "id": "demo",
            "title": "演示",
            "fields": [{"key": "message", "type": "text", "label": "消息", "default": "hello"}],
        },
    )
    assert store.package_values("demo")["message"] == "hello"
    store.save_section("demo", {"message": "world"})
    assert store.package_values("demo")["message"] == "world"


def test_file_permissions(tmp_path: Path) -> None:
    path = tmp_path / "settings.json"
    store = SettingsStore(path)
    store.save()
    assert path.is_file()
    if os.name == "posix":
        import stat

        assert stat.S_IMODE(path.stat().st_mode) == 0o600
