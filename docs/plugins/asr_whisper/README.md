# asr_whisper

## 能力

```text
media.asr
```

使用本地 `faster-whisper` 做离线转写。

## 依赖

```text
faster-whisper>=1.2,<2
av>=15,<16
ffmpeg（系统命令，用于清洗视频容器）
```

## 设置

- 模型目录（需包含 `model.bin`；留空使用 `<data>/models/faster-whisper-base`）
- 设备：CPU / CUDA
- 计算精度：int8 / float16 / float32
- 语言
- 静音过滤
- 最大音频字节数

## 流程

```text
audio/video bytes
  → 写临时文件
  → ffmpeg 去元数据、转 16k 单声道 WAV
  → wave/numpy 读取 PCM
  → faster-whisper
  → Transcript
```

### 为什么要 ffmpeg + PCM

- PyAV 对部分中文视频元数据会按 ASCII 解码失败
- 直接喂 WAV 给 PyAV 的 resampler 也可能触发同类错误
- 因此先 ffmpeg 标准化，再用 numpy 数组交给 faster-whisper

## 限制

- 完整打包版已内置 faster-whisper / av / imageio-ffmpeg；模型仍需外置
- 首次加载模型较慢
- 模型目录必须包含 `model.bin`
- 没有 ffmpeg 时回退到原始文件路径，可能受容器元数据影响

## 源码

`packages/src/asr_whisper/backend/main.py`

---

## License / 许可

Copyright (C) 2026 qincnd <qincnd@qq.com>, XueZicheng <xuezicheng842@outlook.com>, AstercoreTeam.

This project is licensed under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`).
See [https://spdx.org/licenses/AGPL-3.0-only.html](https://spdx.org/licenses/AGPL-3.0-only.html).

