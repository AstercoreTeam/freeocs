# answer_basic

## 能力

```text
answer.choice
```

基于 `llm.chat` 的选择题辅助：题干 + 选项 → 一个选项字母。

## 依赖

- `llm.chat` 能力（通常是 `llm_openai`）
- 无额外 Python 依赖

## 流程

```text
question + options
  → 构造选择题 prompt
  → llm.chat
  → 解析 JSON 的 answer
  → 校验字母在选项范围内
  → 返回 ChoiceAnswer
```

## 设置

无。使用全局大模型设置。

## 适用

- 普通单选题
- 复杂题型（多选、填空、排序）由 U校园 模块自己处理，不走这个插件

## 源码

`packages/src/answer_basic/backend/main.py`

---

## License / 许可

Copyright (C) 2026 qincnd <qincnd@qq.com>, XueZicheng <xuezicheng842@outlook.com>, AstercoreTeam.

This project is licensed under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`).
See [https://spdx.org/licenses/AGPL-3.0-only.html](https://spdx.org/licenses/AGPL-3.0-only.html).

