"""WisdomTree Android module: ADB + uiautomator + LLM agent."""

from __future__ import annotations

import re
import threading
import time
import xml.etree.ElementTree as ET
from typing import Any

from freeocs.sdk import Module, ModuleContext, ModuleRunner

from .agent import AnswerAgent
from .readers.base import Button, Option, PageData, center_of
from .readers.wisdomtree import PACKAGE_NAME, WisdomTreeReader

SYSTEM_PROMPT = (
    "你是一个手机答题助手。通过工具读取页面、点击选项、进入下一题，直到完成所有题目。"
    "选择题只点击与答案对应的选项；多选题可以多次调用 click_option 或一次 click_options。"
    "检测到提交/交卷按钮时绝对不要点击，工具会返回 finished=true，应立即结束。"
    "不要猜测无法识别的题目；无法继续时调用 finish 说明原因。"
)
SUBMIT_WORDS = ("提交", "交卷", "完成", "结束", "保存并提交")
NEXT_WORDS = ("下一题", "下一步", "继续", "下一页")
OPTION_RE = re.compile(r"^([A-Za-z])\s*[\.、\)．]\s*(.+)$")
LOW_QUALITY = {"undefined", "null", "NaN", "true", "false"}


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _sanitize_xml(xml: str) -> str:
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", xml)


class WisdomTreeModule(Module):
    id = "wisdomtree"
    name = "智慧树"

    def __init__(self, ctx: ModuleContext) -> None:
        super().__init__(ctx)
        self.runner = ModuleRunner(self)
        self._lock = threading.RLock()
        self._device = ""
        self._screen = (0, 0)
        self._page: PageData | None = None
        self._last_clicked = ""
        self._submit_detected = False
        self._finish_reason = ""
        self._tool_events: list[dict[str, Any]] = []
        self._reader = WisdomTreeReader()

    # -- Module API --------------------------------------------------------
    def start(self) -> None:
        if self.runner.running:
            return
        with self._lock:
            self._page = None
            self._last_clicked = ""
            self._submit_detected = False
            self._finish_reason = ""
            self._tool_events.clear()
        self.runner.set_extra(
            device="",
            screen="",
            question_type="",
            question="",
            options=[],
            last_clicked="",
            tools=[],
        )
        self.runner.start(self._loop, initial_message="正在连接手机…")
        self.ctx.log("info", "已请求开始；等待 ADB 设备")

    def stop(self) -> None:
        self.runner.stop("正在停止…")
        self.runner.join(5)
        self.ctx.log("info", "已请求停止")

    def status(self) -> dict[str, Any]:
        state = self.runner.status()
        with self._lock:
            extra = {
                "device": self._device,
                "screen": f"{self._screen[0]}x{self._screen[1]}" if self._screen[0] else "",
                "question_type": self._page.question_type if self._page else "",
                "question": (self._page.question if self._page else "")[:500],
                "options": [item.text for item in (self._page.options if self._page else [])][:10],
                "last_clicked": self._last_clicked,
                "tools": list(self._tool_events[-20:]),
            }
        state["extra"] = {**(state.get("extra") or {}), **extra}
        state["stats"] = {
            "answered": int((state.get("stats") or {}).get("answered", 0)),
            "errors": int((state.get("stats") or {}).get("errors", 0)),
        }
        return state

    def actions(self) -> list[dict[str, Any]]:
        return []

    # -- worker ------------------------------------------------------------
    def _loop(self, stop_event: threading.Event) -> None:
        try:
            serial = str(self.ctx.settings.get("device_serial", "") or "") or None
            device = self.ctx.adb.connect(serial)
            width, height = device.screen_size()
            with self._lock:
                self._device = device.serial
                self._screen = (width, height)
            self.runner.set_extra(device=device.serial, screen=f"{width}x{height}")
            self.ctx.log("info", f"已连接设备 {device.serial}（{width}x{height}）")

            agent = AnswerAgent(
                self.ctx.require("llm.chat"),
                system_prompt=SYSTEM_PROMPT,
                max_tool_rounds=int(self.ctx.settings.get("max_tool_rounds", 30) or 30),
                temperature=float(self.ctx.settings.get("temperature", 0.0) or 0.0),
                timeout=float(self.ctx.settings.get("answer_timeout", 300) or 300),
                on_event=self._on_tool_event,
            )
            self._register_tools(agent, device, width, height, stop_event)
            self.runner.set_message("已连接设备，AI 开始答题")
            final = agent.run("开始答题。请先调用 read_page 查看当前页面，然后作答。")
            if stop_event.is_set():
                self.runner.set_message("已停止")
            elif self._submit_detected:
                self.runner.set_message("已到提交/交卷页，未点击；请手动完成", state="waiting")
            elif self._finish_reason:
                self.runner.set_message(self._finish_reason)
            else:
                self.runner.set_message(final or "答题结束")
        except Exception as exc:  # noqa: BLE001 - module boundary
            self.runner.fail(f"运行失败：{exc}")
            self.ctx.log("error", f"运行失败：{exc}")
            try:
                self.ctx.emit("error", {"error": str(exc)}, level="error", message=str(exc))
            except Exception:
                pass

    def _register_tools(self, agent: AnswerAgent, device: Any, width: int, height: int,
                        stop_event: threading.Event) -> None:
        def read_page() -> dict[str, Any]:
            if stop_event.is_set():
                return {"error": "已停止"}
            page = self._read_page(device, width, height)
            if page is None:
                return {"error": "当前页面无法识别"}
            with self._lock:
                self._page = page
            self.runner.set_extra(
                question_type=page.question_type,
                question=page.question[:500],
                options=[item.text for item in page.options][:10],
            )
            self.ctx.emit(
                "question",
                {
                    "question_type": page.question_type,
                    "question": page.question[:1000],
                    "options": [item.text for item in page.options],
                },
                message="读取页面",
            )
            return {
                "question_type": page.question_type,
                "question": page.question,
                "options": [item.text for item in page.options],
                "buttons": [item.text for item in page.buttons],
            }

        def click_option(option_text: str) -> dict[str, Any]:
            page = self._page
            if page is None:
                page = self._read_page(device, width, height)
            if page is None:
                return {"error": "当前页面无法识别"}
            target = _match_option(page, str(option_text))
            if target is None:
                return {
                    "error": f"未找到选项：{option_text}",
                    "available": [item.text for item in page.options],
                }
            jitter = int(self.ctx.settings.get("click_jitter", 2) or 2)
            device.tap(target.x, target.y, jitter=jitter)
            with self._lock:
                self._last_clicked = target.text
                self._page = page
            self.runner.add_stat("answered", 1)
            self._sleep_random()
            return {"ok": True, "clicked": target.text}

        def click_options(option_texts: list[str]) -> dict[str, Any]:
            clicked: list[str] = []
            for text in option_texts or []:
                result = click_option(str(text))
                if not result.get("ok"):
                    return {"ok": False, "error": result.get("error"), "clicked": clicked}
                clicked.append(str(result.get("clicked", "")))
            return {"ok": True, "clicked": clicked}

        def click_next() -> dict[str, Any]:
            page = self._read_page(device, width, height)
            if page is None:
                return {"error": "当前页面无法识别"}
            with self._lock:
                self._page = page
            for button in page.buttons:
                if any(word in button.text for word in SUBMIT_WORDS):
                    self._submit_detected = True
                    return {
                        "ok": True,
                        "button": button.text,
                        "finished": True,
                        "message": f"检测到“{button.text}”，未点击",
                    }
            for button in page.buttons:
                if any(word in button.text for word in NEXT_WORDS):
                    device.tap(button.x, button.y, jitter=0)
                    self._sleep_random()
                    return {"ok": True, "button": button.text, "finished": False}
            return {"error": "未找到下一题或提交按钮"}

        def finish(reason: str = "") -> dict[str, Any]:
            self._finish_reason = str(reason or "AI 结束答题")
            return {"ok": True, "message": self._finish_reason}

        agent.register_tool(
            "read_page",
            "读取当前手机页面的题目、选项和按钮。每次操作后建议重新调用以确认状态。",
            {"type": "object", "properties": {}, "required": []},
            read_page,
        )
        agent.register_tool(
            "click_option",
            "点击一个选项。option_text 必须与 read_page 返回的选项文字一致。",
            {
                "type": "object",
                "properties": {"option_text": {"type": "string", "description": "选项文字"}},
                "required": ["option_text"],
            },
            click_option,
        )
        agent.register_tool(
            "click_options",
            "多选题一次点击多个选项。option_texts 是选项文字数组。",
            {
                "type": "object",
                "properties": {
                    "option_texts": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "要点击的选项文字列表",
                    }
                },
                "required": ["option_texts"],
            },
            click_options,
        )
        agent.register_tool(
            "click_next",
            "点击下一题/下一步。若当前是提交/交卷页，返回 finished=true 且不点击。",
            {"type": "object", "properties": {}, "required": []},
            click_next,
        )
        agent.register_tool(
            "finish",
            "结束答题。所有题目完成或无法继续时调用。",
            {
                "type": "object",
                "properties": {"reason": {"type": "string", "description": "结束原因"}},
                "required": [],
            },
            finish,
        )

    # -- page reading ------------------------------------------------------
    def _read_page(self, device: Any, width: int, height: int) -> PageData | None:
        last_error = ""
        is_target = False
        for attempt in range(3):
            try:
                xml = device.dump_hierarchy(
                    timeout=float(self.ctx.settings.get("dump_timeout", 15) or 15)
                )
                root = ET.fromstring(_sanitize_xml(xml))
                if not self._reader.can_handle(root):
                    last_error = "当前页面不是智慧树答题页"
                    is_target = False
                    break
                is_target = True
                page = self._reader.parse(root, width, height)
                if page.question or page.options:
                    return page
                last_error = "没有读到题干或选项"
            except Exception as exc:  # noqa: BLE001
                last_error = str(exc)
            time.sleep(0.4 + attempt * 0.3)
        if not is_target:
            return None
        if bool(self.ctx.settings.get("ocr_fallback", True)):
            try:
                if device.current_package() != PACKAGE_NAME:
                    return None
            except Exception:
                return None
            if last_error:
                self.ctx.log("warn", f"控件树读取失败，尝试 OCR：{last_error}")
            try:
                ocr_page = self._read_page_ocr(device)
                if ocr_page is not None:
                    return ocr_page
            except Exception as exc:  # noqa: BLE001
                self.ctx.log("warn", f"OCR 兜底失败：{exc}")
        return None

    def _read_page_ocr(self, device: Any) -> PageData | None:
        ocr = self.ctx.optional("media.ocr")
        if ocr is None:
            return None
        png = device.screenshot(
            timeout=float(self.ctx.settings.get("screenshot_timeout", 20) or 20)
        )
        result = ocr.extract(png)
        if not result.blocks:
            return None
        threshold = float(self.ctx.settings.get("ocr_min_confidence", 0.5) or 0.5)
        page = PageData(page_type="ocr", raw_text=result.text)
        lines: list[str] = []
        for block in result.blocks:
            text = block.text.strip()
            if not text or block.confidence < threshold:
                continue
            lines.append(text)
            match = OPTION_RE.match(text)
            if match and len(match.group(2)) <= 100:
                x1, y1, x2, y2 = block.box
                x, y = center_of((int(x1), int(y1), int(x2), int(y2)))
                page.options.append(Option(text=text, x=x, y=y, raw_id=match.group(1)))
            if any(word in text for word in SUBMIT_WORDS + NEXT_WORDS):
                x1, y1, x2, y2 = block.box
                x, y = center_of((int(x1), int(y1), int(x2), int(y2)))
                page.buttons.append(Button(text=text, x=x, y=y))
        if not page.options:
            return None
        page.question = "\n".join(lines)
        return page

    # -- helpers -----------------------------------------------------------
    def _on_tool_event(self, event: dict[str, Any]) -> None:
        name = str(event.get("name", ""))
        kind = str(event.get("type", ""))
        with self._lock:
            self._tool_events.append({"time": _now(), "type": kind, "name": name,
                                      "data": event.get("result") or event.get("arguments")})
            self._tool_events = self._tool_events[-100:]
        if kind == "tool_call":
            self.ctx.log("debug", f"AI 调用工具：{name}")
        elif kind == "tool_result":
            result = event.get("result") or {}
            if isinstance(result, dict) and result.get("clicked"):
                self.ctx.log("info", f"点击了：{result['clicked']}")
            elif isinstance(result, dict) and result.get("finished"):
                self.ctx.log("warn", f"检测到提交页：{result.get('message', '')}")
        self.ctx.emit("tool", {"tool": name, "event": kind, "result": event.get("result")},
                      message=f"工具 {name}")

    def _sleep_random(self) -> None:
        low = max(0.0, float(self.ctx.settings.get("interval_min", 0.2) or 0))
        high = max(low, float(self.ctx.settings.get("interval_max", 0.6) or low))
        delay = low if high <= low else low + (high - low) * 0.5
        time.sleep(delay)


def _match_option(page: PageData, text: str) -> Option | None:
    target = text.strip()
    for option in page.options:
        if option.text.strip() == target:
            return option
    for option in page.options:
        if target in option.text or option.text in target:
            return option
    return None


def setup(api: ModuleContext) -> None:
    api.register_module(WisdomTreeModule(api))
