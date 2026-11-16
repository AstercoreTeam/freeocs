# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

"""Build the FreeOCS desktop app with PyInstaller (onedir by default)."""

from __future__ import annotations

import argparse
import importlib.util
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def build(onefile: bool, clean: bool, name: str) -> Path:
    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        raise SystemExit("未安装 PyInstaller：uv pip install pyinstaller（或安装 dev extra）") from None
    sep = ";" if sys.platform == "win32" else ":"
    data_dirs = ["web", "packages/dist", "extension/dist"]
    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--windowed",
        "--name",
        name,
        "--onefile" if onefile else "--onedir",
        "--hidden-import=webview.platforms.gtk",
        "--hidden-import=gi",
        "--hidden-import=gi.repository.Gtk",
        "--hidden-import=gi.repository.WebKit2",
        "--collect-submodules=webview",
    ]
    if clean:
        cmd.append("--clean")
    # Optional runtime dependencies are loaded dynamically by plugins.  Collect
    # them explicitly so the packaged app is self-contained (models stay out).
    optional_modules = [
        "faster_whisper", "ctranslate2", "av", "tokenizers",
        "onnxruntime", "rapidocr_onnxruntime", "pyttsx3",
        "kokoro_onnx", "kanade_tokenizer",
        "soundfile", "misaki", "vocos", "safetensors",
        "huggingface_hub", "imageio_ffmpeg", "numpy", "PIL",
        "yaml", "jsonargparse",
    ]
    for module in optional_modules:
        try:
            available = importlib.util.find_spec(module) is not None
        except (ImportError, ValueError):
            available = False
        if available:
            cmd.extend(["--collect-all", module])
    for relative in data_dirs:
        source = ROOT / relative
        if source.exists():
            cmd.extend(["--add-data", f"{source}{sep}{relative}"])
    # torch is handled by PyInstaller's own hook; collecting it with
    # --collect-all adds headers, tests and build tools that the app never uses.
    for module in ("torch", "torchaudio"):
        try:
            if importlib.util.find_spec(module) is not None:
                cmd.extend(["--hidden-import", module])
        except (ImportError, ValueError):
            pass
    for extra in ("README.md", "LICENSE"):
        source = ROOT / extra
        if source.exists():
            cmd.extend(["--add-data", f"{source}{sep}."])
    cmd.append(str(ROOT / "main.py"))
    print("[build]", " ".join(cmd))
    result = subprocess.run(cmd, cwd=ROOT, check=False)
    if result.returncode != 0:
        raise SystemExit(f"PyInstaller 失败，退出码 {result.returncode}")
    output = ROOT / "dist" / (name + (".exe" if sys.platform == "win32" else ""))
    if not onefile:
        trim_runtime(output)
    if onefile:
        print(f"[build] 单文件：{output}")
    else:
        print(f"[build] 目录：{ROOT / 'dist' / name}")
    return output


def trim_runtime(output: Path) -> None:
    """Remove files collected by PyInstaller that inference never needs."""
    internal = output / "_internal"
    if not internal.is_dir():
        return
    for relative in (
        "torch/test", "torch/include", "torch/bin",
        "share/icons", "share/themes", "onnxruntime/datasets",
    ):
        target = internal / relative
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
    lib = internal / "torch" / "lib"
    if lib.is_dir():
        for pattern in ("*test*.so", "libaoti_custom_ops.so", "libbackend_with_compiler.so"):
            for target in lib.glob(pattern):
                target.unlink(missing_ok=True)


def package_linux(name: str) -> Path:
    source = ROOT / "dist" / name
    if not source.is_dir():
        raise SystemExit(f"未找到构建目录：{source}")
    archive = shutil.make_archive(str(ROOT / "dist" / name), "gztar", root_dir=source.parent, base_dir=name)
    print(f"[build] 压缩包：{archive}")
    return Path(archive)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="构建 FreeOCS 桌面应用")
    parser.add_argument("--onefile", action="store_true", help="单文件模式（不推荐，启动慢）")
    parser.add_argument("--no-clean", action="store_true", help="不清理 PyInstaller 缓存")
    parser.add_argument("--name", default="FreeOCS")
    parser.add_argument("--tar", action="store_true", help="Linux 下额外生成 tar.gz")
    args = parser.parse_args(argv)
    output = build(onefile=args.onefile, clean=not args.no_clean, name=args.name)
    if args.tar and sys.platform != "win32" and output.suffix != ".exe":
        if output.is_dir():
            package_linux(args.name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
