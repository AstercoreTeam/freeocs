"""Local KokoClone TTS provider.

KokoClone keeps torch / Kokoro / Kanade in a separate environment.  FreeOCS only
passes text, the reference voice sample and an output path to that environment,
so the main application stays lightweight.
"""

from __future__ import annotations

import json
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

from freeocs.sdk import AudioResult, PackageContext, ProviderError


class KokoCloneTTS:
    def __init__(self, api: PackageContext) -> None:
        self.api = api

    def _settings(self) -> dict[str, Any]:
        get = self.api.settings.get
        return {
            "project_dir": str(get("project_dir", "") or "").strip(),
            "python_path": str(get("python_path", "") or "").strip(),
            "reference_audio": str(get("reference_audio", "") or "").strip(),
            "kokoro_model": str(get("kokoro_model", "") or "").strip(),
            "voices_file": str(get("voices_file", "") or "").strip(),
            "kanade_config": str(get("kanade_config", "") or "").strip(),
            "kanade_weights": str(get("kanade_weights", "") or "").strip(),
            "vocoder_dir": str(get("vocoder_dir", "") or "").strip(),
            "vocab_config": str(get("vocab_config", "") or "").strip(),
            "language": str(get("language", "en") or "en").strip().lower(),
            "timeout": float(get("timeout", 600) or 600),
        }

    def _python(self, settings: dict[str, Any], project: Path) -> str:
        configured = settings["python_path"]
        if configured:
            return configured
        candidates = [
            project / ".venv" / "bin" / "python",
            project / ".venv" / "Scripts" / "python.exe",
        ]
        for candidate in candidates:
            if candidate.is_file():
                return str(candidate)
        return sys.executable

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
            raise ProviderError("TTS 文本为空", provider="tts_kokoclone")
        if len(text) > 5000:
            raise ProviderError("TTS 文本超过 5000 字符", provider="tts_kokoclone")

        settings = self._settings()
        project = Path(settings["project_dir"]).expanduser() if settings["project_dir"] else None
        if project is None or not project.is_dir():
            raise ProviderError(
                "未配置 KokoClone 目录；请到设置 → 克隆语音选择包含 core/cloner.py 的项目目录。",
                provider="tts_kokoclone",
            )
        if not (project / "core" / "cloner.py").is_file():
            raise ProviderError(
                f"KokoClone 目录无效（缺少 core/cloner.py）：{project}",
                provider="tts_kokoclone",
            )
        reference = Path(settings["reference_audio"]).expanduser() if settings["reference_audio"] else None
        if reference is None or not reference.is_file():
            raise ProviderError(
                "未配置用于克隆的参考音频；请到设置 → 克隆语音选择一段 3-10 秒人声。",
                provider="tts_kokoclone",
            )
        python = self._python(settings, project)
        if not Path(python).is_file():
            raise ProviderError(f"KokoClone Python 不存在：{python}", provider="tts_kokoclone")
        lang = (language or settings["language"] or "en").lower()
        if lang not in {"en", "zh", "ja", "fr", "hi", "it", "pt", "es"}:
            lang = "en"

        model_keys = ["kokoro_model", "voices_file", "kanade_config", "kanade_weights"]
        selected_models = [key for key in model_keys if settings[key]]
        if selected_models and len(selected_models) != len(model_keys):
            raise ProviderError(
                "选择本地模型时，请同时选择 Kokoro ONNX、voices、Kanade config 和 Kanade 权重四个文件。",
                provider="tts_kokoclone",
            )
        for key in selected_models:
            if not Path(settings[key]).expanduser().is_file():
                raise ProviderError(f"模型文件不存在：{settings[key]}", provider="tts_kokoclone")
        use_external_models = bool(selected_models)
        if use_external_models and settings["vocoder_dir"] and not Path(settings["vocoder_dir"]).expanduser().is_dir():
            raise ProviderError(f"Vocoder 目录不存在：{settings['vocoder_dir']}", provider="tts_kokoclone")

        output_dir = self.api.data_dir / "tts"
        output_dir.mkdir(parents=True, exist_ok=True)
        token = uuid.uuid4().hex
        output_path = output_dir / f"kokoclone-{token}.wav"
        request_path = output_dir / f"kokoclone-{token}.json"
        request_path.write_text(
            json.dumps(
                {
                    "text": text,
                    "lang": lang,
                    "reference_audio": str(reference),
                    "output_path": str(output_path),
                    "use_external_models": use_external_models,
                    "kokoro_model": settings["kokoro_model"],
                    "voices_file": settings["voices_file"],
                    "kanade_config": settings["kanade_config"],
                    "kanade_weights": settings["kanade_weights"],
                    "vocoder_dir": settings["vocoder_dir"],
                    "vocab_config": settings["vocab_config"],
                    "project_dir": str(project),
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        runner = (
            "import json,os,sys\n"
            "from core.cloner import KokoClone\n"
            "request=json.load(open(sys.argv[1], encoding='utf-8'))\n"
            "if request.get('use_external_models'):\n"
            "    import torch\n"
            "    from kanade_tokenizer import KanadeModel, load_vocoder\n"
            "    cloner=KokoClone.__new__(KokoClone)\n"
            "    cloner.device=torch.device('cuda' if torch.cuda.is_available() else 'cpu')\n"
            "    cloner.hf_repo=''\n"
            "    cloner.kanade=KanadeModel.from_pretrained(\n"
            "        config_path=request['kanade_config'],\n"
            "        weights_path=request['kanade_weights']).to(cloner.device).eval()\n"
            "    if request.get('vocoder_dir'):\n"
            "        from vocos import Vocos\n"
            "        cloner.vocoder=Vocos.from_pretrained(request['vocoder_dir']).eval().to(cloner.device)\n"
            "    else:\n"
            "        cloner.vocoder=load_vocoder(cloner.kanade.config.vocoder_name).to(cloner.device)\n"
            "    cloner.sample_rate=cloner.kanade.config.sample_rate\n"
            "    cloner.kokoro_cache={}\n"
            "    def ensure_model(folder, filename):\n"
            "        if folder == 'model': return request['kokoro_model']\n"
            "        if folder == 'voice': return request['voices_file']\n"
            "        return os.path.join(request['project_dir'], folder, filename)\n"
            "    cloner._ensure_file=ensure_model\n"
            "    if request.get('vocab_config'):\n"
            "        cloner._get_vocab_config=lambda lang: request['vocab_config']\n"
            "else:\n"
            "    cloner=KokoClone()\n"
            "cloner.generate(request['text'], request['lang'], request['reference_audio'], request['output_path'])"
        )
        try:
            completed = subprocess.run(
                [python, "-c", runner, str(request_path)],
                cwd=str(project),
                capture_output=True,
                text=True,
                timeout=settings["timeout"],
                check=False,
            )
            if completed.returncode != 0 or not output_path.is_file() or output_path.stat().st_size <= 44:
                detail = (completed.stderr or completed.stdout or "未生成音频")[-1500:]
                raise ProviderError(
                    f"KokoClone 合成失败（退出码 {completed.returncode}）：{detail}",
                    provider="tts_kokoclone",
                )
            return AudioResult(data=output_path.read_bytes(), mime="audio/wav", ext="wav")
        except subprocess.TimeoutExpired as exc:
            raise ProviderError(
                f"KokoClone 合成超时（{settings['timeout']:.0f} 秒）",
                provider="tts_kokoclone",
                retryable=False,
            ) from exc
        except ProviderError:
            raise
        except OSError as exc:
            raise ProviderError(f"无法启动 KokoClone：{exc}", provider="tts_kokoclone") from exc
        finally:
            request_path.unlink(missing_ok=True)
            output_path.unlink(missing_ok=True)

    def close(self) -> None:
        return None


def setup(api: PackageContext) -> None:
    api.provide("media.tts", KokoCloneTTS(api))
