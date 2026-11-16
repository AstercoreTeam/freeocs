# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

from packages.src.ucampus.backend.prompts import build_prompt, parse_answer


def test_choice_prompt_requests_json() -> None:
    prompt = build_prompt(
        {
            "question": "Choose the best answer.",
            "options": ["A. one", "B. two"],
            "question_type": "choice",
        }
    )
    assert "Choose the best answer." in prompt
    assert "A. one" in prompt
    assert '"answer"' in prompt


def test_blanks_prompt_count() -> None:
    prompt = build_prompt(
        {"question": "Fill in the blanks.", "question_type": "blanks", "blank_count": 3}
    )
    assert "3 个空" in prompt
    assert "3 行" in prompt


def test_multi_choice_prompt() -> None:
    prompt = build_prompt(
        {
            "question": "Choose all correct answers.",
            "options": ["A. one", "B. two", "C. three"],
            "question_type": "multi-choice",
        }
    )
    assert "多选题" in prompt
    assert "A, C" in prompt


def test_reading_context_is_included() -> None:
    prompt = build_prompt(
        {
            "question": "According to the passage, what is the main idea?",
            "options": ["A. one", "B. two"],
            "question_type": "choice",
            "context": "The full reading passage goes here.",
        }
    )
    assert "The full reading passage goes here." in prompt
    assert "补充材料" in prompt


def test_sorting_prompt_requests_sequence() -> None:
    prompt = build_prompt(
        {
            "question": "Arrange the following summaries in the order (1-6).",
            "question_type": "matching",
        }
    )
    assert "排序题" in prompt
    assert "C A D" in prompt


def test_parse_standard_json() -> None:
    assert parse_answer('{"answer":"B","explanation":"because"}', "choice") == ("B", "because")
    assert parse_answer('```json\n{"answer":"A"}\n```', "choice") == ("A", "")


def test_parse_blanks_lines() -> None:
    answer, _ = parse_answer("first\nsecond\nthird", "blanks", 3)
    assert answer == "first\nsecond\nthird"
    answer, _ = parse_answer("1. one\n2. two", "blanks", 2)
    assert answer == "one\ntwo"


def test_parse_matching() -> None:
    assert parse_answer("D A B C", "matching")[0] == "D\nA\nB\nC"
    assert parse_answer('["D","A"]', "matching")[0] == "D\nA"
