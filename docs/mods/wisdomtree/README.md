# 智慧树浏览器模块

智慧树模块现通过 FreeOCS 浏览器扩展运行，不再使用 Android、ADB 或 `uiautomator`。页面 Agent 负责读取智慧树页面、执行页面交互；Python 模块负责状态管理和模型调用。

## 组成

```text
packages/src/wisdomtree/
  manifest.json                 Web 平台、站点权限、设置和 Agent 声明
  backend/module.py              页面 API、标签页租约、状态与 LLM 答案
  web/page-agent.js              页面识别、课程流程和题目交互
  web/panel.js                   FreeOCS 模块状态面板
```

模块依赖 `web.bridge` 与 `llm.chat`。模型由 FreeOCS 的全局设置和能力绑定提供，不在智慧树模块中单独保存模型密钥。

## 使用流程

1. 在 FreeOCS 中配置文本模型并安装/启用浏览器扩展。
2. 在扩展所在的浏览器中登录智慧树，打开智慧树课程或测验页面。
3. 从 FreeOCS “应用与插件”启动智慧树模块。
4. 检查智慧树模块面板中的连接状态、当前页面和题目状态。
5. 默认在提交页停止；检查答案后由用户决定是否提交。

模块使用带超时的页面租约，限制同一时刻只有一个智慧树标签页执行自动化。跨智慧树子域导航时，以浏览器 tab ID 续接租约；页面 Agent 会在导航前保存课程进度和其他脚本状态。

## 页面 Agent 与答案

页面 Agent 处理课程目录、章节掌握度、题目识别、答案填入和章节导航。题目内容经模块 API 发送至 Python 后端，后端使用 `llm.chat` 生成结构化答案，并在返回前验证答案格式。模型未返回可用答案时应停止当前题目流程，而不是猜测或选择默认项。

智慧树的页面 DOM 可能随站点更新而变化。若页面 Agent 无法识别题目、选项或按钮，应检查日志和页面面板状态，再更新对应的页面解析逻辑。

## 提交行为

`auto_submit` 默认关闭。关闭时，页面 Agent 到达提交页后发送完成事件并停止，不点击提交或确认按钮。开启时，会按旧脚本流程尝试点击提交及确认按钮；此设置会产生不可逆的站点操作，必须由用户主动开启。

## 状态持久化

页面端通过模块 API 读取和保存脚本状态，后端文件位于 FreeOCS 数据目录下 `package-data/wisdomtree/agent-state.json`。文件使用格式标记和版本号，保存采用同目录临时文件原子替换；格式未知或损坏时会报告错误，不覆盖原文件。

## 测试

```bash
uv run pytest -q tests/test_wisdomtree.py
```

测试使用 fake browser bridge 和 fake LLM，不需要真实浏览器或智慧树账号。真实站点的页面结构变化需要另行手动验证。

---

## License / 许可

Copyright (C) 2026 qincnd <qincnd@qq.com>, XueZicheng <xuezicheng842@outlook.com>, AstercoreTeam.

This project is licensed under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`).
See [https://spdx.org/licenses/AGPL-3.0-only.html](https://spdx.org/licenses/AGPL-3.0-only.html).
