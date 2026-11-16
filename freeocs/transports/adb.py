"""ADB transport: device management, uiautomator dumps, screenshots and input."""

from __future__ import annotations

import math
import random
import re
import shutil
import subprocess
import sys
import threading
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from ..sdk import AdbError

_BOUNDS_RE = re.compile(r"^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$")
_SIZE_RE = re.compile(r"(?:Override|Physical) size:\s*(\d+)x(\d+)")
_PACKAGE_RE = re.compile(r"mCurrentFocus=.*?\s([A-Za-z0-9_.]+)/")


class AdbManager:
    def __init__(self, settings: Any, *, adb_path: str = "") -> None:
        self.settings = settings
        self._configured_path = adb_path

    @property
    def adb_path(self) -> str:
        configured = self._configured_path or str(self.settings.core_get("android", "adb_path", "") or "")
        if configured.strip():
            return configured.strip()
        found = shutil.which("adb")
        if found:
            return found
        bundled = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent.parent)) / "tools" / "adb"
        if bundled.is_file():
            return str(bundled)
        raise AdbError("未找到 adb，请安装 Android platform-tools 或在设置中填写 adb 路径")

    def list_devices(self) -> list[dict[str, Any]]:
        adb = self.adb_path
        try:
            result = subprocess.run(
                [adb, "devices", "-l"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise AdbError(f"执行 adb devices 失败：{exc}") from exc
        devices: list[dict[str, Any]] = []
        for line in (result.stdout or "").splitlines()[1:]:
            line = line.strip()
            if not line:
                continue
            parts = line.split()
            if len(parts) < 2:
                continue
            item: dict[str, Any] = {
                "serial": parts[0],
                "state": parts[1],
                "raw": line,
            }
            for token in parts[2:]:
                if ":" in token:
                    key, value = token.split(":", 1)
                    item[key] = value
            devices.append(item)
        return devices

    def connect(self, serial: str | None = None) -> AdbDevice:
        devices = self.list_devices()
        chosen = serial or str(self.settings.core_get("android", "device_serial", "") or "").strip()
        if chosen:
            match = next((item for item in devices if item.get("serial") == chosen), None)
            if match is None:
                raise AdbError(f"未找到设备 {chosen}；当前：{_device_summary(devices)}")
            if match.get("state") != "device":
                raise AdbError(f"设备 {chosen} 状态为 {match.get('state')}，请在手机上授权 USB 调试")
            return AdbDevice(self, chosen)
        ready = [item for item in devices if item.get("state") == "device"]
        if not ready:
            raise AdbError(f"没有已授权的设备；当前：{_device_summary(devices)}")
        if len(ready) > 1:
            raise AdbError(
                "检测到多台设备，请在设置中填写设备序列号：" + ", ".join(
                    str(item.get("serial")) for item in ready
                )
            )
        return AdbDevice(self, str(ready[0]["serial"]))


class AdbDevice:
    def __init__(self, manager: AdbManager, serial: str) -> None:
        self.manager = manager
        self.serial = serial
        self._lock = threading.Lock()
        self._screen: tuple[int, int] | None = None

    # -- process -----------------------------------------------------------
    def _run(self, args: list[str], *, timeout: float = 15.0, binary: bool = False) -> bytes | str:
        command = [self.manager.adb_path, "-s", self.serial, *args]
        try:
            with self._lock:
                result = subprocess.run(
                    command,
                    capture_output=True,
                    timeout=max(1.0, float(timeout)),
                    check=False,
                )
        except FileNotFoundError as exc:
            raise AdbError(f"adb 不存在：{command[0]}", command=" ".join(command)) from exc
        except subprocess.TimeoutExpired as exc:
            raise AdbError(
                f"adb 命令超时（{timeout}s）：{' '.join(command)}",
                command=" ".join(command),
            ) from exc
        stderr_raw = result.stderr
        if isinstance(stderr_raw, bytes):
            stderr = stderr_raw.decode("utf-8", "replace")
        else:
            stderr = str(stderr_raw or "")
        if result.returncode != 0:
            raise AdbError(
                f"adb 命令失败（退出码 {result.returncode}）：{stderr.strip()[:500]}",
                command=" ".join(command),
                returncode=result.returncode,
                stderr=stderr,
            )
        stdout_raw = result.stdout
        if binary:
            if isinstance(stdout_raw, str):
                return stdout_raw.encode("utf-8")
            return stdout_raw or b""
        if isinstance(stdout_raw, bytes):
            return stdout_raw.decode("utf-8", "replace")
        return str(stdout_raw or "")

    def shell(self, command: str, *, timeout: float = 15.0) -> str:
        value = self._run(["shell", command], timeout=timeout)
        return value if isinstance(value, str) else value.decode("utf-8", "replace")

    # -- screen ------------------------------------------------------------
    def screen_size(self, *, refresh: bool = False) -> tuple[int, int]:
        if self._screen is not None and not refresh:
            return self._screen
        output = self.shell("wm size", timeout=10)
        matches = _SIZE_RE.findall(output)
        if not matches:
            raise AdbError(f"无法解析屏幕尺寸：{output.strip()[:200]}")
        # Prefer override size (last match).
        width, height = int(matches[-1][0]), int(matches[-1][1])
        self._screen = (width, height)
        return self._screen

    def dump_hierarchy(self, *, timeout: float = 15.0) -> str:
        errors: list[str] = []
        for path in ("/sdcard/window_dump.xml", "/data/local/tmp/window_dump.xml"):
            for attempt in range(2):
                try:
                    self.shell(f"uiautomator dump {path}", timeout=timeout)
                    text = self.shell(f"cat {path}", timeout=timeout)
                    start = text.find("<hierarchy")
                    end = text.rfind("</hierarchy>")
                    if start >= 0 and end > start:
                        xml = text[start:end + len("</hierarchy>")]
                        ET.fromstring(xml)
                        return xml
                    errors.append(f"{path}: 未找到 hierarchy")
                except (AdbError, ET.ParseError) as exc:
                    errors.append(f"{path}: {exc}")
                time.sleep(0.3 + attempt * 0.3)
        raise AdbError("无法读取控件树：" + " | ".join(errors[-3:]))

    def screenshot(self, *, timeout: float = 20.0) -> bytes:
        data = self._run(["exec-out", "screencap", "-p"], timeout=timeout, binary=True)
        assert isinstance(data, bytes)
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            return data
        # Some devices break exec-out; fall back to pull.
        temp_path = "/sdcard/freeocs-screen.png"
        self.shell(f"screencap -p {temp_path}", timeout=timeout)
        data = self._run(["exec-out", "cat", temp_path], timeout=timeout, binary=True)
        assert isinstance(data, bytes)
        if not data.startswith(b"\x89PNG\r\n\x1a\n"):
            raise AdbError("截图返回的不是 PNG 数据")
        return data

    # -- input -------------------------------------------------------------
    def tap(self, x: int, y: int, *, jitter: int = 0) -> None:
        width, height = self.screen_size()
        tap_x, tap_y = int(x), int(y)
        if jitter > 0:
            angle = random.uniform(0, math.tau)
            radius = random.uniform(0, float(jitter))
            tap_x += round(math.cos(angle) * radius)
            tap_y += round(math.sin(angle) * radius)
        tap_x = max(0, min(width - 1, tap_x))
        tap_y = max(0, min(height - 1, tap_y))
        self.shell(f"input tap {tap_x} {tap_y}", timeout=10)

    def swipe(self, x1: int, y1: int, x2: int, y2: int, *, duration_ms: int = 300) -> None:
        self.shell(
            f"input swipe {int(x1)} {int(y1)} {int(x2)} {int(y2)} {int(duration_ms)}",
            timeout=15,
        )

    def input_text(self, text: str) -> None:
        if not text:
            return
        if not text.isascii():
            raise AdbError("adb input text 仅支持 ASCII；中文输入请安装 ADBKeyboard 或手动填写")
        escaped = text.replace("%", "\\%").replace(" ", "%s")
        self.shell(f'input text "{escaped}"', timeout=15)

    def keyevent(self, keycode: int | str) -> None:
        self.shell(f"input keyevent {keycode}", timeout=10)

    def current_package(self) -> str:
        try:
            output = self.shell("dumpsys window | grep mCurrentFocus", timeout=10)
        except AdbError:
            output = ""
        match = _PACKAGE_RE.search(output)
        return match.group(1) if match else ""

    def close(self) -> None:
        return None


def _device_summary(devices: list[dict[str, Any]]) -> str:
    if not devices:
        return "无设备"
    return ", ".join(f"{item.get('serial')}({item.get('state')})" for item in devices)
