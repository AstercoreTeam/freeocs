from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from freeocs.capabilities import CapabilityRegistry
from freeocs.config import SettingsStore
from freeocs.events import EventBus
from freeocs.modules import ModuleHost
from freeocs.packages import PackageError, PackageManager, validate_archive

from .helpers import ROOT, copy_package, make_paths, zip_package

FIXTURE = ROOT / "tests" / "fixtures" / "demo_module"


def build_manager(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FREEOCS_PACKAGES", "source")
    paths = make_paths(tmp_path)
    settings = SettingsStore(paths.settings_file)
    events = EventBus()
    registry = CapabilityRegistry()
    manager = PackageManager(paths, settings, events, registry)
    return paths, settings, events, registry, manager


def test_load_builtin_packages(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _paths, _settings, _events, registry, manager = build_manager(tmp_path, monkeypatch)
    manager.load_all()
    ids = {package.id for package in manager.packages.values()}
    assert {"llm_openai", "answer_basic", "tts_system", "tts_openai", "asr_whisper", "asr_openai", "ocr_rapid"} <= ids
    assert "llm.chat" in registry.capabilities()
    assert "media.tts" in registry.capabilities()
    assert manager.get_package("llm_openai").status == "ready"


def test_install_zip_and_module(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    paths, settings, events, registry, manager = build_manager(tmp_path, monkeypatch)
    manager.load_all()
    archive = zip_package(FIXTURE, tmp_path / "demo_module-0.1.0.focpkg")
    result = manager.install_zip(archive)
    assert result["ok"] is True
    assert result["package"]["id"] == "demo_module"

    # A fresh manager reads the installed registry and loads the external module.
    manager2 = PackageManager(paths, settings, events, registry)
    manager2.load_all()
    package = manager2.get_package("demo_module")
    assert package is not None
    assert package.source == "installed"
    assert package.status == "ready"
    host = ModuleHost(manager2, events, manager2.asset_url)
    host.load()
    assert host.get("demo_module") is not None
    assert host.start("demo_module")["ok"] is True
    state = host.state("demo_module")
    assert state["running"] is True
    host.stop("demo_module")
    state = host.state("demo_module")
    assert state["running"] is False
    host.close()
    manager2.close()


def test_zip_traversal_rejected(tmp_path: Path) -> None:
    archive = tmp_path / "bad.focpkg"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("../evil.txt", "oops")
        zf.writestr("manifest.json", "{}")
    with pytest.raises(PackageError):
        validate_archive(archive)


def test_manifest_invalid_entry(tmp_path: Path) -> None:
    source = copy_package(FIXTURE, tmp_path / "src")
    manifest = source / "manifest.json"
    manifest.write_text(manifest.read_text(encoding="utf-8").replace("main:setup", "../escape:setup"),
                        encoding="utf-8")
    archive = zip_package(source, tmp_path / "bad-entry.focpkg")
    with pytest.raises(PackageError):
        validate_archive(archive)


def test_validate_archive_ok(tmp_path: Path) -> None:
    archive = zip_package(FIXTURE, tmp_path / "demo.focpkg")
    info = validate_archive(archive)
    assert info.manifest.id == "demo_module"
    assert info.sha256
    assert info.size > 0
