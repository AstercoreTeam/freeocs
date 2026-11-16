from __future__ import annotations

from pathlib import Path

import pytest

from freeocs.config import SettingsStore
from freeocs.sdk import SettingsError


def test_defaults_and_sections(tmp_path: Path) -> None:
    store = SettingsStore(tmp_path / "settings.json")
    assert store.core_get("llm", "model") == "deepseek-chat"
    ids = [section["id"] for section in store.schema()]
    assert ids[:4] == ["ui", "llm", "usage", "bridge"]
    assert "android" in ids
    assert store.core_get("usage", "price_per_million") == 0.0
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
            "fields": [
                {"key": "message", "type": "text", "label": "消息", "default": "hello"}
            ],
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
    if hasattr(path, "stat"):
        import stat

        assert stat.S_IMODE(path.stat().st_mode) == 0o600
