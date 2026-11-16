"""FreeOCS entry point."""

from __future__ import annotations

import argparse
import os
import sys
import traceback

from freeocs import __version__


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="freeocs", description="FreeOCS 学习助手")
    parser.add_argument("--version", action="version", version=f"FreeOCS {__version__}")
    parser.add_argument("--dev", action="store_true", help="开发模式（源码包 + 调试日志）")
    parser.add_argument("--portable", action="store_true", help="数据保存在程序目录 data/")
    parser.add_argument("--port", type=int, default=None, help="本地 HTTP 端口（默认 8765）")
    parser.add_argument("--log-level", default=None, help="debug/info/warn/error")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.dev:
        os.environ.setdefault("FREEOCS_PACKAGES", "source")
    try:
        from freeocs.app import Application

        app = Application(
            portable=args.portable,
            port=args.port,
            dev=args.dev,
            log_level=args.log_level or ("debug" if args.dev else None),
        )
        app.run()
        return 0
    except Exception as exc:  # noqa: BLE001 - top-level boundary
        traceback.print_exc()
        _show_fatal(str(exc))
        return 1


def _show_fatal(message: str) -> None:
    """Best-effort desktop error dialog before exiting."""
    try:
        import tkinter as tk
        from tkinter import messagebox

        root = tk.Tk()
        root.withdraw()
        messagebox.showerror("FreeOCS 启动失败", message)
        root.destroy()
    except Exception:
        print(f"FreeOCS 启动失败：{message}", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
