# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from freeocs.sdk import ProviderError
from packages.src.tts_kokoclone.backend.main import KokoCloneTTS


class Settings:
    def __init__(self, values):
        self.values = values

    def get(self, key, default=None):
        return self.values.get(key, default)


def make_api(tmp_path: Path, project: Path, reference: Path):
    return SimpleNamespace(
        data_dir=tmp_path / "data",
        settings=Settings(
            {
                "engine": "external",
                "project_dir": str(project),
                "python_path": sys.executable,
                "reference_audio": str(reference),
                "language": "en",
                "timeout": 30,
            }
        ),
    )


def test_kokoclone_generates_wav(tmp_path: Path) -> None:
    project = tmp_path / "kokoclone"
    (project / "core").mkdir(parents=True)
    (project / "core" / "__init__.py").write_text("", encoding="utf-8")
    (project / "core" / "cloner.py").write_text(
        "import wave\n"
        "class KokoClone:\n"
        "    def generate(self, text, lang, reference_audio, output_path):\n"
        "        with wave.open(output_path, 'wb') as wav:\n"
        "            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)\n"
        "            wav.writeframes(b'\\x00\\x00' * 1600)\n",
        encoding="utf-8",
    )
    reference = tmp_path / "reference.wav"
    reference.write_bytes(b"RIFF" + b"\x00" * 100)
    api = make_api(tmp_path, project, reference)
    result = KokoCloneTTS(api).synthesize("Hello")
    assert result.mime == "audio/wav"
    assert result.ext == "wav"
    assert result.data.startswith(b"RIFF")
    assert len(result.data) > 44


def test_kokoclone_uses_selected_models(tmp_path: Path) -> None:
    project = tmp_path / "kokoclone"
    (project / "core").mkdir(parents=True)
    (project / "core" / "__init__.py").write_text("", encoding="utf-8")
    (project / "core" / "cloner.py").write_text(
        "import wave\n"
        "class KokoClone:\n"
        "    def generate(self, text, lang, reference_audio, output_path):\n"
        "        with wave.open(output_path, 'wb') as wav:\n"
        "            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)\n"
        "            wav.writeframes(b'\\x00\\x00' * 800)\n",
        encoding="utf-8",
    )
    # Fake torch / kanade / vocos modules so the external runner path can be
    # exercised without multi-GB ML dependencies.
    (project / "torch.py").write_text(
        "class _D:\n"
        "    def __init__(self, name): self.name=name\n"
        "    def __str__(self): return self.name\n"
        "class cuda:\n"
        "    @staticmethod\n"
        "    def is_available(): return False\n"
        "def device(name): return _D(name)\n",
        encoding="utf-8",
    )
    (project / "kanade_tokenizer.py").write_text(
        "class _C:\n"
        "    vocoder_name='vocos'; sample_rate=24000\n"
        "class _M:\n"
        "    config=_C()\n"
        "    def to(self, device): return self\n"
        "    def eval(self): return self\n"
        "class KanadeModel:\n"
        "    @classmethod\n"
        "    def from_pretrained(cls, **kwargs): return _M()\n"
        "class _V:\n"
        "    def to(self, device): return self\n"
        "    def eval(self): return self\n"
        "def load_vocoder(name): return _V()\n",
        encoding="utf-8",
    )
    reference = tmp_path / "reference.wav"
    reference.write_bytes(b"RIFF" + b"\x00" * 100)
    models = {}
    for key, name in [
        ("kokoro_model", "kokoro.onnx"),
        ("voices_file", "voices.bin"),
        ("kanade_config", "config.yaml"),
        ("kanade_weights", "model.safetensors"),
    ]:
        path = tmp_path / name
        path.write_bytes(b"fake")
        models[key] = str(path)
    api = make_api(tmp_path, project, reference)
    api.settings.values.update(models)
    result = KokoCloneTTS(api).synthesize("Hello")
    assert result.data.startswith(b"RIFF")
    assert len(result.data) > 44


def test_kokoclone_requires_reference(tmp_path: Path) -> None:
    project = tmp_path / "kokoclone"
    (project / "core").mkdir(parents=True)
    (project / "core" / "cloner.py").write_text("", encoding="utf-8")
    api = make_api(tmp_path, project, tmp_path / "missing.wav")
    with pytest.raises(ProviderError, match="参考音频"):
        KokoCloneTTS(api).synthesize("Hello")
