# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

"""com.able.wisdomtree page reader, ported from aiQuestion (MIT)."""

from __future__ import annotations

import re

from .base import Button, Option, PageData, PageReader, center_of, parse_bounds

OPTION_PATTERN = re.compile(r"^([A-Za-z])\s*[\.、\)．]\s*(.+)$")
QUESTION_TYPE_WORDS = ("判断题", "单选题", "多选题", "不定项")
BUTTON_WORDS = ("下一题", "上一题", "提交", "交卷", "完成", "答题卡", "继续")
PACKAGE_NAME = "com.able.wisdomtree"
OPTION_MAX_TEXT_LEN = 100
LOW_QUALITY_TEXTS = {"undefined", "null", "NaN", "true", "false"}


class WisdomTreeReader(PageReader):
    name = "wisdomtree_quiz"

    def can_handle(self, xml_root) -> bool:
        for node in xml_root.iter("node"):
            if node.get("package") == PACKAGE_NAME:
                return True
        return False

    def parse(self, xml_root, screen_width: int, screen_height: int) -> PageData:
        page = PageData(
            page_type=self.name,
            screen_width=screen_width,
            screen_height=screen_height,
        )
        clickable_nodes: list[dict] = []
        text_nodes: list[dict] = []
        raw_lines: list[str] = []

        for node in xml_root.iter("node"):
            text = (node.get("text") or "").strip()
            bounds = parse_bounds(node.get("bounds", ""))
            if not bounds:
                continue
            if not text or text in LOW_QUALITY_TEXTS:
                continue
            clickable = node.get("clickable") == "true"
            cls = node.get("class", "")
            raw_lines.append(text)
            item = {"text": text, "bounds": bounds, "class": cls}
            (clickable_nodes if clickable else text_nodes).append(item)

        page.raw_text = "\n".join(raw_lines)

        for item in text_nodes:
            if any(word in item["text"] for word in QUESTION_TYPE_WORDS):
                page.question_type = item["text"]
                break

        for item in clickable_nodes + text_nodes:
            text = item["text"]
            if text in LOW_QUALITY_TEXTS:
                continue
            if any(word in text for word in BUTTON_WORDS):
                continue
            if any(word in text for word in QUESTION_TYPE_WORDS):
                continue
            if re.fullmatch(r"[\d/]+", text):
                continue
            match = OPTION_PATTERN.match(text)
            if not match:
                continue
            if len(match.group(2)) > OPTION_MAX_TEXT_LEN:
                continue
            x, y = center_of(item["bounds"])
            page.options.append(Option(text=text, x=x, y=y, raw_id=match.group(1)))

        for item in clickable_nodes:
            if any(word in item["text"] for word in BUTTON_WORDS):
                x, y = center_of(item["bounds"])
                page.buttons.append(Button(text=item["text"], x=x, y=y))

        option_top = min((opt.y for opt in page.options), default=screen_height)
        option_texts = {opt.text for opt in page.options}
        question_parts: list[tuple[int, str]] = []
        for item in text_nodes:
            if item["class"] != "android.widget.TextView":
                continue
            if item["text"] in option_texts or item["text"] in LOW_QUALITY_TEXTS:
                continue
            if any(word in item["text"] for word in QUESTION_TYPE_WORDS):
                continue
            if any(word in item["text"] for word in BUTTON_WORDS):
                continue
            if re.fullmatch(r"[\d/]+", item["text"]):
                continue
            if item["bounds"][1] < option_top:
                question_parts.append((item["bounds"][1], item["text"]))
        question_parts.sort(key=lambda entry: entry[0])
        page.question = " ".join(text for _, text in question_parts)
        return page
