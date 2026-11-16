# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

"""OpenAI-compatible /audio/speech TTS provider."""

from __future__ import annotations

from typing import Any

import httpx

from freeocs.sdk import AudioResult, PackageContext, ProviderError


class OpenAITTS:
    def __init__(self, api: PackageContext) -> None:
        self.api = api

    def _settings(self) -> dict[str, Any]:
        get = self.api.settings.get
        return {
            "base_url": str(get("base_url", "") or "").strip().rstrip("/"),
            "api_key": str(get("api_key", "") or "").strip(),
            "model": str(get("model", "gpt-4o-mini-tts") or "gpt-4o-mini-tts").strip(),
            "voice": str(get("voice", "alloy") or "alloy").strip(),
            "format": str(get("format", "mp3") or "mp3").strip(),
            "timeout": float(get("timeout", 300) or 300),
        }

    def synthesize(self, text: str, *, voice: str | None = None,
                   language: str | None = None, output_format: str = "wav") -> AudioResult:
        text = (text or "").strip()
        if not text:
            raise ProviderError("TTS 文本为空", provider="tts_openai")
        settings = self._settings()
        if not settings["base_url"]:
            raise ProviderError("未配置云端 TTS API 地址", provider="tts_openai")
        fmt = str(output_format or settings["format"] or "mp3").lower()
        if fmt not in {"mp3", "wav", "opus", "aac", "flac"}:
            fmt = "mp3"
        url = f"{settings['base_url']}/audio/speech"
        headers = {"Content-Type": "application/json"}
        if settings["api_key"]:
            headers["Authorization"] = f"Bearer {settings['api_key']}"
        payload = {
            "model": settings["model"],
            "input": text,
            "voice": voice or settings["voice"],
            "response_format": fmt,
        }
        try:
            with httpx.Client(timeout=settings["timeout"]) as client:
                response = client.post(url, headers=headers, json=payload)
                response.raise_for_status()
                data = response.content
        except httpx.HTTPStatusError as exc:
            detail = (exc.response.text or "")[:1000]
            raise ProviderError(
                f"云端 TTS 返回 HTTP {exc.response.status_code}：{detail}",
                provider="tts_openai",
                status=exc.response.status_code,
                retryable=exc.response.status_code >= 500 or exc.response.status_code == 429,
            ) from exc
        except httpx.RequestError as exc:
            raise ProviderError(f"无法连接云端 TTS：{exc}", provider="tts_openai", retryable=True) from exc
        if not data:
            raise ProviderError("云端 TTS 返回空音频", provider="tts_openai")
        mime = {"mp3": "audio/mpeg", "wav": "audio/wav", "opus": "audio/ogg",
                "aac": "audio/aac", "flac": "audio/flac"}.get(fmt, "audio/mpeg")
        return AudioResult(data=data, mime=mime, ext=fmt)

    def close(self) -> None:
        return None


def setup(api: PackageContext) -> None:
    api.provide("media.tts", OpenAITTS(api))
