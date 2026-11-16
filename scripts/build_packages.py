# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

"""Build built-in packages into packages/dist/*.focpkg."""

from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from freeocs.packages import Manifest, PackageError, validate_archive  # noqa: E402

SRC = ROOT / "packages" / "src"
DIST = ROOT / "packages" / "dist"
INCLUDE_TOP = {"manifest.json", "README.md", "LICENSE", "icon.png", "requirements.txt"}
EXCLUDE_DIRS = {"__pycache__", ".venv", "tests", ".git"}


def collect(package_dir: Path) -> list[Path]:
    files: list[Path] = []
    for path in sorted(package_dir.rglob("*")):
        if path.is_dir():
            continue
        relative = path.relative_to(package_dir)
        if any(part in EXCLUDE_DIRS for part in relative.parts):
            continue
        if path.suffix in {".pyc", ".pyo"}:
            continue
        if relative.parts[0] in {"backend", "web"} or relative.name in INCLUDE_TOP:
            files.append(path)
    return files


def build_one(package_dir: Path) -> Path:
    manifest_path = package_dir / "manifest.json"
    if not manifest_path.is_file():
        raise PackageError(f"缺少 manifest：{manifest_path}")
    manifest = Manifest.from_dict(json.loads(manifest_path.read_text(encoding="utf-8")))
    destination = DIST / f"{manifest.id}-{manifest.version}.focpkg"
    DIST.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        destination.unlink()
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in collect(package_dir):
            archive.write(path, path.relative_to(package_dir).as_posix())
    info = validate_archive(destination)
    print(f"[package] {manifest.id} {manifest.version} -> {destination.relative_to(ROOT)} ({info.size} B)")
    return destination


def main(argv: list[str]) -> int:
    if not SRC.is_dir():
        print(f"缺少源码目录：{SRC}", file=sys.stderr)
        return 1
    requested = set(argv)
    built = 0
    for package_dir in sorted(SRC.iterdir()):
        if not package_dir.is_dir() or package_dir.name.startswith((".", "_")):
            continue
        if requested and package_dir.name not in requested:
            continue
        try:
            build_one(package_dir)
            built += 1
        except Exception as exc:  # noqa: BLE001
            print(f"构建失败 {package_dir.name}: {exc}", file=sys.stderr)
    print(f"完成：{built} 个包")
    return 0 if built else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
