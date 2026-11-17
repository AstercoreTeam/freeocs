# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

from pathlib import Path

import pytest

from freeocs.capabilities import CapabilityRegistry
from freeocs.config import SettingsStore
from freeocs.events import EventBus
from freeocs.modules import ModuleHost
from freeocs.packages import PackageManager
from freeocs.sdk import ChatResult, ModuleError

from .helpers import make_paths


class FakeWeb:
    connected = True

    def __init__(self) -> None:
        self.target = ""

    def list_tabs(self) -> list[dict[str, object]]:
        return [
            {
                "id": "42",
                "url": "https://studentexamcomh5.zhihuishu.com/exam/1",
                "active": True,
            }
        ]

    def set_target(self, tab_id: str) -> dict[str, object]:
        self.target = tab_id
        return {"ok": True}


class FakeLLM:
    def __init__(self) -> None:
        self.calls: list[list[dict[str, object]]] = []

    def chat(self, messages, **kwargs):
        self.calls.append(list(messages))
        return ChatResult(message={"role": "assistant", "content": '{"answers":["B"]}'})

    def close(self) -> None:
        return None


def build_host(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FREEOCS_PACKAGES", "source")
    paths = make_paths(tmp_path)
    settings = SettingsStore(paths.settings_file)
    events = EventBus()
    registry = CapabilityRegistry()
    web = FakeWeb()
    llm = FakeLLM()
    registry.register_core("web.bridge", web)
    registry.register_provider("fake_llm", "llm.chat", llm, title="fake")
    registry.set_binding("llm.chat", "fake_llm")
    manager = PackageManager(paths, settings, events, registry, web=web)
    manager.load_all()
    host = ModuleHost(manager, events, manager.asset_url)
    host.load()
    return host, manager, web, llm


def test_wisdomtree_manifest_uses_browser_bridge(tmp_path: Path, monkeypatch) -> None:
    host, manager, _web, _llm = build_host(tmp_path, monkeypatch)
    try:
        entry = host.get("wisdomtree")
        assert entry is not None
        assert entry.available is True
        assert entry.package.manifest.platform == "web"
        assert entry.package.manifest.requires == ["llm.chat", "web.bridge"]
        assert entry.package.manifest.page_agents[0]["matches"] == [
            "*://zhihuishu.com/*",
            "*://*.zhihuishu.com/*",
        ]
        settings = manager.settings.package_values("wisdomtree")
        assert settings["auto_submit"] is False
    finally:
        host.close()
        manager.close()


def test_wisdomtree_page_agent_and_answer(tmp_path: Path, monkeypatch) -> None:
    host, manager, web, llm = build_host(tmp_path, monkeypatch)
    try:
        host.start("wisdomtree")
        poll = host.handle_agent_request(
            "wisdomtree",
            "poll",
            {
                "client_id": "agent-1",
                "url": "https://studentexamcomh5.zhihuishu.com/exam/1",
                "title": "练习",
                "mode": "exam",
                "has_content": True,
                "__tab_id": "42",
            },
        )
        assert poll["lease"] is True
        assert poll["desired_running"] is True
        assert poll["auto_submit"] is False
        assert web.target == "42"

        other_tab = host.handle_agent_request(
            "wisdomtree",
            "poll",
            {
                "client_id": "agent-2",
                "url": "https://zhihuishu.com/course/2",
                "mode": "course",
                "has_content": True,
                "__tab_id": "99",
            },
        )
        assert other_tab["lease"] is False
        assert other_tab["desired_running"] is False
        assert host.state("wisdomtree")["extra"]["page_url"] == (
            "https://studentexamcomh5.zhihuishu.com/exam/1"
        )

        with pytest.raises(ModuleError, match="自动化控制权"):
            host.handle_agent_request(
                "wisdomtree",
                "event",
                {
                    "agent_id": "other-agent",
                    "__tab_id": "42",
                    "type": "finished",
                    "message": "伪造完成",
                },
            )
        assert host.state("wisdomtree")["running"] is True
        with pytest.raises(ModuleError, match="自动化控制权"):
            host.handle_agent_request(
                "wisdomtree",
                "storage-save",
                {
                    "agent_id": "other-agent",
                    "__tab_id": "42",
                    "data": {"zhs_auto_run": False},
                },
            )

        answer = host.handle_agent_request(
            "wisdomtree",
            "answer",
            {
                "agent_id": "agent-1",
                "__tab_id": "42",
                "url": "https://studentexamcomh5.zhihuishu.com/exam/1",
                "question": {
                    "id": "q1",
                    "type": "single",
                    "stem": "1 + 1 = ?",
                    "options": [
                        {"key": "A", "text": "1"},
                        {"key": "B", "text": "2"},
                    ],
                    "blanks": 0,
                },
            },
        )
        assert answer["answers"] == ["B"]
        assert llm.calls
        assert host.state("wisdomtree")["extra"]["last_answer"] == "B"
    finally:
        host.close()
        manager.close()


def test_wisdomtree_rejects_non_site_and_non_lease_answer(tmp_path: Path, monkeypatch) -> None:
    host, manager, _web, _llm = build_host(tmp_path, monkeypatch)
    try:
        host.start("wisdomtree")
        with pytest.raises(ModuleError, match="智慧树网页"):
            host.handle_agent_request(
                "wisdomtree",
                "poll",
                {"client_id": "agent-1", "url": "https://example.com", "has_content": True},
            )
        with pytest.raises(ModuleError, match="自动化控制权"):
            host.handle_agent_request(
                "wisdomtree",
                "answer",
                {
                    "agent_id": "other-agent",
                    "url": "https://studentexamcomh5.zhihuishu.com/exam/1",
                    "question": {"type": "single", "stem": "题目", "options": []},
                },
            )
    finally:
        host.close()
        manager.close()


def test_wisdomtree_storage_roundtrip_and_corruption_protection(
    tmp_path: Path, monkeypatch
) -> None:
    host, manager, _web, _llm = build_host(tmp_path, monkeypatch)
    try:
        module = host.get("wisdomtree").module
        module.handle_agent_request(
            "storage-save",
            {"data": {"zhs_auto_course_url": "https://course.zhihuishu.com/course/1"}},
        )
        loaded = module.handle_agent_request("storage-load", {})
        assert loaded["data"]["zhs_auto_course_url"].endswith("/course/1")

        module._storage_path.write_text("{", encoding="utf-8")
        with pytest.raises(ModuleError, match="智慧树页面状态"):
            module.handle_agent_request("storage-load", {})
        assert module._storage_path.read_text(encoding="utf-8") == "{"
    finally:
        host.close()
        manager.close()
