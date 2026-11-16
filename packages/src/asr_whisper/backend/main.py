"""Local faster-whisper ASR provider."""

from __future__ import annotations

import threading
import uuid
from pathlib import Path

from freeocs.sdk import PackageContext, ProviderError, Transcript

_ALLOWED = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".webm", ".mp4", ".m4v", ".mov"}


class WhisperASR:
    def __init__(self, api: PackageContext) -> None:
        self.api = api
        self._model = None
        self._model_key = ""
        self._lock = threading.Lock()

    def _model_dir(self) -> Path:
        value = str(self.api.settings.get("model_dir", "") or "").strip()
        return Path(value).expanduser() if value else self.api.data_dir / "models" / "faster-whisper-base"

    def _load_model(self):
        model_dir = self._model_dir()
        key = f"{model_dir}|{self.api.settings.get('device')}|{self.api.settings.get('compute_type')}"
        with self._lock:
            if self._model is not None and self._model_key == key:
                return self._model
            if not (model_dir / "model.bin").is_file():
                raise ProviderError(
                    f"未找到 ASR 模型：{model_dir}/model.bin。请下载 Systran/faster-whisper-base "
                    "到该目录，或到设置 → 本地语音转写修改模型目录。",
                    provider="asr_whisper",
                )
            try:
                from faster_whisper import WhisperModel
            except ImportError as exc:
                raise ProviderError(
                    "未安装 faster-whisper，请执行：pip install faster-whisper av（或安装 asr extra）",
                    provider="asr_whisper",
                ) from exc
            try:
                self._model = WhisperModel(
                    str(model_dir),
                    device=str(self.api.settings.get("device", "cpu")),
                    compute_type=str(self.api.settings.get("compute_type", "int8")),
                )
                self._model_key = key
                return self._model
            except Exception as exc:  # noqa: BLE001
                raise ProviderError(f"加载 ASR 模型失败：{exc}", provider="asr_whisper") from exc

    def transcribe(
        self,
        audio: bytes,
        *,
        filename: str = "audio.wav",
        language: str | None = None,
    ) -> Transcript:
        if not audio:
            raise ProviderError("音频为空", provider="asr_whisper")
        max_bytes = int(self.api.settings.get("max_bytes", 209715200) or 209715200)
        if len(audio) > max_bytes:
            raise ProviderError("音频超过大小限制", provider="asr_whisper")
        suffix = Path(filename).suffix.lower()
        if suffix not in _ALLOWED:
            suffix = ".wav"
        temp_dir = self.api.data_dir / "asr"
        temp_dir.mkdir(parents=True, exist_ok=True)
        path = temp_dir / f"input-{uuid.uuid4().hex}{suffix}"
        path.write_bytes(audio)
        try:
            model = self._load_model()
            lang = (language or str(self.api.settings.get("language", "") or "")).strip() or None
            with self._lock:
                segments, info = model.transcribe(
                    str(path),
                    language=lang,
                    beam_size=5,
                    vad_filter=bool(self.api.settings.get("vad_filter", True)),
                )
                parts: list[str] = []
                details: list[dict] = []
                for segment in segments:
                    text = (segment.text or "").strip()
                    if text:
                        parts.append(text)
                        details.append(
                            {
                                "start": float(getattr(segment, "start", 0.0) or 0),
                                "end": float(getattr(segment, "end", 0.0) or 0),
                                "text": text,
                            }
                        )
            return Transcript(
                text=" ".join(parts).strip(),
                language=str(getattr(info, "language", "") or ""),
                duration=float(getattr(info, "duration", 0.0) or 0.0),
                segments=details,
            )
        except ProviderError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise ProviderError(f"语音转写失败：{exc}", provider="asr_whisper") from exc
        finally:
            path.unlink(missing_ok=True)

    def close(self) -> None:
        with self._lock:
            self._model = None
            self._model_key = ""


def setup(api: PackageContext) -> None:
    api.provide("media.asr", WhisperASR(api))
