"""System TTS provider (pyttsx3)."""

from __future__ import annotations

import threading
import uuid
from pathlib import Path

from freeocs.sdk import AudioResult, PackageContext, ProviderError

_lock = threading.Lock()


class SystemTTS:
    def __init__(self, api: PackageContext) -> None:
        self.api = api

    def synthesize(
        self,
        text: str,
        *,
        voice: str | None = None,
        language: str | None = None,
        output_format: str = "wav",
    ) -> AudioResult:
        text = (text or "").strip()
        if not text:
            raise ProviderError("TTS 文本为空")
        if len(text) > 5000:
            raise ProviderError("TTS 文本超过 5000 字符")
        try:
            import pyttsx3
        except ImportError as exc:
            raise ProviderError(
                "未安装 pyttsx3，请执行：pip install pyttsx3（或安装 tts extra）",
                provider="tts_system",
            ) from exc

        voice_id = voice or str(self.api.settings.get("voice", "") or "").strip()
        rate = int(self.api.settings.get("rate", 175) or 175)
        volume = float(self.api.settings.get("volume", 1.0) or 1.0)
        output_dir = self.api.data_dir / "tts"
        output_dir.mkdir(parents=True, exist_ok=True)
        path: Path = output_dir / f"tts-{uuid.uuid4().hex}.wav"
        try:
            with _lock:
                engine = pyttsx3.init()
                if voice_id:
                    engine.setProperty("voice", voice_id)
                engine.setProperty("rate", rate)
                engine.setProperty("volume", max(0.0, min(1.0, volume)))
                engine.save_to_file(text, str(path))
                engine.runAndWait()
                try:
                    engine.stop()
                except Exception:
                    pass
            if not path.is_file() or path.stat().st_size <= 44:
                raise ProviderError("系统 TTS 未生成有效音频", provider="tts_system")
            return AudioResult(data=path.read_bytes(), mime="audio/wav", ext="wav")
        except ProviderError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise ProviderError(f"系统 TTS 失败：{exc}", provider="tts_system") from exc
        finally:
            path.unlink(missing_ok=True)

    def close(self) -> None:
        return None


def setup(api: PackageContext) -> None:
    api.provide("media.tts", SystemTTS(api))
