# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

"""Browser-agent module for the Zhihuishu course and quiz workflow."""

from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from datetime import datetime
from typing import Any
from urllib.parse import urlparse

from freeocs.sdk import Module, ModuleContext, ModuleError

STORAGE_FORMAT = "freeocs.wisdomtree.agent-state"
STORAGE_VERSION = 1
STORAGE_LIMIT = 1024 * 1024
LEASE_TIMEOUT = 10.0
QUESTION_TYPES = {"single", "multiple", "judge", "fill", "short"}


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _allowed_page_url(value: Any) -> str:
    url = str(value or "").strip()
    parsed = urlparse(url)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or not (
            parsed.hostname.lower() == "zhihuishu.com"
            or parsed.hostname.lower().endswith(".zhihuishu.com")
        )
    ):
        raise ModuleError("请求必须来自智慧树网页")
    return url[:2048]


def _parse_answers(reply: str) -> list[str]:
    text = re.sub(r"^\s*```(?:json)?\s*|\s*```\s*$", "", reply, flags=re.IGNORECASE)
    decoder = json.JSONDecoder()
    try:
        parsed: Any = json.loads(text)
    except json.JSONDecodeError:
        parsed = None
        for index, character in enumerate(text):
            if character == "{":
                try:
                    parsed, _ = decoder.raw_decode(text[index:])
                    break
                except json.JSONDecodeError:
                    continue
    if not isinstance(parsed, dict):
        raise ModuleError("模型未返回有效 JSON 答案")
    answers = parsed.get("answers", parsed.get("answer"))
    if isinstance(answers, dict):
        answers = list(answers.values())
    if isinstance(answers, str):
        answers = [answers]
    if not isinstance(answers, list) or not answers:
        raise ModuleError("模型响应缺少非空 answers 数组")
    if any(not isinstance(answer, (str, int, float)) for answer in answers):
        raise ModuleError("模型 answers 必须只包含文本答案")
    normalized = [str(answer).strip() for answer in answers]
    if any(not answer for answer in normalized):
        raise ModuleError("模型返回了空答案")
    return normalized


def _question_prompt(question: dict[str, Any]) -> str:
    stem = question.get("stem")
    question_type = question.get("type")
    options = question.get("options", [])
    blanks = question.get("blanks", 0)
    if not isinstance(stem, str) or not stem.strip():
        raise ModuleError("question.stem 不能为空")
    if question_type not in QUESTION_TYPES:
        raise ModuleError("不支持的题型")
    if not isinstance(options, list) or len(options) > 100:
        raise ModuleError("question.options 必须是最多 100 项的数组")
    if isinstance(blanks, bool) or not isinstance(blanks, int) or blanks < 0:
        raise ModuleError("question.blanks 必须是非负整数")

    option_lines = []
    for option in options:
        if not isinstance(option, dict):
            raise ModuleError("每个选项必须是 JSON 对象")
        key = str(option.get("key", "")).strip()[:20]
        text = str(option.get("text", "")).strip()[:1000]
        if key or text:
            option_lines.append(f"{key}. {text}".strip(". "))

    type_names = {
        "single": "单选题",
        "multiple": "多选题",
        "judge": "判断题",
        "fill": "填空题",
        "short": "主观题/简答题",
    }
    if question_type in {"single", "multiple", "judge"}:
        answer_rule = "答案必须使用选项 key；单选/判断返回一个 key，多选返回多个 key。"
    elif question_type == "fill":
        answer_rule = f"按空的顺序返回答案数组（空数约为 {blanks}）。"
    else:
        answer_rule = "返回简洁、准确的作答内容，放在 answers 数组中。"

    prompt = [f"题型：{type_names[question_type]}", f"题目：{stem.strip()[:12000]}"]
    if option_lines:
        prompt.extend(["选项：", *option_lines])
    prompt.extend(
        [
            answer_rule,
            '只输出合法 JSON，不要使用 Markdown 或解释，格式为 {"answers":["..."]}。',
        ]
    )
    return "\n".join(prompt)


class WisdomTreeModule(Module):
    id = "wisdomtree"
    name = "智慧树"

    def __init__(self, ctx: ModuleContext) -> None:
        super().__init__(ctx)
        self._lock = threading.RLock()
        self._active = False
        self._running = False
        self._revision = 0
        self._lease_client = ""
        self._lease_tab_id = ""
        self._lease_seen = 0.0
        self._target_tab_id = ""
        self._page_url = ""
        self._page_title = ""
        self._page_mode = ""
        self._question_type = ""
        self._question = ""
        self._options: list[str] = []
        self._last_answer = ""
        self._last_click: dict[str, Any] = {}
        self._message = "等待智慧树页面"
        self._state = "idle"
        self._updated_at = _now()
        self._completed_sets = 0
        self._answered = 0
        self._errors = 0
        self._agent_last_seen = 0.0
        self._storage_path = ctx.data_dir / "agent-state.json"
        self._storage_lock = threading.Lock()

    def start(self) -> None:
        target_tab_id = self._choose_target_tab()
        with self._lock:
            self._active = True
            self._running = True
            self._revision += 1
            self._target_tab_id = target_tab_id
            self._lease_client = ""
            self._lease_tab_id = ""
            self._lease_seen = 0.0
            self._completed_sets = 0
            self._answered = 0
            self._errors = 0
            self._last_answer = ""
            self._state = "running"
            self._message = "等待当前智慧树标签页连接" if target_tab_id else "等待智慧树页面连接"
            self._touch()
        self.ctx.log("info", f"已请求开始智慧树自动化（目标标签页 {target_tab_id or '自动'}）")

    def stop(self) -> None:
        with self._lock:
            self._active = False
            self._running = False
            self._revision += 1
            self._lease_client = ""
            self._lease_tab_id = ""
            self._state = "idle"
            self._message = "已停止"
            self._touch()
        self.ctx.log("info", "智慧树自动化已停止")

    def status(self) -> dict[str, Any]:
        with self._lock:
            connected = time.time() - self._agent_last_seen < 10
            return {
                "running": self._running,
                "state": self._state,
                "message": self._message,
                "progress": {
                    "current": self._answered,
                    "total": 0,
                    "label": "已答题" if self._answered else "",
                },
                "stats": {
                    "completed_sets": self._completed_sets,
                    "answered": self._answered,
                    "errors": self._errors,
                },
                "updated_at": self._updated_at,
                "extra": {
                    "connected": connected,
                    "page_url": self._page_url,
                    "page_title": self._page_title,
                    "page_mode": self._page_mode,
                    "question_type": self._question_type,
                    "question": self._question[:500],
                    "options": list(self._options[:10]),
                    "last_answer": self._last_answer,
                    "last_click": dict(self._last_click),
                    "target_tab_id": self._target_tab_id,
                    "auto_submit": bool(self.ctx.settings.get("auto_submit", False)),
                },
            }

    def actions(self) -> list[dict[str, Any]]:
        return [{"id": "read", "label": "读取当前页", "style": "default"}]

    def invoke(self, action: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        if action == "read":
            with self._lock:
                if not self._active:
                    return {"ok": False, "message": "请先开始，并确保智慧树网页已连接"}
                self._message = "已请求读取当前页面"
                self._touch()
            return {"ok": True, "message": "页面 Agent 将在下次心跳时更新页面状态"}
        raise ModuleError(f"未知动作：{action}")

    def on_settings_changed(self, values: dict[str, Any]) -> None:
        with self._lock:
            if self._active:
                self._message = "智慧树设置已更新"
                self._touch()

    def handle_agent_request(self, method: str, payload: dict[str, Any]) -> Any:
        handlers = {
            "poll": self._poll,
            "event": self._event,
            "answer": self._answer,
            "storage-load": self._storage_load,
            "storage-save": self._storage_save,
            "state": lambda _payload: self.status(),
        }
        handler = handlers.get(method)
        if handler is None:
            raise ModuleError(f"未知智慧树页面接口：{method}")
        return handler(payload or {})

    def _choose_target_tab(self) -> str:
        web = self.ctx.web
        if web is None or not getattr(web, "connected", False):
            return ""
        try:
            tabs = web.list_tabs()
        except Exception as exc:  # noqa: BLE001
            self.ctx.log("warn", f"读取浏览器标签页失败：{exc}")
            return ""
        candidates = [tab for tab in tabs if self._is_wisdomtree_url(str(tab.get("url", "")))]
        if not candidates:
            return ""
        active = [tab for tab in candidates if tab.get("active")]
        chosen = active[0] if active else candidates[0]
        tab_id = str(chosen.get("id", "") or "")
        if tab_id:
            try:
                web.set_target(tab_id)
            except Exception as exc:  # noqa: BLE001
                self.ctx.log("warn", f"绑定智慧树标签页失败：{exc}")
        return tab_id

    @staticmethod
    def _is_wisdomtree_url(url: str) -> bool:
        try:
            host = urlparse(url).hostname or ""
        except ValueError:
            return False
        host = host.lower()
        return host == "zhihuishu.com" or host.endswith(".zhihuishu.com")

    def _poll(self, payload: dict[str, Any]) -> dict[str, Any]:
        page_url = _allowed_page_url(payload.get("url"))
        client_id = str(payload.get("client_id", "") or "")
        tab_id = str(payload.get("__tab_id", "") or "")
        if not client_id or len(client_id) > 100:
            raise ModuleError("页面 Agent client_id 无效")
        now = time.time()
        with self._lock:
            if self._active and self._target_tab_id and tab_id != self._target_tab_id:
                return self._poll_response(lease=False)
            same_tab = bool(tab_id and tab_id == self._lease_tab_id)
            lease_expired = now - self._lease_seen > LEASE_TIMEOUT
            if self._active and (
                self._lease_client == client_id
                or same_tab
                or not self._lease_client
                or lease_expired
            ):
                if payload.get("has_content") or same_tab or self._lease_client == client_id:
                    self._lease_client = client_id
                    self._lease_tab_id = tab_id
                    self._lease_seen = now
            lease = bool(self._active and self._lease_client == client_id)
            if lease or not self._active:
                self._agent_last_seen = now
                self._page_url = page_url
                self._page_title = str(payload.get("title", "") or "")[:500]
                self._page_mode = str(payload.get("mode", "") or "")[:40]
            if lease and self._state == "running":
                self._message = f"已连接智慧树页面（{self._page_mode or '页面'}）"
                self._touch()
            return self._poll_response(lease=lease)

    def _poll_response(self, *, lease: bool) -> dict[str, Any]:
        settings = self.ctx.settings.all()
        return {
            "active": self._active,
            "desired_running": self._active and lease,
            "revision": self._revision,
            "lease": lease,
            "status": self._message,
            "click": {
                "interval_ms": int(settings.get("click_interval_ms", 1500)),
                "jitter_ms": int(settings.get("click_jitter_ms", 500)),
            },
            "auto_submit": bool(settings.get("auto_submit", False)),
            "settings": settings,
        }

    def _event(self, payload: dict[str, Any]) -> dict[str, Any]:
        event_type = str(payload.get("type", "") or "")
        agent_id = str(payload.get("agent_id", "") or "")
        if not agent_id or len(agent_id) > 100:
            raise ModuleError("页面 Agent ID 无效")
        tab_id = str(payload.get("__tab_id", "") or "")
        with self._lock:
            if (
                event_type != "log"
                and self._active
                and (
                    agent_id != self._lease_client
                    or tab_id != self._lease_tab_id
                    or time.time() - self._lease_seen > LEASE_TIMEOUT
                )
            ):
                raise ModuleError("当前页面没有智慧树自动化控制权")
            self._agent_last_seen = time.time()
            if event_type == "log":
                message = str(payload.get("message", "") or "").strip()[:1000]
                if message:
                    self.ctx.log(
                        "error" if payload.get("is_error") else "info",
                        message,
                        page_url=self._page_url,
                    )
            elif event_type in {"status", "page"}:
                status = payload.get("status", {})
                if not isinstance(status, dict):
                    raise ModuleError("status 必须是对象")
                if status.get("url"):
                    self._page_url = _allowed_page_url(status.get("url"))
                if status.get("title"):
                    self._page_title = str(status["title"])[:500]
                if status.get("mode"):
                    self._page_mode = str(status["mode"])[:40]
                if "running" in status:
                    self._running = bool(status.get("running")) and self._active
                metrics = status.get("metrics") or {}
                if isinstance(metrics, dict):
                    self._answered = max(self._answered, _count(metrics.get("questionsAnswered")))
                    self._completed_sets = max(
                        self._completed_sets,
                        _count(metrics.get("completedSets")),
                    )
                    self._errors = max(self._errors, _count(metrics.get("errors")))
                self._message = str(status.get("status", "") or self._message)[:500]
                self._state = "running" if self._running else self._state
                self._touch()
            elif event_type == "click":
                label = str(payload.get("label", "") or "").strip()
                if not label:
                    raise ModuleError("click label 不能为空")
                self._last_click = {
                    "label": label[:200],
                    "target": str(payload.get("target", "") or "")[:300],
                    "interval_ms": _count(payload.get("interval_ms")),
                    "time": _now(),
                }
                self._touch()
                self.ctx.emit("click", self._last_click, message=f"点击：{label}")
            elif event_type == "finished":
                message = str(payload.get("message", "") or self._message)[:500]
                self._active = False
                self._running = False
                waiting = any(word in message for word in ("提交", "等待手动", "人工"))
                self._state = "waiting" if waiting else "idle"
                self._message = message or "智慧树任务已完成"
                self._revision += 1
                self._touch()
            elif event_type == "stopped":
                self._active = False
                self._running = False
                self._state = "idle"
                self._message = str(payload.get("message", "") or "智慧树任务已停止")[:500]
                self._revision += 1
                self._touch()
            else:
                raise ModuleError(f"不支持的 Agent 事件：{event_type}")
        return {"ok": True}

    def _answer(self, payload: dict[str, Any]) -> dict[str, Any]:
        page_url = _allowed_page_url(payload.get("url") or self._page_url)
        agent_id = str(payload.get("agent_id", "") or "")
        tab_id = str(payload.get("__tab_id", "") or "")
        question = payload.get("question")
        if not isinstance(question, dict):
            raise ModuleError("请求必须包含 question 对象")
        with self._lock:
            if (
                not self._active
                or not agent_id
                or agent_id != self._lease_client
                or tab_id != self._lease_tab_id
                or time.time() - self._lease_seen > LEASE_TIMEOUT
            ):
                raise ModuleError("当前页面没有智慧树自动化控制权")
            if self._target_tab_id and tab_id != self._target_tab_id:
                raise ModuleError("当前标签页不是目标智慧树页面")
            self._lease_seen = time.time()
        prompt = _question_prompt(question)
        llm = self.ctx.require("llm.chat")
        timeout = float(self.ctx.settings.get("answer_timeout", 120) or 120)
        started = time.perf_counter()
        system = "你是严谨的课程学习助手。按题目要求作答，优先使用题目材料，不编造信息。"
        result = llm.chat(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            temperature=float(self.ctx.settings.get("answer_temperature", 0.2)),
            timeout=timeout,
        )
        raw = str((result.message or {}).get("content") or "")
        if not raw.strip():
            raise ModuleError("模型服务没有返回文本答案")
        try:
            answers = _parse_answers(raw)
        except ModuleError:
            retry_prompt = (
                prompt
                + '\n上一次输出格式无效。请重新作答，只输出 {"answers":["答案"]} 这一种 JSON 格式。'
            )
            result = llm.chat(
                [
                    {"role": "system", "content": system},
                    {"role": "user", "content": retry_prompt},
                ],
                temperature=float(self.ctx.settings.get("answer_temperature", 0.2)),
                timeout=timeout,
            )
            raw = str((result.message or {}).get("content") or "")
            answers = _parse_answers(raw)
        with self._lock:
            self._page_url = page_url
            self._question_type = str(question.get("type", ""))[:40]
            self._question = str(question.get("stem", ""))[:12000]
            self._options = [
                str(item.get("key", "")) + ". " + str(item.get("text", ""))
                for item in question.get("options", [])
                if isinstance(item, dict)
            ][:30]
            self._last_answer = ", ".join(answers)[:2000]
            self._answered += 1
            self._message = f"已生成答案：{self._question_type}"
            self._touch()
        self.ctx.emit(
            "answer",
            {
                "question_type": self._question_type,
                "question": self._question[:1000],
                "answers": answers,
                "latency_ms": round((time.perf_counter() - started) * 1000),
            },
            message="已生成智慧树答案",
        )
        return {
            "answers": answers,
            "latency_ms": round((time.perf_counter() - started) * 1000),
        }

    def _storage_load(self, _payload: dict[str, Any]) -> dict[str, Any]:
        with self._storage_lock:
            try:
                if self._storage_path.stat().st_size > STORAGE_LIMIT:
                    raise ModuleError("智慧树页面状态文件过大，未覆盖原文件")
                data = json.loads(self._storage_path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                return {"data": {}}
            except ModuleError:
                raise
            except (OSError, json.JSONDecodeError) as exc:
                raise ModuleError(f"无法读取智慧树页面状态：{exc}") from exc
            if (
                not isinstance(data, dict)
                or data.get("format") != STORAGE_FORMAT
                or data.get("version") != STORAGE_VERSION
                or not isinstance(data.get("data"), dict)
                or len(data.get("data", {})) > 100
                or any(not isinstance(key, str) or len(key) > 100 for key in data.get("data", {}))
            ):
                raise ModuleError("智慧树页面状态格式未知或已损坏，未覆盖原文件")
            return {"data": data["data"]}

    def _storage_save(self, payload: dict[str, Any]) -> dict[str, Any]:
        data = payload.get("data")
        if not isinstance(data, dict):
            raise ModuleError("页面状态 data 必须是对象")
        if len(data) > 100 or any(not isinstance(key, str) or len(key) > 100 for key in data):
            raise ModuleError("页面状态字段过多或键名无效")
        agent_id = str(payload.get("agent_id", "") or "")
        tab_id = str(payload.get("__tab_id", "") or "")
        with self._lock:
            if self._active and (
                agent_id != self._lease_client
                or tab_id != self._lease_tab_id
                or time.time() - self._lease_seen > LEASE_TIMEOUT
            ):
                raise ModuleError("当前页面没有智慧树自动化控制权")
        try:
            encoded = json.dumps(
                {
                    "format": STORAGE_FORMAT,
                    "version": STORAGE_VERSION,
                    "data": data,
                },
                ensure_ascii=False,
                indent=2,
            )
        except (TypeError, ValueError) as exc:
            raise ModuleError(f"页面状态不能序列化：{exc}") from exc
        if len(encoded.encode("utf-8")) > STORAGE_LIMIT:
            raise ModuleError("页面状态过大")
        with self._storage_lock:
            temp_path = self._storage_path.with_name(
                f"{self._storage_path.name}.{uuid.uuid4().hex}.tmp"
            )
            try:
                self._storage_path.parent.mkdir(parents=True, exist_ok=True)
                temp_path.write_text(encoded, encoding="utf-8")
                os.replace(temp_path, self._storage_path)
            except OSError as exc:
                try:
                    temp_path.unlink(missing_ok=True)
                except OSError:
                    self.ctx.log("warn", f"清理智慧树临时状态文件失败：{temp_path}")
                raise ModuleError(f"无法保存智慧树页面状态：{exc}") from exc
        return {"saved": True}

    def _touch(self) -> None:
        self._updated_at = _now()


def _count(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def setup(api: ModuleContext) -> None:
    api.register_module(WisdomTreeModule(api))
