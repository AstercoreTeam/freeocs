# U校园页面结构

U校园的课程页面不是线性的“一页一题”，而是「右侧章节目录 + 顶部模块 Tab + 子模块 Tab + 页面内容」四层结构。

页面快照来自实际课程，模块/章节名称会随课程变化。

## 1. 四层结构

```text
课程
├─ 章节（右侧目录的 Module 1..N）
│   ├─ 学习模块（顶部一级 Tab）
│   │   ├─ 子模块（顶部二级 Tab）
│   │   └─ 页面：视频 / 题目 / 讨论 / 词汇表
```

### 第一层：右侧章节目录

右侧「目录」列出：

```text
Module 1
  Unit 1 Pronunciation skill 1
    绪论
    基本概念
  Unit 2 The Chinese way of learning
    Quote
    Unit introduction
    Cultural reading and listening
    Viewing
    Unit task
Module 2
  ...
```

特点：

- 章节是 `Module N`。
- 每个 Module 包含若干 Unit / Section。
- 每个 Section 右侧有完成状态圆点。
- 点击 Section 切换当前页面。
- 章节全部完成后应点击下一个 Module 的第一项。

### 第二层：页面顶部一级 Tab

不同 Section 的一级 Tab 不同：

```text
绪论 / 基本概念：
  Mini-lecture | Practice

Cultural reading and listening：
  Cultural reading | Cultural listening | Cross-cultural thinking | Language focus

Viewing：
  Viewing | Video comprehension | Language focus | Discussion
```

一级 Tab 是**同一 Section 内的子模块**，不是新章节。

### 第三层：顶部二级 Tab

例如：

```text
Practice：
  Practice 1 | Practice 2

Cultural reading：
  Pre-reading | Reading in detail | Reading comprehension

Language focus：
  Vocabulary learning | Language practice
```

### 第四层：页面内容

内容类型包括：

- 视频（HTML5 / Video.js）
- 音频 + 题目
- 单选/多选/填空/问答/排序
- 讨论区
- Word bank / 纯阅读材料

## 2. 已观察到的页面模板

### 2.1 Mini-lecture + Practice

代表：`Module 1 → 基本概念`

```text
Mini-lecture
  视频 6:43
Practice
  Practice 1 / Practice 2
  每页多道单选题
  底部：提交
```

流程：视频播放完 → Practice → 答完所有题 → 停在提交前。

### 2.2 Practice 多题一页

代表：`Module 1 → 绪论`

```text
Practice 1
  1. 英语属于什么语系？ A/B/C/D
  2. 英语一共有多少个音素？ A/B/C
  ...
  底部：提交
```

不是一页一题；需要遍历同页多个选择题组。

### 2.3 Cultural reading

代表：`Module 1 → Cultural reading and listening`

```text
Cultural reading
  Pre-reading：讨论区
  Reading in detail：阅读文章
  Reading comprehension：
    5 道单选
    阅读摘要 10 空
    摘要排序 6 项
```

阅读理解文章在页面主体中，题目在独立的选择题组里。

### 2.4 Cultural listening

```text
Listening comprehension
  音频 2:07
  多道选择题
  底部：下一题
```

音频转写文本必须和当前页所有题目一起给模型。

### 2.5 Viewing

```text
Viewing
  视频 1:59
Video comprehension
  可能带题
Language focus
  Vocabulary learning / Language practice
Discussion
  讨论区
```

视频本身无题时，播完应自动切到 `Video comprehension` 或下一子模块。

### 2.6 Cross-cultural thinking

```text
2 个问答题文本框
每框 1000 字
底部：提交
```

### 2.7 Unit task

```text
对话/口语任务
可能包含 roleplay / dubbing / 录音提交
```

当前策略：识别到 roleplay/dubbing 后在提交前停止，等待人工。

### 2.8 Language focus

```text
Vocabulary learning
  Word bank（可能无题）
Language practice
  练习题
```

Word bank 本身不是题目，应自动视为完成并切到 Language practice。

## 3. 导航规则

### 页面内

优先级：

1. 当前页有未答题目 → 先答完
2. 有“下一题/下一步/继续” → 点击
3. 有顶部子模块未完成 → 切子模块
4. 有顶部一级 Tab 未完成 → 切一级 Tab
5. 最后才切右侧目录下一个 Section

### 安全停止

遇到以下按钮立即停止，不点击：

```text
提交 / 交卷 / 保存并提交 / 确定提交 / 发布 / 评分提交 / 完成
```

### 用户提交后的续跑（待实现）

```text
用户手动提交
  → 页面切换到下一个子模块 / 下一个 Section
  → 自动开始新页面
  → 如果当前章节已全部完成
      → 自动点击右侧目录下一个 Module
```

## 4. 页面识别锚点

| 结构 | 选择器/文本 |
| --- | --- |
| 右侧目录项 | `span.pc-menu-node-name[title="..."]` |
| 顶部一级 Tab | `.pc-tab-row .tab` / `.pc-header-tab-activity` |
| 顶部任务 Tab | `.pc-header-tasks-row .pc-task` |
| 选择题组 | `.question-common-abs-choice` |
| 选项 | `.option` / `.option.selected` |
| 隐藏填空 | `.comp-abs-input > input` |
| 排序 | `.sortable-list-wrapper` + `.sequence-reply-view-item-text` |
| 视频 | `video.vjs-tech` / `<video>` |
| 讨论区 | `全部评论` / `[class*='discussion']` |
| 提交 | `#pc-foot a.btn` 文本“提交” |

这些选择器是当前课程模板的锚点，换课程模板时需要补充验证。

## 5. 与旧版文档的差异

旧版 `docs/07-modules.md` 把 U校园描述为接近线性的“识别当前题 → 作答 → 下一题”。

实际结构还有：

- 同一页多题
- 同一 Section 多级 Tab
- 无题视频/Word bank
- 用户提交后跨模块续跑
- 章节结束后的目录切换

这些是本目录重点补充的内容。
