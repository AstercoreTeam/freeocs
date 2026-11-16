# 07 应用模块设计：U校园与智慧树

## 1. 模块通用结构

每个模块是一个 zip 包，遵循 `02-package-format.md`：

```text
<module>/
├── manifest.json
├── backend/
│   ├── __init__.py
│   ├── main.py            # setup(api) -> register_module(...)
│   ├── module.py          # Module 子类：start/stop/status/actions/invoke
│   ├── prompts.py         # 提示词与答案解析（可选）
│   └── readers/           # Android 页面解析器（手机模块）
├── web/
│   ├── panel.js           # 模块详情页面板
│   ├── panel.css
│   └── page-agent.js      # 网页模块的页面 Agent
├── README.md
└── icon.png
```

通用要求：

- `setup()` 不做网络/设备/模型初始化。
- 模块运行状态通过 `status()` 暴露；日志通过 `ctx.log`。
- 所有不可逆操作（提交/交卷/发布/评分提交）一律不自动执行。
- 模块设置通过 `register_settings()` 或 manifest 声明；密钥类字段使用 `password`。
- 模块面板只做展示与控制，不复制业务逻辑。

## 2. U校园（网页）

### 2.1 参考实现与差距

参考项目 `/home/xzc/桌面/项目/u校园`：

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `userscript/ucampus-assistant.user.js` | 2541 | 页面扫描、题型识别、回填、自动学习状态机、悬浮面板 |
| `app/main.py` | 402 | FastAPI：命令队列、日志、ASR/TTS/答题 API |
| `app/providers.py` | 463 | 提示词、答案解析、本地/KokoClone TTS |
| `app/asr.py` | 148 | faster-whisper 转写、URL 下载、系统录音 |
| `app/static/app.js` | 541 | 控制台 UI |
| `app/config.py` | 172 | 环境变量配置 |

FreeOCS 的差异：

1. **不启动 FastAPI**：用 FreeOCS 本地 HTTP 服务 + 模块 `handle_agent_request`。
2. **不注入悬浮面板**：所有控制在 FreeOCS 应用内；页面 Agent 无 UI。
3. **不自动提交**：参考脚本会点击“提交”和确认弹窗，必须移除；只填答案并停在提交前。
4. **能力化**：答题走 `llm.chat`，ASR 走 `media.asr`，TTS 走 `media.tts`，可切换本地/云端。
5. **配置化**：`config.py`/`.env` 改为设置页 schema；密钥不进代码。
6. **扩展化**：油猴 `GM_*` 改为扩展 content script 的 `__freeocs` 桥；跨域下载改由 Python 侧完成。

### 2.2 总体方案：Python 模块 + 页面 Agent

不把 2541 行 DOM 逻辑重写成 Python；而是：

```text
┌────────────────────────── 浏览器（U校园页面） ──────────────────────────┐
│ content script（隔离世界）                                               │
│  ├─ 注入本地 bundle（<script src>，无 eval）                             │
│  └─ postMessage 桥（token 校验；转发模块 API）                            │
│                                                                          │
│ page-agent.js（页面主世界，移植自油猴脚本，无悬浮 UI）                    │
│  ├─ __freeocs 桥（请求 Python / 日志 / 页面信息）                        │
│  ├─ 扫描课程/模块/任务/题目                                               │
│  ├─ 回填 DOM                                                             │
│  ├─ 点击“下一题/下一步/继续”                                            │
│  └─ 遇到提交/发布 → 停止并上报                                           │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ 扩展后台代理 HTTP
┌───────────────────────────────▼──────────────────────────────────────────┐
│ FreeOCS Python 模块 ucampus                                              │
│  ├─ 会话状态、租约、命令队列、日志、无法识别记录                         │
│  ├─ 提示词/答案解析（移植 providers.py）                                 │
│  ├─ llm.chat / media.asr / media.tts                                     │
│  └─ 设置项、面板数据                                                     │
└──────────────────────────────────────────────────────────────────────────┘
```

理由：

- 页面 DOM 选择器、Shadow DOM、iframe、目录/任务状态机高度依赖页面；保留在 JS 中改动最小、回归风险最低。
- 模型调用、音频下载/转写、语音合成、配置、日志、状态在 Python 侧更容易复用框架能力。
- 页面 Agent 无 UI，符合“控制在应用内”的产品要求。

### 2.3 包布局

```text
packages/src/ucampus/
├── manifest.json
├── backend/
│   ├── __init__.py
│   ├── main.py              # setup
│   ├── module.py            # UcampusModule
│   ├── prompts.py           # 提示词 + 答案解析
│   ├── state.py             # 会话/命令/租约
│   └── api.py               # handle_agent_request 分发
├── web/
│   ├── page-agent.js        # 移植的页面脚本
│   ├── panel.js
│   └── panel.css
├── README.md
└── icon.png
```

### 2.4 Python 端点

页面 Agent 通过 `/api/module/ucampus/<method>` 调用（由扩展后台代理）：

| method | 方向 | 说明 |
| --- | --- | --- |
| `poll` | Agent → Python | 心跳 + 取命令 + 租约；返回 `active/lease/command/state` |
| `report` | Agent → Python | 上报页面状态、题型、题干、选项、进度、日志 |
| `log` | Agent → Python | 追加日志 |
| `answer` | Agent → Python | 题干/选项/题型/上下文 → 答案 JSON |
| `transcribe_url` | Agent → Python | 音频/视频 URL + Referer → 文本（Python 下载） |
| `transcribe` | Agent → Python | base64 音频（小文件兜底）→ 文本 |
| `tts` | Agent → Python | 文本 + 语音参数 → 音频（base64 或临时 URL） |
| `unrecognized` | Agent → Python | 无法识别的题目/原因，写入日志并停止 |
| `state` | Agent → Python | 只读状态（面板/调试） |
| `release` | Agent → Python | 释放租约 |

约束：

- 请求体上限 2 MB；音频走 URL，不走 base64（除非小片段）。
- 所有方法必须快速返回（模型/ASR 除外，超时 300s/600s）。
- `answer` 的响应：

```json
{ "answer": "B. ...", "explanation": "...", "raw": "...", "model": "..." }
```

- `transcribe_url` 的响应：

```json
{ "text": "...", "language": "en", "cached": false }
```

- `tts` 的响应：`audio/mpeg` 或 `audio/wav` 二进制（或 `{base64, mime, ext}`，按实现统一）。

### 2.5 页面 Agent 协议

Agent 顶部：

```js
if (globalThis.__freeocs_ucampus_loaded__) return;
globalThis.__freeocs_ucampus_loaded__ = true;

const CLIENT_ID = crypto.randomUUID();
const POLL_INTERVAL = 3000;
```

Agent 由本地 bundle 注入页面主世界，通过 `__freeocs` 桥（postMessage → content script → background）调用 Python 端点。

轮询：

```js
async function poll() {
  const res = await __freeocs.request("/api/module/ucampus/poll", {
    body: {
      client_id: CLIENT_ID,
      url: location.href,
      title: document.title,
      frame: window.top === window ? "top" : "child",
      has_content: detectContent(),
    },
  });
  if (res.active && res.lease && res.command) {
    await handleCommand(res.command);
  }
  setTimeout(poll, res.active ? 1500 : POLL_INTERVAL);
}
```

命令：

| command | 行为 |
| --- | --- |
| `start` | 若在课程详情页：`startFromCourseDetail()`；否则 `runAutomation()` |
| `stop` | 设置 `automationRunning=false`，停止循环 |
| `read` | 读取当前题目并上报 |
| `fill` | 把指定答案填入当前题目（不提交） |
| `attach_audio` | 把音频写入上传控件（不提交） |

上报：

```js
await __freeocs.request("/api/module/ucampus/report", {
  body: {
    client_id: CLIENT_ID,
    url: location.href,
    title: document.title,
    question_type: controls.type,
    question: question,
    options: [...],
    status: "正在作答",
    completed: runState.completed,
    steps: runState.entries.slice(-5),
  },
});
```

### 2.6 会话状态与租约

Python 侧：

```python
@dataclass
class Session:
    active: bool = False
    running: bool = False
    run_id: str = ""
    lease_client: str = ""
    lease_seen: float = 0.0
    completed: int = 0
    answered: int = 0
    skipped: int = 0
    errors: int = 0
    status: str = "等待开始"
    last_question: str = ""
    last_options: list[str] = field(default_factory=list)
    last_answer: str = ""
    command_queue: deque[dict] = field(default_factory=deque)
    logs: deque[dict] = field(default_factory=lambda: deque(maxlen=200))
```

规则：

- 开始：`active=True`，清空命令队列，入队 `start`；等待 Agent 取走。
- 租约：`active` 且（无租约或 `now - lease_seen > 10s`）→ 授予第一个 `has_content=true` 的 client；其它 client `lease=false`。
- Agent 每次 poll 更新 `lease_seen`；`release` 立即释放。
- 停止：`active=False`，清空命令，`running=False`，状态“已停止”。
- 页面跳转后旧 client 消失；新 client 在 10 秒内接管；若 `active` 且无新 client，状态显示“等待页面加载”。

### 2.7 自动学习流程（移植）

```text
开始
  ├─ 当前是课程详情页？
  │    ├─ 扫描 Module 1..N 的 Tab
  │    ├─ 每个 Tab 找“进行中/学习中”，否则第一个“未开始/未完成”
  │    └─ 点击任务 → 等待进入学习页 → runAutomation()
  └─ 否则直接 runAutomation()

runAutomation 循环
  ├─ 记录 stepKey（URL + 任务 + Practice 状态 + 媒体 + 题目）
  ├─ 重复 stepKey → 停止
  ├─ processQuestion()
  │    ├─ 处理提交弹窗？→ 停止（安全模式）
  │    ├─ 讨论页？→ 填答案，不发布 → 停止/等待
  │    ├─ 视频？→ 播放到结束 → 下一步
  │    ├─ 检测题型：choice/dropdown/blank/blanks/essays/matching/oral/dubbing/roleplay
  │    ├─ 听力：收集音频 URL → Python 转写 → 拼进题干
  │    ├─ 请求答案 → 回填
  │    └─ 点击“下一题/下一步/继续”或页面动作（绝不提交）
  ├─ 页面还有下一题 → 继续
  └─ 找下一个学习目标（Practice/阅读 Tab/口语任务/菜单/目录/课程任务）
```

保留原脚本的关键扫描函数（改名/整理，不改变行为）：

- `pageDocuments()`：同源 iframe + Shadow DOM。
- `visible()` / `controlVisible()`。
- `questionForDocument()`、`optionChoiceGroups()`、`optionDropdowns()`。
- `currentQuestion()`、`answerControls()`、`controlsAnswered()`。
- `courseTasks()`、`moduleTabs()`、`activateModuleTab()`、`findUnfinishedCourseTask()`。
- `practiceTabs()`、`contentTabs()`、`nextSectionTab()`、`nextReadingTab()`、`nextNestedTab()`、`nextSpeakingTask()`、`menuLevels()`、`nextMenuTarget()`。
- `catalogSections()`、`nextCatalogSection()`。
- `videoForAutomation()`、`audioSources()`。
- `currentStepKey()`、`nextLearningTarget()`。
- `waitForQuestionReady()`、`dismissBlockingDialog()`。

### 2.8 题型与处理

| `controls.type` | 页面特征 | 处理 | 模型提示词类型 |
| --- | --- | --- | --- |
| `choice` | `.question-common-abs-choice` 或 radio/role=radio | 匹配选项文本/字母，点击/勾选 | `choice` |
| `dropdown` | `.scoop-select-wrapper` | 点开下拉，选匹配项 | `choice` |
| `blank` | 单个输入框/textarea | 写入答案 | `blank` |
| `blanks` | 多个输入框 | 按顺序写入 | `blanks` |
| `essays` | 多个 textarea | 逐题请求/写入 | `essay` |
| `matching` | `.sortable-list-wrapper` | 拖拽排序（移植 `dragSortable`） | `matching` |
| `oral` | 音频上传控件 + Speaking task | 生成音频并写入 `input[type=file]`（不提交） | `oral` |
| `dubbing` | `.button-record` / `.record-icon` | **v1 安全模式：停止并提示手动完成**（录音即作答） | — |
| `roleplay` | “Start role-play” | **v1 安全模式：停止并提示手动完成** | — |
| `discussion` | 讨论区编辑器 | 填答案，**不点发布**；停止等待手动发布 | `discussion` |
| `video` | 可见 `<video>` | 播放到结束；有题目时先转写 | — |
| `content` | 无题目 | 找下一个学习目标 | — |
| `unsupported` | 无匹配 | 上报并停止 | — |

关于 `dubbing` / `roleplay`：原脚本通过覆盖 `getUserMedia` 注入 TTS、录制并等待评分，这已经构成一次提交。v1 按“绝不自动提交”原则不执行，改为提示用户手动完成；后续如用户明确开启“允许评分提交”再实现。

### 2.9 听力/视频转写

页面 Agent 只负责收集 URL：

```js
const audioList = audioSources(); // mp3/wav/m4a/aac/ogg/flac 或 /audio/ 路径
const video = videoForAutomation().video;
```

Python 模块：

```python
def transcribe_url(self, url: str, referer: str) -> dict:
    asr = self.ctx.require("media.asr")
    data = self.ctx.download(url, headers={"Referer": referer}, timeout=180)
    return asr.transcribe(data, filename=guess_name(url))
```

- 缓存键：URL（模块内存 + 可选磁盘），避免重复下载/转写。
- 视频：优先直接下载 `currentSrc` 转写；失败时报告“视频音频不可用”，不尝试系统录音（v1 跨平台不可靠）。
- 多音频填空：按顺序转写，拼成带编号的文本；数量上限可配置（默认 12）。
- 失败：记录错误，题目按“无听力原文”处理或停止；不猜测。

### 2.10 提示词与答案解析

移植 `providers.py` 的 `_prompt`、`_parse_answer`、`_parse_blank_answer`、`_parse_matching_answer`：

- 题型映射：
  - `choice` / `dropdown` → `choice`
  - `blank` → `blank`
  - `blanks` → `blanks`（要求按空输出多行）
  - `essays` → `essay`
  - `matching` → `matching`（只输出字母序列）
  - `oral` → `oral`（60 秒内、80–100 词、适合朗读）
  - `discussion` → `discussion`（1–2 句、30–60 词）
- 选择题要求返回 `{"answer":"B","explanation":"..."}`；匹配题只返回一行字母；填空题按行输出。
- 解析失败/答案无法匹配选项 → 不点击，上报 `unrecognized`。
- 题干 + 听力原文 + 选项一起发送；上下文长度设上限（默认 12000 字符）。

### 2.11 回填（移植并改造）

从原脚本移植：

- `writeText(element, value)`：兼容 input/textarea/contenteditable，触发 input/change。
- `applyAnswer(answer, controls)`：
  - `choice`：按字母/文本匹配，点击或设置 checked，触发事件。
  - `dropdown`：点开、找菜单项、点击；校验已选中。
  - `blank`/`blanks`：写入；多空数量校验。
  - `matching`：拖拽排序并校验最终顺序。
  - `oral`：生成音频 → `DataTransfer` 写入 `input[type=file]` → 触发 change；**不点击提交**。
- **移除**：`confirmSubmitDialog()` 的点击逻辑；`pageActionButton()` 中的 `提交`；`clickPageAction()` 中对提交的点击。

安全改造：

```js
const SAFE_ACTIONS = ["下一题", "下一步", "继续"];
const SUBMIT_ACTIONS = ["提交", "交卷", "完成", "结束", "发布"];

function pageActionButton() {
  // 只返回 SAFE_ACTIONS；忽略 SUBMIT_ACTIONS
}

async function clickPageAction() {
  const action = pageActionButton();
  if (!action) {
    if (hasSubmitButton()) {
      reportWaitingForSubmit();
      stopAutomation();
    }
    return false;
  }
  action.element.click();
  ...
}
```

提交页/弹窗检测：

- 页面出现“提交/交卷/确定提交/第一次作答/仅记录第一次”等文本；
- 或唯一可用的动作按钮是“提交”；
- → 状态置为 `waiting`，消息“已填完，等待手动提交”，停止循环；事件级别 `warn`。
- 不点击“确定”。

讨论页：

- 填写编辑器；
- 不点击“发布”；
- 状态 `waiting`，提示手动发布。

### 2.12 设置项

| key | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `auto_start_on_course` | boolean | false | 打开课程详情页时是否自动开始 |
| `play_video` | boolean | true | 是否自动播放课程视频 |
| `asr_language` | text | 空 | 空=自动 |
| `max_audio_files` | integer | 12 | 单页最多转写音频数 |
| `tts_voice` | text | 空 | 覆盖全局 TTS 语音 |
| `tts_format` | select | mp3 | 上传音频格式（mp3/wav） |
| `answer_timeout` | number | 300 | 模型超时秒 |
| `transcribe_timeout` | number | 600 | ASR 超时秒 |
| `max_steps` | integer | 200 | 单次运行最大步骤，防死循环 |
| `stop_on_unknown` | boolean | true | 无法识别时停止 |
| `log_questions` | boolean | false | 是否把题干写入日志文件 |

### 2.13 面板

Tab：`运行状态`

- 浏览器连接状态、当前页面 URL/标题。
- 运行状态、已答题数、跳过/错误数、当前题型/题干（截断）。
- 开始/停止按钮（通用骨架已有，面板可重复展示状态）。
- 最近日志（最近 20 条）。
- “打开 U校园”“打开操作指南”按钮。
- 提示：不会自动提交。

### 2.14 日志与无法识别

- 常规日志：事件总线（UI）+ `<data>/logs/ucampus.log`。
- 无法识别：`<data>/logs/unrecognized.log`，JSON lines：
  ```json
  {"ts":"...","url":"...","title":"...","question":"...","reason":"...","type":"..."}
  ```
- 记录内容不含账号/密码；题干是否记录由 `log_questions` 控制（默认关闭，仍可记录截断摘要用于诊断）。

### 2.15 移植步骤

1. 复制油猴脚本为 `web/page-agent.js`，去掉 `// ==UserScript==`、悬浮面板、`GM_*`。
2. 实现 `__freeocs` 桥替换 `request()`、`GM_getValue`/`GM_setValue`（用 `localStorage` + Python 状态）。
3. 删除 `createPanel`/`renderRunLog` 的 DOM 面板；日志改 `__freeocs.log`。
4. 改写 `handleControllerCommand`/`pollController` 为 `poll()`/`handleCommand()`。
5. 移植 Python 提示词/解析；实现 `handle_agent_request`。
6. 安全改造：移除所有提交/发布点击；增加 `waiting` 状态。
7. 音频：`transcribeAudioUrl` 改为发送 URL；删除 `GM_xmlhttpRequest` 下载。
8. 面板：实现 `panel.js`。
9. 用本地 fixture 页面手动回归：课程详情、目录、Practice、各题型、提交页、讨论页、视频。
10. 打包 zip，安装测试。

### 2.16 验收标准

- [ ] 扩展连接后，在课程详情页点“开始”能扫描模块并打开未完成任务。
- [ ] 能识别并回填：单选、下拉、单空、多空、多 textarea、匹配、口语上传。
- [ ] 听力音频能下载并转写；失败时有明确错误，不猜答案。
- [ ] 视频能播放到结束；有题目时能转写。
- [ ] 任何路径都不会点击“提交/交卷/确定提交/发布”；遇到时状态为“等待手动提交/发布”。
- [ ] 无法识别时停止并写 `unrecognized.log`。
- [ ] 开始/停止/状态/日志/设置持久化正常。
- [ ] 模块可在应用内启用/禁用；浏览器断开时按钮禁用并提示。

## 3. 智慧树（手机）

### 3.1 参考实现

`/home/xzc/桌面/项目/aiQuestion`：

- `automation.py`：ADB + `AnswerBot` + 工具注册。
- `agent.py`：OpenAI Function Calling 循环。
- `pages/wisdomtree.py`：`com.able.wisdomtree` 的控件树解析。
- `main.py`：Flask + 网页控制台（FreeOCS 不需要）。

### 3.2 方案

```text
FreeOCS 智慧树模块
├─ ADB（框架 android.adb）
├─ Reader（移植 wisdomtree.py，模块内）
├─ Agent（移植 agent.py，改用 llm.chat）
├─ 工具：read_page / click_option / click_next / finish
└─ 面板：设备/状态/日志
```

与参考的差异：

1. 不再使用 `adbutils`，改用框架 ADB（纯 `adb` CLI）。
2. 不再读写 `config.json`，改用设置页。
3. 不再有 Flask 控制台，改用 FreeOCS 模块页。
4. 模型调用改为 `ctx.require("llm.chat").chat(...)`，非流式。
5. 工具循环保留；`click_next` 检测提交页时不点击。
6. 增加 OCR 兜底（可选）。

### 3.3 包布局

```text
packages/src/wisdomtree/
├── manifest.json
├── backend/
│   ├── __init__.py
│   ├── main.py
│   ├── module.py
│   ├── agent.py
│   ├── readers/
│   │   ├── __init__.py
│   │   ├── base.py
│   │   └── wisdomtree.py
│   └── prompts.py
├── web/
│   ├── panel.js
│   └── panel.css
├── README.md
└── icon.png
```

### 3.4 Reader

直接移植 `pages/base.py` 与 `pages/wisdomtree.py`：

- `PageData`、`Option`、`Button`、`parse_bounds`、`center_of`。
- `WisdomTreeReader.can_handle`：包名 `com.able.wisdomtree`。
- `parse`：题型、选项、按钮、题干、raw_text。
- 改进：
  - 多选题：保留所有选项，Agent 可返回多个；新增 `click_options(option_texts)` 工具。
  - 过滤更多 WebView 占位符。
  - 解析失败时返回 `None`，由模块决定 OCR 兜底。

### 3.5 ADB 流程

```python
adb = self.ctx.adb.connect(self.settings.get("device_serial") or None)
w, h = adb.screen_size()

def read_page():
    xml = adb.dump_hierarchy(timeout=...)
    root = ET.fromstring(sanitize(xml))
    page = reader.parse(root, w, h)
    ...
```

- dump 失败重试 3 次；等待 `page_load_timeout`。
- 每次点击后等待 `poll_interval`，再 dump。
- 点击使用 `adb.tap(x, y, jitter=click_jitter)`。
- 屏幕旋转：重新获取尺寸。

### 3.6 Agent

移植 `AnswerAgent`，改为同步 `llm.chat`：

```python
result = llm.chat(
    messages,
    tools=self.tools,
    tool_choice="auto",
    temperature=self.settings.get("temperature", 0.0),
    timeout=self.settings.get("answer_timeout", 300),
)
```

- 非流式；每轮检查 `finish_reason` 与 `tool_calls`。
- 工具调用轨迹通过 `ctx.emit("question", ...)` 推给面板，不写入模型上下文。
- `max_tool_rounds` 默认 30；重复页面签名 3 次停止。
- 上下文裁剪：进入下一题后保留 system + 本轮工具链，避免 token 膨胀。

工具：

```python
read_page() -> {
  "question_type": "...",
  "question": "...",
  "options": ["A. ...", "B. ..."],
  "buttons": ["下一题", ...],
}
click_option(option_text) -> {"ok": True, "clicked": "..."}
click_options(option_texts) -> {"ok": True, "clicked": [...]}  # 多选
click_next() -> {"ok": True, "button": "...", "finished": False}
finish(reason) -> {"ok": True}
```

### 3.7 不提交

- `click_next` 先扫描按钮：
  - 含 `提交/交卷/完成/结束` → 返回 `finished=true`，不点击。
  - 含 `下一题/下一步/继续` → 点击。
  - 都没有 → 返回错误。
- 不点击“答题卡”“保存并提交”等。
- 检测到提交确认弹窗 → 停止，状态“等待手动交卷”。
- 模块开始时提示：“只答题，不交卷”。

### 3.8 OCR 兜底

当 Reader 返回 `None` 或题目/选项为空：

1. `adb.screenshot()`。
2. `media.ocr.extract(png)`。
3. 用启发式规则切分题干/选项（按行、字母前缀）。
4. Agent 只拿到文本；点击需要 OCR block 坐标：
   - 在 blocks 中查找与选项文本匹配的块；
   - 匹配失败 → 停止，不点击。
5. 置信度低于阈值 → 停止。

v1 默认开启兜底，但要求用户安装 OCR 插件；缺失时提示安装，不静默失败。

### 3.9 设置项

| key | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `device_serial` | text | 空 | 留空自动选择 |
| `click_jitter` | integer | 2 | 像素 |
| `dump_timeout` | number | 15 | 秒 |
| `screenshot_timeout` | number | 20 | 秒 |
| `page_load_timeout` | number | 8 | 秒 |
| `poll_interval` | number | 0.8 | 秒 |
| `max_tool_rounds` | integer | 30 | 防循环 |
| `temperature` | number | 0.0 | 模型温度 |
| `ocr_fallback` | boolean | true | 控件树失败时 OCR |
| `ocr_min_confidence` | number | 0.5 | 0–1 |
| `interval_min` / `interval_max` | number | 0.2 / 0.6 | 操作间随机等待 |

### 3.10 面板

Tab：`运行状态`

- 设备：序列号、型号、授权状态、分辨率。
- 运行状态、当前题型/题干（截断）、最后点击的选项。
- AI 工具调用轨迹（read_page/click_option/click_next）。
- 最近日志。
- 开始/停止（通用骨架已有）。
- “刷新设备”“截图预览”（可选）。
- 提示：不交卷。

### 3.11 验收标准

- [ ] 能发现设备并显示授权状态；未授权有可操作提示。
- [ ] 能解析智慧树单选/多选/判断页面，坐标正确。
- [ ] Agent 能完成至少 5 道连续题目（测试页面）。
- [ ] 多选支持点击多个选项。
- [ ] 到提交/交卷页停止，不点击。
- [ ] 页面无法识别时停止并给原因；OCR 兜底可用（安装 OCR 插件时）。
- [ ] 开始/停止/状态/日志/设置持久化正常。
- [ ] 真机/模拟器均可运行（v1 至少一台真机）。

## 4. 新模块开发清单

1. 复制 `packages/src/_template`（后续提供）。
2. 修改 manifest：`id`、`name`、`type`、`platform`、`requires`、`provides`、`settings`、`page_agents`/`panels`。
3. 实现 `setup(api)` 与 `Module` 子类。
4. 声明能力依赖；不要在模块内直接 import 插件实现。
5. 实现 `status()`/`actions()`/`invoke()`；耗时工作在 `start()` 的线程中。
6. 网页模块：实现页面 Agent 与 `handle_agent_request`；注册 `web.allowed_hosts`。
7. 手机模块：实现 Reader 与 ADB 流程；遵守不提交。
8. 添加面板（可选）与 README。
9. 本地 `FREEOCS_PACKAGES=source` 调试；打包后在“应用”页安装回归。
10. 通过验收清单后再发布。

## 5. 通用风险与对策

| 风险 | 对策 |
| --- | --- |
| 目标网站/APP 改版 | 解析失败即停止并上报；选择器集中管理；保留 raw HTML/XML 调试开关 |
| 模型答案与选项不匹配 | 严格匹配；失败不点击；记录 raw 输出 |
| 模型幻觉/过度自信 | 提示词要求不确定时输出空；模块对空答案停止 |
| 浏览器自动播放限制 | 提示用户允许；不静默失败 |
| ADB 延迟/动画 | 重试 + 等待 + 超时；不无限循环 |
| 账号风控 | 不实现绕过；随机间隔仅降低机械感；用户自行承担使用风险 |
| 误提交 | 安全模式硬编码；代码审查 + 测试用例覆盖所有提交按钮路径 |
