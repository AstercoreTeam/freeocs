# 智慧树模块

Android 版智慧树答题：通过 ADB 读取 `uiautomator` 控件树，由大模型 Function Calling 决定点击哪个选项。

## 使用前

1. 手机开启开发者选项和 USB 调试，连接电脑并授权。
2. 在设置 → 手机自动化中确认 adb 路径/设备（或留空自动选择唯一设备）。
3. 配置全局文本模型，模型需支持 function calling。
4. 打开智慧树测验页面。

## 使用

在“应用与插件”中打开智慧树，点“开始”。AI 会：

1. `read_page` 读取题型、题干、选项、按钮。
2. `click_option` / `click_options` 点击选项。
3. `click_next` 进入下一题。
4. 检测到提交/交卷按钮时返回 `finished=true`，**不点击**。

## 安全

- 不点击提交、交卷、完成、结束等按钮。
- 到交卷页状态变为“等待手动操作”，请人工核对后交卷。

## 设置

- `device_serial`：覆盖全局设备。
- `click_jitter`：点击随机偏移。
- `dump_timeout` / `screenshot_timeout`：ADB 超时。
- `poll_interval` / `interval_min` / `interval_max`：操作间隔。
- `max_tool_rounds`：防止无限工具调用。
- `temperature`：模型温度。
- `ocr_fallback` / `ocr_min_confidence`：控件树失败时 OCR 兜底（需要 OCR 插件）。

## 限制

- 控件树读不到的 WebView/游戏引擎页面，OCR 只能兜底，可能无法定位。
- 中文输入依赖 ADBKeyboard；v1 主要面向选择题。
- 不做风控绕过，不自动交卷。

---

## License / 许可

Copyright (C) 2026 qincnd <qincnd@qq.com>, XueZicheng <xuezicheng842@outlook.com>, AstercoreTeam.

This project is licensed under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`).
See [https://spdx.org/licenses/AGPL-3.0-only.html](https://spdx.org/licenses/AGPL-3.0-only.html).

