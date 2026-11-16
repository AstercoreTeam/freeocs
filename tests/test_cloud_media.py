# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from freeocs.capabilities import CapabilityRegistry
from freeocs.config import SettingsStore
from freeocs.events import EventBus
from freeocs.packages import PackageManager

from .helpers import make_paths


class MediaHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", "0") or 0)
        self.rfile.read(length)
        if self.path.endswith("/audio/transcriptions"):
            payload = json.dumps({"text": "hello world", "language": "en"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if self.path.endswith("/audio/speech"):
            data = b"ID3-fake-mp3"
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self.send_response(404)
        self.end_headers()


@pytest.fixture()
def media_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), MediaHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


def test_cloud_asr_and_tts(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, media_server: str) -> None:
    monkeypatch.setenv("FREEOCS_PACKAGES", "source")
    paths = make_paths(tmp_path)
    settings = SettingsStore(paths.settings_file)
    registry = CapabilityRegistry()
    manager = PackageManager(paths, settings, EventBus(), registry)
    manager.load_all()
    settings.save_section(
        "asr_openai",
        {"base_url": media_server, "api_key": "k", "model": "whisper-1"},
    )
    settings.save_section(
        "tts_openai",
        {"base_url": media_server, "api_key": "k", "model": "tts-1", "voice": "alloy"},
    )
    registry.set_binding("media.asr", "asr_openai")
    registry.set_binding("media.tts", "tts_openai")
    try:
        asr = registry.require("media.asr")
        transcript = asr.transcribe(b"fake audio", filename="test.wav")
        assert transcript.text == "hello world"
        tts = registry.require("media.tts")
        audio = tts.synthesize("hi", output_format="mp3")
        assert audio.ext == "mp3"
        assert audio.data == b"ID3-fake-mp3"
    finally:
        manager.close()
