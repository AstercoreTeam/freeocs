# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

"""Platform-specific application paths.

All mutable state lives outside the source tree by default.  ``--portable``
switches the data root to ``<repo>/data`` so the app can run from a USB stick.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

from . import APP_NAME


def repo_root() -> Path:
    """Return the source checkout root (parent of the ``freeocs`` package)."""
    return Path(__file__).resolve().parent.parent


def _xdg(env: str, fallback: str) -> Path:
    value = os.environ.get(env, "").strip()
    return Path(value) if value else Path.home() / fallback


@dataclass(slots=True)
class AppPaths:
    repo: Path
    config_dir: Path
    data_dir: Path
    cache_dir: Path
    log_dir: Path
    packages_dir: Path
    builtin_cache_dir: Path
    package_data_dir: Path
    models_dir: Path
    audio_dir: Path
    extension_dir: Path
    web_dir: Path
    packages_src_dir: Path
    packages_dist_dir: Path
    extension_dist_dir: Path
    portable: bool = False

    @property
    def settings_file(self) -> Path:
        return self.config_dir / "settings.json"

    @property
    def registry_file(self) -> Path:
        return self.packages_dir / "registry.json"

    @property
    def log_file(self) -> Path:
        return self.log_dir / "freeocs.log"

    def ensure(self) -> AppPaths:
        for path in (
            self.config_dir,
            self.data_dir,
            self.cache_dir,
            self.log_dir,
            self.packages_dir,
            self.builtin_cache_dir,
            self.package_data_dir,
            self.models_dir,
            self.audio_dir,
            self.extension_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)
        return self

    def package_data(self, package_id: str) -> Path:
        path = self.package_data_dir / package_id
        path.mkdir(parents=True, exist_ok=True)
        return path


def build_paths(*, portable: bool = False, repo: Path | None = None) -> AppPaths:
    root = (repo or repo_root()).resolve()
    if portable:
        data_root = root / "data"
        return AppPaths(
            repo=root,
            config_dir=data_root / "config",
            data_dir=data_root,
            cache_dir=data_root / "cache",
            log_dir=data_root / "logs",
            packages_dir=data_root / "packages",
            builtin_cache_dir=data_root / "builtin",
            package_data_dir=data_root / "package-data",
            models_dir=data_root / "models",
            audio_dir=data_root / "audio",
            extension_dir=data_root / "extension",
            web_dir=root / "web",
            packages_src_dir=root / "packages" / "src",
            packages_dist_dir=root / "packages" / "dist",
            extension_dist_dir=root / "extension" / "dist",
            portable=True,
        )

    if sys.platform == "win32":
        config = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / APP_NAME
        data = (
            Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
            / APP_NAME
        )
        cache = data / "cache"
    elif sys.platform == "darwin":
        base = Path.home() / "Library"
        config = base / "Application Support" / APP_NAME
        data = base / "Application Support" / APP_NAME
        cache = base / "Caches" / APP_NAME
    else:
        config = _xdg("XDG_CONFIG_HOME", ".config") / APP_NAME
        data = _xdg("XDG_DATA_HOME", ".local/share") / APP_NAME
        cache = _xdg("XDG_CACHE_HOME", ".cache") / APP_NAME

    # Keep the extension outside XDG hidden directories: snap-packaged Firefox
    # cannot read hidden paths such as ~/.local/share via its home interface.
    public_extension_dir = Path.home() / "FreeOCS" / "extensions"

    return AppPaths(
        repo=root,
        config_dir=config,
        data_dir=data,
        cache_dir=cache,
        log_dir=data / "logs",
        packages_dir=data / "packages",
        builtin_cache_dir=data / "builtin",
        package_data_dir=data / "package-data",
        models_dir=data / "models",
        audio_dir=data / "audio",
        extension_dir=public_extension_dir,
        web_dir=root / "web",
        packages_src_dir=root / "packages" / "src",
        packages_dist_dir=root / "packages" / "dist",
        extension_dist_dir=root / "extension" / "dist",
        portable=False,
    )
