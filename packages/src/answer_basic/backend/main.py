# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

"""Minimal choice-answer capability built on llm.chat."""

from __future__ import annotations

import re
from collections.abc import Sequence

from freeocs.sdk import (
    ChoiceAnswer,
    PackageContext,
    ProviderError,
    parse_json_object,
)


class BasicChoiceAnswer:
    def __init__(self, api: PackageContext) -> None:
        self.api = api

    def answer_choice(
        self,
        question: str,
        options: Sequence[str],
        *,
        context: str = "",
        timeout: float | None = None,
    ) -> ChoiceAnswer:
        llm = self.api.require("llm.chat")
        letters = [chr(65 + index) for index in range(len(options))]
        option_lines = "\n".join(
            f"{letter}. {text}" for letter, text in zip(letters, options, strict=False)
        )
        prompt = f"题目：\n{question}"
        if context.strip():
            prompt += f"\n\n补充材料：\n{context}"
        if option_lines:
            prompt += f"\n\n选项：\n{option_lines}"
        prompt += (
            "\n\n只返回 JSON 对象，格式为 "
            '{"answer":"A"}。'
            "answer 必须是选项字母之一；不要返回 explanation 或解析。"
        )
        result = llm.chat(
            [
                {"role": "system", "content": "你是严谨的学习助手，只选择最合适的选项。"},
                {"role": "user", "content": prompt},
            ],
            temperature=0,
            timeout=timeout,
        )
        raw = str((result.message or {}).get("content") or "")
        parsed = parse_json_object(raw)
        answer = str(parsed.get("answer", "") or "").strip()
        explanation = str(parsed.get("explanation", "") or "").strip()
        if not answer:
            match = re.search(r"\b([A-Z])\b", raw.upper())
            answer = match.group(1) if match else ""
        match = re.search(r"([A-Z])", answer.upper())
        if not match:
            raise ProviderError(f"模型未返回可识别的选项：{raw[:200]}")
        letter = match.group(1)
        index = ord(letter) - 65
        if not 0 <= index < len(options):
            raise ProviderError(f"模型返回的选项 {letter} 不在范围内")
        return ChoiceAnswer(
            index=index,
            letter=letter,
            text=str(options[index]),
            explanation=explanation,
            raw=raw,
        )


def setup(api: PackageContext) -> None:
    api.provide("answer.choice", BasicChoiceAnswer(api))
