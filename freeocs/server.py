# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

"""Loopback HTTP server used by the browser extension and module page agents."""

from __future__ import annotations

import json
import logging
import mimetypes
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urlparse

from . import __version__
from .events import EventBus
from .modules import ModuleHost
from .packages import PackageManager
from .sdk import BridgeError, FreeOCSError
from .transports.browser_bridge import BrowserBridge

logger = logging.getLogger("freeocs.server")

_CLIENT_HEADER = "X-FreeOCS-Client"
_EXTENSION_CLIENT = "browser-bridge"


class LocalHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], handler: type[BaseHTTPRequestHandler], app: LocalServer):
        self.app = app
        super().__init__(address, handler)


class LocalServer:
    """Small JSON/static HTTP server bound to 127.0.0.1."""

    def __init__(
        self,
        port: int,
        *,
        packages: PackageManager | None = None,
        modules: ModuleHost | None = None,
        events: EventBus | None = None,
        bridge: BrowserBridge | None = None,
    ) -> None:
        self.requested_port = 8765 if port is None else int(port)
        self.packages = packages
        self.modules = modules
        self.events = events or EventBus()
        self.bridge = bridge or BrowserBridge()
        self._server: LocalHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self.started_at = 0.0
        self.extension_last_seen = 0.0
        self.extension_info: dict[str, Any] = {}

    @property
    def port(self) -> int:
        if self._server is not None:
            return int(self._server.server_address[1])
        return self.requested_port

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self) -> None:
        with self._lock:
            if self._server is not None:
                return
            try:
                server = LocalHTTPServer(("127.0.0.1", self.requested_port), _Handler, self)
            except OSError as exc:
                raise OSError(f"无法监听 127.0.0.1:{self.requested_port}：{exc}") from exc
            self._server = server
            self.started_at = time.time()
            self._thread = threading.Thread(
                target=server.serve_forever,
                name="freeocs-http",
                daemon=True,
            )
            self._thread.start()
            logger.info("本地服务已启动 %s", self.base_url)

    def stop(self) -> None:
        with self._lock:
            server = self._server
            self._server = None
        if server is not None:
            server.shutdown()
            server.server_close()
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=3)
        self._thread = None

    # -- shared helpers ----------------------------------------------------
    def health(self) -> dict[str, Any]:
        return {
            "ok": True,
            "name": "FreeOCS",
            "version": __version__,
            "uptime": round(time.time() - self.started_at, 1),
            "extension_connected": self.extension_connected(),
        }

    def extension_connected(self) -> bool:
        if self.bridge is not None:
            return self.bridge.connected
        return bool(self.extension_last_seen and time.time() - self.extension_last_seen < 60)

    def bridge_status(self) -> dict[str, Any]:
        if self.bridge is not None:
            status = self.bridge.status()
            return {
                "connected": status["connected"],
                "last_seen": status["last_seen"],
                "info": dict(status.get("extension") or {}),
                "server": self.base_url,
                "last_poll": status.get("last_poll", 0),
                "pending": status.get("pending", 0),
            }
        return {
            "connected": self.extension_connected(),
            "last_seen": self.extension_last_seen,
            "info": dict(self.extension_info),
            "server": self.base_url,
        }

    def module_request(self, module_id: str, method: str, payload: dict[str, Any]) -> Any:
        if self.modules is None:
            raise FreeOCSError("模块系统尚未初始化")
        return self.modules.handle_agent_request(module_id, method, payload)

    def agent_descriptors(self, page_url: str, token: str = "") -> list[dict[str, Any]]:
        if self.packages is None:
            return []
        descriptors: list[dict[str, Any]] = []
        for item in self.packages.matching_page_agents(page_url):
            path = item["path"]
            try:
                size = path.stat().st_size
            except OSError:
                continue
            if size > 2 * 1024 * 1024:
                logger.warning("页面 Agent 过大，跳过：%s", path)
                continue
            package_id = quote(str(item["package"]), safe="")
            agent_id = quote(str(item["id"]), safe="")
            descriptor = {
                "id": item["id"],
                "package": item["package"],
                "matches": item["matches"],
            }
            if token:
                descriptor["bundle_url"] = (
                    f"{self.base_url}/extension/agent.js?package={package_id}"
                    f"&id={agent_id}&token={quote(token, safe='')}"
                )
            descriptors.append(descriptor)
        return descriptors

    def agent_bundle(self, package_id: str, agent_id: str, token: str) -> str | None:
        if self.packages is None:
            return None
        path = self.packages.find_page_agent(package_id, agent_id)
        if path is None:
            return None
        try:
            code = path.read_text(encoding="utf-8")
        except OSError:
            return None
        if len(code.encode("utf-8")) > 2 * 1024 * 1024:
            return None
        token_json = json.dumps(token)
        base_json = json.dumps(self.base_url)
        return f"""(function () {{
  "use strict";
  const TOKEN = {token_json};
  const BASE = {base_json};
  const pending = new Map();
  let seq = 0;
  function post(type, payload) {{
    window.postMessage(Object.assign({{ __freeocsAgent: true, token: TOKEN, type }}, payload || {{}}), "*");
  }}
  window.addEventListener("message", (event) => {{
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__freeocsAgent !== true || data.token !== TOKEN) return;
    if (data.type !== "freeocs:response") return;
    const slot = pending.get(data.id);
    if (!slot) return;
    pending.delete(data.id);
    if (data.ok) slot.resolve(data.result);
    else slot.reject(new Error(data.error || "本地服务请求失败"));
  }});
  const bridge = {{
    version: "0.1.0",
    baseUrl: BASE,
    request(path, options) {{
      const opts = options || {{}};
      return new Promise((resolve, reject) => {{
        const id = ++seq;
        pending.set(id, {{ resolve, reject }});
        post("freeocs:request", {{
          id,
          path,
          method: opts.method || "POST",
          body: opts.body || {{}},
        }});
        window.setTimeout(() => {{
          if (pending.delete(id)) reject(new Error("本地服务请求超时"));
        }}, 600000);
      }});
    }},
    log(level, message, data) {{
      post("freeocs:log", {{ level: level || "info", message: String(message || ""), data: data || {{}} }});
    }},
    pageInfo() {{
      return {{
        url: location.href,
        title: document.title,
        host: location.host,
        origin: location.origin,
        frame: window.top === window ? "top" : "child",
      }};
    }},
  }};
  (function (__freeocs) {{
{code}
  }})(bridge);
}})();
"""


class _Handler(BaseHTTPRequestHandler):
    server: LocalHTTPServer

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        logger.debug("%s - %s", self.address_string(), format % args)

    # -- plumbing ----------------------------------------------------------
    def _json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-FreeOCS-Client")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.end_headers()
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def _error(self, status: int, message: str, code: str = "") -> None:
        self._json({"ok": False, "error": message, "code": code}, status)

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0:
            return {}
        if length > 4 * 1024 * 1024:
            raise ValueError("请求体过大")
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError(f"请求体不是 JSON：{exc}") from exc
        if not isinstance(data, dict):
            raise ValueError("请求体必须是对象")
        return data

    def _is_extension(self) -> bool:
        return self.headers.get(_CLIENT_HEADER, "") == _EXTENSION_CLIENT

    # -- methods -----------------------------------------------------------
    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-FreeOCS-Client")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/health":
            return self._json(self.server.app.health())
        if path == "/api/status":
            app = self.server.app
            return self._json(
                {
                    "ok": True,
                    "version": __version__,
                    "bridge": app.bridge_status(),
                    "packages": len(app.packages.list_packages()) if app.packages else 0,
                    "modules": len(app.modules.list_public()) if app.modules else 0,
                }
            )
        if path.startswith("/packages/"):
            return self._serve_package_asset(path)
        if path == "/extension/agents":
            query = parse_qs(parsed.query)
            page_url = (query.get("url") or [""])[0]
            token = (query.get("token") or [""])[0]
            return self._json({"agents": self.server.app.agent_descriptors(page_url, token)})
        if path == "/extension/agent.js":
            query = parse_qs(parsed.query)
            package_id = (query.get("package") or [""])[0]
            agent_id = (query.get("id") or [""])[0]
            token = (query.get("token") or [""])[0]
            bundle = self.server.app.agent_bundle(package_id, agent_id, token)
            if bundle is None:
                return self._error(404, "agent not found")
            body = bundle.encode("utf-8")
            try:
                self.send_response(200)
                self.send_header("Content-Type", "application/javascript; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(body)
            except BrokenPipeError:
                pass
            return
        if path == "/extension/status":
            return self._json(self.server.app.bridge_status())
        if path == "/api/tabs":
            try:
                tabs = self.server.app.bridge.list_tabs(timeout=10)
            except BridgeError as exc:
                return self._error(504, str(exc), "BRIDGE_ERROR")
            return self._json({"ok": True, "tabs": tabs})
        if path == "/api/events":
            limit = int((parse_qs(parsed.query).get("limit") or ["200"])[0] or 200)
            return self._json({"ok": True, **self.server.app.events.since(0, limit=limit)})
        if path == "/api/page":
            try:
                info = self.server.app.bridge.page_info(timeout=15)
            except BridgeError as exc:
                return self._error(504, str(exc), "BRIDGE_ERROR")
            return self._json({"ok": True, "page": info})
        if path == "/api/page/reload":
            try:
                info = self.server.app.bridge.page_info(timeout=15)
                url = str(info.get("url", "") or "")
                if not url.startswith(("http://", "https://")):
                    return self._error(400, "当前页面不是 http(s)")
                head, _, fragment = url.partition("#")
                joiner = "&" if "?" in head else "?"
                reload_url = f"{head}{joiner}freeocs_reload={time.time_ns()}"
                if fragment:
                    reload_url = f"{reload_url}#{fragment}"
                result = self.server.app.bridge.navigate(reload_url, timeout=15)
            except BridgeError as exc:
                return self._error(504, str(exc), "BRIDGE_ERROR")
            return self._json({"ok": True, "result": result})
        if path == "/extension/poll":
            query = parse_qs(parsed.query)
            try:
                timeout = float((query.get("timeout") or ["25"])[0])
            except (TypeError, ValueError):
                timeout = 25.0
            task = self.server.app.bridge.poll(timeout) if self.server.app.bridge else {}
            return self._json(task)
        return self._error(404, "not found")

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            body = self._body()
        except ValueError as exc:
            return self._error(400, str(exc))
        if path == "/extension/register":
            app = self.server.app
            app.extension_last_seen = time.time()
            app.extension_info = {
                "browser": body.get("browser", ""),
                "version": body.get("version", ""),
                "extension_id": body.get("extension_id", ""),
            }
            if app.bridge is not None:
                app.bridge.register(body)
            return self._json({"ok": True, "server_version": __version__, "poll_timeout": 25})
        if path == "/extension/result":
            ok = self.server.app.bridge.complete(body) if self.server.app.bridge else False
            return self._json({"ok": ok})
        if path == "/extension/log":
            message = str(body.get("message", ""))[:1000]
            level = str(body.get("level", "info"))
            if message:
                self.server.app.events.emit("", "log", level, message)
            return self._json({"ok": True})
        if path.startswith("/extension/agent/"):
            # Compatibility endpoint: POST with client_id and command result.
            return self._json({"ok": True})
        if path.startswith("/api/module/"):
            if not self._is_extension():
                return self._error(403, "仅允许浏览器扩展访问模块接口", "FORBIDDEN")
            parts = path.strip("/").split("/")
            if len(parts) < 4:
                return self._error(404, "not found")
            module_id = unquote(parts[2])
            method = unquote(parts[3])
            tab_id = self.headers.get("X-FreeOCS-Tab-Id", "").strip()
            if tab_id:
                body["__tab_id"] = tab_id
            try:
                result = self.server.app.module_request(module_id, method, body)
            except FreeOCSError as exc:
                return self._error(400, str(exc), getattr(exc, "code", "MODULE_ERROR"))
            except Exception as exc:  # noqa: BLE001
                logger.exception("模块请求失败 %s/%s", module_id, method)
                return self._error(500, str(exc), "MODULE_ERROR")
            return self._json({"ok": True, "result": result})
        if path == "/api/tabs/activate":
            pattern = str(body.get("url_pattern", "") or "")
            if not pattern:
                return self._error(400, "缺少 url_pattern")
            try:
                result = self.server.app.bridge.activate(pattern, timeout=15)
            except BridgeError as exc:
                return self._error(504, str(exc), "BRIDGE_ERROR")
            return self._json({"ok": True, "result": result})
        if path == "/api/tabs/target":
            tab_id = body.get("tab_id")
            if tab_id is None:
                return self._error(400, "缺少 tab_id")
            try:
                result = self.server.app.bridge.set_target(tab_id, timeout=10)
            except BridgeError as exc:
                return self._error(504, str(exc), "BRIDGE_ERROR")
            return self._json({"ok": True, "result": result})
        if path == "/call":
            method = str(body.get("method", "") or "")
            args = body.get("args") or []
            if not method:
                return self._error(400, "缺少 method")
            if not isinstance(args, list):
                return self._error(400, "args 必须是数组")
            try:
                result = self.server.app.bridge.call(method, *args, timeout=15)
            except BridgeError as exc:
                return self._error(504, str(exc), "BRIDGE_ERROR")
            return self._json({"result": result})
        return self._error(404, "not found")

    # -- static assets -----------------------------------------------------
    def _serve_package_asset(self, path: str) -> None:
        app = self.server.app
        if app.packages is None:
            return self._error(404, "not found")
        parts = path.strip("/").split("/")
        if len(parts) < 4:
            return self._error(404, "not found")
        _, package_id, version, *rest = parts
        package_id = unquote(package_id)
        version = unquote(version)
        relative = unquote("/".join(rest))
        target = app.packages.resolve_asset(package_id, version, relative)
        if target is None:
            return self._error(404, "not found")
        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        try:
            data = target.read_bytes()
        except OSError:
            return self._error(404, "not found")
        try:
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
        except BrokenPipeError:
            pass
