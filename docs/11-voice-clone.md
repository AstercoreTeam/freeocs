# 克隆语音（KokoClone）

`tts_kokoclone` 是新增的本地 TTS 插件，使用 **KokoClone / Kokoro + Kanade** 做零样本声音克隆。

## 设置位置

设置 → **克隆语音（KokoClone）**：

| 字段 | 说明 |
| --- | --- |
| KokoClone 目录 | 包含 `core/cloner.py`、`model/`、`voice/` 的目录 |
| KokoClone Python | 安装了 torch、kokoro-onnx、kanade-tokenizer 的 Python；留空自动找 `.venv/bin/python` |
| Kokoro ONNX 模型 | 用户选择 `kokoro.onnx`（或中文模型） |
| Kokoro voices 文件 | 用户选择 `voices-v1.0.bin`（或中文 voices） |
| Kanade config.yaml | 用户选择 Kanade 模型配置 |
| Kanade model.safetensors | 用户选择 Kanade 权重 |
| Vocoder 模型目录 | 可选，留空自动下载 |
| Kokoro vocab config | 可选，中文/日文模型可指定 |
| 参考音频（用于克隆） | **用户在这里放 3–10 秒、单人、无背景音乐的人声** WAV/MP3 |
| 语言 | en / zh / ja / fr / hi / it / pt / es |
| 合成超时 | 默认 600 秒 |

设置 → 能力绑定 → `media.tts` 选择 **KokoClone 克隆语音**。

## 运行方式

FreeOCS 不把 torch/Kokoro/Kanade 装进主程序，而是：

```text
TTS 能力
  → 写请求 JSON（文本、语言、参考音频、输出路径）
  → 调用 KokoClone 独立 Python 的 core.cloner.KokoClone
  → 读取 WAV
```

参考音频只在本机使用，不上传。

## KokoClone 环境准备

准备一个 KokoClone 项目目录（含 `core/cloner.py`、`model/`、`voice/`）。

需要一个 Linux 环境（示例）：

```bash
cd <KokoClone目录>
uv venv .venv-linux
uv pip install --python .venv-linux/bin/python -r requirements.txt
```

然后在设置中选择：

```text
KokoClone 目录 = <KokoClone目录>
KokoClone Python = <KokoClone目录>/.venv-linux/bin/python
参考音频 = 你选择的 3–10 秒人声.wav
```

首次合成会从 Hugging Face 下载 Kanade 模型，时间较长；之后会复用缓存。

## 参考音频建议

- 3–10 秒
- 单人说话
- 无背景音乐/噪声
- 语速自然
- WAV/MP3 均可

## 限制

- 需要独立 KokoClone 环境；主程序不内置 torch。
- 首次模型下载需要网络。
- 当前不自动裁剪参考音频，请自行保证时长。
- 未打包进 `dist`；当前为源码插件。
