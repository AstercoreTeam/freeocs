# llm_openai

## 能力

```text
llm.chat
```

调用任意 OpenAI 兼容 `/chat/completions` 文本模型。

## 配置

使用全局「设置 → 大模型」：

- API 地址
- API Key
- 模型名
- 温度
- 最大输出
- 超时
- 额外请求头

## 流程

```text
messages/tools/response_format
  → POST /chat/completions
  → ChatResult(message, usage, raw)
```

`usage` 会交给框架的 Token 统计/消费限额。

## 兼容

- DeepSeek
- OpenAI
- Ollama / vLLM / LM Studio 等兼容实现
- 需要 Function Calling 时由调用方传 `tools`

## 源码

`packages/src/llm_openai/backend/main.py`

---

## License / 许可

Copyright (C) 2026 qincnd <qincnd@qq.com>, XueZicheng <xuezicheng842@outlook.com>, AstercoreTeam.

This project is licensed under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`).
See [https://spdx.org/licenses/AGPL-3.0-only.html](https://spdx.org/licenses/AGPL-3.0-only.html).

