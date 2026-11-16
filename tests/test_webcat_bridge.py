# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import threading
import time

import httpx
import pytest

from freeocs.sdk import BridgeError
from freeocs.transports.webcat import WebcatBridge


def test_bridge_roundtrip() -> None:
    bridge = WebcatBridge()
    bridge.register({"browser": "chrome", "version": "1.0.0"})
    assert bridge.connected is True
    result: list[str] = []

    def worker() -> None:
        result.append(bridge.call("getText", "h1", timeout=5))

    thread = threading.Thread(target=worker)
    thread.start()
    task = bridge.poll(2)
    assert task["action"] == "dom.call"
    assert task["args"]["method"] == "getText"
    assert task["args"]["args"] == ["h1"]
    assert bridge.complete({"id": task["id"], "ok": True, "result": "hello"}) is True
    thread.join(5)
    assert result == ["hello"]


def test_bridge_timeout() -> None:
    bridge = WebcatBridge()
    with pytest.raises(BridgeError):
        bridge.call("getText", "h1", timeout=0.2)


def test_server_extension_roundtrip(running_server) -> None:
    server, _manager, _host = running_server
    bridge = server.bridge
    result: list[object] = []

    def worker() -> None:
        result.append(bridge.call("getText", "h1", timeout=5))

    thread = threading.Thread(target=worker)
    thread.start()
    time.sleep(0.1)
    response = httpx.get(f"{server.base_url}/extension/poll?timeout=3", timeout=10)
    assert response.status_code == 200
    task = response.json()
    assert task["action"] == "dom.call"
    response = httpx.post(
        f"{server.base_url}/extension/result",
        json={"id": task["id"], "ok": True, "result": "hello"},
        timeout=5,
    )
    assert response.json()["ok"] is True
    thread.join(5)
    assert result == ["hello"]
    assert bridge.connected is True
