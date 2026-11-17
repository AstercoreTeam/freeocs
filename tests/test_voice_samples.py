# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import base64
from pathlib import Path

import pytest

from freeocs import voice_samples
from freeocs.voice_samples import VoiceSampleError


def test_import_voice_sample_copies_file(tmp_path: Path) -> None:
    source = tmp_path / "reference.wav"
    source.write_bytes(b"RIFF-sample")
    root = tmp_path / "voice-samples"

    target = voice_samples.import_voice_sample(source, root)

    assert target.parent == root
    assert target.suffix == ".wav"
    assert target.name.startswith("voice-")
    assert target.read_bytes() == b"RIFF-sample"
    assert not list(root.glob("*.part"))


def test_import_voice_sample_rejects_unsupported_and_empty_files(tmp_path: Path) -> None:
    root = tmp_path / "voice-samples"
    bad = tmp_path / "notes.txt"
    bad.write_text("not audio", encoding="utf-8")
    empty = tmp_path / "empty.mp3"
    empty.write_bytes(b"")

    with pytest.raises(VoiceSampleError, match="不支持"):
        voice_samples.import_voice_sample(bad, root)
    with pytest.raises(VoiceSampleError, match="为空"):
        voice_samples.import_voice_sample(empty, root)
    with pytest.raises(VoiceSampleError, match="不存在"):
        voice_samples.import_voice_sample(tmp_path / "missing.wav", root)


def test_import_voice_sample_enforces_size_limit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(voice_samples, "MAX_AUDIO_BYTES", 4)
    source = tmp_path / "reference.mp3"
    source.write_bytes(b"12345")

    with pytest.raises(VoiceSampleError, match="超过"):
        voice_samples.import_voice_sample(source, tmp_path / "voice-samples")


def test_save_recorded_voice_sample_and_validate_extension(tmp_path: Path) -> None:
    root = tmp_path / "voice-samples"

    target = voice_samples.save_voice_sample(b"recorded", "webm", root)

    assert target.suffix == ".webm"
    assert target.read_bytes() == b"recorded"
    assert not list(root.glob("*.part"))
    with pytest.raises(VoiceSampleError, match="不支持"):
        voice_samples.save_voice_sample(b"data", "exe", root)


def test_decode_base64_rejects_invalid_and_oversized_payloads(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    encoded = base64.b64encode(b"audio-bytes").decode("ascii")

    assert voice_samples.decode_base64(encoded) == b"audio-bytes"
    with pytest.raises(VoiceSampleError, match="Base64"):
        voice_samples.decode_base64("not-base64!")
    with pytest.raises(VoiceSampleError, match="为空"):
        voice_samples.decode_base64("")
    monkeypatch.setattr(voice_samples, "MAX_AUDIO_BYTES", 2)
    with pytest.raises(VoiceSampleError, match="过大"):
        voice_samples.decode_base64(encoded)


def test_describe_sample_reports_missing_file(tmp_path: Path) -> None:
    assert voice_samples.describe_sample("") == {
        "path": "",
        "name": "",
        "exists": False,
        "size": 0,
    }

    path = tmp_path / "voice.wav"
    path.write_bytes(b"1234")
    described = voice_samples.describe_sample(path)
    assert described["exists"] is True
    assert described["name"] == "voice.wav"
    assert described["size"] == 4

    missing = voice_samples.describe_sample(tmp_path / "gone.wav")
    assert missing["exists"] is False
    assert missing["path"].endswith("gone.wav")
