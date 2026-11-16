# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import json
import time
import xml.etree.ElementTree as ET
from pathlib import Path

from freeocs.capabilities import CapabilityRegistry
from freeocs.config import SettingsStore
from freeocs.events import EventBus
from freeocs.modules import ModuleHost
from freeocs.packages import PackageManager
from freeocs.sdk import ChatResult

from .helpers import make_paths

PAGE = '''<hierarchy rotation="0">
  <node package="com.able.wisdomtree" class="android.widget.TextView" text="单选题" bounds="[40,200][200,240]" clickable="false" />
  <node package="com.able.wisdomtree" class="android.widget.TextView" text="What is 1+1?" bounds="[40,300][900,360]" clickable="false" />
  <node package="com.able.wisdomtree" class="android.widget.TextView" text="A. one" bounds="[40,500][900,560]" clickable="false" />
  <node package="com.able.wisdomtree" class="android.widget.TextView" text="B. two" bounds="[40,600][900,660]" clickable="false" />
  <node package="com.able.wisdomtree" class="android.widget.Button" text="下一题" bounds="[800,2000][1000,2080]" clickable="true" />
</hierarchy>'''

SUBMIT = '''<hierarchy rotation="0">
  <node package="com.able.wisdomtree" class="android.widget.TextView" text="单选题" bounds="[40,200][200,240]" clickable="false" />
  <node package="com.able.wisdomtree" class="android.widget.TextView" text="What is 1+1?" bounds="[40,300][900,360]" clickable="false" />
  <node package="com.able.wisdomtree" class="android.widget.TextView" text="A. one" bounds="[40,500][900,560]" clickable="false" />
  <node package="com.able.wisdomtree" class="android.widget.Button" text="交卷" bounds="[800,2000][1000,2080]" clickable="true" />
</hierarchy>'''


class FakeDevice:
    serial = "test-device"

    def __init__(self) -> None:
        self.taps: list[tuple[int, int]] = []
        self.dumps = 0

    def screen_size(self, refresh: bool = False):
        return 1080, 2160

    def dump_hierarchy(self, timeout: float = 15.0) -> str:
        self.dumps += 1
        return SUBMIT if self.taps else PAGE

    def tap(self, x: int, y: int, *, jitter: int = 0) -> None:
        self.taps.append((x, y))

    def screenshot(self, timeout: float = 20.0) -> bytes:
        raise AssertionError("OCR should not be used")


class FakeAdb:
    def __init__(self) -> None:
        self.device = FakeDevice()

    def connect(self, serial=None):
        return self.device


class FakeLLM:
    def __init__(self) -> None:
        self.calls = 0

    def chat(self, messages, **kwargs):
        self.calls += 1
        calls = {
            1: [("read_page", {})],
            2: [("click_option", {"option_text": "B. two"})],
            3: [("click_next", {})],
        }.get(self.calls, [("finish", {"reason": "done"})])
        tool_calls = [
            {
                "id": f"call-{self.calls}-{index}",
                "type": "function",
                "function": {"name": name, "arguments": json.dumps(args)},
            }
            for index, (name, args) in enumerate(calls)
        ]
        return ChatResult(
            message={"role": "assistant", "content": None, "tool_calls": tool_calls}
        )

    def close(self) -> None:
        return None


def test_reader_parses_question_and_options() -> None:
    from packages.src.wisdomtree.backend.readers.wisdomtree import WisdomTreeReader

    root = ET.fromstring(PAGE)
    reader = WisdomTreeReader()
    assert reader.can_handle(root) is True
    page = reader.parse(root, 1080, 2160)
    assert page.question == "What is 1+1?"
    assert [option.text for option in page.options] == ["A. one", "B. two"]
    assert page.buttons and page.buttons[0].text == "下一题"


def test_wisdomtree_run_stops_at_submit(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("FREEOCS_PACKAGES", "source")
    paths = make_paths(tmp_path)
    settings = SettingsStore(paths.settings_file)
    events = EventBus()
    registry = CapabilityRegistry()
    adb = FakeAdb()
    registry.register_core("android.adb", adb)
    manager = PackageManager(paths, settings, events, registry, adb=adb)
    manager.load_all()
    registry.register_provider("fake_llm", "llm.chat", FakeLLM(), title="fake")
    registry.set_binding("llm.chat", "fake_llm")
    host = ModuleHost(manager, events, manager.asset_url)
    host.load()
    try:
        assert host.get("wisdomtree") is not None
        assert host.get("wisdomtree").available is True
        host.start("wisdomtree")
        deadline = time.time() + 8
        state = host.state("wisdomtree")
        while state["running"] and time.time() < deadline:
            time.sleep(0.1)
            state = host.state("wisdomtree")
        assert state["running"] is False
        assert state["state"] == "waiting"
        assert "未点击" in state["message"]
        assert state["extra"]["last_clicked"] == "B. two"
        # The option was tapped, the submit button was not.
        assert (470, 630) in adb.device.taps
        assert (900, 2040) not in adb.device.taps
    finally:
        host.close()
        manager.close()
