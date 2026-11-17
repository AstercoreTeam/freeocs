# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from scripts import build_app


def test_windows_build_does_not_collect_gtk(monkeypatch: pytest.MonkeyPatch) -> None:
    commands: list[list[str]] = []

    def fake_run(command: list[str], **_: object) -> subprocess.CompletedProcess[str]:
        commands.append(command)
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(build_app.sys, "platform", "win32")
    monkeypatch.setattr(build_app.subprocess, "run", fake_run)

    output = build_app.build(onefile=False, clean=False, name="FreeOCS")

    assert output == build_app.ROOT / "dist" / "FreeOCS.exe"
    assert "--hidden-import=webview.platforms.gtk" not in commands[0]
    assert "--hidden-import=gi" not in commands[0]
    assert "--collect-submodules=webview" in commands[0]


def test_linux_build_collects_gtk(monkeypatch: pytest.MonkeyPatch) -> None:
    commands: list[list[str]] = []

    def fake_run(command: list[str], **_: object) -> subprocess.CompletedProcess[str]:
        commands.append(command)
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(build_app.sys, "platform", "linux")
    monkeypatch.setattr(build_app.subprocess, "run", fake_run)

    build_app.build(onefile=False, clean=False, name="FreeOCS")

    assert "--hidden-import=webview.platforms.gtk" in commands[0]
    assert "--hidden-import=gi.repository.WebKit2" in commands[0]


def test_windows_target_option_is_supported(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(build_app.sys, "platform", "win32")
    monkeypatch.setattr(build_app, "build", lambda **_: Path("FreeOCS.exe"))

    assert build_app.main(["--windows"]) == 0


def test_cross_platform_target_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(build_app.sys, "platform", "linux")

    with pytest.raises(SystemExit) as exc_info:
        build_app.main(["--windows"])
    assert exc_info.value.code == 2
