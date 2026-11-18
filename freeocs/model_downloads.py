# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

"""Download the documented public model files into a user-selected directory."""

from __future__ import annotations

import copy
import json
import logging
import os
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import quote, urlsplit

import httpx

logger = logging.getLogger("freeocs.models")


@dataclass(frozen=True, slots=True)
class ModelFile:
    repo: str
    source: str
    destination: str


@dataclass(frozen=True, slots=True)
class ModelDefinition:
    id: str
    name: str
    description: str
    files: tuple[ModelFile, ...]
    ollama_tag: str = ""


MODEL_CATALOG = (
    ModelDefinition(
        "faster-whisper-base",
        "faster-whisper base",
        "本地语音转写模型，下载目录结构可直接用于 asr_whisper。",
        tuple(
            ModelFile("Systran/faster-whisper-base", name, f"faster-whisper-base/{name}")
            for name in ("config.json", "model.bin", "tokenizer.json", "vocabulary.txt")
        ),
    ),
    ModelDefinition(
        "kokoro-en",
        "Kokoro 英文模型",
        "包含英文 ONNX 模型和 voices 文件。",
        (
            ModelFile(
                "PatnaikAshish/kokoclone",
                "model/kokoro.onnx",
                "kokoclone/model/kokoro.onnx",
            ),
            ModelFile(
                "PatnaikAshish/kokoclone",
                "voice/voices-v1.0.bin",
                "kokoclone/voice/voices-v1.0.bin",
            ),
        ),
    ),
    ModelDefinition(
        "kokoro-zh",
        "Kokoro 中文模型",
        "包含中文 ONNX 模型、voices 文件和可选 vocab 配置。",
        (
            ModelFile(
                "PatnaikAshish/kokoclone",
                "model/kokoro-v1.1-zh.onnx",
                "kokoclone/model/kokoro-v1.1-zh.onnx",
            ),
            ModelFile(
                "PatnaikAshish/kokoclone",
                "voice/voices-v1.1-zh.bin",
                "kokoclone/voice/voices-v1.1-zh.bin",
            ),
            ModelFile(
                "PatnaikAshish/kokoclone",
                "model/config.json",
                "kokoclone/model/config.json",
            ),
        ),
    ),
    ModelDefinition(
        "kanade",
        "Kanade 语音模型",
        "包含 config.yaml 和 model.safetensors；权重文件较大。",
        (
            ModelFile(
                "frothywater/kanade-12.5hz",
                "config.yaml",
                "kanade/config.yaml",
            ),
            ModelFile(
                "frothywater/kanade-12.5hz",
                "model.safetensors",
                "kanade/model.safetensors",
            ),
        ),
    ),
    ModelDefinition(
        "ollama-qwen2.5vl-7b",
        "Qwen2.5-VL 7B（Ollama）",
        "推荐的本地视觉语言模型。需要先安装并启动 Ollama；模型由 Ollama 管理存储目录。",
        (),
        "qwen2.5vl:7b",
    ),
)

_MODELS_BY_ID = {model.id: model for model in MODEL_CATALOG}


def _nonnegative_int(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


class ModelDownloadError(ValueError):
    """Raised when a model download request is invalid or cannot start."""


class _DownloadCancelled(Exception):
    pass


class ModelDownloadManager:
    def __init__(self, default_dir: Path) -> None:
        self.default_dir = default_dir
        self._lock = threading.Lock()
        self._cancel = threading.Event()
        self._thread: threading.Thread | None = None
        self._state: dict[str, Any] = {
            "state": "idle",
            "progress": 0,
            "completed_files": 0,
            "file_count": 0,
            "current_file": "",
            "current_bytes": 0,
            "current_total": None,
            "target_dir": str(default_dir),
            "error": "",
        }

    @staticmethod
    def catalog() -> list[dict[str, Any]]:
        return [
            {
                "id": model.id,
                "name": model.name,
                "description": model.description,
                "kind": "ollama" if model.ollama_tag else "files",
                "ollama_tag": model.ollama_tag,
                "files": [item.destination for item in model.files],
                "repositories": list(dict.fromkeys(item.repo for item in model.files)),
            }
            for model in MODEL_CATALOG
        ]

    def status(self) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._state)

    def start(self, model_id: str, target_dir: str) -> dict[str, Any]:
        model = _MODELS_BY_ID.get(str(model_id))
        if model is None:
            raise ModelDownloadError(f"未知模型：{model_id}")
        if not model.ollama_tag and not str(target_dir or "").strip():
            raise ModelDownloadError("请选择模型保存目录")
        root: Path | None = None
        if not model.ollama_tag:
            root = Path(target_dir).expanduser()
            if not root.is_absolute():
                # Relative paths are anchored to the program/models root,
                # never to whatever cwd the process happened to inherit.
                root = self.default_dir.parent / root
            root = root.resolve()
            if root.exists() and not root.is_dir():
                raise ModelDownloadError(f"保存位置不是目录：{root}")
            root.mkdir(parents=True, exist_ok=True)

        with self._lock:
            if self._state["state"] in {"downloading", "cancelling"}:
                raise ModelDownloadError("已有模型正在下载")
            job_id = uuid.uuid4().hex
            self._cancel = threading.Event()
            self._state = {
                "job_id": job_id,
                "model_id": model.id,
                "name": model.name,
                "kind": "ollama" if model.ollama_tag else "files",
                "state": "downloading",
                "progress": 0,
                "completed_files": 0,
                "file_count": len(model.files) or 1,
                "current_file": "",
                "current_bytes": 0,
                "current_total": None,
                "target_dir": ("Ollama 管理的模型目录" if model.ollama_tag else str(root)),
                "error": "",
            }
            self._thread = threading.Thread(
                target=self._download,
                args=(job_id, model, root, self._cancel),
                name=f"model-download-{model.id}",
                daemon=True,
            )
            try:
                self._thread.start()
            except RuntimeError as exc:
                self._state.update(state="failed", error=str(exc))
                raise
            return copy.deepcopy(self._state)

    def cancel(self) -> dict[str, Any]:
        with self._lock:
            if self._state["state"] == "downloading":
                self._state["state"] = "cancelling"
                self._cancel.set()
            return copy.deepcopy(self._state)

    def close(self) -> None:
        self.cancel()
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=3)

    def _update(self, job_id: str, **values: Any) -> None:
        with self._lock:
            if self._state.get("job_id") == job_id:
                self._state.update(values)
                self._state["progress"] = self._progress(self._state)

    @staticmethod
    def _progress(state: dict[str, Any]) -> int:
        count = int(state.get("file_count", 0))
        if count <= 0:
            return 0
        completed = int(state.get("completed_files", 0))
        total = state.get("current_total")
        current = int(state.get("current_bytes", 0))
        fraction = min(1.0, current / total) if isinstance(total, int) and total > 0 else 0
        return min(100, round((completed + fraction) * 100 / count))

    @staticmethod
    def _endpoint() -> str:
        endpoint = os.environ.get("HF_ENDPOINT", "https://huggingface.co").strip()
        parsed = urlsplit(endpoint)
        if (
            parsed.scheme != "https"
            or not parsed.netloc
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            raise ModelDownloadError("HF_ENDPOINT 必须是无凭据的 HTTPS 地址")
        return endpoint.rstrip("/")

    def _download(
        self,
        job_id: str,
        model: ModelDefinition,
        root: Path,
        cancel: threading.Event,
    ) -> None:
        temp_path: Path | None = None
        try:
            if model.ollama_tag:
                self._pull_ollama(job_id, model, cancel)
                self._update(
                    job_id,
                    state="completed",
                    progress=100,
                    completed_files=1,
                    current_file="",
                )
                return
            if root is None:
                raise ModelDownloadError("模型保存目录无效")
            endpoint = self._endpoint()
            timeout = httpx.Timeout(connect=20, read=60, write=20, pool=20)
            with httpx.Client(follow_redirects=True, timeout=timeout) as client:
                for index, item in enumerate(model.files):
                    if cancel.is_set():
                        raise _DownloadCancelled
                    relative = PurePosixPath(item.destination)
                    if relative.is_absolute() or ".." in relative.parts or "\\" in item.destination:
                        raise ModelDownloadError("模型目录清单包含无效路径")
                    destination = root.joinpath(*relative.parts)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    self._update(
                        job_id,
                        current_file=item.destination,
                        current_bytes=0,
                        current_total=None,
                    )
                    if destination.is_file() and destination.stat().st_size > 0:
                        self._update(job_id, completed_files=index + 1)
                        continue

                    temp_path = destination.with_name(destination.name + ".part")
                    temp_path.unlink(missing_ok=True)
                    url = (
                        f"{endpoint}/{quote(item.repo, safe='/')}/resolve/main/"
                        f"{quote(item.source, safe='/')}"
                    )
                    with client.stream("GET", url) as response:
                        response.raise_for_status()
                        raw_total = response.headers.get("content-length")
                        total = int(raw_total) if raw_total and raw_total.isdigit() else None
                        self._update(job_id, current_total=total)
                        received = 0
                        with temp_path.open("wb") as output:
                            for chunk in response.iter_bytes(chunk_size=1024 * 1024):
                                if cancel.is_set():
                                    raise _DownloadCancelled
                                if chunk:
                                    output.write(chunk)
                                    received += len(chunk)
                                    self._update(job_id, current_bytes=received)
                        if total is not None and received != total:
                            raise OSError(
                                f"下载内容长度不匹配：收到 {received} 字节，应为 {total} 字节"
                            )
                    temp_path.replace(destination)
                    temp_path = None
                    self._update(job_id, completed_files=index + 1)
            self._update(job_id, state="completed", progress=100, current_file="")
        except _DownloadCancelled:
            self._update(job_id, state="cancelled", current_file="")
        except Exception as exc:
            logger.exception("模型下载失败：%s (%s)", model.id, exc)
            self._update(job_id, state="failed", error=str(exc), current_file="")
        finally:
            if temp_path is not None:
                try:
                    temp_path.unlink(missing_ok=True)
                except OSError:
                    logger.warning("清理模型临时文件失败：%s", temp_path, exc_info=True)

    def _pull_ollama(
        self,
        job_id: str,
        model: ModelDefinition,
        cancel: threading.Event,
    ) -> None:
        timeout = httpx.Timeout(connect=5, read=30, write=20, pool=5)
        progress_by_digest: dict[str, tuple[int, int]] = {}
        succeeded = False
        try:
            with httpx.Client(timeout=timeout) as client:
                with client.stream(
                    "POST",
                    "http://127.0.0.1:11434/api/pull",
                    json={"name": model.ollama_tag, "stream": True},
                ) as response:
                    response.raise_for_status()
                    for line in response.iter_lines():
                        if cancel.is_set():
                            raise _DownloadCancelled
                        if not line:
                            continue
                        try:
                            item = json.loads(line)
                        except json.JSONDecodeError as exc:
                            raise ModelDownloadError("Ollama 返回了无效的下载状态") from exc
                        if not isinstance(item, dict):
                            raise ModelDownloadError("Ollama 返回了无效的下载状态")
                        if item.get("error"):
                            raise ModelDownloadError(
                                f"Ollama 拉取失败：{str(item['error'])[:1000]}"
                            )
                        status = str(item.get("status", "") or "")
                        digest = str(item.get("digest", "") or "")
                        if digest:
                            previous = progress_by_digest.get(digest, (0, 0))
                            total = _nonnegative_int(item.get("total", previous[0]))
                            completed = _nonnegative_int(item.get("completed", previous[1]))
                            progress_by_digest[digest] = (total, min(total, completed))
                        total_bytes = sum(total for total, _ in progress_by_digest.values())
                        current_bytes = sum(done for _, done in progress_by_digest.values())
                        succeeded = succeeded or status.lower() == "success"
                        self._update(
                            job_id,
                            current_file=status or model.ollama_tag,
                            current_bytes=current_bytes,
                            current_total=total_bytes or None,
                            completed_files=1 if succeeded else 0,
                        )
        except httpx.RequestError as exc:
            raise ModelDownloadError(f"无法连接本地 Ollama，请先安装并启动 Ollama：{exc}") from exc
        except httpx.HTTPStatusError as exc:
            detail = (exc.response.text or "")[:500]
            raise ModelDownloadError(
                f"Ollama 返回 HTTP {exc.response.status_code}：{detail}"
            ) from exc
        if not succeeded:
            raise ModelDownloadError("Ollama 下载流结束，但没有报告拉取成功")
