# 01 总体架构

## 1. 目标

FreeOCS v1 要交付一个能在 Linux 桌面上直接运行的 pywebview 应用：

1. 打开即见统一控制台，能配置大模型、安装/启用插件与模块。
2. 能通过浏览器扩展操作 U校园网页，完成识别题目、听力转写、作答、回填、连续学习，但**停在提交前**。
3. 能通过 ADB 操作手机上的智慧树，完成章节测验的读题、作答、下一题，但**停在交卷前**。
4. 新应用只需新增一个 zip 包，不修改主程序。
5. 同一个能力可以有多个实现（本地/云端），用户可切换。

## 2. 设计原则

1. **本地优先**：默认只监听 `127.0.0.1`；不主动上传用户数据；媒体能力优先本地模型。
2. **能力显式化**：模块不直接 import 具体实现，只声明需要的能力 ID；框架负责解析、绑定和注入。
3. **契约先行**：manifest、SDK、中继协议、页面 Agent 协议都有版本号；包可以独立构建。
4. **可失败**：任一插件缺失、设备离线、浏览器未连接时，框架仍能启动，并在 UI 中给出可操作的诊断信息。
5. **不可逆操作交给人**：提交、交卷、发布讨论、删除内容一律不自动执行。
6. **单进程、少依赖**：除 pywebview、httpx 等基础库外，重依赖（faster-whisper、RapidOCR）作为可选 extra / 插件依赖，按需安装。

## 3. 总体架构

```text
┌───────────────────────────── pywebview 窗口 ─────────────────────────────┐
│  web/  (HTML + CSS + 原生 JS + layui)                                    │
│  首页 │ 应用 │ 模块详情 │ 操作指南 │ 设置 │ 日志                          │
└───────────────▲───────────────────────────────────────────┬──────────────┘
                │ pywebview.api.*  (请求/响应)               │ 定时轮询事件
┌───────────────┴───────────────────────────────────────────▼──────────────┐
│ freeocs.app  Application                                                │
│  ├─ PackageManager      扫描、校验、安装、加载 zip 包                     │
│  ├─ CapabilityRegistry  能力注册、依赖解析、提供者绑定                    │
│  ├─ SettingsStore       core / plugin / module 配置，schema 渲染          │
│  ├─ EventBus            日志、状态、进度（带序号，供 UI 轮询）             │
│  ├─ ModuleHost          模块生命周期、状态、动作、面板                    │
│  └─ UiApi               暴露给前端的稳定 API                              │
└───────┬───────────────────────┬───────────────────────┬─────────────────┘
        │                       │                       │
┌───────▼────────┐     ┌────────▼─────────┐     ┌───────▼──────────────┐
│ packages       │     │ Local HTTP Server│     │ transports           │
│ plugin/module  │     │ 127.0.0.1:8765   │     │  adb.py / webcat.py  │
│ (Python zip)   │     │ 扩展中继/页面Agent│     │                      │
└───────┬────────┘     └────────┬─────────┘     └───────┬──────────────┘
        │                       │                       │
        ▼                       ▼                       ▼
  llm.chat / asr / ocr / tts   浏览器扩展 <──> 目标网页    Android 设备
  answer.choice                 （Chrome/Edge/Firefox）    （adb）
```

### 3.1 为什么是 pywebview + 本地 HTTP

- pywebview 负责桌面窗口和 Python↔JS 的 `js_api`，适合“Python 重、前端轻”的工具型应用。
- 浏览器扩展必须通过 HTTP 长轮询与本地程序通信；页面 Agent 也需要一个 HTTP 端点。因此主程序内置一个只监听回环地址的 HTTP 服务，而不是额外启动 FastAPI/uvicorn。
- 页面资源和模块面板资源由本地 HTTP 服务提供，pywebview 不需要为每个包动态注册路由。

### 3.2 为什么不用 FastAPI

v1 的 API 面很小（十几条路由），`http.server.ThreadingHTTPServer` 足够，且减少依赖、便于 PyInstaller 打包。若后续需要 WebSocket、流式响应或更复杂的鉴权，再评估迁移到 Starlette/uvicorn。

## 4. 运行时与线程模型

| 执行体 | 职责 | 规则 |
| --- | --- | --- |
| pywebview 主线程 | GUI 事件循环、窗口 | 不执行耗时操作 |
| `UiApi` 调用线程 | 响应前端 `pywebview.api.*` | 只做内存操作/短任务；启动模块只投递线程 |
| 模块工作线程 | 每个运行中的模块一个 | 模块自行管理停止事件；所有阻塞调用必须可超时 |
| 本地 HTTP 服务线程 | 扩展长轮询、页面 Agent API、静态资源 | 每请求一个线程；不直接操作 Tk/GTK |
| 能力调用线程 | LLM、ASR、TTS、OCR 的同步 HTTP/本地推理 | 在模块线程内同步调用；httpx 设置超时 |
| ADB 子进程 | `adb` 命令 | `subprocess.run(timeout=...)`；输出解码容错 |
| 浏览器扩展 | 独立进程 | 只通过 HTTP 长轮询/消息与本地服务通信 |

约束：

- **不使用 asyncio 作为全局事件循环**。v1 的并发来自线程；SDK 接口是同步的，降低模块开发与调试复杂度。
- 所有共享状态（事件环形缓冲、模块状态、命令队列）使用 `threading.Lock` 保护。
- UI 通过轮询获取变化，而不是依赖 pywebview 的 `evaluate_js` 推送，避免线程安全问题。
- 任何模块的 `stop()` 必须在有限时间内返回；工作线程使用 `Event.wait(timeout)` 检查停止信号。

## 5. 分层与目标目录

```text
FreeOCS/
├── main.py                     # 入口：初始化路径/配置/包/服务，创建窗口
├── pyproject.toml
├── README.md
├── docs/
├── freeocs/                    # 框架本体
│   ├── app.py                  # Application 组装与生命周期
│   ├── api.py                  # pywebview js_api（UiApi）
│   ├── paths.py                # 配置/数据/缓存/日志目录
│   ├── config.py               # SettingsStore + schema + 默认值 + 迁移
│   ├── events.py               # EventBus + 环形缓冲
│   ├── packages.py             # zip 校验、安装、加载、清单
│   ├── capabilities.py         # 能力注册表、依赖解析、绑定
│   ├── modules.py              # ModuleHost、Module 基类、ModuleRunner
│   ├── sdk.py                  # 对外导出的类型/协议/上下文
│   ├── server.py               # 本地 HTTP 服务 + 路由
│   ├── security.py             # Origin/来源校验、路径校验
│   ├── logging_setup.py
│   ├── transports/
│   │   ├── adb.py              # AdbManager/AdbDevice
│   │   └── webcat.py           # 扩展队列、长轮询、页面 Agent 注册
│   └── ui/
│       └── pages.py            # 页面注册表（供前端导航）
├── web/                        # 前端（无需构建）
│   ├── index.html
│   ├── css/app.css
│   ├── css/theme.css
│   ├── js/app.js               # 路由、轮询、通用组件
│   ├── js/api.js               # pywebview.api 封装
│   ├── js/settings.js          # schema 渲染
│   ├── js/module.js            # 模块详情页
│   ├── i18n/{zh-CN,en-US}.json
│   ├── vendor/layui/           # 从 hpm-gui 复用（MIT）
│   └── pages/
│       ├── home/{index.html,page.js,page.css}
│       ├── apps/...
│       ├── module/...
│       ├── guide/...
│       ├── settings/...
│       └── logs/...
├── packages/
│   ├── src/                    # 内置包源码（开发时直接加载）
│   │   ├── llm_openai/
│   │   ├── answer_basic/
│   │   ├── asr_whisper/
│   │   ├── asr_openai/
│   │   ├── ocr_rapid/
│   │   ├── tts_system/
│   │   ├── tts_openai/
│   │   ├── ucampus/
│   │   └── wisdomtree/
│   └── dist/                   # 构建产物 *.focpkg（发布时随应用）
├── extension/
│   ├── shared/                 # background/content/options 共享源码
│   ├── chromium/manifest.json
│   ├── firefox/manifest.json
│   └── dist/                   # 构建后可直接“加载已解压”的目录
├── scripts/
│   ├── build_packages.py
│   ├── build_extension.py
│   ├── build_app.py
│   └── dev.py
└── tests/
    ├── test_packages.py
    ├── test_capabilities.py
    ├── test_settings.py
    ├── test_webcat_protocol.py
    ├── test_adb_parsers.py
    ├── fixtures/
    └── modules/                # 模块解析/提示词单测
```

### 5.1 内置包 vs 外部包

- **内置包**：位于 `packages/src/<id>/`，随应用发布。开发模式直接加载源码；发布模式加载构建出的 `packages/dist/<id>-<version>.focpkg`。
- **外部包**：用户从 UI 安装 zip，解压到数据目录 `packages/<id>/`。与内置包使用完全相同的 manifest/入口契约。
- 内置包可以被禁用，但不能卸载；外部包可以卸载。
- 包源码目录中不放 `.venv`、缓存或大模型文件。

## 6. 关键数据流

### 6.1 网页模块（以 U校园为例）

```text
用户点“开始”
  → UI: pywebview.api.module_invoke("ucampus", "start")
  → ModuleHost: ucampus.start() 设置 active，投递 start 命令
  → 浏览器中的 U校园页面 Agent 轮询 /api/module/ucampus/poll
  → Agent 扫描页面，发现题目
  → Agent POST /api/module/ucampus/report  （题型/题干/选项/页面信息）
  → Python 模块调用 llm.chat（必要时先 transcribe_url / media.asr）
  → Python 返回答案
  → Agent 把答案填进 DOM（不点击提交）
  → Agent 继续“下一题/下一步”；遇到提交/发布 → 停止并上报
  → 事件总线 → UI 轮询展示状态/日志
```

要点：

- 页面 Agent 以本地 bundle 注入页面主世界，能访问 DOM 和页面 JS；content script 只提供 token 校验的 postMessage 桥与 API 转发。
- Agent 通过扩展后台代理访问本地 HTTP，避免 HTTPS 页面直接请求 HTTP 的混合内容问题，也避免把本地 API 暴露给页面脚本。
- Python 模块是唯一的“大脑”：模型调用、ASR/TTS、状态机、日志都在 Python 侧；页面 Agent 只负责 DOM 扫描/回填/导航。

### 6.2 手机模块（以智慧树为例）

```text
用户点“开始”
  → module.start() 启动工作线程
  → adb.devices() 选择设备；uiautomator dump 拉取 XML
  → Reader 解析出 PageData（题型/题干/选项/按钮/坐标）
  → LLM Agent（function calling）决定 click_option / click_next
  → 本地按选项文字匹配坐标，adb shell input tap
  → 每次操作后重新 dump 确认
  → 检测到“提交/交卷” → 不点击，停止并提示
```

### 6.3 设置

```text
设置页打开
  → get_settings_schema()  返回 core/插件/模块的字段定义（不含密钥值）
  → get_settings_values()  返回已保存值（password 只返回 has_value）
  → 用户修改 → save_settings(section_id, values)
  → SettingsStore 校验/合并/原子写入
  → 通知相关包 on_settings_changed()
```

### 6.4 包安装

```text
选择 zip
  → 校验路径安全、manifest、api_version、id/version、能力依赖
  → 展示摘要（提供/需要的能力、Python 依赖）
  → 用户确认
  → （可选）pip 安装依赖 → 失败则中止
  → 解压到 staging → 原子替换 → 记录注册表
  → 提示“重启后生效”（v1 不做运行中卸载 Python 模块）
```

## 7. 启动与关闭流程

### 7.1 启动

1. 解析命令行参数（`--portable`、`--port`、`--debug`）。
2. 初始化 `paths`：配置目录、数据目录、缓存目录、日志目录。
3. 加载 `settings.json`；缺失字段补默认值；执行迁移。
4. 初始化日志（文件 + 事件总线）。
5. 构建 `CapabilityRegistry`，注册核心能力（`web.bridge`、`android.adb`）。
6. `PackageManager` 扫描内置包与已安装包；按依赖顺序加载；记录失败原因。
7. 构建 `ModuleHost`，实例化模块；不自动启动业务。
8. 启动本地 HTTP 服务（默认 `127.0.0.1:8765`）；端口占用则报错并在 UI 给出修改入口。
9. 构建 `UiApi`。
10. 创建 pywebview 窗口，加载 `web/index.html`。
11. 前端拉取导航、包列表、设置 schema、事件游标；开始轮询。
12. 扩展安装/连接状态在首页与指南页展示。

### 7.2 关闭

1. 停止所有运行中的模块（发送 stop，等待有限时间）。
2. 停止本地 HTTP 服务。
3. 终止由框架启动的子进程（adb 不需要；TTS/OCR 子进程需清理）。
4. flush 日志与设置。
5. 销毁窗口。

异常退出时，模块状态不保证保存；运行日志落盘可用于诊断。

## 8. 本地 HTTP 服务

默认地址 `http://127.0.0.1:8765`，端口可在设置中修改。

路由分组：

| 前缀 | 用途 | 访问者 |
| --- | --- | --- |
| `/health` | 健康检查 | 本机/扩展 |
| `/packages/<id>/<version>/<path>` | 包内 `web/` 静态资源 | pywebview 前端、扩展 |
| `/extension/*` | 扩展长轮询、结果、Agent 配置、状态 | 浏览器扩展后台 |
| `/api/module/<id>/<method>` | 页面 Agent 调用模块方法 | 扩展后台代理 |
| `/call` | 兼容 webcat 的手动调用入口（调试） | 本机 curl |
| `/events` | 可选：调试用事件快照 | 本机 |

安全策略见 `05-webcat-bridge.md` 与 `09-decisions.md`：

- 只绑定回环地址。
- `/api/module/*` 要求请求来自扩展后台（`X-FreeOCS-Client` + Origin 校验）或本机回环；浏览器页面直接请求会被拒绝。
- `/packages/*` 只读静态资源，不含密钥。
- 不在 URL 中传递 API Key。

## 9. 配置、数据与日志位置

| 类型 | Linux | Windows |
| --- | --- | --- |
| 配置 | `~/.config/FreeOCS/settings.json` | `%APPDATA%\FreeOCS\settings.json` |
| 数据 | `~/.local/share/FreeOCS/` | `%LOCALAPPDATA%\FreeOCS\` |
| 包 | `<data>/packages/<id>/` | 同左 |
| 内置包缓存 | `<data>/builtin/<id>-<version>/` | 同左 |
| 模型 | `<data>/models/<name>/` | 同左 |
| TTS 输出 | `<data>/audio/` | 同左 |
| 日志 | `<data>/logs/freeocs.log` | 同左 |
| 扩展 | `<data>/extension/{chromium,firefox}/` | 同左 |

支持 `--portable`：上述路径改为可执行文件旁的 `./data/`，便于 U 盘携带。

## 10. 失败处理与诊断

| 场景 | 行为 |
| --- | --- |
| 包 manifest 非法 | 跳过该包，UI“应用/插件”页显示错误与行号 |
| 缺少依赖能力 | 包标记为“不可用”，列出缺失能力与安装建议 |
| LLM 未配置/401 | 模块启动失败或运行中停止，错误写入事件与日志，不重试到刷爆额度 |
| 浏览器未连接 | 网页模块显示“未连接”，开始按钮禁用；指南页给安装步骤 |
| 手机未授权 | 显示 `adb devices` 输出与授权提示 |
| ASR 模型缺失 | 返回可读错误；听力题标记“未识别”，不猜测答案 |
| 题目无法识别 | 写入 `logs/unrecognized.log`，停止当前流程，不尝试提交 |
| 本地端口占用 | 启动时明确报错，提供修改端口入口 |
| 模块线程异常 | 捕获堆栈，状态置为错误，UI 显示“查看日志” |

## 11. 安全边界

1. **包 = 任意代码执行**。只安装可信来源的包；UI 在安装时明确警告。
2. **API Key 明文存储**。配置文件权限 `0600`；UI 只显示“已配置”；日志中脱敏。v1 不引入 keyring，后续可加。
3. **浏览器扩展权限很大**（读取/修改所有页面）。仅在用户主动安装并启用时工作；不收集页面内容到远端。
4. **页面 Agent 只从本地服务加载**；桥对象在 bundle 闭包内，页面脚本无法直接引用；脚本 URL 含随机 token，目标站点被视为可信。
5. **不自动提交**，避免不可逆操作与误判风险。
6. **网络出站**仅限用户配置的 LLM/ASR/TTS 服务、目标学习站点音频下载、模型下载；无遥测。

## 12. 平台差异

| 方面 | Linux | Windows |
| --- | --- | --- |
| pywebview 后端 | GTK + WebKit2GTK 4.1 | WebView2 |
| 系统依赖 | `python3-gi`、`gir1.2-webkit2-4.1`、`gir1.2-gtk-3.0` | WebView2 Runtime |
| ADB | 系统 `adb` 或设置路径 | 随包携带 `tools/adb.exe`，或系统 PATH |
| 本地 TTS | `pyttsx3` + espeak-ng | SAPI5 |
| 打包 | tar.gz / AppImage（后续） | zip / 安装器（后续） |
| 路径 | XDG | `%APPDATA%` / `%LOCALAPPDATA%` |

代码中所有路径使用 `pathlib.Path`；子进程参数使用列表而非 shell 字符串；窗口图标、字体、快捷键做平台判断。

## 13. 未来扩展

- 插件市场与签名。
- 云端同步/多设备。
- 更多模块（学习通、知到、中国大学 MOOC 等）。
- 视觉模型直接读屏（替代 uiautomator/HTML 解析）。
- 本地 embedding + 课程资料知识库。
- 运行中热卸载包（需要子进程隔离）。
