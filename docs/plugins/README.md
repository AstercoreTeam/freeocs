# 插件实现文档（plugins）

本目录按插件拆分，每个插件一个文件夹，记录：

- 提供的能力
- 依赖与运行环境
- 设置项
- 调用流程
- 限制与回退策略

平台/模块机制见 [../mods/README.md](../mods/README.md)。

## 插件索引

| 插件 | 能力 | 类型 | 文档 |
| --- | --- | --- | --- |
| `answer_basic` | `answer.choice` | 答题 | [answer_basic](answer_basic/README.md) |
| `llm_openai` | `llm.chat` | 模型 | [llm_openai](llm_openai/README.md) |
| `asr_openai` | `media.asr` | 云端 | [asr_openai](asr_openai/README.md) |
| `asr_whisper` | `media.asr` | 本地 | [asr_whisper](asr_whisper/README.md) |
| `ocr_rapid` | `media.ocr` | 本地 | [ocr_rapid](ocr_rapid/README.md) |
| `tts_system` | `media.tts` | 本地 | [tts_system](tts_system/README.md) |
| `tts_openai` | `media.tts` | 云端 | [tts_openai](tts_openai/README.md) |
| `tts_kokoclone` | `media.tts` | 本地克隆 | [tts_kokoclone](tts_kokoclone/README.md) |

同一能力有多个插件时，在「设置 → 能力绑定」中选择实际使用的插件。

## 插件通用约定

- 插件只通过 `PackageContext` 使用能力，不直接依赖主程序内部实现。
- 包内 `manifest.json` 声明 `provides`、`requires`、`dependencies`、`settings`。
- 依赖按需安装；重依赖（torch、faster-whisper、OCR）不默认进主程序。
- 失败时抛 `ProviderError`，由模块/UI 显示可操作错误。

---

## License / 许可

Copyright (C) 2026 qincnd <qincnd@qq.com>, XueZicheng <xuezicheng842@outlook.com>, AstercoreTeam.

This project is licensed under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`).
See [https://spdx.org/licenses/AGPL-3.0-only.html](https://spdx.org/licenses/AGPL-3.0-only.html).

