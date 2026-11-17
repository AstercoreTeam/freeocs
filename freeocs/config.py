# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

"""Settings schema, validation and atomic JSON persistence."""

from __future__ import annotations

import json
import os
import threading
from copy import deepcopy
from pathlib import Path
from typing import Any

from .sdk import SettingsError

SETTINGS_VERSION = 1


def field(
    key: str,
    label: str,
    type_: str = "text",
    default: Any = "",
    *,
    help: str = "",
    placeholder: str = "",
    options: list[dict[str, str]] | None = None,
    min: float | None = None,
    max: float | None = None,
    step: float | None = None,
    required: bool = False,
    advanced: bool = False,
    max_length: int | None = None,
    rows: int | None = None,
    visible_when: dict[str, Any] | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "key": key,
        "label": label,
        "type": type_,
        "default": default,
        "help": help,
        "required": required,
        "advanced": advanced,
    }
    if placeholder:
        result["placeholder"] = placeholder
    if options is not None:
        result["options"] = options
    if min is not None:
        result["min"] = min
    if max is not None:
        result["max"] = max
    if step is not None:
        result["step"] = step
    if max_length is not None:
        result["max_length"] = max_length
    if rows is not None:
        result["rows"] = rows
    if visible_when is not None:
        result["visible_when"] = visible_when
    return result


CORE_SECTIONS: list[dict[str, Any]] = [
    {
        "id": "legal",
        "title": "许可协议",
        "description": "AGPL-3.0-only 许可与版权信息。",
        "group": "core",
        "order": 5,
        "fields": [
            field("accepted", "已同意 AGPL-3.0-only", "boolean", False, advanced=True),
            field("accepted_at", "同意时间", "text", "", advanced=True),
        ],
    },
    {
        "id": "ui",
        "title": "界面",
        "description": "外观、语言与日志级别。",
        "group": "core",
        "order": 10,
        "fields": [
            field(
                "theme",
                "主题",
                "select",
                "light",
                options=[
                    {"value": "light", "label": "浅色"},
                    {"value": "dark", "label": "深色"},
                    {"value": "system", "label": "跟随系统"},
                ],
            ),
            field(
                "locale",
                "语言",
                "select",
                "zh-CN",
                options=[
                    {"value": "zh-CN", "label": "简体中文"},
                    {"value": "en-US", "label": "English"},
                ],
            ),
            field(
                "start_page",
                "启动页",
                "select",
                "home",
                options=[
                    {"value": "home", "label": "首页"},
                    {"value": "apps", "label": "应用"},
                    {"value": "models", "label": "模型下载"},
                    {"value": "guide", "label": "操作指南"},
                ],
            ),
            field(
                "log_level",
                "日志级别",
                "select",
                "info",
                options=[
                    {"value": "info", "label": "普通"},
                    {"value": "debug", "label": "调试"},
                    {"value": "warn", "label": "警告"},
                    {"value": "error", "label": "错误"},
                ],
            ),
        ],
    },
    {
        "id": "llm",
        "title": "大模型",
        "description": "全局文本模型，兼容 OpenAI /chat/completions。",
        "group": "core",
        "order": 20,
        "fields": [
            field(
                "provider_mode",
                "连接方式",
                "select",
                "cloud",
                options=[
                    {"value": "cloud", "label": "云端大模型"},
                    {"value": "ollama", "label": "本地 Ollama"},
                ],
                help="本地 Ollama 默认使用 http://localhost:11434/v1。",
            ),
            field(
                "base_url",
                "API 地址",
                "text",
                "https://api.deepseek.com",
                placeholder="https://api.deepseek.com",
                help="OpenAI 兼容根地址，例如 https://api.openai.com/v1。",
                required=True,
            ),
            field(
                "api_key",
                "API Key",
                "password",
                "",
                placeholder="sk-...",
                help="仅保存在本机配置文件（权限 0600），不会上传。",
            ),
            field("model", "模型", "text", "deepseek-flash", required=True),
            field("temperature", "温度", "number", 0.2, min=0, max=2, step=0.1),
            field("max_tokens", "最大输出", "integer", 2048, min=1, max=65536, step=1),
            field("timeout", "超时（秒）", "number", 300, min=5, max=3600, step=5),
            field(
                "extra_headers",
                "额外请求头",
                "textarea",
                "",
                rows=3,
                advanced=True,
                placeholder='{"X-Example": "value"}',
                help="JSON 对象，可选。",
            ),
        ],
    },
    {
        "id": "usage",
        "title": "Token 消耗",
        "description": "按模型返回的 usage 统计 token；单价与限额用人民币。",
        "group": "core",
        "order": 25,
        "fields": [
            field(
                "cache_hit_price_per_million",
                "缓存命中输入单价（元/百万 token）",
                "number",
                0.0,
                min=0,
                step=0.01,
                help="命中缓存的输入 token 单价。0 表示沿用统一单价。",
            ),
            field(
                "cache_miss_price_per_million",
                "缓存未命中输入单价（元/百万 token）",
                "number",
                0.0,
                min=0,
                step=0.01,
                help="未命中缓存的输入 token 单价。0 表示沿用统一单价。",
            ),
            field(
                "output_price_per_million",
                "输出 token 单价（元/百万 token）",
                "number",
                0.0,
                min=0,
                step=0.01,
                help="模型输出 token 单价。0 表示沿用缓存未命中单价。",
            ),
            field(
                "price_per_million",
                "统一兜底单价（旧配置，元/百万 token）",
                "number",
                0.0,
                min=0,
                step=0.01,
                advanced=True,
                help="未设置上面三类单价时使用；兼容旧配置。",
            ),
            field(
                "monthly_limit",
                "每月消费限额（元）",
                "number",
                0.0,
                min=0,
                step=1,
                help="0 表示不限制。达到限额后会阻止新的模型调用；提高限额后立即恢复。",
            ),
        ],
    },
    {
        "id": "bridge",
        "title": "浏览器自动化",
        "description": "浏览器扩展与本地中继。",
        "group": "core",
        "order": 30,
        "fields": [
            field(
                "port",
                "本地端口",
                "integer",
                8765,
                min=1024,
                max=65535,
                step=1,
                help="修改后需要同步扩展设置页的端口。",
            ),
            field("auto_start", "启动时开启中继", "boolean", True),
            field("request_timeout", "请求超时（秒）", "number", 15, min=3, max=120, step=1),
            field("agent_enabled", "启用页面 Agent", "boolean", True),
        ],
    },
    {
        "id": "android",
        "title": "手机自动化",
        "description": "ADB 设备与控件树读取。",
        "group": "core",
        "order": 40,
        "fields": [
            field("adb_path", "adb 路径", "text", "", placeholder="留空使用 PATH"),
            field("device_serial", "设备序列号", "text", "", placeholder="留空自动选择唯一设备"),
            field("click_jitter", "点击随机偏移（像素）", "integer", 2, min=0, max=20, step=1),
            field("dump_timeout", "dump 超时（秒）", "number", 15, min=3, max=60, step=1),
            field("screenshot_timeout", "截图超时（秒）", "number", 20, min=5, max=120, step=1),
            field("ocr_fallback", "OCR 兜底", "boolean", True),
        ],
    },
]


class SettingsStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._data: dict[str, Any] = {}
        self._package_sections: dict[str, list[dict[str, Any]]] = {}
        self._section_owner: dict[str, str] = {}
        self.load()

    # -- loading/saving ----------------------------------------------------
    def _defaults(self) -> dict[str, Any]:
        data: dict[str, Any] = {"version": SETTINGS_VERSION, "capabilities": {}, "packages": {}}
        for section in CORE_SECTIONS:
            data[section["id"]] = {
                item["key"]: deepcopy(item.get("default")) for item in section["fields"]
            }
        return data

    def load(self) -> None:
        with self._lock:
            data = self._defaults()
            if self.path.is_file():
                try:
                    loaded = json.loads(self.path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    loaded = {}
                if isinstance(loaded, dict):
                    for key, value in loaded.items():
                        if key in {"version", "capabilities", "packages"}:
                            data[key] = value
                        elif isinstance(value, dict) and isinstance(data.get(key), dict):
                            data[key].update(value)
                    if isinstance(loaded.get("packages"), dict):
                        data["packages"] = loaded["packages"]
            self._data = data

    def save(self) -> None:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(
                json.dumps(self._data, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            try:
                os.chmod(tmp, 0o600)
            except OSError:
                pass
            os.replace(tmp, self.path)

    # -- schema ------------------------------------------------------------
    def register_package_section(
        self, package_id: str, package_type: str, section: dict[str, Any]
    ) -> None:
        section_id = str(section.get("id", "")).strip()
        if not section_id:
            raise SettingsError("设置 section 缺少 id")
        if not section_id.replace("_", "").replace("-", "").isalnum():
            raise SettingsError(f"设置 section id 非法：{section_id}")
        fields = section.get("fields")
        if not isinstance(fields, list) or not fields:
            raise SettingsError(f"设置 section {section_id} 缺少 fields")
        keys: set[str] = set()
        for item in fields:
            key = str(item.get("key", "")).strip()
            if not key or not key.replace("_", "").isalnum():
                raise SettingsError(f"设置字段 key 非法：{key}")
            if key in keys:
                raise SettingsError(f"设置 section {section_id} 字段重复：{key}")
            keys.add(key)

        with self._lock:
            owner = self._section_owner.get(section_id)
            if owner is not None and owner != package_id:
                raise SettingsError(f"设置 section id 已被占用：{section_id}")
            normalized = deepcopy(section)
            normalized["group"] = "plugin" if package_type == "plugin" else "module"
            normalized["package_id"] = package_id
            normalized.setdefault("order", 200)
            normalized.setdefault("title", package_id)
            normalized.setdefault("description", "")
            normalized.setdefault("fields", [])
            sections = self._package_sections.setdefault(package_id, [])
            if owner == package_id:
                # Idempotent reload: replace the old definition in place.
                sections[:] = [item for item in sections if item.get("id") != section_id]
            sections.append(normalized)
            self._section_owner[section_id] = package_id

    def unregister_package(self, package_id: str) -> None:
        with self._lock:
            for section in self._package_sections.pop(package_id, []):
                self._section_owner.pop(section["id"], None)

    def _all_sections(self) -> list[dict[str, Any]]:
        sections = deepcopy(CORE_SECTIONS)
        for items in self._package_sections.values():
            sections.extend(deepcopy(items))
        sections.sort(key=lambda item: (int(item.get("order", 500)), str(item.get("id"))))
        return sections

    def schema(self) -> list[dict[str, Any]]:
        with self._lock:
            return self._all_sections()

    def section(self, section_id: str) -> dict[str, Any] | None:
        for item in self.schema():
            if item["id"] == section_id:
                return item
        return None

    # -- values ------------------------------------------------------------
    def core_get(self, section: str, key: str, default: Any = None) -> Any:
        with self._lock:
            values = self._data.get(section)
            if isinstance(values, dict) and key in values:
                return values[key]
            return default

    def section_values(self, section_id: str, *, mask: bool = False) -> dict[str, Any]:
        section = self.section(section_id)
        if section is None:
            raise SettingsError(f"未知设置 section：{section_id}")
        package_id = section.get("package_id")
        with self._lock:
            if package_id:
                stored = dict(self._data.get("packages", {}).get(package_id, {}))
            else:
                stored = dict(self._data.get(section_id, {}))
        values: dict[str, Any] = {}
        for item in section["fields"]:
            if item.get("type") == "info":
                continue
            key = item["key"]
            values[key] = deepcopy(stored.get(key, item.get("default")))
        if mask:
            values = self._mask_values(section["fields"], values)
        return values

    @staticmethod
    def _mask_values(fields: list[dict[str, Any]], values: dict[str, Any]) -> dict[str, Any]:
        hidden: dict[str, bool] = {}
        for item in fields:
            if item.get("type") == "password":
                key = item["key"]
                hidden[key] = bool(values.get(key))
                values[key] = ""
        values["__has_value"] = hidden
        return values

    def package_values(self, package_id: str, *, mask: bool = False) -> dict[str, Any]:
        merged: dict[str, Any] = {}
        for section in self._package_sections.get(package_id, []):
            merged.update(self.section_values(section["id"], mask=False))
        with self._lock:
            stored = dict(self._data.get("packages", {}).get(package_id, {}))
        merged.update(stored)
        if mask:
            fields: list[dict[str, Any]] = []
            for section in self._package_sections.get(package_id, []):
                fields.extend(section.get("fields", []))
            merged = self._mask_values(fields, merged)
        return merged

    def public_values(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for section in self.schema():
            try:
                result[section["id"]] = self.section_values(section["id"], mask=True)
            except SettingsError:
                continue
        result["capabilities"] = self.capability_bindings()
        return result

    # -- saving ------------------------------------------------------------
    def _coerce(self, item: dict[str, Any], value: Any) -> Any:
        type_ = item.get("type", "text")
        label = item.get("label", item.get("key", ""))
        if type_ in {"text", "password", "textarea", "path"}:
            if value is None:
                return ""
            if not isinstance(value, str):
                value = str(value)
            max_length = item.get("max_length")
            if max_length and len(value) > int(max_length):
                raise SettingsError(f"“{label}”长度超过 {max_length}")
            return value
        if type_ == "number":
            try:
                number = float(value)
            except (TypeError, ValueError) as exc:
                raise SettingsError(f"“{label}”必须是数字") from exc
            if item.get("min") is not None and number < float(item["min"]):
                raise SettingsError(f"“{label}”不能小于 {item['min']}")
            if item.get("max") is not None and number > float(item["max"]):
                raise SettingsError(f"“{label}”不能大于 {item['max']}")
            return number
        if type_ == "integer":
            try:
                number = int(float(value))
            except (TypeError, ValueError) as exc:
                raise SettingsError(f"“{label}”必须是整数") from exc
            if item.get("min") is not None and number < int(item["min"]):
                raise SettingsError(f"“{label}”不能小于 {item['min']}")
            if item.get("max") is not None and number > int(item["max"]):
                raise SettingsError(f"“{label}”不能大于 {item['max']}")
            return number
        if type_ == "boolean":
            if isinstance(value, bool):
                return value
            if isinstance(value, (int, float)):
                return bool(value)
            if isinstance(value, str):
                return value.strip().lower() in {"true", "1", "yes", "on"}
            raise SettingsError(f"“{label}”必须是布尔值")
        if type_ == "select":
            allowed = {str(option.get("value")) for option in item.get("options", [])}
            if str(value) not in allowed:
                raise SettingsError(f"“{label}”的值无效")
            return str(value)
        return value

    def save_section(self, section_id: str, values: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(values, dict):
            raise SettingsError("设置值必须是对象")
        if section_id == "capabilities":
            with self._lock:
                current = dict(self._data.get("capabilities") or {})
                for key, value in values.items():
                    if value:
                        current[str(key)] = str(value)
                    else:
                        current.pop(str(key), None)
                self._data["capabilities"] = current
                self.save()
            return self.capability_bindings()

        section = self.section(section_id)
        if section is None:
            raise SettingsError(f"未知设置 section：{section_id}")
        package_id = section.get("package_id")
        with self._lock:
            if package_id:
                current = dict(self._data.setdefault("packages", {}).setdefault(package_id, {}))
            else:
                current = dict(self._data.setdefault(section_id, {}))
        for item in section["fields"]:
            key = item["key"]
            if item.get("type") == "info" or key not in values:
                continue
            value = values[key]
            if item.get("type") == "password" and value == "":
                continue  # empty password means "keep existing"
            if item.get("type") == "password" and value is None:
                current[key] = ""
                continue
            if item.get("required") and (value is None or str(value).strip() == ""):
                raise SettingsError(f"“{item.get('label', key)}”不能为空")
            current[key] = self._coerce(item, value)
        with self._lock:
            if package_id:
                self._data.setdefault("packages", {})[package_id] = current
            else:
                self._data[section_id] = current
            self.save()
        return self.section_values(section_id, mask=True)

    def reset_section(self, section_id: str) -> dict[str, Any]:
        section = self.section(section_id)
        if section is None:
            raise SettingsError(f"未知设置 section：{section_id}")
        package_id = section.get("package_id")
        with self._lock:
            if package_id:
                self._data.setdefault("packages", {}).pop(package_id, None)
            else:
                self._data.pop(section_id, None)
            self.save()
        return self.section_values(section_id, mask=True)

    # -- capability bindings ----------------------------------------------
    def capability_bindings(self) -> dict[str, str]:
        with self._lock:
            value = self._data.get("capabilities")
            return dict(value) if isinstance(value, dict) else {}

    def set_capability_binding(self, capability: str, package_id: str | None) -> None:
        with self._lock:
            current = dict(self._data.get("capabilities") or {})
            if package_id:
                current[capability] = package_id
            else:
                current.pop(capability, None)
            self._data["capabilities"] = current
            self.save()

    # -- summary -----------------------------------------------------------
    def summary(self) -> dict[str, Any]:
        llm_mode = self.core_get("llm", "provider_mode", "cloud")
        llm_base_url = self.core_get("llm", "base_url", "")
        llm_model = self.core_get("llm", "model", "")
        llm_api_key = self.core_get("llm", "api_key", "")
        return {
            "llm": {
                "configured": bool(
                    llm_base_url and llm_model and (llm_mode == "ollama" or llm_api_key)
                ),
                "provider_mode": llm_mode,
                "base_url": llm_base_url,
                "model": llm_model,
            },
            "bridge": {
                "port": self.core_get("bridge", "port", 8765),
                "auto_start": self.core_get("bridge", "auto_start", True),
            },
            "android": {
                "adb_path": self.core_get("android", "adb_path", ""),
                "device_serial": self.core_get("android", "device_serial", ""),
            },
            "ui": {
                "theme": self.core_get("ui", "theme", "light"),
                "locale": self.core_get("ui", "locale", "zh-CN"),
                "start_page": self.core_get("ui", "start_page", "home"),
            },
        }
