# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import httpx


def test_health(running_server) -> None:
    server, _manager, _host = running_server
    response = httpx.get(f"{server.base_url}/health", timeout=5)
    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert data["name"] == "FreeOCS"


def test_module_api_requires_extension_header(running_server) -> None:
    server, _manager, _host = running_server
    url = f"{server.base_url}/api/module/demo_module/ping"
    response = httpx.post(url, json={}, timeout=5)
    assert response.status_code == 403
    response = httpx.post(
        url,
        json={},
        headers={"X-FreeOCS-Client": "browser-bridge"},
        timeout=5,
    )
    assert response.status_code == 400


def test_agents_endpoint_empty(running_server) -> None:
    server, _manager, _host = running_server
    response = httpx.get(f"{server.base_url}/extension/agents", params={"url": "https://example.com"}, timeout=5)
    assert response.status_code == 200
    assert response.json()["agents"] == []


def test_unknown_path(running_server) -> None:
    server, _manager, _host = running_server
    response = httpx.get(f"{server.base_url}/nope", timeout=5)
    assert response.status_code == 404
