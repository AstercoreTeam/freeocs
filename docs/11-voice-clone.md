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
| 参考音频（用于克隆） | **3–10 秒、单人、无背景音乐的人声**；可在首页上传或现场录制 |
| 语言 | en / zh / ja / fr / hi / it / pt / es |
| 合成超时 | 默认 600 秒 |

首次启动时 `media.tts` 默认绑定 **KokoClone 克隆语音**；如需改用系统语音或云端语音，可在设置 → 能力绑定切换。

单次合成文本上限 `max_chars` 默认 `0`（不限制）。如需限制单次合成长度，可在克隆语音设置中填写字符数。

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
- WAV/MP3/OGG/WebM/M4A/FLAC 均可

## 首页快捷设置

首页选择 U校园后，在“语音合成”区域：

1. 语音提供者选择“克隆语音（KokoClone）”。
2. 点击“上传音频文件”导入已有录音；或点击“录制朗读”，朗读页面显示的示例文字并停止保存。
3. 录制最长 30 秒，建议保持 3–10 秒；录音会转换为应用数据目录下的参考音频。

导入或录制的文件保存在 `<数据目录>/voice-samples/`，路径会自动写入克隆语音的“参考音频”设置。文件只在本机使用，不会上传。

## 限制

- 需要独立 KokoClone 环境；主程序不内置 torch。
- 首次模型下载需要网络。
- 当前不自动裁剪参考音频，请自行保证时长。
- 未打包进 `dist`；当前为源码插件。
