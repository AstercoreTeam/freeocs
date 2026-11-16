# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

"""End-to-end U校园 test with a real Chromium extension and a mock LLM.

This is a developer test, not part of the normal test suite.  It requires
Playwright Chromium (PLAYWRIGHT_BROWSERS_PATH=.playwright).

    PLAYWRIGHT_BROWSERS_PATH=$PWD/.playwright \
      FREEOCS_PACKAGES=dist .venv/bin/python scripts/e2e_ucampus.py
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

TEMP = Path(tempfile.mkdtemp(prefix="freeocs-e2e-"))
os.environ.setdefault("XDG_CONFIG_HOME", str(TEMP / "config"))
os.environ.setdefault("XDG_DATA_HOME", str(TEMP / "data"))
os.environ.setdefault("XDG_CACHE_HOME", str(TEMP / "cache"))
os.environ.setdefault("FREEOCS_PACKAGES", "dist")


class MockLLM(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", "0") or 0)
        self.rfile.read(length)
        body = {
            "id": "mock",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": '{"answer":"B","explanation":"mock"}',
                    },
                    "finish_reason": "stop",
                }
            ],
            "usage": {},
        }
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


PAGE = r'''<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>U校园 E2E</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; }
  #quiz { display: none; }
  .question-common-abs-choice { width: 700px; }
  .option { padding: 6px; border: 1px solid #ddd; margin: 4px 0; cursor: pointer; }
  .option.selected { background: #dbeafe; border-color: #2563eb; }
  .ques-title { margin: 12px 0; font-weight: 700; }
  .taskItemContainer { padding: 10px; border: 1px solid #ddd; margin: 8px 0; cursor: pointer; }
</style></head>
<body>
<div id="modal" style="position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:1000;display:flex;align-items:center;justify-content:center;">
  <div style="background:#fff;border-radius:12px;padding:24px;width:360px;font:14px/1.5 system-ui,sans-serif;">
    <p>本单元学习时间：无限制</p>
    <p>是否必修：必修</p>
    <button id="know">我知道了</button>
  </div>
</div>
<div id="detail">
  <h1>Course detail</h1>
  <div class="taskItemContainer" id="task">
    <span class="taskTypeName">Unit 1 Quiz</span>
    <span class="taskStateContainer">未开始</span>
  </div>
</div>
<div id="video-page" style="display:none">
  <p>当前浏览器不支持此视频格式，请继续下一节。</p>
  <button id="video-next">下一节</button>
</div>
<div id="quiz">
  <div class="question-common-abs-choice">
    <div class="ques-title">Choose the correct answer.</div>
    <div class="option" id="opt-a"><span class="caption">A</span><span class="content">one</span></div>
    <div class="option" id="opt-b"><span class="caption">B</span><span class="content">two</span></div>
  </div>
  <button id="next">下一题</button>
</div>
<div id="submit-page" style="display:none">
  <h2>Quiz summary</h2>
  <button id="submit">提交</button>
</div>
<div id="second" style="display:none">
  <div class="question-common-abs-choice">
    <div class="ques-title">Second question: choose the correct answer.</div>
    <div class="option" id="opt2-a"><span class="caption">A</span><span class="content">one</span></div>
    <div class="option" id="opt2-b"><span class="caption">B</span><span class="content">two</span></div>
  </div>
  <button id="next2">下一题</button>
</div>
<div id="submit2" style="display:none">
  <h2>Second summary</h2>
  <button id="submit-final">提交</button>
</div>
<script>
  window.__submitClicks = 0;
  window.__modalDismissed = false;
  window.__videoPassed = false;
  document.getElementById("know").addEventListener("click", () => {
    window.__modalDismissed = true;
    document.getElementById("modal").style.display = "none";
  });
  document.getElementById("task").addEventListener("click", () => {
    history.pushState({}, "", "/app/learning/video/1");
    document.getElementById("detail").style.display = "none";
    document.getElementById("video-page").style.display = "block";
  });
  document.getElementById("video-next").addEventListener("click", () => {
    window.__videoPassed = true;
    history.pushState({}, "", "/app/learning/quiz/1");
    document.getElementById("video-page").style.display = "none";
    document.getElementById("quiz").style.display = "block";
  });
  document.querySelectorAll(".option").forEach((option) => {
    option.addEventListener("click", () => {
      document.querySelectorAll(".option").forEach((item) => item.classList.remove("selected"));
      option.classList.add("selected");
    });
  });
  document.getElementById("next").addEventListener("click", () => {
    document.getElementById("quiz").style.display = "none";
    document.getElementById("submit-page").style.display = "block";
  });
  document.getElementById("submit").addEventListener("click", () => {
    window.__submitClicks += 1;
    document.getElementById("submit-page").style.display = "none";
    document.getElementById("second").style.display = "block";
  });
  document.getElementById("next2").addEventListener("click", () => {
    document.getElementById("second").style.display = "none";
    document.getElementById("submit2").style.display = "block";
  });
</script>
</body></html>'''


def main() -> int:
    from playwright.sync_api import sync_playwright

    from freeocs.app import Application

    mock = ThreadingHTTPServer(("127.0.0.1", 0), MockLLM)
    threading.Thread(target=mock.serve_forever, daemon=True, name="mock-llm").start()
    mock_port = mock.server_address[1]

    port = int(os.environ.get("E2E_PORT", "8766"))
    app = Application(port=port)
    app.settings.save_section(
        "llm",
        {
            "base_url": f"http://127.0.0.1:{mock_port}",
            "api_key": "test",
            "model": "mock",
            "timeout": 30,
        },
    )
    app.load_packages()
    assert app.modules.get("ucampus") is not None

    # Use a throw-away copy with the e2e port as the extension default, so the
    # test does not interfere with the user's real extension on 8765.
    extension = str(TEMP / "extension-chromium")
    shutil.copytree(ROOT / "extension" / "dist" / "chromium", extension)
    background = Path(extension) / "background.js"
    background.write_text(
        background.read_text(encoding="utf-8").replace(
            "const DEFAULT_PORT = 8765;", f"const DEFAULT_PORT = {port};"
        ),
        encoding="utf-8",
    )
    profile = TEMP / "chromium-profile"
    profile.mkdir(parents=True, exist_ok=True)
    result = 1
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            str(profile),
            headless=False,
            no_viewport=True,
            args=[
                f"--disable-extensions-except={extension}",
                f"--load-extension={extension}",
                "--no-sandbox",
                "--disable-dev-shm-usage",
            ],
        )
        try:
            context.route("https://course.unipus.cn/**", lambda route: route.fulfill(
                status=200, content_type="text/html; charset=utf-8", body=PAGE
            ))
            page = context.pages[0] if context.pages else context.new_page()
            page.on("console", lambda message: print("CONSOLE:", message.type, message.text))
            page.on("pageerror", lambda error: print("PAGEERROR:", error))
            page.goto("https://course.unipus.cn/app/cmgt/resource-detail/1", wait_until="load")
            time.sleep(3)
            print("DATASET:", page.evaluate("JSON.stringify(document.documentElement.dataset)"))
            print("WORKERS:", len(context.service_workers))
            panel_ready = False
            for _ in range(30):
                panel_ready = page.evaluate("Boolean(document.getElementById('freeocs-ucampus-panel'))")
                if panel_ready:
                    break
                time.sleep(0.5)
            print("PANEL:", panel_ready)
            print("DATASET2:", page.evaluate("JSON.stringify(document.documentElement.dataset)"))
            if panel_ready:
                page.locator("#freeocs-ucampus-panel [data-foc='start']").click()
            else:
                app.modules.start("ucampus")
            deadline = time.time() + 45
            state = app.modules.state("ucampus")
            while time.time() < deadline:
                state = app.modules.state("ucampus")
                if state["state"] == "waiting" and not state["running"]:
                    break
                if state["state"] == "error":
                    break
                time.sleep(0.5)
            print("BRIDGE:", app.web.connected)
            print("STATE:", state["state"], state["message"])
            print("EXTRA:", json.dumps(state.get("extra", {}), ensure_ascii=False)[:800])
            print("SELECTED:", page.evaluate("document.querySelector('.option.selected')?.innerText || ''"))
            print("SUBMIT_CLICKS:", page.evaluate("window.__submitClicks"))
            print("SUBMIT_VISIBLE:", page.evaluate("getComputedStyle(document.getElementById('submit-page')).display !== 'none'"))
            print("MODAL_DISMISSED:", page.evaluate("window.__modalDismissed"))
            print("VIDEO_PASSED:", page.evaluate("window.__videoPassed"))
            if state["state"] == "waiting":
                print("USER SUBMIT: click")
                page.locator("#submit").click()
                deadline = time.time() + 35
                while time.time() < deadline:
                    state = app.modules.state("ucampus")
                    if (state["state"] == "waiting" and
                            page.evaluate("document.querySelector('#second .option.selected')?.innerText || ''")):
                        break
                    time.sleep(0.5)
                print("HANDOFF_STATE:", state["state"], state["message"])
                print("HANDOFF_SECOND:", page.evaluate("document.querySelector('#second .option.selected')?.innerText || ''"))
                print("HANDOFF_SUBMIT_VISIBLE:", page.evaluate("getComputedStyle(document.getElementById('submit2')).display !== 'none'"))
                print("SUBMIT_CLICKS_AFTER:", page.evaluate("window.__submitClicks"))
            for event in app.events.since(0, 300)["events"]:
                if event.get("package") == "ucampus":
                    print("EVENT:", event.get("level"), event.get("message"))
            ok = (
                app.web.connected
                and state["state"] == "waiting"
                and "two" in page.evaluate("document.querySelector('.option.selected')?.innerText || ''")
                and state["extra"].get("last_answer") == "B"
                and page.evaluate("window.__modalDismissed") is True
                and page.evaluate("window.__videoPassed") is True
                and page.evaluate("window.__submitClicks") == 1
                and "two" in page.evaluate("document.querySelector('#second .option.selected')?.innerText || ''")
                and page.evaluate("getComputedStyle(document.getElementById('submit2')).display !== 'none'")
            )
            result = 0 if ok else 1
        finally:
            context.close()
    app.shutdown()
    mock.shutdown()
    print("RESULT:", "PASS" if result == 0 else "FAIL")
    return result


if __name__ == "__main__":
    raise SystemExit(main())
