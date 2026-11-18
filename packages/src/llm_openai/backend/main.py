# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

"""OpenAI-compatible chat provider using the global LLM settings."""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any

import httpx

from freeocs.sdk import ChatResult, PackageContext, ProviderError


class OpenAICompatibleLLM:
    def __init__(self, api: PackageContext) -> None:
        self.api = api
        self._client: httpx.Client | None = None

    def _settings(self) -> dict[str, Any]:
        get = self.api.core_settings.get
        return {
            "base_url": str(get("llm", "base_url", "") or "").strip(),
            "api_key": str(get("llm", "api_key", "") or "").strip(),
            "model": str(get("llm", "model", "") or "").strip(),
            "deep_thinking": bool(get("llm", "deep_thinking", False)),
            "temperature": float(get("llm", "temperature", 0.2) or 0.2),
            "max_tokens": int(get("llm", "max_tokens", 2048) or 2048),
            "timeout": float(get("llm", "timeout", 300) or 300),
            "extra_headers": get("llm", "extra_headers", "") or "",
        }

    def _endpoint(self, base_url: str) -> str:
        base = base_url.rstrip("/")
        if base.endswith("/chat/completions"):
            return base
        return f"{base}/chat/completions"

    def _headers(self, settings: dict[str, Any]) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if settings["api_key"]:
            headers["Authorization"] = f"Bearer {settings['api_key']}"
        extra = settings.get("extra_headers")
        if isinstance(extra, str) and extra.strip():
            try:
                parsed = json.loads(extra)
            except json.JSONDecodeError as exc:
                raise ProviderError(f"额外请求头不是合法 JSON：{exc}") from exc
            if isinstance(parsed, dict):
                headers.update({str(k): str(v) for k, v in parsed.items()})
        return headers

    def chat(
        self,
        messages: Sequence[dict[str, Any]],
        *,
        tools: Sequence[dict[str, Any]] | None = None,
        tool_choice: str | dict[str, Any] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        response_format: dict[str, Any] | None = None,
        timeout: float | None = None,
    ) -> ChatResult:
        settings = self._settings()
        if not settings["base_url"]:
            raise ProviderError("未配置大模型 API 地址，请到设置 → 大模型填写")
        if not settings["model"]:
            raise ProviderError("未配置模型名，请到设置 → 大模型填写")
        payload: dict[str, Any] = {
            "model": settings["model"],
            "messages": list(messages),
            "temperature": settings["temperature"] if temperature is None else float(temperature),
            "max_tokens": settings["max_tokens"] if max_tokens is None else int(max_tokens),
            "stream": False,
        }
        # DeepSeek defaults to thinking mode.  Only send this for DeepSeek
        # endpoints; generic OpenAI-compatible servers may reject the field.
        if "deepseek" in settings["base_url"].lower() or settings["model"].lower().startswith("deepseek"):
            payload["thinking"] = {
                "type": "enabled" if settings.get("deep_thinking") else "disabled"
            }
        if tools:
            payload["tools"] = list(tools)
            payload["tool_choice"] = tool_choice or "auto"
        if response_format is not None:
            payload["response_format"] = response_format
        try:
            with httpx.Client(timeout=float(timeout or settings["timeout"])) as client:
                response = client.post(
                    self._endpoint(settings["base_url"]),
                    headers=self._headers(settings),
                    json=payload,
                )
                response.raise_for_status()
                data = response.json()
        except httpx.HTTPStatusError as exc:
            detail = (exc.response.text or "")[:1000]
            raise ProviderError(
                f"模型服务返回 HTTP {exc.response.status_code}：{detail}",
                provider="llm_openai",
                status=exc.response.status_code,
                retryable=exc.response.status_code >= 500 or exc.response.status_code == 429,
                detail=detail,
            ) from exc
        except httpx.RequestError as exc:
            raise ProviderError(
                f"无法连接模型服务：{exc}",
                provider="llm_openai",
                retryable=True,
            ) from exc
        except (ValueError, KeyError, IndexError) as exc:
            raise ProviderError(f"模型响应格式异常：{exc}", provider="llm_openai") from exc

        try:
            choice = data["choices"][0]
            message = choice.get("message") or {}
            if not isinstance(message, dict):
                raise ValueError("message 不是对象")
            result = ChatResult(
                message=message,
                finish_reason=str(choice.get("finish_reason", "") or ""),
                usage=data.get("usage") or {},
                raw=data if isinstance(data, dict) else {},
            )
            return result
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise ProviderError(f"模型响应缺少 choices/message：{exc}", provider="llm_openai") from exc

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None


def setup(api: PackageContext) -> None:
    api.provide("llm.chat", OpenAICompatibleLLM(api))
