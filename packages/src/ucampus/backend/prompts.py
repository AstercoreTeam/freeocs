# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

"""Prompt construction and answer parsing for U校园."""

from __future__ import annotations

import json
import re
from typing import Any

TYPE_LABELS = {
    "choice": "选择题",
    "multi-choice": "多选题",
    "dropdown": "下拉选择题",
    "blank": "填空题",
    "blanks": "多空填空题",
    "essay": "问答题",
    "essays": "问答题",
    "matching": "匹配题",
    "oral": "口语题",
    "discussion": "讨论题",
}


def build_prompt(payload: dict[str, Any]) -> str:
    question_type = str(payload.get("question_type", "choice") or "choice")
    question = str(payload.get("question", "") or "")
    options = payload.get("options") or []
    context = str(payload.get("context", "") or "")
    blank_count = int(payload.get("blank_count", 0) or 0)
    parts = [f"题型：{TYPE_LABELS.get(question_type, question_type)}", f"题目：\n{question}"]
    if options:
        parts.append("选项：\n" + "\n".join(str(item) for item in options))
    if context.strip():
        parts.append(f"补充材料：\n{context}")
    if question_type == "multi-choice":
        parts.append(
            "这是多选题。answer 输出所有正确选项的字母，用逗号或空格分隔，"
            "例如 A, C。不要只给一个选项。"
        )
        parts.append('仅返回 JSON 对象，格式为 {"answer":"...","explanation":"..."}。')
    elif question_type == "matching":
        if re.search(r"arrange|order|sort|排序|顺序", question, re.IGNORECASE):
            parts.append(
                "这是排序题。请根据文章内容，按正确顺序输出 A-F 的字母，"
                "用空格分隔，例如 C A D F B E。不要 JSON，不要编号，不要解释。"
            )
        else:
            parts.append(
                "这是匹配题。只输出一行字母，按单词顺序给出每个单词对应含义的字母，"
                "用空格分隔，例如 D A B C。不要 JSON，不要编号，不要解释。"
            )
        parts.append("只输出这一行字母，不要输出任何其它文字。")
    elif question_type == "discussion":
        parts.append(
            "这是讨论区题目。answer 用 1-2 句简短英文直接回答，控制在 30-60 词，"
            "观点明确、适合直接发布，不要分点，不要额外解释。"
        )
        parts.append('仅返回 JSON 对象，格式为 {"answer":"...","explanation":"..."}。')
    elif question_type == "oral":
        parts.append(
            "这是口语/朗读题。answer 用自然英文写成 60 秒以内、约 80-100 词的简短对话，"
            "适合直接朗读，不要解释。"
        )
        parts.append('仅返回 JSON 对象，格式为 {"answer":"...","explanation":"..."}。')
    elif question_type in {"essay", "essays"}:
        parts.append(
            "这是开放式问答题。answer 用 80-120 词英文完整回答，观点清楚，"
            "直接可填入答题框，不要分点，不要额外解释。"
        )
        parts.append('仅返回 JSON 对象，格式为 {"answer":"...","explanation":"..."}。')
    elif question_type == "blanks":
        count = blank_count or 0
        if count > 0:
            parts.append(
                f"页面恰好有 {count} 个空。请按空格顺序输出 {count} 行纯文本，"
                "每行只写一个空的答案，行数必须等于空数，不要编号，不要 JSON，不要解释。"
            )
        else:
            parts.append(
                "这是多空填空题。请按空格顺序每行输出一个空的答案，不要编号，不要 JSON，不要解释。"
            )
    else:
        parts.append(
            "请根据题目作答。选择题的 answer 写选项字母及选项内容；"
            "填空题的 answer 写可直接填入的内容；口语题的 answer 写自然、"
            "适合朗读的英文作答。仅返回 JSON 对象，格式为 "
            '{"answer":"...","explanation":"..."}。'
        )
    return "\n\n".join(parts)


def parse_answer(raw: str, question_type: str, blank_count: int = 0) -> tuple[str, str]:
    if question_type == "blanks":
        return _parse_blanks(raw, blank_count), ""
    if question_type == "matching":
        return _parse_matching(raw), ""
    return _parse_standard(raw)


def _json_candidate(raw: str) -> Any:
    candidate = (raw or "").strip()
    fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", candidate, re.DOTALL)
    if fenced:
        candidate = fenced.group(1).strip()
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        start = candidate.find("{")
        end = candidate.rfind("}")
        if 0 <= start < end:
            try:
                return json.loads(candidate[start : end + 1])
            except json.JSONDecodeError:
                pass
    return None


def _parse_standard(raw: str) -> tuple[str, str]:
    decoded = _json_candidate(raw)
    if isinstance(decoded, list):
        return "\n".join(str(item).strip() for item in decoded if str(item).strip()), ""
    if not isinstance(decoded, dict):
        return (raw or "").strip(), ""
    answer = decoded.get("answer", "")
    explanation = decoded.get("explanation", "")
    if isinstance(answer, list):
        answer = "\n".join(str(item).strip() for item in answer if str(item).strip())
    elif not isinstance(answer, str):
        answer = str(answer)
    if not isinstance(explanation, str):
        explanation = str(explanation)
    return answer.strip(), explanation.strip()


_BLANK_PREFIX = re.compile(r"^\s*(?:[\[(（]?\d{1,3}[\]）)]?[.)、:：=-]?|[-*•])\s*")
_INLINE_NUMBERED = re.compile(r"(?:^|\s)\d{1,3}[.)、:：]\s*(.+?)(?=(?:\s+\d{1,3}[.)、:：]\s*)|$)")


def _clean_blank(value: str) -> str:
    text = str(value or "").strip().strip("\"'`“”")
    text = _BLANK_PREFIX.sub("", text)
    return text.strip().strip("\"'`“”")


def _parse_blanks(raw: str, count: int) -> str:
    candidate = (raw or "").strip()
    fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", candidate, re.DOTALL)
    if fenced:
        candidate = fenced.group(1).strip()
    decoded = _json_candidate(candidate)
    values: list[str] = []
    if isinstance(decoded, list):
        values = [_clean_blank(item) for item in decoded]
    elif isinstance(decoded, dict):
        value = decoded.get("answer", decoded.get("answers"))
        if isinstance(value, list):
            values = [_clean_blank(item) for item in value]
        elif isinstance(value, str):
            values = [_clean_blank(line) for line in value.splitlines()]
        else:
            values = [_clean_blank(item) for item in decoded.values()]
    values = [value for value in values if value]

    if not values:
        for line in candidate.splitlines():
            value = _clean_blank(line)
            if value:
                values.append(value)

    if count > 0:
        # Key/value forms such as "1=apple" or "blank1: apple".
        pairs = re.findall(
            r"^\s*(?:blank\s*)?\d+\s*[=:：]\s*(.+)$", candidate, re.IGNORECASE | re.MULTILINE
        )
        cleaned = [_clean_blank(item) for item in pairs]
        cleaned = [value for value in cleaned if value]
        if len(cleaned) == count:
            values = cleaned

    if count > 0 and len(values) != count:
        # A single line like "1. apple 2. banana" contains several answers.
        inline = [
            _clean_blank(match.group(1))
            for match in _INLINE_NUMBERED.finditer(" ".join(candidate.splitlines()))
        ]
        inline = [value for value in inline if value]
        if len(inline) == count:
            values = inline

    if count > 0 and len(values) < count:
        # Fall back to strong separators only: "|", ";", "；" and tabs.
        parts = [part for part in re.split(r"\s*[|;；\t]\s*", "\n".join(values)) if part.strip()]
        if len(parts) > len(values):
            values = [_clean_blank(part) for part in parts]
            values = [value for value in values if value]

    if count > 0 and len(values) > count:
        values = values[:count]
    return "\n".join(values)


def _parse_matching(raw: str) -> str:
    candidate = (raw or "").strip()
    fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", candidate, re.DOTALL)
    if fenced:
        candidate = fenced.group(1).strip()
    array_match = re.search(r"\[([^\]]*)\]", candidate)
    if array_match:
        return "\n".join(re.findall(r"\b([A-Z])\b", array_match.group(1)))
    decoded = _json_candidate(candidate)
    if isinstance(decoded, dict):
        values = [str(value) for value in decoded.values()]
        letters = re.findall(r"\b([A-Z])\b", " ".join(values))
        if letters:
            return "\n".join(letters)
    lines = [line for line in candidate.splitlines() if line.strip()]
    scope = lines[-1] if lines else candidate
    return "\n".join(re.findall(r"\b([A-Z])\b", scope))
