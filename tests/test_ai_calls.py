# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

from pathlib import Path

from freeocs.ai_calls import AICallStore


class Settings:
    def core_get(self, section: str, key: str, default=None):
        return default


def test_ai_call_store_writes_and_redacts_secret(tmp_path: Path) -> None:
    store = AICallStore(tmp_path / "ai-calls", Settings())
    store.record(
        source="test",
        model="test-model",
        messages=[{"role": "user", "content": "key sk-1234567890"}],
        kwargs={"temperature": 0},
        response=None,
        ok=False,
        error="network",
        latency_ms=12.5,
    )
    calls = store.list(10)
    assert len(calls) == 1
    assert calls[0]["source"] == "test"
    assert calls[0]["ok"] is False
    assert "sk-***" in calls[0]["request"]["messages"][0]["content"]
    assert calls[0]["error"] == "network"
