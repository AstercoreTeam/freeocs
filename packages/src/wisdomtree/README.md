# 智慧树模块

智慧树通过浏览器扩展连接已登录的智慧树网页，由页面 Agent 读取课程和题目、执行页面操作，Python 后端复用 FreeOCS 配置的文本模型生成答案。

## 使用前

1. 在 FreeOCS 的“设置 → 大模型”中配置文本模型。
2. 在“操作指南 → 浏览器扩展”中安装并启用 FreeOCS 扩展。
3. 使用该浏览器登录智慧树并打开课程或测验页面。
4. 在“应用与插件”中启动智慧树模块；页面 Agent 会连接当前智慧树标签页。

## 能力

- 按课程目录处理可用章节，并读取单选、多选、判断、填空及简答题。
- 通过 FreeOCS 的 `llm.chat` 能力生成答案；无需单独配置模型密钥。
- 页面状态保存在 FreeOCS 的模块数据目录中，以便在智慧树子域之间导航后恢复进度。
- 模块面板显示页面连接、运行状态、题目和最近操作。

## 提交设置

“自动提交作业”默认关闭。关闭时，模块会在提交页停止，等待人工核对和提交。开启后，页面 Agent 会尝试执行提交及确认操作；请仅在明确需要时启用。

## 安全与限制

- 模块不会处理登录、验证码或绕过网站风控。
- 页面结构或接口变化可能导致题目识别或导航失败；遇到错误应停止并检查页面及日志。
- 页面 Agent 需要浏览器扩展保持连接，并且智慧树页面必须处于扩展匹配的域名下。

---

## License / 许可

Copyright (C) 2026 qincnd <qincnd@qq.com>, XueZicheng <xuezicheng842@outlook.com>, AstercoreTeam.

This project is licensed under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`).
See [https://spdx.org/licenses/AGPL-3.0-only.html](https://spdx.org/licenses/AGPL-3.0-only.html).
