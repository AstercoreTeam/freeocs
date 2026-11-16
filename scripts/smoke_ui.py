# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

"""Headless-ish UI smoke test: start the real window and inspect rendered DOM.

Run from the repo root:

    XDG_CONFIG_HOME=/tmp/... .venv/bin/python scripts/smoke_ui.py
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import webview  # noqa: E402

from freeocs.app import Application  # noqa: E402


def main() -> int:
    app = Application(port=int(os.environ.get("SMOKE_PORT", "8899")))
    app.settings.save_section("legal", {"accepted": True})
    app.load_packages()
    api = app.create_ui_api()
    web_dir = app.paths.web_dir
    window = webview.create_window(
        "FreeOCS smoke",
        str(web_dir / "index.html"),
        js_api=api,
        width=1100,
        height=720,
    )

    def inspect() -> None:
        deadline = time.time() + 20
        while time.time() < deadline:
            time.sleep(0.5)
            try:
                ready = window.evaluate_js("Boolean(document.querySelector('.page-title'))")
            except Exception:
                ready = False
            if ready:
                break
        print("TITLE:", window.evaluate_js("document.title"))
        print("PAGE:", window.evaluate_js("document.querySelector('.page-title')?.textContent"))
        print("NAV:", window.evaluate_js("Array.from(document.querySelectorAll('#focs-nav .nav-item')).map(e=>e.textContent.trim()).join('|')"))
        print("HOME_CARDS:", window.evaluate_js("document.querySelectorAll('.stat-card').length"))
        print("API:", window.evaluate_js("typeof window.pywebview.api.get_home"))

        def wait_js(expression: str, timeout: float = 8.0) -> bool:
            end = time.time() + timeout
            while time.time() < end:
                try:
                    if window.evaluate_js(expression):
                        return True
                except Exception:
                    pass
                time.sleep(0.2)
            return False

        window.evaluate_js("App.navigate('apps')")
        if wait_js("document.querySelector('.page-title')?.textContent === '应用与插件'"):
            print("APPS:", window.evaluate_js("document.querySelectorAll('[data-package]').length"))
        else:
            print("APPS: FAILED")
        window.evaluate_js("App.navigate('module', {id: 'ucampus'})")
        if wait_js("document.querySelector('.page-title')?.textContent?.includes('U校园')"):
            print("UCAMPUS_PAGE:", window.evaluate_js("Boolean(document.querySelector('#module-tabs'))"))
            window.evaluate_js("document.querySelector('#module-tabs .tab[data-tab=\"panel-ucampus_console\"]')?.click()")
            print("UCAMPUS_PANEL:", wait_js("Boolean(document.querySelector('.uca-panel'))"))
        else:
            print("UCAMPUS_PAGE: FAILED")
        window.evaluate_js("App.navigate('module', {id: 'wisdomtree'})")
        if wait_js("document.querySelector('.page-title')?.textContent?.includes('智慧树')"):
            print("WISDOMTREE_PAGE:", window.evaluate_js("Boolean(document.querySelector('#module-tabs'))"))
            window.evaluate_js("document.querySelector('#module-tabs .tab[data-tab=\"panel-wisdomtree_console\"]')?.click()")
            print("WISDOMTREE_PANEL:", wait_js("Boolean(document.querySelector('.wt-panel'))"))
        else:
            print("WISDOMTREE_PAGE: FAILED")
        print("TEXT:", window.evaluate_js("document.body.innerText.slice(0, 300).replace(/\\n+/g,' / ')"))
        window.destroy()

    storage = app.paths.cache_dir / "webview"
    storage.mkdir(parents=True, exist_ok=True)
    webview.start(
        inspect,
        http_server=True,
        debug=False,
        private_mode=False,
        storage_path=str(storage),
    )
    app.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
