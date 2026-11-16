# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

"""Build the browser extension into extension/dist/{chromium,firefox} + zips."""

from __future__ import annotations

import json
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXTENSION = ROOT / "extension"
SHARED = EXTENSION / "shared"
DIST = EXTENSION / "dist"

BROWSERS = ("chromium", "firefox")


def build() -> list[Path]:
    if not SHARED.is_dir():
        raise SystemExit(f"缺少共享源码目录：{SHARED}")
    DIST.mkdir(parents=True, exist_ok=True)
    outputs: list[Path] = []
    for browser in BROWSERS:
        source_manifest = EXTENSION / browser / "manifest.json"
        if not source_manifest.is_file():
            raise SystemExit(f"缺少 manifest：{source_manifest}")
        target = DIST / browser
        if target.exists():
            shutil.rmtree(target)
        target.mkdir(parents=True)
        for item in SHARED.iterdir():
            if item.is_file():
                shutil.copy2(item, target / item.name)
        shutil.copy2(source_manifest, target / "manifest.json")
        version = json.loads(source_manifest.read_text(encoding="utf-8")).get("version", "0.0.0")
        archive = DIST / f"freeocs-bridge-{browser}-{version}.zip"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
            for path in sorted(target.rglob("*")):
                if path.is_file():
                    zf.write(path, path.relative_to(target).as_posix())
        for path in [target, *target.rglob("*")]:
            try:
                path.chmod(0o755 if path.is_dir() else 0o644)
            except OSError:
                pass
        outputs.append(archive)
        print(f"[extension] {browser}: {target.relative_to(ROOT)}")
        print(f"[extension] zip: {archive.relative_to(ROOT)}")
    return outputs


if __name__ == "__main__":
    try:
        build()
    except Exception as exc:  # noqa: BLE001
        print(f"构建扩展失败：{exc}", file=sys.stderr)
        raise SystemExit(1) from exc
