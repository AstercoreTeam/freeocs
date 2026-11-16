# U校园实现

U校园是**网页平台**，通过「浏览器扩展 + 本地中继 + 页面 Agent」接入。

## 1. 组成

```text
Firefox / Chromium
  content.js
    ├─ 与 background 通信
    ├─ 从本地服务加载 page-agent.js
    └─ token 校验的 postMessage 桥

FreeOCS 主程序
  freeocs/server.py             本地 HTTP 中继
  freeocs/transports/webcat.py  扩展长轮询 / 标签页目标
  packages/src/ucampus/
    backend/module.py           会话、租约、LLM/ASR/TTS、页面保存
    backend/prompts.py          题型提示词与答案解析
    web/page-agent.js           页面主世界：识别、作答、导航
    web/panel.js                应用内模块面板
```

浏览器扩展只负责通用能力：

- 标签页枚举、激活、显式绑定目标标签页
- 页面 Agent bundle 注入
- `/api/module/<id>/<method>` 代理
- 把 `X-FreeOCS-Tab-Id` 传给 Python

U校园的业务逻辑全部在模块内，不写进扩展。

## 2. 文件地图

| 文件 | 职责 |
| --- | --- |
| `packages/src/ucampus/backend/module.py` | 模块生命周期、poll/lease、答案/ASR/TTS、目标标签页、AI 网页兜底 |
| `packages/src/ucampus/backend/prompts.py` | 选择题/填空/匹配/排序/讨论提示词与解析 |
| `packages/src/ucampus/web/page-agent.js` | 页面扫描、视频/音频、控件识别、作答、导航、安全停止 |
| `packages/src/ucampus/web/panel.js` | 应用内 `ucampus_console` 面板 |
| `packages/src/ucampus/manifest.json` | 包声明、设置项、`web_fallback` |
| `scripts/e2e_ucampus.py` | Chromium + Playwright 端到端测试 |

## 3. 一次运行的生命周期

```text
用户点开始 / 页面面板点开始
  → Python ModuleHost.start()
  → 模块创建 run_id、目标标签页、start 指令
  → 页面 Agent 轮询 /api/module/ucampus/poll
  → 只有目标标签页拿到 lease 和 start
  → Agent 进入 runAutomation()
  → 识别页面 → 请求答案/转写 → 回填
  → 到提交/发布/评分前自动停止
  → 用户手动提交
```

目标标签页规则：

- 应用内开始时优先选活动中的 U校园 标签页。
- 页面面板点“开始/接管本页”时绑定**当前标签页**。
- 其他 U校园 标签页不会拿到 lease，也不会执行 start/stop。

## 4. 页面层级

U校园不是“一页一题”，而是：

```text
课程
  └─ 章节（右侧目录的 Module）
       └─ 学习模块（顶部一级 Tab）
            └─ 子模块（顶部二级 Tab）
                 └─ 题目 / 视频 / 讨论 / 练习
```

详见 [page-structure.md](page-structure.md)。

## 5. 题型与上下文

支持的题型、每题需要附带给模型的材料，见 [question-types.md](question-types.md)。

关键要求：

- 阅读题必须把**文章正文**作为 `context` 一起发给模型，不能只给题干和选项。
- 听力题必须把**音频转写**一起发给模型。
- 视频题必须把**视频音轨转写**一起发给模型。
- 同一页多题要分别作答，但补充材料（文章/音频转写）应复用。

## 6. 自动化与安全

详见 [automation-flow.md](automation-flow.md)。

当前安全边界：

- 绝不自动提交/交卷/发布/评分提交。
- 朗读评分、角色扮演停在手动完成前。
- 讨论区只填内容，不点发布。
- 排序题当前只显示正确顺序，不自动拖拽，避免打乱页面。
- 朗读/配音/录音（如 Viewing → Language focus → Dubbing）会停止，等你手动完成并提交。
- AI 网页兜底会先保存页面，再弹确认框；取消时不会发送给模型，也不消耗 token。

## 7. 当前状态

| 能力 | 状态 |
| --- | --- |
| 单选/判断/下拉/填空/问答 | ✅ |
| 阅读文章作为上下文 | ✅ 源码 |
| 音频/视频转写作为上下文 | ⚠️ 依赖 ASR；视频题转写失败会停止，不猜答案 |
| 多题一页（`.question-common-abs-choice`） | ✅ 逐组作答 |
| 多题一页（原生 radio 多组） | ✅ 源码按组识别并逐组作答 |
| 多选（组件/原生 checkbox） | ✅ 源码按组识别并多选 |
| 排序/匹配 | 🧭 改为只显示答案，不自动拖 |
| AI 网页兜底与页面保存（含用户确认） | ✅ 源码 |
| Token 统计/消费限额 | ✅ 源码（框架统一） |
| 无题视频自动完成 | ⚠️ 能播放，真实模板仍需验证 |
| 用户提交后自动下一模块 | ✅ 源码 + e2e 验证 |
| 章节完成后自动下一章 | 🧭 目录推进待完整验证 |

## 8. 已知限制

- 打包版不内置 `faster-whisper`、`pyttsx3`；本地 ASR/TTS 需要源码环境或后续打包依赖。
- Firefox/snap 缺少部分视频编解码器时，视频会提示不支持；当前策略是记录警告并继续。
- U校园 的排序拖拽组件对合成鼠标事件不稳定；因此改为“显示正确顺序 + 用户手动拖拽”。
- 页面结构会随课程模板变化，选择器需要持续补。

## 9. 开发入口

- 页面 Agent：`packages/src/ucampus/web/page-agent.js`
- Python 模块：`packages/src/ucampus/backend/module.py`
- 提示词：`packages/src/ucampus/backend/prompts.py`
- 浏览器中继：`docs/05-webcat-bridge.md`
- 测试：`.venv/bin/python -m pytest -q`

> 本轮新增的阅读上下文、排序只显示答案等改动只在源码中，尚未重新打包。
