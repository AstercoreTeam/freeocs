# U校园自动化流程

## 1. 当前状态机

```text
idle
  │ start（应用面板 / 页面面板 / Agent 请求）
  ▼
running
  │ 页面 Agent 轮询，拿到 lease 和 start
  ▼
识别页面
  ├─ 提交/交卷/发布/评分 → waiting（手动）
  ├─ roleplay/dubbing   → waiting（手动）
  ├─ 有题目             → 请求模型 → 回填 → 下一题/停止
  ├─ 有视频             → 播放/转写 → 下一子模块
  ├─ 讨论区             → 填入 → waiting（手动发布）
  └─ 未知               → 保存页面 → AI 兜底 / waiting
  ▼
waiting
  │ 用户手动提交
  ▼
（待实现）自动进入下一模块
```

## 2. 启动与目标标签页

### 应用内开始

1. Python 模块 `start()`。
2. 查询所有窗口的活动 U校园 标签页。
3. `bridge.set_target(tab_id)`。
4. 页面 Agent 的 poll 请求带 `X-FreeOCS-Tab-Id`。
5. 服务端注入 `__tab_id`。
6. 只有目标标签页拿到 lease 和 `start` 指令。

### 页面面板开始/接管

1. 面板调用 `/api/module/ucampus/start`。
2. 请求头带当前 `tab.id`。
3. 模块把当前标签页设为目标。
4. 其他 U校园 标签页显示“不是当前控制页”。

## 3. 页面处理顺序

当前 `processQuestion()` 的顺序：

```text
关闭“我知道了”类弹窗
  → 检查提交确认弹窗
  → 讨论区
  → 检测题型
  → 视频/音频转写
  → 识别控件
  → 请求模型
  → 回填/点击
  → 安全导航（下一题/下一步）
  → 没有安全导航则等待手动提交
```

注意：

- 不再因为页面上存在“提交”按钮就提前停止。
- 先答题，最后停在提交前。
- `clickPageAction()` 只点击“下一题/下一步/继续”等安全按钮，不点击提交。

## 4. 提交后自动续跑（已实现，e2e 验证）

目标：

```text
用户点击“提交”
  → 页面切换
  → Agent 自动开始新页面
  → 如果当前章节所有模块完成
      → 自动进入下一章
```

实现要点：

1. 捕获用户对提交按钮的点击（capture 阶段监听）。
2. 记录提交前 URL / 当前 Section / 当前 Tab。
3. 等待 URL、Section、Tab 或题目内容发生变化。
4. 页面稳定 2 秒后自动调用模块 `start`。
5. 不自动点击提交本身。

不能在“用户只是查看页面”时自动重启；必须由提交点击触发。

当前实现：

- 捕获 capture 阶段的提交/发布点击
- 记录提交前页面签名
- 等待 URL、Section、Tab、题目或提交状态变化
- 页面稳定后调用模块 start，自动开始新页面
- e2e 已覆盖“用户提交 → 第二页自动作答 → 停在第二次提交前”

## 5. 模块/章节推进（计划实现）

页面层级见 [page-structure.md](page-structure.md)。

目标顺序：

```text
当前 Section
  ├─ 当前一级 Tab
  │   ├─ 当前二级 Tab
  │   │   ├─ 视频：播放到结束
  │   │   ├─ 无题内容：视为完成
  │   │   └─ 题目：答完，等待提交
  │   └─ 下一个二级 Tab
  └─ 下一个一级 Tab
→ 右侧目录下一个 Section
→ 当前 Module 完成
→ 下一个 Module / 章节
```

优先级：

1. 未答题目
2. 当前页“下一题/下一步”
3. 同 Section 的下一子 Tab
4. 同 Section 的下一一级 Tab
5. 右侧目录下一 Section
6. 下一章节

## 6. 无题视频/内容模块

代表：

- `基本概念 → Mini-lecture`（视频 6:43）
- `Viewing → Viewing`（视频 1:59）
- `Language focus → Vocabulary learning`（Word bank，无题）

策略：

```text
视频：
  play()
  → 等待 ended
  → 记录完成
  → 切下一个子模块
无题内容：
  → 短暂等待
  → 切下一个子模块
```

限制：

- 视频编码不支持时只能记录警告并继续。
- 是否加速播放待确认；U校园可能统计观看时长。
- 长视频播放期间不能误点提交。

## 7. 多题一页

同一页多个 `.question-common-abs-choice`：

```text
循环：
  找第一个未答组
  → 请求模型（带文章/音频/视频上下文）
  → 点击选项
  → 标记该组已答
直到没有未答组
  → 停在提交前
```

原生 radio 多组目前仍需补齐；见 [question-types.md](question-types.md)。

## 8. 失败与兜底

- 未知题型：保存 HTML、文本、交互元素快照到
  `package-data/ucampus/unsupported_pages/`
- 调用模型生成最多 6 个 `click / set_value / select` 动作
- 过滤提交/交卷/发布按钮
- 执行后只走安全导航
- 失败则停在当前页并提示

## 9. 排序题

当前不自动拖拽：

```text
模型输出顺序
  → 面板显示顺序
  → 等待用户手动拖拽
  → 用户提交后（待实现）自动进入下一模块
```

## 10. 测试

```bash
.venv/bin/python -m pytest -q
.venv/bin/python -m ruff check freeocs main.py packages/src tests scripts
```

U校园 E2E：

```bash
PLAYWRIGHT_BROWSERS_PATH=$PWD/.playwright \
FREEOCS_PACKAGES=dist DISPLAY=:0 \
.venv/bin/python scripts/e2e_ucampus.py
```

覆盖：面板启动、目标标签页、选择题、阅读填空、弹窗关闭、视频不支持跳过、不自动提交。
