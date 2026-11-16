"""U校园 module: session state, page-agent endpoints and LLM/ASR/TTS glue."""

from __future__ import annotations

import base64
import binascii
import json
import threading
import time
import uuid
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from freeocs.sdk import Module, ModuleContext, ModuleError, ProviderError

from .prompts import build_prompt, parse_answer


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


class UcampusModule(Module):
    id = "ucampus"
    name = "U校园"

    def __init__(self, ctx: ModuleContext) -> None:
        super().__init__(ctx)
        self._lock = threading.RLock()
        self._active = False
        self._running = False
        self._run_id = ""
        self._lease_client = ""
        self._lease_seen = 0.0
        self._commands: deque[dict[str, Any]] = deque(maxlen=20)
        self._logs: deque[dict[str, Any]] = deque(maxlen=200)
        self._page_url = ""
        self._page_title = ""
        self._question_type = ""
        self._question = ""
        self._options: list[str] = []
        self._last_answer = ""
        self._completed = 0
        self._answered = 0
        self._skipped = 0
        self._errors = 0
        self._state = "idle"
        self._message = "等待开始"
        self._updated_at = _now()
        self._transcript_cache: dict[str, dict[str, Any]] = {}
        self._auto_started_url = ""
        self._target_tab_id = ""

    # -- Module API --------------------------------------------------------
    def start(self) -> None:
        self._activate(self._choose_target_tab())

    def _choose_target_tab(self) -> str:
        """Prefer an active U校园 tab, searching tabs in every browser window."""
        web = self.ctx.web
        if web is None or not getattr(web, "connected", False):
            return ""
        try:
            tabs = web.list_tabs(timeout=3)
        except Exception as exc:  # noqa: BLE001
            self.ctx.log("warn", f"读取浏览器标签页失败：{exc}")
            return ""
        candidates = [
            tab for tab in tabs
            if "unipus.cn" in str(tab.get("url", ""))
        ]
        if not candidates:
            return ""
        active = [tab for tab in candidates if tab.get("active")]
        chosen = active[0] if active else candidates[0]
        tab_id = str(chosen.get("id", "") or "")
        if tab_id:
            try:
                web.set_target(tab_id, timeout=3)
            except Exception as exc:  # noqa: BLE001
                self.ctx.log("warn", f"绑定目标标签页失败：{exc}")
        return tab_id

    def _activate(self, target_tab_id: str = "") -> None:
        with self._lock:
            self._active = True
            self._running = True
            self._run_id = uuid.uuid4().hex
            self._target_tab_id = str(target_tab_id or "")
            self._lease_client = ""
            self._lease_seen = 0.0
            self._commands.clear()
            self._commands.append({"action": "start"})
            self._state = "running"
            self._message = (
                f"正在连接 U校园标签页（{self._target_tab_id}）…"
                if self._target_tab_id else "正在连接 U校园页面…"
            )
            self._completed = 0
            self._answered = 0
            self._skipped = 0
            self._errors = 0
            self._last_answer = ""
            if self._page_url:
                self._auto_started_url = self._page_url
            self._touch()
        self.ctx.log(
            "info",
            f"已请求开始；目标标签页 {self._target_tab_id or '自动选择'}",
        )

    def stop(self) -> None:
        with self._lock:
            was_active = self._active
            self._active = False
            self._running = False
            self._state = "idle"
            self._message = "已停止"
            self._commands.clear()
            if was_active:
                self._commands.append({"action": "stop"})
            self._touch()
        self.ctx.log("info", "已请求停止")

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "running": self._running,
                "state": self._state,
                "message": self._message,
                "progress": {
                    "current": self._completed,
                    "total": 0,
                    "label": "已答题" if self._completed else "",
                },
                "stats": {
                    "answered": self._answered,
                    "skipped": self._skipped,
                    "errors": self._errors,
                },
                "updated_at": self._updated_at,
                "extra": {
                    "active": self._active,
                    "page_url": self._page_url,
                    "page_title": self._page_title,
                    "question_type": self._question_type,
                    "question": self._question[:500],
                    "options": list(self._options[:10]),
                    "last_answer": self._last_answer,
                    "completed": self._completed,
                    "lease_client": self._lease_client,
                    "target_tab_id": self._target_tab_id,
                },
            }

    def actions(self) -> list[dict[str, Any]]:
        return [
            {"id": "read", "label": "读取当前页", "style": "default"},
            {"id": "clear_logs", "label": "清空日志", "style": "default"},
        ]

    def invoke(self, action: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        if action == "read":
            with self._lock:
                if not self._active:
                    return {"ok": False, "message": "请先开始，并确保 U校园 页面已连接"}
                self._commands.append({"action": "read"})
            return {"ok": True, "message": "已请求读取当前页面"}
        if action == "clear_logs":
            with self._lock:
                self._logs.clear()
            return {"ok": True, "message": "日志已清空"}
        raise ModuleError(f"未知动作：{action}")

    def on_settings_changed(self, values: dict[str, Any]) -> None:
        return None

    def handle_agent_request(self, method: str, payload: dict[str, Any]) -> Any:
        handlers = {
            "poll": self._poll,
            "start": self._start_from_agent,
            "stop": self._stop_from_agent,
            "report": self._report,
            "log": self._log,
            "answer": self._answer,
            "transcribe": self._transcribe,
            "transcribe-url": self._transcribe_url,
            "listen": self._listen,
            "tts": self._tts,
            "unrecognized": self._unrecognized,
            "finish": self._finish,
            "state": lambda _payload: self.status(),
            "release": self._release,
        }
        handler = handlers.get(method)
        if handler is None:
            raise ModuleError(f"未知页面 Agent 接口：{method}")
        try:
            return handler(payload or {})
        except ProviderError as exc:
            raise ModuleError(str(exc)) from exc
        except (ValueError, binascii.Error, UnicodeDecodeError) as exc:
            raise ModuleError(f"参数无效：{exc}") from exc

    # -- page agent protocol ----------------------------------------------
    def _poll(self, payload: dict[str, Any]) -> dict[str, Any]:
        now = time.time()
        client_id = str(payload.get("client_id", "") or "")
        has_content = bool(payload.get("has_content"))
        with self._lock:
            self._page_url = str(payload.get("url", "") or self._page_url)[:2048]
            self._page_title = str(payload.get("title", "") or self._page_title)[:500]
            if payload.get("question_type"):
                self._question_type = str(payload.get("question_type"))[:40]
            if payload.get("question"):
                self._question = str(payload.get("question"))[:12000]
            if isinstance(payload.get("options"), list):
                self._options = [str(item)[:500] for item in payload["options"][:30]]
            if isinstance(payload.get("completed"), int):
                self._completed = max(self._completed, int(payload["completed"]))
                self._answered = self._completed

            page_url = str(payload.get("url", "") or "")
            tab_id = str(payload.get("__tab_id", "") or "")
            if self._active and self._target_tab_id and tab_id != self._target_tab_id:
                return {
                    "active": True,
                    "lease": False,
                    "auto_start": False,
                    "run_id": self._run_id,
                    "command": None,
                    "status": "本标签页不是当前控制页",
                    "completed": self._completed,
                }
            is_course_detail = bool(payload.get("is_course_detail"))
            auto_start = bool(self.ctx.settings.get("auto_start_on_course", False))
            if (
                not self._active
                and auto_start
                and is_course_detail
                and has_content
                and page_url
                and page_url != self._auto_started_url
            ):
                self._auto_started_url = page_url
                self._active = True
                self._running = True
                self._run_id = uuid.uuid4().hex
                self._target_tab_id = tab_id
                self._lease_client = client_id
                self._lease_seen = now
                self._commands.clear()
                self._commands.append({"action": "start"})
                self._state = "running"
                self._message = f"检测到课程页，自动开始（标签页 {tab_id or '未知'}）"
                self._completed = 0
                self._answered = 0
                self._skipped = 0
                self._errors = 0
                self._touch()
                self.ctx.log("info", "检测到课程页，按设置自动开始")

            if self._active:
                if self._lease_client == client_id:
                    self._lease_seen = now
                elif not self._lease_client or now - self._lease_seen > 10:
                    if has_content or self._commands:
                        self._lease_client = client_id
                        self._lease_seen = now
            lease = bool(client_id and self._lease_client == client_id)
            command = None
            if lease and self._commands:
                command = self._commands.popleft()
            # A client that is not the lease holder still needs a stop command.
            if not lease and client_id == self._lease_client and self._commands:
                command = self._commands.popleft()
            response = {
                "active": self._active,
                "lease": lease,
                "auto_start": bool(self._active and lease),
                "run_id": self._run_id,
                "command": command,
                "status": self._message,
                "completed": self._completed,
            }
        return response

    def _start_from_agent(self, payload: dict[str, Any]) -> dict[str, Any]:
        tab_id = str(payload.get("__tab_id", "") or "")
        self._activate(tab_id)
        return self.status()

    def _stop_from_agent(self, _payload: dict[str, Any]) -> dict[str, Any]:
        self.stop()
        return self.status()

    def _report(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            if payload.get("url"):
                self._page_url = str(payload["url"])[:2048]
            if payload.get("title"):
                self._page_title = str(payload["title"])[:500]
            if payload.get("question_type"):
                self._question_type = str(payload["question_type"])[:40]
            if payload.get("question") is not None:
                self._question = str(payload.get("question", ""))[:12000]
            if isinstance(payload.get("options"), list):
                self._options = [str(item)[:500] for item in payload["options"][:30]]
            if isinstance(payload.get("completed"), int):
                self._completed = max(self._completed, int(payload["completed"]))
                self._answered = self._completed
            status = str(payload.get("status", "") or "")
            if status:
                self._message = status[:500]
            if "running" in payload:
                self._running = bool(payload.get("running"))
            if "skipped" in payload:
                self._skipped = max(self._skipped, int(payload.get("skipped") or 0))
            if "errors" in payload:
                self._errors = max(self._errors, int(payload.get("errors") or 0))
            if "等待手动" in status or "等待手动" in self._message:
                self._state = "waiting"
                self._running = False
            elif self._running:
                self._state = "running"
            self._touch()
        return {"ok": True}

    def _log(self, payload: dict[str, Any]) -> dict[str, Any]:
        message = str(payload.get("message", "") or "")[:2000]
        level = str(payload.get("level", "info") or "info")
        if level not in {"debug", "info", "success", "warn", "error"}:
            level = "info"
        if not message:
            return {"ok": True}
        entry = {
            "ts": _now(),
            "level": level,
            "message": message,
            "url": str(payload.get("page_url", "") or self._page_url)[:2048],
            "title": str(payload.get("page_title", "") or self._page_title)[:500],
        }
        with self._lock:
            self._logs.append(entry)
            if self._state not in {"waiting", "error"}:
                self._message = message[:500]
            self._touch()
        self.ctx.log(level, message, page_url=entry["url"])
        return {"ok": True}

    def _answer(self, payload: dict[str, Any]) -> dict[str, Any]:
        question = str(payload.get("question", "") or "").strip()
        if not question:
            raise ModuleError("题目为空，无法作答")
        options = payload.get("options") or []
        if not isinstance(options, list):
            options = []
        question_type = str(payload.get("question_type", "choice") or "choice")
        blank_count = int(payload.get("blank_count", 0) or 0)
        context = str(payload.get("context", "") or "")
        prompt = build_prompt(
            {
                "question": question,
                "options": options,
                "question_type": question_type,
                "blank_count": blank_count,
                "context": context,
            }
        )
        llm = self.ctx.require("llm.chat")
        timeout = float(self.ctx.settings.get("answer_timeout", 300) or 300)
        result = llm.chat(
            [
                {
                    "role": "system",
                    "content": "你是英语学习助手。认真阅读题目和材料，给出准确、简洁的答案。",
                },
                {"role": "user", "content": prompt},
            ],
            temperature=0.2,
            timeout=timeout,
        )
        raw = str((result.message or {}).get("content") or "")
        if not raw.strip():
            raise ModuleError("模型返回为空")
        answer, explanation = parse_answer(raw, question_type, blank_count)
        if not answer.strip():
            raise ModuleError("模型未返回可用答案")
        with self._lock:
            self._last_answer = answer[:2000]
            self._question_type = question_type[:40]
            self._question = question[:12000]
            self._touch()
        return {
            "answer": answer,
            "explanation": explanation,
            "raw": raw,
            "model": str((result.message or {}).get("model", "") or ""),
            "question_type": question_type,
        }

    def _transcribe(self, payload: dict[str, Any]) -> dict[str, Any]:
        encoded = str(payload.get("audio_base64", "") or "")
        if not encoded:
            raise ModuleError("缺少 audio_base64")
        if len(encoded) > 40_000_000:
            raise ModuleError("音频过大")
        audio = base64.b64decode(encoded, validate=True)
        filename = str(payload.get("filename", "audio.wav") or "audio.wav")
        language = str(payload.get("language", "") or self.ctx.settings.get("asr_language", "") or "") or None
        asr = self.ctx.require("media.asr")
        transcript = asr.transcribe(audio, filename=filename, language=language)
        return {
            "text": transcript.text,
            "language": transcript.language,
            "duration": transcript.duration,
        }

    def _transcribe_url(self, payload: dict[str, Any]) -> dict[str, Any]:
        url = str(payload.get("url", "") or "").strip()
        if not url.startswith(("http://", "https://")):
            raise ModuleError("只支持 http(s) 音频 URL")
        with self._lock:
            cached = self._transcript_cache.get(url)
        if cached is not None:
            return {**cached, "cached": True}
        referer = str(payload.get("referer", "") or "") or None
        headers = {"Referer": referer} if referer else {}
        timeout = float(self.ctx.settings.get("transcribe_timeout", 600) or 600)
        data = self.ctx.download(url, headers=headers, timeout=timeout)
        suffix = Path(unquote(urlparse(url).path)).suffix.lower()
        if suffix not in {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".webm", ".mp4"}:
            suffix = ".mp3"
        language = str(self.ctx.settings.get("asr_language", "") or "") or None
        asr = self.ctx.require("media.asr")
        transcript = asr.transcribe(data, filename=f"audio{suffix}", language=language)
        result = {
            "text": transcript.text,
            "language": transcript.language,
            "duration": transcript.duration,
        }
        with self._lock:
            if len(self._transcript_cache) > 50:
                self._transcript_cache.pop(next(iter(self._transcript_cache)))
            self._transcript_cache[url] = result
        return {**result, "cached": False}

    def _listen(self, _payload: dict[str, Any]) -> dict[str, Any]:
        raise ModuleError("系统录音未启用；请让页面提供音频 URL，或手动完成听力题")

    def _tts(self, payload: dict[str, Any]) -> dict[str, Any]:
        text = str(payload.get("text", "") or "").strip()
        if not text:
            raise ModuleError("TTS 文本为空")
        voice = str(payload.get("voice", "") or self.ctx.settings.get("tts_voice", "") or "") or None
        language = str(payload.get("language", "") or "") or None
        output_format = str(payload.get("output_format", "") or self.ctx.settings.get("tts_format", "mp3") or "mp3")
        tts = self.ctx.require("media.tts")
        result = tts.synthesize(text, voice=voice, language=language, output_format=output_format)
        if len(result.data) > 20_000_000:
            raise ModuleError("生成的音频过大")
        return {
            "audio_base64": base64.b64encode(result.data).decode("ascii"),
            "mime": result.mime,
            "ext": result.ext,
            "duration": result.duration,
        }

    def _unrecognized(self, payload: dict[str, Any]) -> dict[str, Any]:
        entry = {
            "ts": _now(),
            "url": str(payload.get("url", "") or self._page_url)[:2048],
            "title": str(payload.get("title", "") or self._page_title)[:500],
            "question": str(payload.get("question", "") or "")[:12000],
            "reason": str(payload.get("reason", "") or "")[:1000],
            "type": str(payload.get("question_type", "") or "")[:40],
        }
        path = self.ctx.data_dir / "unrecognized.log"
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except OSError:
            pass
        with self._lock:
            self._errors += 1
            self._active = False
            self._running = False
            self._state = "error"
            self._message = f"无法继续：{entry['reason'] or '无法识别题目'}"
            self._touch()
        self.ctx.log("error", self._message, page_url=entry["url"])
        return {"ok": True}

    def _finish(self, payload: dict[str, Any]) -> dict[str, Any]:
        reason = str(payload.get("reason", "") or "").strip()
        with self._lock:
            self._active = False
            self._running = False
            waiting = any(word in reason for word in ("等待手动", "提交", "发布"))
            if waiting:
                self._state = "waiting"
            elif "失败" in reason or "无法" in reason:
                self._state = "error"
            else:
                self._state = "idle"
            self._message = reason[:500] or "自动学习已结束"
            self._touch()
        self.ctx.log("info", self._message)
        return {"ok": True}

    def _release(self, payload: dict[str, Any]) -> dict[str, Any]:
        client_id = str(payload.get("client_id", "") or "")
        with self._lock:
            if not client_id or client_id == self._lease_client:
                self._lease_client = ""
                self._lease_seen = 0.0
        return {"ok": True}

    # -- helpers -----------------------------------------------------------
    def _touch(self) -> None:
        self._updated_at = _now()

    def _set_error(self, message: str) -> None:
        with self._lock:
            self._running = False
            self._state = "error"
            self._message = message
            self._errors += 1
            self._touch()


def setup(api: ModuleContext) -> None:
    api.register_module(UcampusModule(api))
