# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

"""Launch supported websites in a Chromium browser with the local bridge loaded."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class BrowserInstall:
    name: str
    executable: str


@dataclass(frozen=True, slots=True)
class SupportedWebsite:
    id: str
    name: str
    description: str
    url: str
    module_id: str = ""


SUPPORTED_WEBSITES = (
    SupportedWebsite(
        "ucampus",
        "U校园",
        "课程、听力与口语练习；会使用语音转写、语音合成和回填答案。",
        "https://course.unipus.cn/",
    ),
    SupportedWebsite(
        "zhihuishu",
        "智慧树",
        "课程目录、章节测验与练习；默认停在提交页等待人工确认。",
        "https://www.zhihuishu.com/",
        "wisdomtree",
    ),
)


class BrowserLaunchError(RuntimeError):
    """Raised when a supported site cannot be opened with the bridge enabled."""


def supported_websites() -> list[dict[str, str]]:
    return [
        {
            "id": site.id,
            "name": site.name,
            "description": site.description,
            "url": site.url,
            "module_id": site.module_id or site.id,
        }
        for site in SUPPORTED_WEBSITES
    ]


def find_browsers(
    *,
    platform: str | None = None,
    environ: Mapping[str, str] | None = None,
) -> list[BrowserInstall]:
    system = platform or sys.platform
    env = os.environ if environ is None else environ
    found: list[BrowserInstall] = []
    seen: set[str] = set()

    def add(name: str, executable: str | None) -> None:
        if not executable:
            return
        key = os.path.normcase(os.path.abspath(executable))
        if key not in seen:
            found.append(BrowserInstall(name, executable))
            seen.add(key)

    if system == "win32":
        specs = (
            (
                "Chrome",
                "chrome.exe",
                (("Google", "Chrome", "Application", "chrome.exe"),),
            ),
            (
                "Edge",
                "msedge.exe",
                (("Microsoft", "Edge", "Application", "msedge.exe"),),
            ),
            (
                "Brave",
                "brave.exe",
                (("BraveSoftware", "Brave-Browser", "Application", "brave.exe"),),
            ),
            ("Chromium", "chromium.exe", ()),
        )
        roots = (
            env.get("ProgramFiles", ""),
            env.get("ProgramFiles(x86)", ""),
            env.get("LOCALAPPDATA", ""),
        )
        for name, binary, suffixes in specs:
            path = shutil.which(binary)
            if not path:
                for root in roots:
                    if not root:
                        continue
                    for suffix in suffixes:
                        candidate = Path(root).joinpath(*suffix)
                        if candidate.is_file():
                            path = str(candidate)
                            break
                    if path:
                        break
            add(name, path)
        return found

    specs = (
        ("Chrome", ("google-chrome", "google-chrome-stable")),
        ("Edge", ("microsoft-edge", "microsoft-edge-stable")),
        ("Brave", ("brave-browser", "brave")),
        ("Chromium", ("chromium", "chromium-browser")),
    )
    for name, binaries in specs:
        for binary in binaries:
            path = shutil.which(binary)
            if path:
                add(name, path)
                break
    return found


def launch_supported_website(
    site_id: str,
    *,
    extension_dir: Path,
    profile_dir: Path,
) -> dict[str, str]:
    site = next((item for item in SUPPORTED_WEBSITES if item.id == site_id), None)
    if site is None:
        raise BrowserLaunchError(f"不支持的网页：{site_id}")

    extension = extension_dir.expanduser().resolve()
    if not (extension / "manifest.json").is_file():
        raise BrowserLaunchError(f"浏览器扩展不存在或缺少 manifest：{extension}")

    browsers = find_browsers()
    if not browsers:
        raise BrowserLaunchError(
            "未找到支持自动加载扩展的 Chromium 浏览器，请安装 Chrome、Edge、Brave 或 Chromium。"
        )
    browser = browsers[0]
    profile = profile_dir.expanduser().resolve()
    profile.mkdir(parents=True, exist_ok=True)
    command = [
        browser.executable,
        f"--user-data-dir={profile}",
        f"--load-extension={extension}",
        "--no-first-run",
        "--no-default-browser-check",
        "--new-window",
        site.url,
    ]
    try:
        process = subprocess.Popen(command)
    except OSError as exc:
        raise BrowserLaunchError(f"启动 {browser.name} 失败：{exc}") from exc
    return {
        "site": site.name,
        "browser": browser.name,
        "profile_dir": str(profile),
        "pid": str(process.pid),
    }
