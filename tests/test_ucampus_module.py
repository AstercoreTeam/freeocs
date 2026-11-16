from __future__ import annotations

from pathlib import Path

import pytest

from freeocs.capabilities import CapabilityRegistry
from freeocs.config import SettingsStore
from freeocs.events import EventBus
from freeocs.modules import ModuleHost
from freeocs.packages import PackageManager
from freeocs.sdk import ChatResult
from freeocs.transports.webcat import WebcatBridge

from .helpers import ROOT, make_paths

AGENT = ROOT / "packages" / "src" / "ucampus" / "web" / "page-agent.js"


class FakeLLM:
    def chat(self, messages, **kwargs):
        return ChatResult(
            message={"role": "assistant", "content": '{"answer":"B","explanation":"ok"}'}
        )

    def close(self) -> None:
        return None


class FakeASR:
    def transcribe(self, audio, **kwargs):
        raise AssertionError("not used")


class FakeTTS:
    def synthesize(self, text, **kwargs):
        raise AssertionError("not used")


@pytest.fixture()
def ucampus_host(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FREEOCS_PACKAGES", "source")
    paths = make_paths(tmp_path)
    settings = SettingsStore(paths.settings_file)
    events = EventBus()
    registry = CapabilityRegistry()
    web = WebcatBridge()
    registry.register_core("web.bridge", web)
    manager = PackageManager(paths, settings, events, registry, web=web)
    manager.load_all()
    host = ModuleHost(manager, events, manager.asset_url)
    host.load()
    registry.register_provider("fake_llm", "llm.chat", FakeLLM(), title="fake")
    registry.set_binding("llm.chat", "fake_llm")
    try:
        yield host, registry, manager
    finally:
        host.close()
        manager.close()


def test_ucampus_loads_and_starts(ucampus_host) -> None:
    host, _registry, _manager = ucampus_host
    assert host.get("ucampus") is not None
    assert host.get("ucampus").available is True
    assert host.start("ucampus")["ok"] is True
    poll = host.handle_agent_request(
        "ucampus",
        "poll",
        {
            "client_id": "c1",
            "url": "https://course.unipus.cn/x",
            "title": "课程",
            "has_content": True,
            "running": False,
        },
    )
    assert poll["active"] is True
    assert poll["lease"] is True
    assert poll["command"] == {"action": "start"}
    state = host.state("ucampus")
    assert state["running"] is True


def test_ucampus_auto_start_on_course(ucampus_host) -> None:
    host, _registry, manager = ucampus_host
    manager.settings.save_section("ucampus", {"auto_start_on_course": True})
    poll = host.handle_agent_request(
        "ucampus",
        "poll",
        {
            "client_id": "auto-client",
            "url": "https://course.unipus.cn/app/cmgt/resource-detail/9",
            "title": "课程",
            "is_course_detail": True,
            "has_content": True,
            "running": False,
        },
    )
    assert poll["active"] is True
    assert poll["command"] == {"action": "start"}
    assert "自动开始" in poll["status"]


def test_ucampus_answer(ucampus_host) -> None:
    host, _registry, _manager = ucampus_host
    result = host.handle_agent_request(
        "ucampus",
        "answer",
        {
            "question": "Choose the best answer.",
            "options": ["A. one", "B. two"],
            "question_type": "choice",
        },
    )
    assert result["answer"] == "B"
    assert result["explanation"] == "ok"


def test_ucampus_waiting_and_finish(ucampus_host) -> None:
    host, _registry, _manager = ucampus_host
    host.start("ucampus")
    host.handle_agent_request(
        "ucampus",
        "report",
        {"status": "已填完，等待手动提交", "running": False, "completed": 3},
    )
    state = host.state("ucampus")
    assert state["state"] == "waiting"
    assert state["running"] is False
    assert state["stats"]["answered"] == 3
    host.handle_agent_request("ucampus", "finish", {"reason": "等待手动提交"})
    state = host.state("ucampus")
    assert state["running"] is False
    assert state["message"] == "等待手动提交"


def test_page_agent_has_no_auto_submit() -> None:
    code = AGENT.read_text(encoding="utf-8")
    assert "waitingForManual" in code
    assert "publish.click" not in code
    assert "已确认提交弹窗" not in code
    # The safe navigation button list must not include submit labels.
    start = code.index("function pageActionButton()")
    end = code.index("function findSubmitButton()")
    section = code[start:end]
    assert '"提交"' not in section
    assert "confirmSubmitDialog" in code
    assert "button.click();" not in code[code.index("async function confirmSubmitDialog"):code.index("async function clickPageAction")]
