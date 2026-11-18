# U校园模块

网页版 U校园 的自动学习助手。页面 Agent 由浏览器扩展注入，Python 模块负责模型、ASR/TTS、状态与会话。

## 使用前

1. 安装 FreeOCS 浏览器扩展（设置 → 操作指南 → 浏览器扩展）。
2. 配置全局文本模型（设置 → 大模型）。
3. 安装/启用本地 ASR 插件（听力题）与 TTS 插件（口语题），或切换云端提供者。
4. 打开并登录 U校园课程页。

## 使用

在“应用与插件”中打开 U校园，或直接在 U校园 页面右下角的控制面板点“开始”。模块会：

- 在目录页扫描 Module 1..N，优先打开“进行中”的任务，否则打开第一个未开始任务。
- 识别选择题、下拉题、填空、多空、问答、匹配、口语等题型。
- 自动收集听力音频 URL，由 Python 下载并转写。
- 自动关闭“我知道了/知道了”等单元信息弹窗。
- 视频页优先播放到结束；浏览器提示“视频不支持/无法播放”时记录警告并继续下一项。
- 回填答案，只点击“下一题/下一步/继续”等导航按钮。

## AI 网页兜底

遇到无法识别的题型时：

1. 保存当前页面 HTML 与元素快照到 `<数据目录>/package-data/ucampus/unsupported_pages/`；
2. 把可见元素（按钮、输入框、下拉框、单选项等）交给大模型，生成最多 6 个“点击/填写/选择”动作；
3. 本地执行这些动作，并过滤提交、交卷、发布、评分提交等按钮；
4. 执行后只使用安全的“下一题/下一步”继续；没有安全操作时停下。

可在设置 → U校园 关闭“不支持的题目让 AI 操作网页”。页面 HTML 会发送给你配置的大模型；使用本地模型时不会离开本机。

## 安全模式

默认不自动点击提交、交卷、发布；可在 U校园面板开启“自动提交”。

- 讨论区：只填入内容，不点“发布”。
- 朗读评分/角色扮演：用语音合成模拟麦克风完成录音，随后停在提交前等待人工核对；可在设置中关闭。
- 口语题：生成音频并写入上传控件，不提交。
- 登录页/门户页：提示先登录后停止，不写入未识别日志。

## 设置

- `auto_start_on_course`：检测到课程详情页时自动开始（每个 URL 只触发一次）。
- `play_video`：自动播放课程视频。
- `asr_language`：听力转写语言。
- `max_audio_files`：单页最多转写音频数。
- `tts_voice` / `tts_format`：口语题语音。
- `auto_record_speaking`：自动完成朗读评分与角色扮演录音（默认开启，提交前停止）。
- `answer_timeout` / `transcribe_timeout`：模型/转写超时。
- `log_questions`：是否把题干写入日志（默认关闭）。

## 限制

- 依赖浏览器扩展和已登录的 U校园 页面。
- 网站改版会导致选择器失效；模块会停止并写 `unrecognized.log`。
- 视频自动播放可能被浏览器拦截；视频源不可用时按内容页跳过。
- 朗读/角色扮演依赖 Web Audio 和语音合成插件；自动播放策略可能延迟音频启动。
- 听力音频必须能通过 URL 下载；系统回环录音为兜底。

---

## License / 许可

Copyright (C) 2026 qincnd <qincnd@qq.com>, XueZicheng <xuezicheng842@outlook.com>, AstercoreTeam.

This project is licensed under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`).
See [https://spdx.org/licenses/AGPL-3.0-only.html](https://spdx.org/licenses/AGPL-3.0-only.html).

