# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

"""Store user-provided voice reference samples for local TTS cloning."""

from __future__ import annotations

import base64
import binascii
import os
import shutil
import uuid
from datetime import datetime
from pathlib import Path

ALLOWED_AUDIO_EXTENSIONS = {".wav", ".mp3", ".m4a", ".ogg", ".webm", ".flac"}
MAX_AUDIO_BYTES = 20 * 1024 * 1024


def _max_encoded_length() -> int:
    return ((MAX_AUDIO_BYTES + 2) // 3) * 4 + 4


class VoiceSampleError(ValueError):
    """Raised when a voice sample is invalid or cannot be stored."""


def _normalize_extension(extension: str) -> str:
    value = str(extension or "").strip().lower()
    if not value:
        raise VoiceSampleError("缺少音频格式")
    if not value.startswith("."):
        value = f".{value}"
    if value not in ALLOWED_AUDIO_EXTENSIONS:
        raise VoiceSampleError(f"不支持的音频格式：{value.lstrip('.')}")
    return value


def _validate_size(size: int) -> None:
    if size <= 0:
        raise VoiceSampleError("音频文件为空")
    if size > MAX_AUDIO_BYTES:
        raise VoiceSampleError(
            f"音频文件超过 {MAX_AUDIO_BYTES // (1024 * 1024)} MB，请截取 3–10 秒的片段"
        )


def _target_path(root: Path, extension: str) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return root / f"voice-{stamp}-{uuid.uuid4().hex[:8]}{extension}"


def import_voice_sample(source: str | Path, root: Path) -> Path:
    """Copy an existing audio file into the app data directory."""
    path = Path(source).expanduser()
    if not path.is_file():
        raise VoiceSampleError(f"音频文件不存在：{path}")
    extension = _normalize_extension(path.suffix)
    _validate_size(path.stat().st_size)
    target = _target_path(root, extension)
    temp_path = target.with_name(target.name + ".part")
    try:
        shutil.copyfile(path, temp_path)
        _validate_size(temp_path.stat().st_size)
        os.replace(temp_path, target)
    except OSError as exc:
        raise VoiceSampleError(f"无法保存参考音频：{exc}") from exc
    finally:
        temp_path.unlink(missing_ok=True)
    return target


def decode_base64(value: str) -> bytes:
    text = str(value or "").strip()
    if not text:
        raise VoiceSampleError("录音数据为空")
    if len(text) > _max_encoded_length():
        raise VoiceSampleError("录音数据过大")
    try:
        return base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise VoiceSampleError("录音数据不是有效的 Base64") from exc


def save_voice_sample(data: bytes, extension: str, root: Path) -> Path:
    """Persist recorded audio bytes as a reference sample."""
    normalized = _normalize_extension(extension)
    _validate_size(len(data))
    target = _target_path(root, normalized)
    temp_path = target.with_name(target.name + ".part")
    try:
        temp_path.write_bytes(data)
        os.replace(temp_path, target)
    except OSError as exc:
        raise VoiceSampleError(f"无法保存录音：{exc}") from exc
    finally:
        temp_path.unlink(missing_ok=True)
    return target


def describe_sample(value: str | Path) -> dict[str, object]:
    text = str(value or "").strip()
    if not text:
        return {"path": "", "name": "", "exists": False, "size": 0}
    path = Path(text).expanduser()
    try:
        exists = path.is_file()
        size = path.stat().st_size if exists else 0
    except OSError:
        exists, size = False, 0
    return {"path": text, "name": path.name, "exists": exists, "size": size}
