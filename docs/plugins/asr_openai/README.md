# asr_openai

## 能力

```text
media.asr
```

调用 OpenAI 兼容 `/audio/transcriptions` 做云端语音转写。

## 设置

- API 地址
- API Key
- 模型（默认 `whisper-1`）
- 语言（留空自动检测）
- 超时

## 流程

```text
audio bytes
  → multipart/form-data
  → POST /audio/transcriptions
  → Transcript(text, language)
```

## 适用

- 没有本地 `faster-whisper` 环境时
- U校园听力、视频音轨转写

## 限制

- 需要网络和云端 API Key
- 音频会上传到配置的服务商

## 源码

`packages/src/asr_openai/backend/main.py`

---

## License / 许可

Copyright (C) 2026 qincnd <qincnd@qq.com>, XueZicheng <xuezicheng842@outlook.com>, AstercoreTeam.

This project is licensed under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`).
See [https://spdx.org/licenses/AGPL-3.0-only.html](https://spdx.org/licenses/AGPL-3.0-only.html).

