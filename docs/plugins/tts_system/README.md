# tts_system

## 能力

```text
media.tts
```

使用操作系统语音引擎生成 WAV，离线可用。

## 依赖

- `pyttsx3`
- Linux 通常需要 `espeak-ng`
- Windows 使用 SAPI5
- macOS 使用系统语音

## 设置

- 语音 ID（留空系统默认）
- 语速（默认 175）
- 音量（0-1）
- 单次合成文本上限（默认 0 = 不限制）

## 流程

```text
text
  → pyttsx3.init()
  → save_to_file()
  → runAndWait()
  → 读取 WAV
```

临时文件在 `<data>/tts/`，读取后删除；全局锁串行化。

## 限制

- 打包版未内置 pyttsx3
- 音色取决于系统安装的语音
- 中文效果取决于系统中文 voice

## 源码

`packages/src/tts_system/backend/main.py`

---

## License / 许可

Copyright (C) 2026 qincnd <qincnd@qq.com>, XueZicheng <xuezicheng842@outlook.com>, AstercoreTeam.

This project is licensed under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`).
See [https://spdx.org/licenses/AGPL-3.0-only.html](https://spdx.org/licenses/AGPL-3.0-only.html).

