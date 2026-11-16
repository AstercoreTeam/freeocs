"""Small function-calling loop for the WisdomTree quiz."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from freeocs.sdk import ChatResult, LLMProvider


class AnswerAgent:
    def __init__(
        self,
        llm: LLMProvider,
        *,
        system_prompt: str,
        max_tool_rounds: int = 30,
        temperature: float = 0.0,
        timeout: float = 300.0,
        on_event: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self.llm = llm
        self.system_prompt = system_prompt
        self.max_tool_rounds = max(1, int(max_tool_rounds))
        self.temperature = temperature
        self.timeout = timeout
        self.on_event = on_event
        self.tools: list[dict[str, Any]] = []
        self.tool_functions: dict[str, Callable[..., Any]] = {}
        self.messages: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}]
        self.finished = False

    def register_tool(
        self,
        name: str,
        description: str,
        parameters: dict[str, Any],
        func: Callable[..., Any],
    ) -> None:
        self.tools.append(
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": description,
                    "parameters": parameters,
                },
            }
        )
        self.tool_functions[name] = func

    def _emit(self, event: dict[str, Any]) -> None:
        if self.on_event is not None:
            try:
                self.on_event(event)
            except Exception:
                pass

    def _execute(self, name: str, raw_arguments: str | dict[str, Any]) -> dict[str, Any]:
        if isinstance(raw_arguments, dict):
            arguments = raw_arguments
        else:
            try:
                arguments = json.loads(raw_arguments or "{}")
            except json.JSONDecodeError:
                return {"error": f"工具 {name} 的参数不是合法 JSON"}
        func = self.tool_functions.get(name)
        if func is None:
            return {"error": f"未知工具：{name}"}
        try:
            result = func(**arguments)
        except TypeError as exc:
            return {"error": f"工具 {name} 参数错误：{exc}"}
        except Exception as exc:  # noqa: BLE001 - tool boundary
            return {"error": f"工具 {name} 执行失败：{exc}"}
        return result if isinstance(result, dict) else {"result": result}

    @staticmethod
    def _tool_calls(message: dict[str, Any]) -> list[dict[str, Any]]:
        calls = message.get("tool_calls")
        return calls if isinstance(calls, list) else []

    def run(self, user_message: str) -> str:
        self.messages.append({"role": "user", "content": user_message})
        for _ in range(self.max_tool_rounds):
            if self.finished:
                return "已结束"
            result: ChatResult = self.llm.chat(
                self.messages,
                tools=self.tools or None,
                tool_choice="auto" if self.tools else None,
                temperature=self.temperature,
                timeout=self.timeout,
            )
            message = dict(result.message or {})
            message.setdefault("role", "assistant")
            self.messages.append(message)
            calls = self._tool_calls(message)
            if not calls:
                content = message.get("content")
                return str(content or "").strip()
            for call in calls:
                call_id = str(call.get("id", "") or "")
                function = call.get("function") or {}
                name = str(function.get("name", "") or "")
                raw_arguments = function.get("arguments", "{}")
                self._emit(
                    {
                        "type": "tool_call",
                        "name": name,
                        "arguments": raw_arguments if isinstance(raw_arguments, str) else json.dumps(raw_arguments, ensure_ascii=False),
                    }
                )
                output = self._execute(name, raw_arguments)
                self._emit({"type": "tool_result", "name": name, "result": output})
                self.messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call_id,
                        "content": json.dumps(output, ensure_ascii=False),
                    }
                )
                if output.get("finished") is True:
                    self.finished = True
                    return str(output.get("message", "已到提交页，停止")).strip()
                if self.finished:
                    return "已结束"
        return f"达到最大工具调用轮数（{self.max_tool_rounds}），已停止"
