# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import subprocess

import pytest

from freeocs.sdk import AdbError
from freeocs.transports.adb import AdbDevice, AdbManager


class FakeSettings:
    def core_get(self, section: str, key: str, default=None):
        return {"adb_path": "/usr/bin/adb", "device_serial": ""}.get(key, default)


def fake_run_factory(outputs):
    def fake_run(command, capture_output=True, timeout=10, check=False, **kwargs):
        joined = " ".join(command)
        for marker, stdout in outputs.items():
            if marker in joined:
                return subprocess.CompletedProcess(command, 0, stdout=stdout, stderr=b"")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr=b"")

    return fake_run


def test_list_devices(monkeypatch) -> None:
    manager = AdbManager(FakeSettings(), adb_path="/usr/bin/adb")
    output = "List of devices attached\nR58M device product:beyond model:SM_G9730 transport_id:2\n"
    monkeypatch.setattr(subprocess, "run", fake_run_factory({"devices -l": output}))
    devices = manager.list_devices()
    assert devices[0]["serial"] == "R58M"
    assert devices[0]["state"] == "device"
    assert devices[0]["model"] == "SM_G9730"


def test_screen_size_prefers_override(monkeypatch) -> None:
    manager = AdbManager(FakeSettings(), adb_path="/usr/bin/adb")
    device = AdbDevice(manager, "R58M")
    output = "Physical size: 1080x2340\nOverride size: 1080x2160\n"
    monkeypatch.setattr(subprocess, "run", fake_run_factory({"wm size": output}))
    assert device.screen_size() == (1080, 2160)


def test_dump_hierarchy(monkeypatch) -> None:
    manager = AdbManager(FakeSettings(), adb_path="/usr/bin/adb")
    device = AdbDevice(manager, "R58M")
    xml = '<hierarchy rotation="0"><node text="hello" bounds="[0,0][10,10]" /></hierarchy>'
    monkeypatch.setattr(
        subprocess,
        "run",
        fake_run_factory({"cat /sdcard/window_dump.xml": xml}),
    )
    assert "<hierarchy" in device.dump_hierarchy()


def test_tap_and_error(monkeypatch) -> None:
    manager = AdbManager(FakeSettings(), adb_path="/usr/bin/adb")
    device = AdbDevice(manager, "R58M")
    calls: list[str] = []

    def fake_run(command, capture_output=True, timeout=10, check=False, **kwargs):
        calls.append(" ".join(command))
        if "wm size" in " ".join(command):
            return subprocess.CompletedProcess(command, 0, stdout="Physical size: 100x200\n", stderr=b"")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr=b"")

    monkeypatch.setattr(subprocess, "run", fake_run)
    device.tap(50, 60)
    assert any("input tap 50 60" in call for call in calls)

    def failing_run(command, capture_output=True, timeout=10, check=False, **kwargs):
        return subprocess.CompletedProcess(command, 1, stdout="", stderr=b"boom")

    monkeypatch.setattr(subprocess, "run", failing_run)
    with pytest.raises(AdbError):
        device.shell("echo hi")
