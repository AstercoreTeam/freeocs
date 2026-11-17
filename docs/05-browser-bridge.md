# 05 浏览器中继与扩展

## 1. 目标

网页模块需要一个稳定、通用、可复用的方式操作浏览器：

- 不要求用户安装 Python 版 Playwright/Chromium。
- 复用用户已经登录的日常浏览器（Chrome/Edge/Firefox）。
- 扩展保持通用，不内置任何具体学习网站的适配代码；站点适配由模块的**页面 Agent** 提供。
- 扩展与本地程序通过回环 HTTP 通信，协议简单、可调试。

FreeOCS 自己实现浏览器扩展中继：扩展后台长轮询本地服务，content script 执行 DOM 操作。在此基础上增加：

1. 模块页面 Agent 的注册与自动注入。
2. 扩展后台代理页面 Agent 的本地 API 请求（避免混合内容/CORS 问题）。
3. 模块级 Origin 校验。
4. 多浏览器（Chromium MV3 + Firefox）与安装引导。

## 2. 组件

```text
┌─────────────────────┐        HTTP 长轮询         ┌──────────────────────────┐
│ Browser Extension   │ ◀────────────────────────▶ │ FreeOCS Local Server      │
│  background (SW)    │  /extension/poll           │ 127.0.0.1:8765            │
│  content script     │  /extension/result         │                          │
│   ├─ DOM 操作       │  /extension/agents         │  队列 / 结果 / Agent 注册  │
│   └─ 页面 Agent     │  /extension/agent.js       │                          │
└─────────┬───────────┘                            └────────────┬─────────────┘
          │ 操作                                                 │ 能力调用
          ▼                                                      ▼
   用户已登录的目标网页                                  Python 模块 / 插件
   （U校园等）                                           llm / asr / tts
```

- **background**：维护长轮询、标签页选择、Agent 代码获取、本地 API 代理、跨域下载（可选）。
- **content script**：在页面隔离世界执行 DOM 操作；注入本地 Agent bundle；提供 token 校验的 postMessage 桥。
- **local server**：扩展任务队列、结果回传、Agent 下发、模块 API 转发、静态资源。
- **Python module**：业务状态机、模型调用、ASR/TTS、日志。

## 3. 协议

### 3.1 通用约定

- 地址：`http://127.0.0.1:8765`（端口可配置）。
- 请求/响应均为 JSON；二进制使用 base64 或分块上传（v1 仅音频 URL/文本）。
- 扩展后台在所有请求上带：
  ```http
  X-FreeOCS-Client: browser-bridge
  X-FreeOCS-Extension-Version: 1.0.0
  ```
- 页面 Agent 的请求由后台代理，额外带：
  ```http
  X-FreeOCS-Page-URL: https://course.unipus.cn/...
  X-FreeOCS-Page-Origin: https://course.unipus.cn
  ```
- 服务端校验页面 URL 的 host 是否匹配模块 `web.allowed_hosts`；不匹配返回 403。
- 浏览器页面**不能直接**调用 `/api/module/*`：服务端要求 `X-FreeOCS-Client`，而页面自定义头会触发 CORS 预检，预检被拒绝。这样本地 LLM 不会被任意网页滥用。
- v1 不引入共享 token；威胁模型是“本机可信、浏览器页面不可信”。未来可加 `bridge_token`。

### 3.2 扩展注册/心跳

扩展后台启动时：

```http
POST /extension/register
{
  "browser": "chrome",
  "version": "1.0.0",
  "extension_id": "abcdef...",
  "user_agent": "..."
}
```

响应：

```json
{ "ok": true, "server_version": "0.2.0", "poll_timeout": 25 }
```

服务端记录 `last_seen`、浏览器、版本、扩展 ID。每 30 秒可再发一次；长轮询本身也可视为心跳。

### 3.3 任务长轮询

扩展后台循环：

```http
GET /extension/poll?timeout=25
X-FreeOCS-Client: browser-bridge
```

- 有任务：`200 {"id":"...","action":"dom.call","args":{...}}`
- 超时：`200 {}`（空对象，不是错误）
- 服务端等待最长 `timeout` 秒；建议 20–25 秒。

结果：

```http
POST /extension/result
{
  "id": "...",
  "ok": true,
  "result": ...
}
```

失败：

```json
{ "id": "...", "ok": false, "error": "未找到活动标签页" }
```

服务端用 `threading.Event` 等待结果，默认超时 15 秒；超时返回 504 给 Python 调用方。

### 3.4 动作

| action | args | 说明 |
| --- | --- | --- |
| `dom.call` | `{method, args}` | 在目标标签页执行通用 DOM 操作 |
| `page.info` | `{}` | 当前页 URL/title/host/readyState |
| `page.navigate` | `{url}` | 目标标签页跳转 |
| `tabs.list` | `{}` | 列出标签页概要 |
| `tabs.activate` | `{url_pattern}` | 按 URL 子串/通配符激活并设为目标 |
| `tabs.target` | `{tab_id}` | 显式绑定目标标签页（不要求窗口活动） |
| `fetch` | `{url, method, headers, body_base64, timeout}` | 后台跨域请求（可选） |
| `ping` | `{}` | 连通性检查 |

`dom.call` 的 `method` 见第 5 节。

### 3.5 Agent 下发（无 eval）

扩展后台在 content script 就绪时请求：

```http
GET /extension/agents?url=https%3A%2F%2Fcourse.unipus.cn%2F...&token=<random>
X-FreeOCS-Client: browser-bridge
```

响应：

```json
{
  "agents": [
    {
      "id": "ucampus",
      "package": "ucampus",
      "matches": ["*://*.unipus.cn/*"],
      "bundle_url": "http://127.0.0.1:8765/extension/agent.js?package=ucampus&id=ucampus&token=..."
    }
  ]
}
```

content script 通过 `<script src="bundle_url">` 把 Agent 注入**页面主世界**（而不是 eval），因此不受扩展 MV3 的 `unsafe-eval` CSP 限制。

`/extension/agent.js` 返回的 bundle 结构：

```js
(function () {
  const TOKEN = "...";
  const bridge = {
    request(path, options) { /* postMessage 到 content script */ },
    log(level, message, data) { ... },
    pageInfo() { ... },
  };
  (function (__freeocs) {
    /* page-agent.js 原文 */
  })(bridge);
})();
```

- Agent 用 `window.postMessage` 与 content script 通信；content script 校验 `token`，再转发给扩展后台。
- 页面脚本无法直接拿到 `bridge` 对象（它在 bundle 闭包里），但可以从 `<script src>` 的 URL 看到 token；v1 的目标站点被视为可信。
- 只返回**已启用**模块的 Agent；`url` 必须匹配 `page_agents[].matches`。
- 服务端读取 Agent 文件时做路径校验与大小限制（默认 2 MB）。
- content script 用 DOM dataset 防重复注入；Agent 自身也有 guard。
- 如果模块未运行，Agent 仍然注入，但只做轻量轮询/等待，不执行自动化。
- 如果目标页面 CSP 禁止 `http://127.0.0.1` 脚本，注入会失败；content script 会上报错误。v1 以“目标站点允许 localhost 脚本”为前提；后续可评估 `chrome.userScripts` 或扩展内打包 Agent 的回退方案。

### 3.6 模块 API 代理

页面 Agent 通过 content script → background → 本地服务：

```http
POST /api/module/ucampus/poll
X-FreeOCS-Client: browser-bridge
X-FreeOCS-Page-URL: https://course.unipus.cn/...
Content-Type: application/json

{ "client_id": "...", "url": "...", "title": "...", "frame": "top" }
```

响应：

```json
{
  "ok": true,
  "active": true,
  "lease": true,
  "command": { "action": "start" },
  "state": { "completed": 0 }
}
```

- 服务端按模块 ID 路由到 `Module.handle_agent_request(method, payload)`。
- 请求体/响应体默认上限 2 MB；音频使用 URL 下载，不走 base64（v1 的 U校园 音频由 Python 侧下载）。
- 页面 URL/Origin 用于模块白名单校验。
- `client_id` 由 Agent 生成（每帧一个），用于租约和去重。

### 3.7 单 Runner 租约

同一模块可能同时有多个页面/iframe 的 Agent。为避免重复答题：

- 服务端为每个模块维护 `lease = {client_id, last_seen, url}`。
- Agent 轮询时带上 `client_id` 与“本帧是否有可处理内容”的标记。
- 若 `active=true` 且当前无租约/租约过期（默认 10 秒无心跳），把租约授予第一个报告有内容的 client。
- 非租约持有者返回 `lease=false`，只做心跳，不执行自动化。
- 页面导航后旧 client 停止心跳；新 client 在租约过期后接管。
- Agent 在 `pagehide` 时尽力发送 `release`（失败也无妨）。
- 租约只保证“同一时刻一个执行者”，不保证跨页面的业务状态；业务状态由 Python 模块保存。

## 4. 扩展生命周期

### 4.1 启动

1. 读取 `storage.local` 配置：端口（默认 8765）、启用状态。
2. `POST /extension/register`。
3. 启动长轮询循环。
4. 监听 `tabs.onUpdated`/`tabs.onActivated`，更新当前标签页信息（可选）。
5. content script 在每个页面加载时请求 Agent 列表并注入。

### 4.2 长轮询循环

```js
while (enabled) {
  try {
    const res = await fetch(`${base}/extension/poll?timeout=25`, { headers });
    if (res.ok) {
      const task = await res.json();
      if (task.id) {
        const result = await dispatch(task);
        await fetch(`${base}/extension/result`, { method: "POST", body: ... });
      }
    }
  } catch (e) {
    await sleep(2000);
  }
}
```

- MV3 service worker 可能被浏览器回收；循环在唤醒后重新开始。
- 不使用 `setInterval` 做长轮询；用 `await fetch` 保持。
- 连续失败时指数退避（2s、4s、8s，最大 30s）。

### 4.3 分发到页面

1. 解析目标标签页：优先 `tabs.target` 显式绑定的 tab；否则在**所有窗口**的活动标签页中选最近访问的 http(s) 页；再否则选任意 http(s) 标签页。不使用 `currentWindow` 限制。
2. 若 URL 不是 http/https，报错。
3. `chrome.tabs.sendMessage(tabId, {type:"freeocs:dom", method, args})`。
4. 若 content script 未注入（接收方不存在），尝试 `chrome.scripting.executeScript` 注入 `content.js` 后重试一次。
5. 返回结果或错误。

U校园模块会在开始前绑定一个匹配的标签页；页面内控制面板点“开始/接管本页”时，会把**当前标签页**绑定为目标，避免操作错页。

## 5. content script：DOM 操作

在隔离世界执行，直接访问 DOM；不能访问页面 JS 变量。

| method | args | 返回 | 说明 |
| --- | --- | --- | --- |
| `getHTML` | `[selector?]` | string | 元素 outerHTML 或整页 |
| `getText` | `[selector]` | string\|null | textContent |
| `getAttr` | `[selector, name]` | string\|null | 属性 |
| `getValue` | `[selector]` | string\|null | 表单值 |
| `queryAll` | `[selector]` | array | `{tag,id,class,text}`，text 截断 200 |
| `click` | `[selector]` | bool | `el.click()` |
| `setValue` | `[selector, value]` | bool | 触发 input/change |
| `setHTML` | `[selector, html]` | bool | innerHTML |
| `setAttr` | `[selector, name, value]` | bool | setAttribute |
| `remove` | `[selector]` | bool | 移除 |
| `scrollTo` | `[selector]` | bool | scrollIntoView |
| `scrollBy` | `[x, y]` | bool | window.scrollBy |
| `waitFor` | `[selector, timeout_ms]` | bool | MutationObserver |
| `getPageInfo` | `[]` | object | url/title/host/readyState/viewport |
| `pressKey` | `[key, selector?]` | bool | 键盘事件（可选） |

页面内的 U校园 控制面板注入在目标标签页右下角；它不属于页面题目扫描范围（会从 `#freeocs-ucampus-panel` 中排除）。

约束：

- 选择器只支持 CSS；不支持 XPath。
- 单次返回文本默认上限 1 MB；`getHTML` 整页可能很大，模块应优先 `queryAll`/`getText`。
- 对 Shadow DOM 不自动穿透；页面 Agent 可自行遍历（U校园 Agent 已实现 `pageDocuments()`）。
- iframe：content script 配置 `all_frames: true`；同源 iframe 可直接访问，跨源 iframe 各自注入实例。

## 6. 页面 Agent 契约

### 6.1 注入

- content script 在 `document_start` 运行；等待 `DOMContentLoaded` 后请求 Agent 列表。
- 服务端返回 `bundle_url`，content script 通过 `<script src="bundle_url">` 把 bundle 注入**页面主世界**；不使用 eval。
- bundle 由 `/extension/agent.js` 动态生成：包含 token-scoped postMessage 桥 + 模块 `page-agent.js` 原文。
- content script 用 DOM dataset 防重复注入；Agent 自身也有 guard：
  ```js
  if (globalThis.__freeocs_ucampus_loaded__) return;
  globalThis.__freeocs_ucampus_loaded__ = true;
  ```
- Agent 在 bundle 的 IIFE 内通过参数拿到 `__freeocs` 桥，不挂到 `window`。

### 6.2 `__freeocs` 桥（bundle 内）

```js
const bridge = {
  version: "0.2.0",
  baseUrl: "http://127.0.0.1:8765",

  // 调用模块 API；自动带 page URL/Origin
  request(path, { method = "POST", body } = {}) { /* postMessage → content → background */ },

  // 当前页信息
  pageInfo() { return { url, title, host, frame, top }; },

  // 日志（写入模块事件）
  log(level, message, data) { ... },
};
```

实现：

- bundle 的 `request` 通过 `window.postMessage` 把请求发给 content script；content script 校验 token。
- content script 用 `chrome.runtime.sendMessage({type:"freeocs:api", ...})` 转发给 background。
- background 代理 `fetch(base + path, {headers: {"X-FreeOCS-Client":..., "X-FreeOCS-Page-URL":...}})`。
- 返回 JSON；非 2xx 抛错，错误信息包含 `detail`。
- 桥在 bundle 闭包内；页面脚本无法直接引用 `bridge`，但可以从脚本 URL 看到 token（见安全说明）。
- `pageInfo` 在页面主世界读取 `location`/`document`。

## 7. 扩展安装与引导

### 7.1 目录

```text
extension/
├── shared/
│   ├── background.js
│   ├── content.js
│   ├── options.html
│   ├── options.js
│   └── common.js
├── chromium/
│   └── manifest.json
├── firefox/
│   └── manifest.json
└── dist/
    ├── chromium/        # 构建产物：manifest + shared 文件
    └── firefox/
```

构建脚本 `scripts/build_extension.py`：

1. 清空 `dist/`。
2. 复制 `shared/*` 到 `dist/<browser>/`。
3. 复制对应 manifest 为 `dist/<browser>/manifest.json`。
4. 生成 zip（便于分发），并计算版本。
5. 应用启动时把 `dist/<browser>` 复制到 `~/FreeOCS/extensions/<browser>/`（非隐藏路径，兼容 snap Firefox），供用户“加载已解压”。

### 7.2 Chromium MV3 manifest

```json
{
  "manifest_version": 3,
  "name": "FreeOCS Browser Bridge",
  "version": "1.0.0",
  "description": "FreeOCS 本地学习助手的浏览器中继（仅连接 127.0.0.1）。",
  "permissions": ["tabs", "scripting", "storage"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js" },
  "action": { "default_title": "FreeOCS Bridge" },
  "options_page": "options.html",
  "content_scripts": [
    {
      "matches": ["http://*/*", "https://*/*"],
      "js": ["content.js"],
      "run_at": "document_start",
      "all_frames": true
    }
  ]
}
```

### 7.3 Firefox manifest

```json
{
  "manifest_version": 3,
  "name": "FreeOCS Browser Bridge",
  "version": "1.0.0",
  "description": "FreeOCS 本地学习助手的浏览器中继（仅连接 127.0.0.1）。",
  "permissions": ["tabs", "scripting", "storage"],
  "host_permissions": ["<all_urls>"],
  "background": { "scripts": ["background.js"] },
  "action": { "default_title": "FreeOCS Bridge" },
  "options_ui": { "page": "options.html" },
  "browser_specific_settings": {
    "gecko": { "id": "freeocs-bridge@local", "strict_min_version": "115.0" }
  },
  "content_scripts": [
    {
      "matches": ["http://*/*", "https://*/*"],
      "js": ["content.js"],
      "run_at": "document_start",
      "all_frames": true
    }
  ]
}
```

注意：

- Firefox MV3 使用 `background.scripts`（事件页），不是 `service_worker`。
- 共享代码使用 `const ext = globalThis.browser ?? globalThis.chrome;`，并对 Chrome 的回调式 API 做 Promise 包装。
- 不使用 `eval`；Agent 以本地 bundle 注入页面主世界，content script 只负责桥与转发。

### 7.4 安装步骤（写入指南页）

**Chrome / Edge / Brave**

1. 应用内点击“打开扩展目录”，得到 `~/FreeOCS/extensions/chromium`。
2. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）。
3. 打开“开发者模式”。
4. “加载已解压的扩展程序” → 选择该目录。
5. 回到应用“检测连接”。

**Firefox**

1. 应用内点击“打开扩展目录”，得到 `~/FreeOCS/extensions/firefox`。
   - 如果 Firefox 是 snap 版，**不要**把扩展放在 `~/.local/...` 等隐藏目录；snap 的 home 接口可能读不到，表现为 `background.js` 加载失败。
2. 打开 `about:debugging#/runtime/this-firefox`。
3. “临时载入附加组件” → 选择该目录下的 `manifest.json`。
4. v1 为临时加载，Firefox 重启后需重新载入；后续可提供签名 XPI。
5. 回到应用“检测连接”。

### 7.5 扩展设置页

- 本地端口（默认 8765）。
- 启用/禁用中继。
- “测试连接”按钮：请求 `/health` 与 `/extension/register`。
- 显示当前版本、扩展 ID、最近错误。
- 配置保存在 `storage.local`，不包含密钥。

### 7.6 独立浏览器启动器

首页的“选择要执行的网页”步骤提供 U校园（`https://course.unipus.cn/`）和智慧树（`https://www.zhihuishu.com/`）。点击“打开”后会在 Windows/Linux 上检测 Chrome、Edge、Brave 或 Chromium，并通过独立进程打开新窗口，使用 Chromium 的 `--load-extension` 参数加载应用准备好的扩展目录。Firefox 不支持此命令行自动加载方式，不会用于快捷启动。

快捷启动使用 FreeOCS 专属的持久浏览器配置目录（应用数据目录下 `browser-profiles/chromium`），不复用用户日常浏览器配置。首次打开需要在新窗口登录；之后登录状态保留在该独立配置中。若找不到兼容浏览器或扩展文件未准备好，启动 API 会返回错误；用户仍可按 7.4 节手动安装扩展到自己的浏览器配置。

## 8. 安全

1. **只监听回环地址**；不提供局域网访问。
2. `/api/module/*` 要求扩展头 + 页面 Origin/URL 白名单；页面脚本无法伪造（CORS 预检拒绝）。
3. `/extension/agents` 返回的代码仅来自本地已安装模块；页面无法指定任意 URL。
4. Agent 通过本地 bundle 注入页面主世界；桥在 bundle 闭包内，不挂到 `window`；页面无法直接读取桥对象。
5. 扩展不存储 API Key、题目、答案；只做传输。
6. `host_permissions: <all_urls>` 是必要的，因为模块可能适配不同学习站点；安装时明确告知。
7. 不使用远程代码托管；Agent 代码来自本机包。Chrome Web Store 对远程代码有政策限制，v1 以“加载已解压/临时加载”为主，不承诺商店上架。
8. 本地配置文件权限 `0600`；日志脱敏。

## 9. 兼容性与限制

| 项 | 支持 |
| --- | --- |
| Chrome / Edge / Brave | 109+（MV3） |
| Firefox | 115+（MV3 事件页） |
| 目标标签页 | 支持指定 tab；不限于活动窗口 |
| 多标签页 | 列表/激活；不并行执行 |
| iframe | `all_frames`，跨源各自注入 |
| Shadow DOM | content script 不自动穿透；Agent 自行处理 |
| 无头/后台执行 | 否 |
| 浏览器关闭 | 模块显示未连接 |
| 页面 CSP | 可能影响注入；需实测并准备回退方案 |
| 扩展商店 | v1 不提供 |

已知风险：

- MV3 service worker 休眠：长轮询会重新唤醒；用退避重连。
- 浏览器重启后 Firefox 临时扩展失效；指南页明确。
- 页面结构变化导致选择器失效：模块应上报“无法识别”，停止而不是乱点。
- 页面禁止自动播放：视频可能无法自动播放；模块提示用户手动开始。
- 跨域音频：由 Python 侧下载（httpx），不使用页面 fetch；需要 Referer 时模块传入。

## 10. 测试计划

### 10.1 协议单测

- 启动本地服务，模拟扩展长轮询：
  - 入队任务 → `/extension/poll` 返回 → `/extension/result` 回传 → Python 调用方收到结果。
  - 超时 → 504。
  - 缺少 `X-FreeOCS-Client` → 403。
  - 页面 Origin 不在白名单 → 403。
  - `/extension/agents` 只返回匹配且启用的 Agent。
- 租约：两个 client 并发轮询，只一个获得 lease；过期后转移。

### 10.2 扩展手动测试

- Chrome/Edge：加载、注册、DOM 方法、导航、Agent 注入、模块 API 代理。
- Firefox：同上；确认 MV3 事件页长轮询。
- 断网/服务停止：扩展 2 秒退避，应用恢复后自动重连。
- 页面刷新/跳转：Agent 重新注入，租约接管。
- iframe：同源/跨源页面。

### 10.3 安全测试

- 从任意网页 console 执行 `fetch('http://127.0.0.1:8765/api/module/ucampus/answer', ...)`，应被 CORS/头部校验拒绝。
- 非白名单页面请求模块 API，应 403。
- 路径穿越请求 `/packages/../../etc/passwd`，应 400/404。
