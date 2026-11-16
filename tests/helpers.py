# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def make_paths(tmp_path: Path, *, repo: Path | None = None):
    from freeocs.paths import AppPaths

    root = repo or ROOT
    return AppPaths(
        repo=root,
        config_dir=tmp_path / "config",
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        log_dir=tmp_path / "logs",
        packages_dir=tmp_path / "data" / "packages",
        builtin_cache_dir=tmp_path / "data" / "builtin",
        package_data_dir=tmp_path / "data" / "package-data",
        models_dir=tmp_path / "data" / "models",
        audio_dir=tmp_path / "data" / "audio",
        extension_dir=tmp_path / "data" / "extension",
        web_dir=root / "web",
        packages_src_dir=root / "packages" / "src",
        packages_dist_dir=root / "packages" / "dist",
        extension_dist_dir=root / "extension" / "dist",
        portable=True,
    ).ensure()


def copy_package(source: Path, target_src: Path) -> Path:
    target = target_src / source.name
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target)
    return target


def zip_package(source: Path, destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(source.rglob("*")):
            if path.is_dir():
                continue
            if "__pycache__" in path.parts:
                continue
            archive.write(path, path.relative_to(source).as_posix())
    return destination
