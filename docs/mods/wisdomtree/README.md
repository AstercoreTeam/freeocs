# 智慧树实现

智慧树是**手机平台**，通过 ADB + `uiautomator dump` + 大模型 Function Calling 接入。

## 1. 组成

```text
FreeOCS 主程序
  freeocs/android.py              ADB 传输层（设备/点击/滑动/dump/截图）
  packages/src/wisdomtree/
    backend/module.py             模块生命周期、循环、工具执行、提交检测
    backend/agent.py              Function Calling Agent
    backend/readers/wisdomtree.py 智慧树控件树解析
    backend/readers/base.py       PageData / Option / Button
    web/panel.js                  应用内面板
```

与 U校园不同，智慧树没有页面 JS，也不依赖浏览器扩展。所有页面信息来自 Android 控件树。

## 2. 运行前条件

1. 手机开启开发者选项和 USB 调试。
2. 电脑安装 `adb`，设备授权。
3. 设置 → 手机自动化中填写 adb 路径或设备序列号。
4. 配置支持 **Function Calling** 的全局文本模型。
5. 打开智慧树测验页面。

## 3. 一次运行流程

```text
用户点开始
  → 模块连接 ADB 设备，读取屏幕尺寸
  → AnswerAgent 启动
  → read_page 读取控件树
      ├─ 题型、题干、选项、按钮
      └─ 控件树失败时 OCR 兜底
  → 模型决定点击哪个选项
  → click_option / click_options
  → click_next
  → 下一题
  → 检测到“提交/交卷/完成/结束”
      → finished=true
      → 不点击，等待人工
```

## 4. 工具

| 工具 | 作用 |
| --- | --- |
| `read_page` | 重新读取当前控件树，返回题型/题干/选项/按钮 |
| `click_option` | 点击一个选项 |
| `click_options` | 多选，依次点击多个选项 |
| `click_next` | 点击“下一题/下一步/继续/下一页” |
| `finish` | 结束并说明原因 |

执行器会：

- 检查按钮是否属于提交类文案
- 检查选项是否存在
- 用屏幕坐标中心点击
- 加入随机偏移和间隔
- 限制工具轮数，避免死循环

## 5. 控件树解析

`WisdomTreeReader` 从 `uiautomator dump` 的 XML 中提取：

- `question_type`
- `question`
- `options`
- `buttons`
- 屏幕尺寸

解析失败或关键字段为空时，可以：

- 用截图 + OCR 插件兜底
- 记录低质量文本（`undefined/null/NaN` 等）并停止
- 返回 `finish` 原因

## 6. 安全边界

- 不点击提交、交卷、完成、结束、保存并提交。
- 检测到提交按钮立即 `finished=true`。
- 不自动处理验证码、登录、支付。
- 不绕过风控。
- OCR 只用于定位，不对不确定内容乱猜。

## 7. 设置项

| 设置 | 作用 |
| --- | --- |
| `device_serial` | 指定设备；留空选唯一设备 |
| `click_jitter` | 点击坐标随机偏移 |
| `dump_timeout` | 控件树超时 |
| `screenshot_timeout` | 截图超时 |
| `poll_interval` | 每步间隔 |
| `interval_min` / `interval_max` | 操作间隔范围 |
| `max_tool_rounds` | 工具调用上限 |
| `temperature` | 模型温度 |
| `ocr_fallback` | 控件树失败时 OCR 兜底 |
| `ocr_min_confidence` | OCR 最低置信度 |

## 8. 当前支持范围

| 能力 | 状态 |
| --- | --- |
| 单选/多选 | ✅ |
| 下一题 | ✅ |
| 提交检测 | ✅ |
| 控件树读取 | ✅ |
| OCR 兜底 | ⚠️ 依赖 OCR 插件/模型 |
| 填空/问答输入 | ⚠️ 依赖 ADBKeyboard，v1 主要面向选择题 |
| WebView/游戏引擎页面 | ❌ 控件树可能读不到，OCR 只能兜底 |

## 9. 测试

```bash
.venv/bin/python -m pytest -q tests/test_wisdomtree_module.py
```

使用 fake ADB/控件树，不需要真实手机。

真实设备验证需要：

1. 连接手机并授权。
2. 打开智慧树测验。
3. 开始运行，检查题型识别、选项点击、提交停止。
4. 在交卷页人工核对。

## 10. 已知限制

- 不同版本智慧树的控件树结构可能变化，需要补 reader。
- ADB 点击是坐标级的，屏幕分辨率/刘海/缩放会影响定位。
- 中文输入需要 ADBKeyboard。
- 提交页文案可能变化；目前覆盖“提交/交卷/完成/结束/保存并提交”。

## 11. 与 U校园的差异

| 维度 | U校园 | 智慧树 |
| --- | --- | --- |
| 传输 | 浏览器扩展 + 本地中继 | ADB |
| 页面信息 | DOM / 页面 Agent | `uiautomator` 控件树 |
| 作答 | JS 点击/写值 | ADB 坐标点击 |
| 多媒体 | 浏览器视频/音频 + ASR/TTS | 手机端播放，v1 不处理 |
| 续跑 | 页面监听 + 模块切换（待实现） | 工具循环内逐题推进 |

---

## License / 许可

Copyright (C) 2026 qincnd <qincnd@qq.com>, XueZicheng <xuezicheng842@outlook.com>, AstercoreTeam.

This project is licensed under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`).
See [https://spdx.org/licenses/AGPL-3.0-only.html](https://spdx.org/licenses/AGPL-3.0-only.html).

