# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

from types import SimpleNamespace

import pytest

from freeocs import browser_launcher
from freeocs.browser_launcher import (
    BrowserInstall,
    BrowserLaunchError,
    find_browsers,
    launch_supported_website,
    supported_websites,
)


def test_find_browsers_on_linux_path(monkeypatch: pytest.MonkeyPatch) -> None:
    executables = {
        "google-chrome": "/usr/bin/google-chrome",
        "microsoft-edge": "/usr/bin/microsoft-edge",
        "brave-browser": "/usr/bin/brave-browser",
        "chromium": "/usr/bin/chromium",
    }
    monkeypatch.setattr(
        browser_launcher.shutil,
        "which",
        lambda name: executables.get(name),
    )

    browsers = find_browsers(platform="linux", environ={})

    assert [(browser.name, browser.executable) for browser in browsers] == [
        ("Chrome", "/usr/bin/google-chrome"),
        ("Edge", "/usr/bin/microsoft-edge"),
        ("Brave", "/usr/bin/brave-browser"),
        ("Chromium", "/usr/bin/chromium"),
    ]


def test_find_browsers_in_windows_install_directory(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    chrome = tmp_path / "Google" / "Chrome" / "Application" / "chrome.exe"
    chrome.parent.mkdir(parents=True)
    chrome.touch()
    monkeypatch.setattr(browser_launcher.shutil, "which", lambda _name: None)

    browsers = find_browsers(
        platform="win32",
        environ={"ProgramFiles": str(tmp_path)},
    )

    assert browsers == [BrowserInstall("Chrome", str(chrome))]


def test_supported_websites_cover_builtin_modules() -> None:
    sites = {site["id"]: site for site in supported_websites()}

    assert set(sites) == {"ucampus", "zhihuishu"}
    assert sites["zhihuishu"]["url"] == "https://www.zhihuishu.com/"
    assert sites["zhihuishu"]["module_id"] == "wisdomtree"
    assert sites["ucampus"]["module_id"] == "ucampus"
    assert all(site["description"] for site in sites.values())


def test_launch_rejects_site_outside_allowlist(tmp_path) -> None:
    with pytest.raises(BrowserLaunchError, match="不支持的网页"):
        launch_supported_website(
            "https://example.com",
            extension_dir=tmp_path / "extension",
            profile_dir=tmp_path / "profile",
        )


def test_launch_requires_built_chromium_extension(tmp_path) -> None:
    with pytest.raises(BrowserLaunchError, match="manifest"):
        launch_supported_website(
            "ucampus",
            extension_dir=tmp_path / "extension",
            profile_dir=tmp_path / "profile",
        )


def test_launch_uses_new_window_and_extension(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    extension = tmp_path / "extension"
    extension.mkdir()
    (extension / "manifest.json").write_text("{}", encoding="utf-8")
    profile = tmp_path / "profile"
    monkeypatch.setattr(
        browser_launcher,
        "find_browsers",
        lambda: [BrowserInstall("Edge", "msedge.exe")],
    )
    commands: list[list[str]] = []

    def fake_popen(command: list[str]) -> SimpleNamespace:
        commands.append(command)
        return SimpleNamespace(pid=123)

    monkeypatch.setattr(browser_launcher.subprocess, "Popen", fake_popen)

    result = launch_supported_website(
        "ucampus",
        extension_dir=extension,
        profile_dir=profile,
    )

    assert commands == [
        [
            "msedge.exe",
            f"--user-data-dir={profile.resolve()}",
            f"--load-extension={extension.resolve()}",
            "--no-first-run",
            "--no-default-browser-check",
            "--new-window",
            "https://course.unipus.cn/",
        ]
    ]
    assert result["browser"] == "Edge"
    assert result["site"] == "U校园"
    assert result["pid"] == "123"
    assert profile.is_dir()
