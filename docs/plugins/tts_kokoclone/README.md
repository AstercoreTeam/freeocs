# tts_kokoclone

## 能力

```text
media.tts
```

使用 KokoClone（Kokoro + Kanade）做零样本声音克隆。

## 用户配置

设置 → 克隆语音（KokoClone）：

- 运行方式：内置依赖（推荐）或外部 KokoClone Python
- 外部方式才需要 KokoClone 代码目录和 Python
- **参考音频：3-10 秒单人、无背景音乐的人声**
- 语言
- 合成超时
- 模型文件：
  - Kokoro ONNX（`kokoro.onnx`）
  - Kokoro voices（`voices-v1.0.bin`）
  - Kanade `config.yaml`
  - Kanade `model.safetensors`
  - 可选 Vocos 模型目录
  - 可选 Kokoro vocab config

设置 → 能力绑定 → `media.tts` 选择 KokoClone。

## 流程

```text
FreeOCS
  → 校验参考音频和模型文件
  → 内置依赖直接加载 Kokoro + Kanade
  → 用参考音频克隆音色
  → 读取 WAV
```

完整打包版已经内置 torch、torchaudio、kokoro-onnx、kanade-tokenizer、
soundfile、misaki、vocos 等运行时依赖；模型文件保持外置。

## 为什么用外部 Python

KokoClone 依赖 torch / torchaudio / Kanade，体积和平台差异都很大。主程序只负责配置、调用和读取结果，不把 torch 装进主进程。

## 限制

- 内置方式不再需要独立 Python 环境
- 外部方式仍可使用独立 KokoClone 环境
- 模型文件必须由用户选择；不会打进安装包
- 参考音频质量决定克隆效果
- 当前不自动裁剪参考音频

## 源码

`packages/src/tts_kokoclone/backend/main.py`

---

## License / 许可

Copyright (C) 2026 qincnd <qincnd@qq.com>, XueZicheng <xuezicheng842@outlook.com>, AstercoreTeam.

This project is licensed under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`).
See [https://spdx.org/licenses/AGPL-3.0-only.html](https://spdx.org/licenses/AGPL-3.0-only.html).

