# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

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


def test_default_model_download_directory_is_in_project(tmp_path: Path) -> None:
    paths = build_paths(repo=tmp_path)

    assert paths.default_model_download_dir == tmp_path / "models"


def test_non_portable_paths_have_expected_names() -> None:
    paths = build_paths(portable=False)
    assert paths.settings_file.name == "settings.json"
    assert paths.log_file.name == "freeocs.log"
    assert paths.packages_src_dir.name == "src"


def test_extension_dir_is_not_hidden() -> None:
    paths = build_paths(portable=False)
    assert paths.extension_dir.name == "extensions"
    assert paths.extension_dir.parent.name == "FreeOCS"
    assert not paths.extension_dir.name.startswith(".")
