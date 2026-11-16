# 08 开发、运行、构建与测试

## 1. 开发环境

### 1.1 已验证环境

| 项 | 值 |
| --- | --- |
| 系统 | Ubuntu 26.04 LTS |
| 桌面 | KDE Plasma，Wayland |
| Python（系统） | 3.14.4 |
| pywebview 运行时 | GTK 3 + WebKit2GTK 4.1（已安装） |
| ADB | `/usr/bin/adb`（已安装） |
| uv | 0.10.0（已安装） |
| 浏览器 | Firefox（已安装）；Chrome/Edge 需自行安装 |
| 项目目录 | `/home/xzc/桌面/项目/FreeOCS` |

**Python 版本策略**：项目固定 **Python 3.12**。系统 3.14 对 `faster-whisper`、`torch`、`onnxruntime` 等可选依赖兼容性不足；用 uv 管理独立解释器，不污染系统。

```bash
uv python install 3.12
uv venv --python 3.12
source .venv/bin/activate
uv pip install -e ".[dev]"
```

### 1.2 系统依赖（Linux）

```bash
sudo apt install python3-gi gir1.2-gtk-3.0 gir1.2-webkit2-4.1 \
  adb ffmpeg espeak-ng
```

- `gir1.2-webkit2-4.1`：pywebview GTK 后端。
- `adb`：Android 调试桥。
- `ffmpeg`：音频格式转换（TTS/ASR 可选）。
- `espeak-ng`：`pyttsx3` 在 Linux 上的语音引擎。

Windows：

- WebView2 Runtime（Windows 10/11 通常已装；否则安装 Evergreen Runtime）。
- 随包携带 `adb.exe`、`AdbWinApi.dll`、`AdbWinUsbApi.dll`。
- SAPI5 提供系统 TTS。

## 2. 依赖划分

`pyproject.toml` 目标结构：

```toml
[project]
name = "freeocs"
requires-python = ">=3.12,<3.13"
dependencies = [
  "pywebview>=5,<6",
  "httpx>=0.27,<1",
]

[project.optional-dependencies]
asr = ["faster-whisper>=1.2,<2", "av>=13"]
ocr = ["rapidocr-onnxruntime>=1.4", "pillow>=10"]
tts = ["pyttsx3>=2.90,<3", "edge-tts>=6.1"]
dev = ["pytest>=8", "pytest-timeout>=2", "ruff>=0.6", "pyinstaller>=6.6"]
all = ["freeocs[asr,ocr,tts]"]
```

原则：

- **核心保持轻量**：没有 numpy/torch/onnxruntime 也能启动 UI、管理包、看日志。
- 重依赖通过插件声明 + 安装时确认，或开发时 `pip install -e ".[all]"`。
- 内置插件包 manifest 的 `dependencies` 与 extra 保持一致，避免“开发能跑、用户装不上”。
- 不在主程序 import 可选库；插件内部惰性 import，缺失时给可读错误。

## 3. 运行

```bash
# 开发模式：直接加载 packages/src
FREEOCS_PACKAGES=source uv run python main.py --dev

# 普通模式：加载 packages/dist 中已构建的包
uv run python main.py

# 指定端口 / 便携模式
uv run python main.py --port 8765 --portable
```

启动后：

1. 窗口出现，首页显示状态。
2. 扩展未安装时，指南页给出步骤。
3. 设置页配置大模型。
4. “应用”页启用模块。

调试：

- `--debug`：日志级别 debug，保留更多诊断信息（不记录密钥）。
- `FREEOCS_LOG_LEVEL=debug`。
- 本地 HTTP 服务可用 `curl http://127.0.0.1:8765/health` 检查。
- 页面 Agent 调试：浏览器 DevTools → Console 查看 `[FreeOCS]` 日志（content script 日志在页面 Console 的扩展上下文）。

## 4. 目录与路径

开发时：

```text
<repo>/web/                    前端
<repo>/packages/src/           内置包源码
<repo>/packages/dist/          构建产物
<repo>/extension/dist/         扩展构建产物
<repo>/.venv/                  虚拟环境（gitignore）
```

运行时：

```text
~/.config/FreeOCS/settings.json
~/.local/share/FreeOCS/
  ├── packages/                外部包
  ├── builtin/                 内置包缓存（发布模式）
  ├── package-data/<id>/       模块运行数据
  ├── models/                  ASR/OCR 模型
  ├── audio/                   TTS 输出
  ├── logs/                    freeocs.log, ucampus.log, unrecognized.log
  └── extension/{chromium,firefox}/
```

`--portable` 时改为可执行文件旁的 `data/`。

## 5. 构建

### 5.1 构建内置包

```bash
uv run python scripts/build_packages.py            # 全部
uv run python scripts/build_packages.py ucampus    # 单个
```

输出：`packages/dist/<id>-<version>.focpkg`。

脚本必须：

- 校验 manifest（复用框架校验器）。
- 排除 `__pycache__`、`*.pyc`、`.venv`、测试、临时文件。
- 保持 zip 内路径使用 `/`。
- 打印 SHA256 和大小。
- 失败时非零退出。

### 5.2 构建扩展

```bash
uv run python scripts/build_extension.py
```

输出：

```text
extension/dist/
├── freeocs-bridge-chromium/   # 可直接“加载已解压”
├── freeocs-bridge-firefox/    # 临时载入 manifest.json
├── freeocs-bridge-chromium.zip
└── freeocs-bridge-firefox.zip
```

- 复制 `extension/shared/*`。
- 复制对应 manifest。
- 版本号从 manifest 读取并注入注册信息。
- 应用启动时把 `dist/<browser>` 复制/解压到 `<data>/extension/<browser>`。

### 5.3 构建应用

```bash
uv run python scripts/build_app.py --linux
uv run python scripts/build_app.py --windows   # 在 Windows 上执行
```

**推荐 onedir**：

```bash
pyinstaller --noconfirm --clean --windowed \
  --name FreeOCS \
  --add-data "web:web" \
  --add-data "packages/dist:packages/dist" \
  --add-data "extension/dist:extension/dist" \
  main.py
```

原因：

- pywebview 需要动态库/资源；onefile 解压慢、杀软误报多、调试困难。
- onedir 便于替换包、更新扩展、查看日志。
- 最终安装器（Debian 包/AppImage、Windows Inno Setup）可以包装 onedir。

onefile 可选，但需验证：

- GTK/WebKit 资源是否完整。
- 首次启动解压时间。
- 杀毒软件误报。
- 模型不打包；首次使用下载到数据目录。

打包包含：

- `web/`（前端 + layui）。
- `packages/dist/*.focpkg`（内置包）。
- `extension/dist/`（扩展）。
- 图标、License、README。
- 不包含：`.git`、测试、模型、`~/.config`。

Linux 交付：

- `FreeOCS-linux-x86_64.tar.gz`（onedir）。
- `.desktop` 文件、图标。
- 后续：AppImage / .deb。

Windows 交付：

- `FreeOCS-windows-x64.zip` 或 Inno Setup 安装器。
- 处理 `_MEIPASS` 路径、中文路径、WebView2 检测。

### 5.4 版本号

- 单一来源：`freeocs/__init__.py` 的 `__version__`。
- `pyproject.toml` 可动态读取；包 manifest 有自己的版本。
- UI 关于页显示应用版本、Python 版本、平台、数据目录。

## 6. 测试

### 6.1 单元测试

| 文件 | 覆盖 |
| --- | --- |
| `test_packages.py` | manifest 校验、路径安全、zip 大小/条目限制、版本比较、安装回滚 |
| `test_capabilities.py` | 提供/依赖解析、多提供者绑定、缺失能力、禁用回退 |
| `test_settings.py` | 默认值、类型归一化、密码保留/清除、迁移、原子写 |
| `test_modules.py` | 生命周期、状态 schema、动作、面板元数据、线程停止 |
| `test_webcat_protocol.py` | 长轮询、结果回传、超时、Origin/头部校验、Agent 下发、租约 |
| `test_adb_parsers.py` | XML fixtures：题型/题干/选项/按钮/提交页 |
| `test_ucampus_prompts.py` | 提示词构造、JSON/填空/匹配解析 |
| `test_wisdomtree_reader.py` | 智慧树单选/多选/判断/WebView 占位 |
| `test_paths.py` | Linux/Windows 路径、portable 模式 |

### 6.2 集成测试

- **本地 HTTP 服务**：模拟扩展客户端（长轮询、结果回传），验证模块端点与租约。
- **假 ADB**：`FakeAdbDevice` 按脚本返回 XML/截图，验证点击与提交检测。
- **假 LLM**：实现 `LLMProvider`，返回固定答案/工具调用序列。
- **假扩展**：不启动浏览器，直接向 `/extension/result` 回传。
- **包安装**：用临时目录构建/安装 zip，验证加载与禁用。

### 6.3 端到端测试（开发者）

`scripts/e2e_ucampus.py` 使用 Playwright Chromium 加载真实扩展，路由一个本地 U校园 fixture，配合 mock LLM，验证：

- 扩展注册/长轮询；
- 页面 Agent 注入（无 eval）；
- 开始 → 读题 → 作答 → 下一题；
- 到提交页停止，提交按钮点击次数为 0。

```bash
PLAYWRIGHT_BROWSERS_PATH="$PWD/.playwright" \
FREEOCS_PACKAGES=dist DISPLAY=:0 \
.venv/bin/python scripts/e2e_ucampus.py
```

### 6.4 手动测试

- Chrome/Edge/Firefox 扩展安装、连接、DOM 操作、Agent 注入。
- U校园：课程详情、目录、Practice、各题型、提交页、讨论页、视频、听力。
- 智慧树：真机/模拟器，单选/多选/判断/提交页/断线。
- 设置：密码保留、路径选择、能力绑定、端口冲突。
- 打包产物：干净机器/新用户配置目录启动。

### 6.4 质量门禁

```bash
uv run ruff check .
uv run ruff format --check .
uv run pytest -q
```

- 不引入未使用依赖。
- 新增模块必须有单元测试或明确的手动测试记录。
- 所有提交按钮路径必须有“不点击”的测试用例。

## 7. 日志与诊断

- 文件：`<data>/logs/freeocs.log`，滚动 5×2 MB。
- 模块日志：`<data>/logs/<module>.log`（可选）。
- 无法识别：`<data>/logs/unrecognized.log`（JSON lines）。
- 安装日志：`<data>/logs/install.log`。
- UI：日志页 + 模块详情页。
- 脱敏：`api_key`、`password`、`token`、`authorization`、`cookie`、`secret`。
- 崩溃：捕获主线程/模块线程异常；写出 traceback；UI 显示“查看日志”。

## 8. 代码规范

- Python 3.12，类型注解；公共 API 用 `dataclass`/`Protocol`。
- 模块边界：`sdk.py` 只放类型/协议/上下文接口；实现放 `capabilities.py`/`modules.py`/`transports/`。
- 不在 `freeocs/` 内 import 任何具体内置包。
- 前端无构建步骤：原生 ES2020 + layui；避免引入 npm/Vite。
- JS 使用 `const/let`、`async/await`；模块面板使用 IIFE/块作用域，避免全局污染。
- CSS 使用变量；不覆盖 layui 全局样式过多。
- 注释解释“为什么”，不重复代码。
- 提交信息：`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `build:`。

## 9. 里程碑

| 阶段 | 交付 | 验收 |
| --- | --- | --- |
| M0 文档 | `docs/` 设计基线 | 评审通过 |
| M1 框架 | 启动窗口、导航、设置、包管理、能力注册、事件 | 能安装/加载 demo 包；设置持久化 |
| M2 浏览器中继 | 本地服务、扩展 MV3/Firefox、指南页、DOM 操作 | Chrome/Firefox 能连接并执行 DOM 方法 |
| M3 U校园 | 页面 Agent + Python 模块 + 面板 + 设置 | 验收清单 2.16 |
| M4 智慧树 | ADB + Reader + Agent + 面板 | 验收清单 3.11 |
| M5 打包 | 内置包 zip、扩展 dist、PyInstaller、tar.gz | 干净环境可启动 |

每个阶段结束更新 `docs/` 与 README。

## 10. 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| Python 3.12 依赖体积大（torch/onnxruntime） | 安装包大、打包难 | 核心不带；按需安装；优先 faster-whisper/rapidocr 的轻量 CPU 版本 |
| 页面 CSP 阻止 localhost 脚本 | Agent 注入失败 | 已改为无 eval 的 bundle 注入；如目标站点 CSP 禁止，需扩展内打包 Agent 或 userScripts 回退 |
| 网站改版 | 模块失效 | 选择器集中；失败即停；保留 raw 调试；快速迭代 |
| 模型不稳定性 | 答案错/格式错 | 严格解析；不匹配不点击；低温度；可换模型 |
| 误提交 | 用户数据损失 | 硬编码安全模式；测试覆盖；代码审查 |
| Windows 兼容 | 路径/窗口/ADB 问题 | CI/手动矩阵；路径全用 pathlib；打包测试 |
| pywebview Wayland 问题 | 窗口/输入异常 | 验证 GTK 后端；必要时 `GDK_BACKEND=x11` 作为已知 workaround 写入 FAQ |

## 11. 完成定义（v1）

- [ ] `uv run python main.py` 在 Linux 上打开窗口，无控制台异常。
- [ ] 设置页可配置大模型并测试连接；配置持久化；密钥不回显。
- [ ] 插件/模块以 zip 安装、启用、禁用；缺失能力有提示。
- [ ] 浏览器扩展（Chrome/Edge + Firefox）可安装并连接；指南页步骤可完成。
- [ ] U校园模块通过 2.16 验收。
- [ ] 智慧树模块通过 3.11 验收。
- [ ] 所有路径不自动提交/交卷/发布；有测试覆盖。
- [ ] `pytest` 通过；`ruff` 通过。
- [ ] `build_packages.py`、`build_extension.py`、`build_app.py` 可复现构建。
- [ ] 打包产物在干净配置目录下可启动。

## 12. 常用命令速查

```bash
# 环境
uv venv --python 3.12
uv pip install -e ".[dev]"

# 运行（源码包）
FREEOCS_PACKAGES=source uv run python main.py --dev

# 测试/检查
uv run pytest -q
uv run ruff check .

# 构建
uv run python scripts/build_packages.py
uv run python scripts/build_extension.py
uv run python scripts/build_app.py --linux

# 调试本地服务
curl -s http://127.0.0.1:8765/health
curl -s -X POST http://127.0.0.1:8765/call \
  -H 'Content-Type: application/json' \
  -d '{"method":"getPageInfo","args":[]}'

# 清理运行数据（谨慎）
rm -rf ~/.local/share/FreeOCS ~/.config/FreeOCS
```
