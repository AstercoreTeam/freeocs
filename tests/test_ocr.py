# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from freeocs.capabilities import CapabilityRegistry
from freeocs.config import SettingsStore
from freeocs.events import EventBus
from freeocs.packages import PackageManager

from .helpers import make_paths


@pytest.mark.skipif(not shutil.which("tesseract"), reason="tesseract not installed")
@pytest.mark.skipif(not shutil.which("convert"), reason="ImageMagick convert not installed")
def test_ocr_tesseract_fallback(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FREEOCS_PACKAGES", "source")
    image = tmp_path / "ocr.png"
    subprocess.run(
        [
            "convert",
            "-size", "700x220",
            "xc:white",
            "-fill", "black",
            "-pointsize", "72",
            "-annotate", "+30+130",
            "HELLO WORLD",
            str(image),
        ],
        check=True,
        timeout=20,
    )
    paths = make_paths(tmp_path)
    settings = SettingsStore(paths.settings_file)
    registry = CapabilityRegistry()
    manager = PackageManager(paths, settings, EventBus(), registry)
    manager.load_all()
    try:
        settings.save_section("ocr_rapid", {"engine": "tesseract", "lang": "eng"})
        provider = registry.require("media.ocr")
        result = provider.extract(image.read_bytes())
        assert "HELLO" in result.text.upper()
    finally:
        manager.close()
