# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import pytest

from freeocs.capabilities import CapabilityRegistry
from freeocs.config import SettingsStore
from freeocs.events import EventBus
from freeocs.modules import ModuleHost
from freeocs.packages import PackageManager
from freeocs.server import LocalServer

from .helpers import ROOT, make_paths, zip_package

FIXTURE = ROOT / "tests" / "fixtures" / "demo_module"


@pytest.fixture()
def running_server(tmp_path, monkeypatch):
    monkeypatch.setenv("FREEOCS_PACKAGES", "source")
    paths = make_paths(tmp_path)
    settings = SettingsStore(paths.settings_file)
    events = EventBus()
    registry = CapabilityRegistry()
    manager = PackageManager(paths, settings, events, registry)
    manager.load_all()
    manager.install_zip(zip_package(FIXTURE, tmp_path / "demo.focpkg"))
    manager = PackageManager(paths, settings, events, registry)
    manager.load_all()
    host = ModuleHost(manager, events, manager.asset_url)
    host.load()
    server = LocalServer(0, packages=manager, modules=host, events=events)
    server.start()
    try:
        yield server, manager, host
    finally:
        server.stop()
        host.close()
        manager.close()
