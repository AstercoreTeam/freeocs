# 本地克隆语音（KokoClone）

使用 KokoClone（Kokoro TTS + Kanade voice conversion）进行零样本声音克隆。

## 设置

1. 准备 KokoClone 项目目录，包含：
   - `core/cloner.py`
   - `model/kokoro.onnx`
   - `voice/voices-v1.0.bin`
2. 配置一个安装了 KokoClone 依赖的 Python：
   - torch / torchaudio
   - kokoro-onnx
   - kanade-tokenizer
   - soundfile / misaki
3. 在设置 → 克隆语音中：
   - 选择 KokoClone 目录（代码）
   - 选择 KokoClone Python（留空尝试 `.venv/bin/python`）
   - 选择模型文件：
     - Kokoro ONNX（`kokoro.onnx`）
     - Kokoro voices（`voices-v1.0.bin`）
     - Kanade `config.yaml`
     - Kanade `model.safetensors`
     - 可选 Vocos 模型目录、Kokoro vocab config
   - 选择一段 **3-10 秒、单人、无背景音乐** 的参考音频
   - 选择语言
4. 设置 → 能力绑定 → `media.tts` 选择“KokoClone 克隆语音”。

## 合成方式

FreeOCS 不把 torch 装进主程序，而是：

```text
FreeOCS TTS 能力
  → 写请求 JSON（文本、语言、参考音频、输出路径）
  → 调用 KokoClone Python 的 core.cloner.KokoClone
  → 读取生成的 WAV
```

参考音频只保存在本机；不会上传。

## 注意

- 第一次使用会下载 Kanade 模型，可能需要较长时间。
- 合成在 KokoClone 独立环境中运行，不会阻塞主程序启动。
- 参考音频质量直接决定克隆效果。

---

## License / 许可

Copyright (C) 2026 qincnd <qincnd@qq.com>, XueZicheng <xuezicheng842@outlook.com>, AstercoreTeam.

This project is licensed under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`).
See [https://spdx.org/licenses/AGPL-3.0-only.html](https://spdx.org/licenses/AGPL-3.0-only.html).

