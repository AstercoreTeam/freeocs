# FreeOCS

本地优先、插件化的学习助手桌面应用。pywebview 界面，网页应用通过浏览器扩展中继。

> 设计文档见 [`docs/README.md`](docs/README.md)。

## 当前状态

- 框架：zip 插件/模块、能力注册、设置页、操作指南、日志、事件
- 浏览器扩展：Chromium MV3 + Firefox，页面 Agent 注入、DOM 操作、模块 API 代理
- Android ADB：保留通用传输支持；当前内置模块不依赖它
- 内置插件：LLM、选择题、TTS、ASR、OCR
- 内置模块：**U校园（网页）**、**智慧树（网页）**
- 安全：智慧树默认关闭自动提交；其他模块在提交/交卷/发布前停止

## 快速开始（开发）

以下命令都必须在**仓库根目录**（包含 `main.py` 的目录）执行。若当前在 `docs/` 等子目录，先 `cd` 回根目录：

```powershell
cd E:\project\freeocs
```

Linux：

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

Windows（PowerShell）：

```powershell
cd E:\project\freeocs
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
.\.venv\Scripts\python.exe scripts\build_packages.py
.\.venv\Scripts\python.exe scripts\build_extension.py
$env:FREEOCS_PACKAGES = "dist"
.\.venv\Scripts\python.exe main.py --dev
```

如果 `python main.py` 报错找不到文件，通常是当前目录不在仓库根目录；如果 `python` 指向 Microsoft Store 的 Python，请改用上面的 `.\.venv\Scripts\python.exe`。

Windows 桌面运行需要 WebView2 Runtime（Windows 10/11 通常已安装）。

## 使用流程

1. 首页 → 大模型配置：选择云端 API 或本地 Ollama，保存并测试连接；本地推荐 `qwen2.5vl:7b`。
2. 操作指南 → 浏览器扩展：加载 `~/FreeOCS/extensions/chromium`（或 Firefox 临时加载 manifest.json）。
3. 打开 U校园 目录页，在页面右下角控制面板点“开始”，会自动扫描未完成任务并进入。
4. 模型下载：下载 Kokoro / Kanade 语音模型，或在同一页面拉取 Ollama 模型；默认语音提供者为 KokoClone。
5. 首页：选择要执行的网页，上传或录制样本音频、调整点击节奏后打开网页并启动模块；详细选项在模块详情和设置页。
6. 遇到提交/交卷/发布页面会停止，请人工确认；单元信息弹窗会自动关闭，视频不支持时会记录警告并继续。
7. 无法识别的题型会保存页面并尝试 AI 操作网页兜底；页面保存在 `<数据目录>/package-data/ucampus/unsupported_pages/`。

## 目录

- `freeocs/`：框架核心
- `web/`：pywebview 前端
- `packages/src/`：内置插件与模块源码
- `extension/`：浏览器扩展
- `docs/`：设计文档
- `tests/`：测试

## 分发包说明

完整打包版包含本地 ASR、OCR、系统 TTS、克隆语音所需的 Python 运行时依赖
（faster-whisper、PyAV、CTranslate2、RapidOCR、ONNX Runtime、pyttsx3、
Kokoro/Kanade、PyTorch CPU、ffmpeg 等），但**不包含任何模型权重**。

模型下载与目录说明见 [docs/12-models.md](docs/12-models.md)。模型仍由用户在设置中选择：

- faster-whisper 模型目录
- Kokoro ONNX / voices
- Kanade config.yaml / model.safetensors
- 大模型 API 或本地模型配置
- RapidOCR 自带的轻量 OCR 模型随依赖包存在

打包目录约 1.9 GB，压缩包约几百 MB；如果只需要云端能力，可以使用源码版或精简包。

## 构建

```bash
.venv/bin/python scripts/build_packages.py      # 内置包 zip
.venv/bin/python scripts/build_extension.py    # 扩展目录 + zip
.venv/bin/python scripts/build_app.py --tar     # PyInstaller onedir + tar.gz
```

Windows 上使用 `.venv\Scripts\python.exe scripts\build_app.py --windows` 构建 onedir 应用。

## 测试

```bash
.venv/bin/python -m pytest -q
.venv/bin/ruff check freeocs packages/src tests scripts
.venv/bin/python scripts/smoke_ui.py            # 需要图形环境
PLAYWRIGHT_BROWSERS_PATH=$PWD/.playwright \
  FREEOCS_PACKAGES=dist .venv/bin/python scripts/e2e_ucampus.py
```

## 致谢

本项目的开发离不开以下优秀开源项目和社区的贡献，在此我们表示由衷的感谢。

| 项目 | 用途 | 开源协议 |
| :--- | :--- | :--- |
| pywebview | 桌面窗口与 Python/JS 桥 | BSD-3-Clause |
| GTK / WebKitGTK | Linux 桌面渲染 | LGPL-2.1-or-later |
| PyGObject | GTK 的 Python 绑定 | LGPL-2.1-or-later |
| layui | 前端基础样式与组件 | MIT |
| httpx | HTTP 客户端 | BSD-3-Clause |
| Ruff | Python lint / format | MIT |
| pytest | 测试框架 | MIT |
| PyInstaller | 桌面打包 | GPL-2.0-or-later WITH Bootloader-exception |
| Playwright | 浏览器端到端测试 | Apache-2.0 |
| faster-whisper | 本地语音转写 | MIT |
| PyAV | 音视频容器解码 | BSD-3-Clause |
| FFmpeg | 音视频转码/标准化 | LGPL-2.1-or-later 或 GPL-2.0-or-later（取决于构建） |
| RapidOCR | 本地 OCR | Apache-2.0 |
| ONNX Runtime | OCR/模型推理运行时 | MIT |
| Pillow | 图像处理 | HPND |
| NumPy | 数值计算 | BSD-3-Clause |
| pyttsx3 | 系统语音合成 | MPL-2.0 |
| KokoClone / Kokoro / Kanade | 本地克隆语音引擎 | Apache-2.0 |
| PyTorch | 克隆语音推理运行时 | BSD-3-Clause |

感谢以上项目及其贡献者。各依赖的完整许可文本请查看对应上游项目。

---

## License / 许可

Copyright (C) 2026 qincnd <qincnd@qq.com>, XueZicheng <xuezicheng842@outlook.com>, AstercoreTeam.

This project is licensed under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`).
See [https://spdx.org/licenses/AGPL-3.0-only.html](https://spdx.org/licenses/AGPL-3.0-only.html).


## 贡献

欢迎提交 Issue 和 Pull Request。请参阅[CONTRIBUTING.md](CONTRIBUTING.md)、[ToDo文档](ToDo.md)

## 联系方式
---

作者

qincnd <qincnd@qq.com>

Xue Zicheng <xuezicheng842@outlook.com>

---
