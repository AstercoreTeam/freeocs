from __future__ import annotations

from pathlib import Path

from freeocs.paths import build_paths


def test_portable_paths(tmp_path: Path) -> None:
    paths = build_paths(portable=True, repo=tmp_path).ensure()
    assert paths.config_dir == tmp_path / "data" / "config"
    assert paths.data_dir == tmp_path / "data"
    assert paths.settings_file.parent.is_dir()
    assert paths.packages_dir.is_dir()
    assert paths.web_dir == tmp_path / "web"


def test_non_portable_paths_have_expected_names() -> None:
    paths = build_paths(portable=False)
    assert paths.settings_file.name == "settings.json"
    assert paths.log_file.name == "freeocs.log"
    assert paths.packages_src_dir.name == "src"
