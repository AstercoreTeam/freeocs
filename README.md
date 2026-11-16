# FreeOCS

本地优先、插件化的学习助手桌面应用。pywebview 界面，手机应用走 ADB，网页应用走浏览器扩展中继。

> 设计文档见 [`docs/README.md`](docs/README.md)。

## 当前状态

- 框架：zip 插件/模块、能力注册、设置页、操作指南、日志、事件
- 浏览器扩展：Chromium MV3 + Firefox，页面 Agent 注入、DOM 操作、模块 API 代理
- 手机：ADB 设备管理、uiautomator、截图、点击
- 内置插件：LLM、选择题、TTS、ASR、OCR
- 内置模块：**U校园（网页）**、**智慧树（手机）**
- 安全：所有模块都不会自动提交/交卷/发布

## 快速开始（开发）

```bash
uv venv --python /usr/bin/python3.12 .venv
export UV_CACHE_DIR="$PWD/.uv-cache"
uv pip install --python .venv/bin/python -e ".[dev]"
.venv/bin/python scripts/build_packages.py
.venv/bin/python scripts/build_extension.py
FREEOCS_PACKAGES=dist .venv/bin/python main.py --dev
```

Linux 需要 `gir1.2-webkit2-4.1`、`gir1.2-gtk-3.0`；`pywebview[gtk]` 会安装 PyGObject。
Wayland 下若窗口异常，可尝试 `GDK_BACKEND=x11`。

## 使用流程

1. 设置 → 大模型：填写 OpenAI 兼容地址、Key、模型名。
2. 操作指南 → 浏览器扩展：加载 `~/FreeOCS/extensions/chromium`（或 Firefox 临时加载 manifest.json）。
3. 打开 U校园 目录页，在页面右下角控制面板点“开始”，会自动扫描未完成任务并进入。
4. 设置 → 本地语音转写 / 本地 OCR / 系统语音：按需安装依赖并选择模型。
5. 应用与插件：打开 U校园或智慧树，点开始。
6. 遇到提交/交卷/发布页面会停止，请人工确认；单元信息弹窗会自动关闭，视频不支持时会记录警告并继续。
7. 无法识别的题型会保存页面并尝试 AI 操作网页兜底；页面保存在 `<数据目录>/package-data/ucampus/unsupported_pages/`。

## 目录

- `freeocs/`：框架核心
- `web/`：pywebview 前端
- `packages/src/`：内置插件与模块源码
- `extension/`：浏览器扩展
- `docs/`：设计文档
- `tests/`：测试

## 构建

```bash
.venv/bin/python scripts/build_packages.py      # 内置包 zip
.venv/bin/python scripts/build_extension.py    # 扩展目录 + zip
.venv/bin/python scripts/build_app.py --tar     # PyInstaller onedir + tar.gz
```

## 测试

```bash
.venv/bin/python -m pytest -q
.venv/bin/ruff check freeocs packages/src tests scripts
.venv/bin/python scripts/smoke_ui.py            # 需要图形环境
PLAYWRIGHT_BROWSERS_PATH=$PWD/.playwright \
  FREEOCS_PACKAGES=dist .venv/bin/python scripts/e2e_ucampus.py
```
