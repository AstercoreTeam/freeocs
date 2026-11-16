"""OpenAI-compatible /audio/transcriptions ASR provider."""

from __future__ import annotations

from typing import Any

import httpx

from freeocs.sdk import PackageContext, ProviderError, Transcript


class OpenAITranscribe:
    def __init__(self, api: PackageContext) -> None:
        self.api = api

    def _settings(self) -> dict[str, Any]:
        get = self.api.settings.get
        return {
            "base_url": str(get("base_url", "") or "").strip().rstrip("/"),
            "api_key": str(get("api_key", "") or "").strip(),
            "model": str(get("model", "whisper-1") or "whisper-1").strip(),
            "language": str(get("language", "") or "").strip(),
            "timeout": float(get("timeout", 300) or 300),
        }

    def transcribe(self, audio: bytes, *, filename: str = "audio.wav",
                   language: str | None = None) -> Transcript:
        if not audio:
            raise ProviderError("音频为空", provider="asr_openai")
        settings = self._settings()
        if not settings["base_url"]:
            raise ProviderError("未配置云端 ASR API 地址", provider="asr_openai")
        url = f"{settings['base_url']}/audio/transcriptions"
        headers = {}
        if settings["api_key"]:
            headers["Authorization"] = f"Bearer {settings['api_key']}"
        data = {"model": settings["model"]}
        lang = (language or settings["language"] or "").strip()
        if lang:
            data["language"] = lang
        try:
            with httpx.Client(timeout=settings["timeout"]) as client:
                response = client.post(
                    url,
                    headers=headers,
                    data=data,
                    files={"file": (filename or "audio.wav", audio, "application/octet-stream")},
                )
                response.raise_for_status()
                payload = response.json()
        except httpx.HTTPStatusError as exc:
            detail = (exc.response.text or "")[:1000]
            raise ProviderError(
                f"云端 ASR 返回 HTTP {exc.response.status_code}：{detail}",
                provider="asr_openai",
                status=exc.response.status_code,
                retryable=exc.response.status_code >= 500 or exc.response.status_code == 429,
            ) from exc
        except httpx.RequestError as exc:
            raise ProviderError(f"无法连接云端 ASR：{exc}", provider="asr_openai", retryable=True) from exc
        except ValueError as exc:
            raise ProviderError(f"云端 ASR 响应不是 JSON：{exc}", provider="asr_openai") from exc
        text = str(payload.get("text", "") or "").strip()
        return Transcript(text=text, language=str(payload.get("language", "") or ""))

    def close(self) -> None:
        return None


def setup(api: PackageContext) -> None:
    api.provide("media.asr", OpenAITranscribe(api))
