# tts_openai

## 能力

```text
media.tts
```

调用 OpenAI 兼容 `/audio/speech` 生成 MP3/WAV。

## 设置

- API 地址
- API Key
- 模型（默认 `gpt-4o-mini-tts`）
- 语音（默认 `alloy`）
- 输出格式 mp3/wav
- 超时

## 流程

```text
text + voice + format
  → POST /audio/speech
  → AudioResult(data, mime, ext)
```

## 适用

- 没有本地 TTS 环境
- 需要 MP3 输出
- 不想安装 pyttsx3/系统语音

## 源码

`packages/src/tts_openai/backend/main.py`

---

## License / 许可

Copyright (C) 2026 qincnd <qincnd@qq.com>, XueZicheng <xuezicheng842@outlook.com>, AstercoreTeam.

This project is licensed under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`).
See [https://spdx.org/licenses/AGPL-3.0-only.html](https://spdx.org/licenses/AGPL-3.0-only.html).

