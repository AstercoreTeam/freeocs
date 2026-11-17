# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any

import pytest

from freeocs import model_downloads
from freeocs.model_downloads import ModelDownloadError, ModelDownloadManager


class FakeResponse:
    def __init__(self, content: bytes, error: Exception | None = None) -> None:
        self.content = content
        self.error = error
        self.headers = {"content-length": str(len(content))}

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def raise_for_status(self) -> None:
        if self.error:
            raise self.error

    def iter_bytes(self, chunk_size: int):
        yield self.content[:5]
        yield self.content[5:]


class FakeClient:
    def __init__(self, content: bytes, error: Exception | None = None) -> None:
        self.content = content
        self.error = error
        self.urls: list[str] = []

    def __enter__(self) -> FakeClient:
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def stream(self, method: str, url: str) -> FakeResponse:
        assert method == "GET"
        self.urls.append(url)
        return FakeResponse(self.content, self.error)


class FakeOllamaResponse:
    headers: dict[str, str] = {}
    text = ""

    def __enter__(self) -> FakeOllamaResponse:
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def raise_for_status(self) -> None:
        return None

    def iter_lines(self):
        yield '{"status":"pulling manifest"}'
        yield '{"status":"downloading","digest":"sha256:test","total":100,"completed":45}'
        yield '{"status":"downloading","digest":"sha256:test","total":100,"completed":100}'
        yield '{"status":"success"}'


class FakeOllamaClient:
    def __init__(self) -> None:
        self.request: tuple[str, str, dict[str, Any]] | None = None

    def __enter__(self) -> FakeOllamaClient:
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def stream(self, method: str, url: str, *, json: dict[str, Any]) -> FakeOllamaResponse:
        self.request = (method, url, json)
        return FakeOllamaResponse()


def wait_for_terminal(manager: ModelDownloadManager) -> dict[str, Any]:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        state = manager.status()
        if state["state"] not in {"downloading", "cancelling"}:
            return state
        time.sleep(0.01)
    raise AssertionError("model download did not finish")


def test_download_writes_catalog_files_and_reports_completion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = FakeClient(b"model data")
    monkeypatch.setattr(model_downloads.httpx, "Client", lambda **_: client)
    monkeypatch.setenv("HF_ENDPOINT", "https://mirror.example")
    manager = ModelDownloadManager(tmp_path / "default")
    target = tmp_path / "chosen"

    manager.start("faster-whisper-base", str(target))
    state = wait_for_terminal(manager)

    assert state["state"] == "completed"
    assert state["progress"] == 100
    assert len(client.urls) == 4
    assert (target / "faster-whisper-base" / "model.bin").read_bytes() == b"model data"
    assert not list(target.rglob("*.part"))
    assert all(url.startswith("https://mirror.example/") for url in client.urls)


def test_failed_download_reports_error_and_removes_partial_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = FakeClient(b"", RuntimeError("remote unavailable"))
    monkeypatch.setattr(model_downloads.httpx, "Client", lambda **_: client)
    manager = ModelDownloadManager(tmp_path / "models")
    target = tmp_path / "chosen"

    manager.start("faster-whisper-base", str(target))
    state = wait_for_terminal(manager)

    assert state["state"] == "failed"
    assert "remote unavailable" in state["error"]
    assert not list(target.rglob("*.part"))


def test_unknown_model_is_rejected(tmp_path: Path) -> None:
    manager = ModelDownloadManager(tmp_path / "models")

    with pytest.raises(ModelDownloadError, match="未知模型"):
        manager.start("arbitrary-repository", str(tmp_path))

    with pytest.raises(ModelDownloadError, match="保存目录"):
        manager.start("faster-whisper-base", "")


def test_model_endpoint_must_use_https_without_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HF_ENDPOINT", "http://mirror.example")

    with pytest.raises(ModelDownloadError, match="HTTPS"):
        ModelDownloadManager._endpoint()

    monkeypatch.setenv("HF_ENDPOINT", "https://user:secret@mirror.example")
    with pytest.raises(ModelDownloadError, match="HTTPS"):
        ModelDownloadManager._endpoint()


def test_cancelled_download_removes_partial_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    first_chunk_written = threading.Event()
    release_stream = threading.Event()

    class BlockingResponse(FakeResponse):
        def iter_bytes(self, chunk_size: int):
            yield b"first"
            first_chunk_written.set()
            release_stream.wait(timeout=5)
            yield b"second"

    class BlockingClient(FakeClient):
        def stream(self, method: str, url: str) -> BlockingResponse:
            assert method == "GET"
            return BlockingResponse(b"")

    client = BlockingClient(b"")
    monkeypatch.setattr(model_downloads.httpx, "Client", lambda **_: client)
    manager = ModelDownloadManager(tmp_path / "models")
    target = tmp_path / "chosen"

    manager.start("faster-whisper-base", str(target))
    assert first_chunk_written.wait(timeout=2)
    assert manager.cancel()["state"] == "cancelling"
    release_stream.set()
    state = wait_for_terminal(manager)

    assert state["state"] == "cancelled"
    assert not list(target.rglob("*.part"))
    assert not (target / "faster-whisper-base" / "config.json").exists()


def test_ollama_catalog_entry_pulls_recommended_qwen_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = FakeOllamaClient()
    monkeypatch.setattr(model_downloads.httpx, "Client", lambda **_: client)
    manager = ModelDownloadManager(tmp_path / "models")

    entry = next(item for item in manager.catalog() if item["kind"] == "ollama")
    assert entry["ollama_tag"] == "qwen2.5vl:7b"
    manager.start(entry["id"], "")
    state = wait_for_terminal(manager)

    assert state["state"] == "completed"
    assert state["progress"] == 100
    assert state["kind"] == "ollama"
    assert client.request == (
        "POST",
        "http://127.0.0.1:11434/api/pull",
        {"name": "qwen2.5vl:7b", "stream": True},
    )


def test_ollama_unavailable_reports_startup_guidance(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class UnavailableClient(FakeOllamaClient):
        def stream(self, method: str, url: str, *, json: dict[str, Any]) -> FakeOllamaResponse:
            raise model_downloads.httpx.ConnectError("connection refused")

    monkeypatch.setattr(model_downloads.httpx, "Client", lambda **_: UnavailableClient())
    manager = ModelDownloadManager(tmp_path / "models")

    manager.start("ollama-qwen2.5vl-7b", "")
    state = wait_for_terminal(manager)

    assert state["state"] == "failed"
    assert "安装并启动 Ollama" in state["error"]
