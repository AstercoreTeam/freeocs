# 03 能力模型与 SDK

本文档定义插件/模块开发者依赖的稳定契约。实现位于 `freeocs/sdk.py`、`freeocs/capabilities.py`、`freeocs/modules.py`。

## 1. 核心概念

```text
能力 (Capability)  ── 稳定字符串 ID，例如 llm.chat
    ▲
    │ provides
提供者 (Provider)  ── 一个 Python 对象，实现某能力的协议
    ▲
    │ 注册
插件 (Plugin)      ── 一个 zip 包，可提供 0..n 个能力

模块 (Module)      ── 一个 zip 包，声明 requires，运行时通过 Context 取能力
```

- **能力 ID** 是模块与实现之间唯一的耦合点。
- 模块不 import `tts_system` 或 `asr_whisper`，只调用 `ctx.require("media.tts")`。
- 同一能力可以有多个提供者；由用户选择（`capabilities.<id>` 设置）或框架自动选择。

## 2. 能力清单（v1）

| 能力 ID | 类型 | 内置提供者 | 必需方法 |
| --- | --- | --- | --- |
| `llm.chat` | 核心能力接口 | `llm_openai` | `chat(...)` |
| `answer.choice` | 便捷能力 | `answer_basic` | `answer_choice(...)` |
| `media.asr` | 媒体能力 | `asr_whisper`（本地）、`asr_openai`（云端） | `transcribe(...)` |
| `media.ocr` | 媒体能力 | `ocr_rapid`（本地）、可选云端 | `extract(...)` |
| `media.tts` | 媒体能力 | `tts_system`（本地）、`tts_openai`（云端） | `synthesize(...)` |
| `web.bridge` | 核心能力 | 框架内置（webcat 中继） | `call/page_info/navigate/...` |
| `android.adb` | 核心能力 | 框架内置（adb CLI） | `dump_hierarchy/tap/screenshot/...` |

说明：

- `answer.choice` 只是“题干 + 选项 → 选项”的便捷实现；**复杂题型由模块自己调用 `llm.chat` 并构造提示词**。框架不试图覆盖所有题型。
- `llm.chat` 默认只有一套全局文本模型配置；视觉/语音等模型配置属于相应插件或模块自己的设置。
- `web.bridge` 与 `android.adb` 由框架直接提供，不需要安装插件。

## 3. 公共数据类型

```python
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, Sequence

API_VERSION = 1


@dataclass(slots=True)
class ChatResult:
    message: dict[str, Any]          # OpenAI 风格 assistant message
    finish_reason: str = ""
    usage: dict[str, Any] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class ChoiceAnswer:
    index: int                       # 0-based；无法确定时为 -1
    letter: str                      # "A"/"B"/...
    text: str                        # 选项文本
    explanation: str = ""
    raw: str = ""


@dataclass(slots=True)
class Transcript:
    text: str
    language: str = ""
    duration: float = 0.0
    segments: list[dict[str, Any]] = field(default_factory=list)


@dataclass(slots=True)
class OCRBlock:
    text: str
    box: tuple[float, float, float, float]   # x1,y1,x2,y2；像素坐标
    confidence: float = 0.0


@dataclass(slots=True)
class OCRResult:
    text: str
    blocks: list[OCRBlock] = field(default_factory=list)


@dataclass(slots=True)
class AudioResult:
    data: bytes
    mime: str = "audio/wav"
    ext: str = "wav"
    duration: float = 0.0
```

约定：

- 时间单位：秒；超时、时长都是 `float`。
- 坐标：手机截图为像素；OCR box 与截图同尺寸。
- 所有返回值必须可 JSON 序列化（`bytes` 仅在明确的二进制接口中使用）。
- 错误使用 SDK 异常，不要返回 `{"error": ...}` 作为成功结果。

## 4. 能力协议

### 4.1 `llm.chat`

```python
class LLMProvider(Protocol):
    def chat(
        self,
        messages: Sequence[dict[str, Any]],
        *,
        tools: Sequence[dict[str, Any]] | None = None,
        tool_choice: str | dict[str, Any] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        response_format: dict[str, Any] | None = None,
        timeout: float | None = None,
    ) -> ChatResult:
        ...

    def close(self) -> None:
        ...
```

- `messages` 使用 OpenAI 兼容格式：`system` / `user` / `assistant` / `tool`。
- `tools` 使用 OpenAI function calling 格式；不使用工具时传 `None`。
- `ChatResult.message` 至少包含 `role`；可能包含 `content`、`tool_calls`。
- 失败抛 `ProviderError`（包含 HTTP 状态、响应摘要、是否可重试）。
- **v1 不做流式**；需要“边生成边显示”的模块自行分步调用或显示进度。

内置 `llm_openai` 设置：

| key | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `base_url` | text | `https://api.deepseek.com` | OpenAI 兼容根地址，不以 `/v1` 结尾也可 |
| `api_key` | password | 空 | 必填才能调用 |
| `model` | text | `deepseek-chat` | 文本模型名 |
| `temperature` | number | `0.2` | 0–2 |
| `max_tokens` | integer | `2048` | 上限 |
| `timeout` | number | `300` | 秒 |
| `extra_headers` | textarea | 空 | JSON 对象，可选 |

### 4.2 `answer.choice`

```python
class ChoiceAnswerProvider(Protocol):
    def answer_choice(
        self,
        question: str,
        options: Sequence[str],
        *,
        context: str = "",
        timeout: float | None = None,
    ) -> ChoiceAnswer:
        ...
```

- `options` 是纯文本列表（不含 `A.` 前缀也可以；实现需兼容两种）。
- 只处理单选题/多选题的“选一个最佳选项”场景；多选、填空、匹配、口语由模块自行处理。
- `answer_basic` 的实现：构造 JSON 输出提示词，调用 `llm.chat`，解析 `{"answer":"B","explanation":"..."}`；解析失败时尝试字母匹配。
- 选项无法匹配时抛 `ProviderError`，模块应停止而不是乱点。

### 4.3 `media.asr`

```python
class ASRProvider(Protocol):
    def transcribe(
        self,
        audio: bytes,
        *,
        filename: str = "audio.wav",
        language: str | None = None,
    ) -> Transcript:
        ...
```

- 支持格式由提供者决定；内置本地提供者支持 mp3/wav/m4a/aac/ogg/flac/webm/mp4 等（依赖 PyAV/ffmpeg）。
- 文件名用于推断后缀；不要依赖它做安全校验。
- 音频大小上限由提供者限制（默认 200 MB），超出抛 `ProviderError`。
- 模型缺失时抛 `ProviderError`，消息中给出模型下载/设置路径。

内置 `asr_whisper` 设置：

| key | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `model_dir` | path(dir) | `<data>/models/faster-whisper-base` | 本地模型目录 |
| `device` | select | `cpu` | `cpu` / `cuda` |
| `compute_type` | select | `int8` | `int8` / `float16` / `float32` |
| `language` | text | 空 | 空=自动检测 |
| `vad_filter` | boolean | `true` | 静音过滤 |
| `max_bytes` | integer | `209715200` | 200 MB |

内置 `asr_openai` 设置：`base_url`、`api_key`、`model`（默认 `whisper-1`）、`language`、`timeout`。

### 4.4 `media.ocr`

```python
class OCRProvider(Protocol):
    def extract(
        self,
        image: bytes,
        *,
        language: str | None = None,
    ) -> OCRResult:
        ...
```

- 输入 PNG/JPEG/WebP 字节；输出全文与带坐标的块。
- 手机截图兜底时，模块用 `OCRBlock.box` 的中心点点击；没有坐标的提供者不适用于点击兜底。
- `ocr_rapid` 使用 RapidOCR（onnxruntime），设置：`engine`（`auto`/`rapidocr`/`tesseract`）、`lang`、`min_confidence`。
- 模型/依赖缺失时抛 `ProviderError`，模块可回退到“只读文字、不点击”。

### 4.5 `media.tts`

```python
class TTSProvider(Protocol):
    def synthesize(
        self,
        text: str,
        *,
        voice: str | None = None,
        language: str | None = None,
        output_format: str = "wav",
    ) -> AudioResult:
        ...
```

- `output_format`：`wav` / `mp3`；不支持时抛 `ProviderError` 或返回实际格式（模块检查 `AudioResult.ext`）。
- 文本长度上限由提供者决定（建议 5000 字符）。
- 本地系统 TTS 可能不支持中文；设置页应提示用户安装语音包或切换 `tts_openai`。
- `tts_system` 设置：`voice`、`rate`、`volume`。
- `tts_openai` 设置：`base_url`、`api_key`、`model`、`voice`、`format`、`timeout`。

### 4.6 `web.bridge`

```python
class WebBridge(Protocol):
    def status(self) -> dict[str, Any]:
        """返回 {connected, browser, extension_version, active_tab, last_seen, agents}。"""

    def call(self, method: str, *args: Any, timeout: float = 15.0) -> Any:
        """对当前活动标签页执行通用 DOM 操作。"""

    def page_info(self) -> dict[str, Any]:
        """{url, title, host, ready_state, frame}。"""

    def navigate(self, url: str) -> dict[str, Any]:
        """让活动标签页跳转；返回 {ok}。"""

    def list_tabs(self) -> list[dict[str, Any]]:
        """[{id, url, title, active}]。"""

    def activate(self, url_pattern: str) -> dict[str, Any]:
        """按 URL 子串/通配符激活标签页。"""
```

通用 DOM 方法见 `05-webcat-bridge.md`。模块通常不直接使用 `call` 完成整站自动化，而是通过页面 Agent；`call` 用于轻量检查/导航。

### 4.7 `android.adb`

```python
class AdbManager(Protocol):
    def list_devices(self) -> list[dict[str, Any]]:
        """[{serial, state, model, product, transport_id}]。"""

    def connect(self, serial: str | None = None) -> "AdbDevice":
        """选择设备；serial 为空时要求恰好一个已授权设备。"""


class AdbDevice(Protocol):
    serial: str

    def shell(self, command: str, *, timeout: float = 15.0) -> str: ...
    def screen_size(self) -> tuple[int, int]: ...
    def dump_hierarchy(self, *, timeout: float = 15.0) -> str: ...
    def screenshot(self, *, timeout: float = 20.0) -> bytes: ...
    def tap(self, x: int, y: int, *, jitter: int = 0) -> None: ...
    def swipe(self, x1: int, y1: int, x2: int, y2: int, *, duration_ms: int = 300) -> None: ...
    def input_text(self, text: str) -> None: ...
    def keyevent(self, keycode: int | str) -> None: ...
    def current_package(self) -> str: ...
    def close(self) -> None: ...
```

- `tap` 的 `jitter` 在半径内随机偏移，降低机械感；默认从设置读取。
- `input_text` 只保证 ASCII；中文输入需要 ADBKeyboard（见 `06-android.md`）。
- 所有方法抛 `AdbError`，包含命令、退出码、stderr 摘要。

## 5. Context API

### 5.1 `PackageContext`

`setup(api)` 收到的是 `PackageContext`（模块用其子类/同一对象）。

```python
class PackageContext:
    package_id: str
    package_version: str
    package_type: str                 # plugin / module / bundle
    package_dir: Path                 # 包根目录（只读）
    data_dir: Path                    # <data>/package-data/<id>/
    app_version: str
    http_base_url: str                # 例如 http://127.0.0.1:8765
    settings: ScopedSettings
    web: WebBridge
    adb: AdbManager

    def require(self, capability_id: str) -> Any: ...
    def optional(self, capability_id: str) -> Any | None: ...
    def provide(self, capability_id: str, provider: Any) -> None: ...
    def register_settings(self, section: dict[str, Any]) -> None: ...
    def register_module(self, module: "Module") -> None: ...
    def asset_url(self, relative_path: str) -> str: ...
    def download(self, url: str, *, headers: dict[str, str] | None = None,
                 timeout: float = 180.0, max_bytes: int = 200_000_000) -> bytes: ...
    def log(self, level: str, message: str, **data: Any) -> None: ...
    def emit(self, event_type: str, data: dict[str, Any] | None = None,
             *, level: str = "info", message: str = "") -> None: ...
```

规则：

- `require` 在能力缺失/未绑定时抛 `CapabilityMissing` / `CapabilityUnbound`，消息包含解决建议。
- `optional` 返回 `None`，不抛异常。
- `asset_url("panel.js")` 返回本地 HTTP URL，仅对包内 `web/` 下已存在文件有效；路径穿越会被拒绝。
- `download` 由框架实现（httpx），用于下载听力音频/视频；会校验大小、超时、重定向；不自动携带 Cookie。
- `log` 写入事件总线与文件日志；`data` 中的敏感键（`api_key`、`password`、`token`）自动脱敏。
- `emit` 用于自定义事件（例如题目、进度），UI 可按 `type` 展示。

### 5.2 `ScopedSettings`

```python
class ScopedSettings:
    def get(self, key: str, default: Any = None) -> Any: ...
    def all(self) -> dict[str, Any]: ...
    def has(self, key: str) -> bool: ...
```

- 只读；写入只能通过设置页/`SettingsStore`。
- 值来自 `settings.json` 的 `packages.<package_id>`；缺失时用 section 字段的 `default`。
- 类型在读取时按 schema 归一化（数字、布尔、字符串）；非法值回退默认并记录警告。

### 5.3 设置 section schema

```python
{
    "id": "ucampus",              # 全局唯一，建议以包 ID 开头
    "title": "U校园",
    "order": 300,                  # 设置页排序；数字小的在前
    "description": "可选说明",
    "fields": [
        {
            "key": "auto_start",
            "type": "boolean",
            "label": "打开课程页时自动开始",
            "default": False,
            "help": "仅当模块已启用且浏览器已连接时生效。",
            "advanced": False
        }
    ]
}
```

字段类型：

| type | 额外属性 | 值类型 | UI |
| --- | --- | --- | --- |
| `text` | `placeholder`, `max_length` | string | 单行输入 |
| `password` | `placeholder` | string | 密码框；回显“已配置” |
| `textarea` | `rows`, `placeholder`, `max_length` | string | 多行 |
| `number` | `min`, `max`, `step` | float | 数字输入 |
| `integer` | `min`, `max`, `step` | int | 数字输入 |
| `boolean` | — | bool | 开关 |
| `select` | `options: [{value,label}]` | string | 下拉 |
| `path` | `mode: file|dir` | string | 输入 + 选择按钮 |
| `info` | — | — | 只读说明块 |

通用属性：

| 属性 | 说明 |
| --- | --- |
| `key` | section 内唯一；存储用 |
| `label` | 显示名 |
| `default` | 默认值 |
| `help` | 字段下方说明 |
| `required` | 保存时校验非空 |
| `advanced` | 默认折叠到“高级” |
| `visible_when` | 可选：`{"key": "...", "equals": ...}`；v1 可只实现简单相等 |
| `secret` | 等价于 `type: password`；用于日志脱敏 |

约束：

- `key` 只允许 `[a-z][a-z0-9_]*`。
- `select` 的 `default` 必须在 options 中。
- 数值越界在保存时被钳制或拒绝（二选一，v1 选择拒绝并提示）。
- 密码字段保存空字符串表示“保留原值”；要清空需点击“清除”按钮（UI 发送 `null` 或专用标记）。

## 6. 模块契约

### 6.1 基类

```python
class Module:
    id: str
    name: str

    def __init__(self, ctx: "ModuleContext") -> None:
        self.ctx = ctx

    def start(self) -> None:
        """开始运行。必须快速返回；耗时工作放工作线程。"""

    def stop(self) -> None:
        """请求停止。必须幂等；应在有限时间内返回。"""

    def status(self) -> dict[str, Any]:
        """线程安全、快速；返回当前状态。"""

    def actions(self) -> list[dict[str, Any]]:
        """[{id,label,style,confirm,enabled}]；由通用骨架渲染按钮。"""

    def invoke(self, action: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        """执行自定义动作；必须快速返回，长任务投递线程。"""

    def on_settings_changed(self, values: dict[str, Any]) -> None:
        """可选；设置保存后调用。"""

    def handle_agent_request(self, method: str, payload: dict[str, Any]) -> Any:
        """可选；页面 Agent 通过 /api/module/<id>/<method> 调用。"""

    def panels(self) -> list[dict[str, Any]]:
        """可选；覆盖 manifest.panels。"""
```

### 6.2 状态 schema

```python
{
    "running": False,
    "state": "idle",             # idle | running | stopping | error | waiting
    "message": "等待开始",
    "progress": {"current": 0, "total": 0, "label": ""},
    "stats": {"answered": 0, "skipped": 0, "errors": 0},
    "updated_at": "2026-11-16T16:00:00+08:00",
    "extra": {}                   # 模块自定义，前端原样展示/面板使用
}
```

- UI 每秒轮询；不要放大量文本（日志走事件）。
- `state=waiting` 用于“等待用户手动提交/等待浏览器连接/等待设备授权”。

### 6.3 动作 schema

```python
{"id": "start", "label": "开始", "style": "primary", "confirm": None, "enabled": True}
```

- `style`：`primary` / `default` / `danger`。
- `confirm`：非空时 UI 先弹确认框。
- 通用骨架默认提供“开始/停止”（映射 `start()`/`stop()`）；模块可追加自定义动作。
- `invoke` 返回 `{ok: true, message?: str, data?: Any}`；失败抛 `ModuleError`。

### 6.4 面板契约

`web/panel.js`：

```js
window.FreeOCS.registerPanel("ucampus", {
  mount(el, ctx) {
    // ctx: { moduleId, api, getState(), invoke(action, payload), onEvent(cb), toast(msg) }
    this.el = el;
    this.render();
  },
  unmount() {},
  onState(state) { /* 可选：状态更新 */ },
  onEvent(event) { /* 可选：事件 */ },
});
```

- 面板 JS 在 pywebview 页面上下文执行，拥有与主 UI 相同的权限。
- 面板样式加载自包内 `web/*.css`；不要依赖外部 CDN。
- 面板必须自行处理空状态/错误状态；主骨架提供容器、Tab、刷新。
- 面板不使用 `innerHTML` 插入不可信页面内容；如需展示网页文本，用 `textContent` 转义。

### 6.5 线程规则

1. `start()` 只设置状态、启动线程；不要阻塞 UI。
2. 工作线程循环检查 `stop_event`；所有等待使用 `Event.wait(timeout)` 或带超时的 I/O。
3. `stop()` 设置事件，`join(timeout=...)`；不要无限等待。
4. `status()`/`actions()` 加锁，返回副本。
5. `handle_agent_request()` 在 HTTP 线程执行；必须加锁，不得调用 pywebview API。
6. 模块之间不直接引用；需要协作时通过能力或事件。

### 6.6 `ModuleRunner` 辅助类

框架提供可选的线程/状态管理：

```python
from freeocs.sdk import Module, ModuleRunner

class MyModule(Module):
    def __init__(self, ctx):
        super().__init__(ctx)
        self.runner = ModuleRunner(self)

    def start(self):
        if self.runner.running:
            return
        self.runner.start(self._loop, initial_message="启动中…")

    def stop(self):
        self.runner.stop("正在停止…")

    def _loop(self, stop_event):
        self.runner.set_message("运行中")
        while not stop_event.wait(0.5):
            ...
```

- `set_message` / `set_progress` / `add_stat` / `fail` 线程安全。
- `runner.running` 反映线程状态；`status()` 返回其快照。
- 模块可不用 `ModuleRunner`，自行实现同等语义。

## 7. 设置页与能力绑定

### 7.1 核心设置 section

| section | 字段 |
| --- | --- |
| `ui` | `theme`、`locale`、`start_page`、`log_level` |
| `llm` | `base_url`、`api_key`、`model`、`temperature`、`max_tokens`、`timeout`、`extra_headers` |
| `bridge` | `port`、`auto_start`、`active_tab_only`、`request_timeout`、`agent_enabled` |
| `android` | `adb_path`、`device_serial`、`click_jitter`、`dump_timeout`、`screenshot_timeout`、`ocr_fallback` |
| `capabilities` | 动态生成：每个多提供者能力一个 select |

### 7.2 绑定规则

- 设置键：`capabilities.<capability_id>` = `package_id`。
- 若只存在一个提供者：自动选择，设置页显示只读信息。
- 若存在多个：默认选择“第一个已启用且内置优先”；用户可改。
- 若选中的提供者被禁用：自动回退；没有可用者时，依赖模块不可用，UI 显示原因。
- 模块通过 `ctx.require` 拿到的始终是当前绑定的提供者；不要在模块内缓存跨设置变更的提供者（或实现 `on_settings_changed` 刷新）。

### 7.3 密码字段

- `get_settings_values` 对 `type=password` 返回 `""`，并附带 `__has_value` 布尔。
- 保存时值为 `""` → 保留原值；值为 `null` → 清除；非空 → 覆盖。
- 日志、事件、异常消息中禁止出现密码值；框架提供 `redact()`。

## 8. 事件与日志

### 8.1 事件结构

```python
{
    "seq": 123,
    "ts": "2026-11-16T16:00:00+08:00",
    "package": "ucampus",
    "type": "log",                # log | status | progress | question | error | custom
    "level": "info",              # debug | info | success | warn | error
    "message": "正在读取题目",
    "data": {"url": "..."}
}
```

- `seq` 单调递增；UI 用 `after_seq` 拉增量。
- 环形缓冲默认 2000 条；同时写文件日志（滚动 5×2 MB）。
- 高频日志（>10 条/秒）应合并或降级为 `debug`。

### 8.2 敏感信息

- 自动脱敏字段名：`api_key`、`password`、`token`、`authorization`、`cookie`、`secret`。
- URL 中的 query 参数如含 `key`/`token`，记录前移除。
- 题目/选项可以记录，但默认不写完整 HTML。

## 9. 错误类型

```python
class FreeOCSError(Exception): ...
class PackageError(FreeOCSError): ...
class CapabilityMissing(FreeOCSError): ...
class CapabilityUnbound(FreeOCSError): ...
class ProviderError(FreeOCSError): ...
class ModuleError(FreeOCSError): ...
class SettingsError(FreeOCSError): ...
class BridgeError(FreeOCSError): ...
class AdbError(FreeOCSError): ...
class UserCancelled(FreeOCSError): ...
```

- `ProviderError` 建议字段：`provider`、`status`、`retryable`、`detail`。
- `AdbError` 建议字段：`command`、`returncode`、`stderr`。
- UI 展示 `str(exc)`；详细堆栈写日志。
- 模块应将异常转换为 `status.state="error"` + 可读 `message`，而不是让线程静默死亡。

## 10. 示例

### 10.1 最小 TTS 插件

```python
# backend/main.py
from freeocs.sdk import PackageContext

class SystemTTS:
    def __init__(self, api: PackageContext):
        self.api = api

    def synthesize(self, text, *, voice=None, language=None, output_format="wav"):
        from freeocs.sdk import AudioResult
        ...
        return AudioResult(data=wav_bytes, mime="audio/wav", ext="wav")

def setup(api: PackageContext) -> None:
    api.provide("media.tts", SystemTTS(api))
```

### 10.2 最小模块

```python
# backend/main.py
from freeocs.sdk import Module, ModuleContext

class DemoModule(Module):
    id = "demo"
    name = "演示模块"

    def start(self) -> None:
        self.ctx.log("info", "开始运行")
        self.ctx.require("llm.chat").chat([
            {"role": "user", "content": "用一句话介绍你自己"}
        ])

    def stop(self) -> None:
        pass

    def status(self) -> dict:
        return {"running": False, "state": "idle", "message": "空闲"}

    def actions(self) -> list[dict]:
        return [{"id": "ping", "label": "测试", "style": "default"}]

    def invoke(self, action, payload=None):
        return {"ok": True, "message": "pong"}

def setup(api: ModuleContext) -> None:
    api.register_module(DemoModule(api))
```

### 10.3 页面 Agent 请求

```python
class UcampusModule(Module):
    def handle_agent_request(self, method: str, payload: dict) -> Any:
        if method == "answer":
            llm = self.ctx.require("llm.chat")
            result = llm.chat([
                {"role": "system", "content": "你是学习助手"},
                {"role": "user", "content": build_prompt(payload)},
            ])
            return {"answer": parse_answer(result)}
        raise ModuleError(f"未知方法：{method}")
```

对应页面 Agent：

```js
const result = await __freeocs.request("/api/module/ucampus/answer", {
  method: "POST",
  body: { question, options, question_type: "choice" },
});
```

## 11. 兼容性策略

- `API_VERSION = 1`。新增可选参数/字段不升版本；删除或语义变更必须升版本。
- manifest 的 `api_version` 与 SDK 不匹配时拒绝加载，并提示升级应用或包。
- 能力接口新增方法不破坏旧提供者；模块调用前应检查 `hasattr` 或使用 `optional`。
- 文档中的“建议”与“必须”区分：违反“必须”会被框架拒绝或产生未定义行为。
