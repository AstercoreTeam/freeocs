# FreeOCS 设计文档

> 状态：v0.1 设计基线（2026-11-16）
>
> 本文档集是 FreeOCS v1 的实现依据。代码实现与文档不一致时，以本文档集为准并同步修正文档。

## 1. 项目是什么

FreeOCS（Free Open Course Study）是一个本地优先、插件化的学习助手桌面应用：

- 界面使用 **pywebview**（Linux：GTK + WebKit2；Windows：WebView2）。
- 支持的应用以 **应用模块** 接入，模块之间互不依赖。
- 手机应用通过 **ADB** 操作；网页应用通过 **浏览器扩展 + 本地中继** 操作。
- 框架提供通用能力，能力由 **插件** 提供：大模型对话、选择题作答、语音转写、图片 OCR、语音合成。
- 设置页由框架统一渲染，插件和模块可注册自己的设置项。
- **绝不自动点击“提交/交卷/发布”等不可逆操作**，只填答案并提示用户手动完成。

参考项目：

| 项目 | 可复用的部分 |
| --- | --- |
| `/home/xzc/桌面/项目/u校园` | U校园页面扫描、题型识别、答案回填、ASR/TTS、自动学习状态机 |
| `/home/xzc/桌面/项目/aiQuestion` | ADB `uiautomator dump`、控件树解析、Function Calling 答题 Agent |
| `/home/xzc/桌面/项目/webcat` | 浏览器扩展 + 本地长轮询中继、通用 DOM 操作协议 |
| `/home/xzc/桌面/项目/hpm-gui` | pywebview + layui 的顶栏/侧边栏/页面注册/设置页 UI 形态 |

## 2. 文档索引

| 文档 | 内容 | 读者 |
| --- | --- | --- |
| [01-architecture.md](01-architecture.md) | 总体架构、线程模型、目录结构、启动流程、安全边界 | 所有人 |
| [02-package-format.md](02-package-format.md) | 插件/模块 zip 包格式、manifest、安装与加载 | 插件/模块开发者 |
| [03-capability-sdk.md](03-capability-sdk.md) | 能力注册、SDK 接口、模块生命周期、设置/事件 | 插件/模块开发者 |
| [04-ui-design.md](04-ui-design.md) | 界面导航、页面结构、模块面板注入、设置页 schema | 前端/UI |
| [05-webcat-bridge.md](05-webcat-bridge.md) | 浏览器扩展、中继协议、页面 Agent 注入、安装引导 | 网页模块开发者 |
| [06-android.md](06-android.md) | ADB 传输层、uiautomator、OCR 兜底、点击策略 | 手机模块开发者 |
| [mods/](mods/README.md) | 按平台拆分的实际实现：U校园页面/题型/流程，智慧树 ADB 流程 | 模块开发者 |
| [plugins/](plugins/README.md) | 按插件拆分的实现：LLM、ASR、OCR、TTS/KokoClone | 插件开发者 |
| [08-development.md](08-development.md) | 环境、运行、构建、打包、测试、里程碑 | 开发者 |
| [10-token-usage.md](10-token-usage.md) | Token 统计、缓存命中/未命中/输出单价、消费限额、AI 兜底确认 | 开发者/用户 |
| [11-voice-clone.md](11-voice-clone.md) | KokoClone 本地克隆语音、参考音频设置、独立环境 | 开发者/用户 |
| [09-decisions.md](09-decisions.md) | 关键架构决策记录（ADR） | 所有人 |

建议阅读顺序：`README → 01 → 02 → 03 → 04 → 05/06 → mods → plugins → 08 → 10 → 11`。

## 3. 已确认的产品决策

| 主题 | 决策 |
| --- | --- |
| 平台 | Linux 优先，Windows 保留兼容层，条件允许时同步支持 |
| UI | pywebview；导航与页面组织参考 hpm-gui（顶栏 + 左侧导航 + 每页独立资源 + layui） |
| 模块/插件分发 | 统一为独立构建的 zip 包；包内是 Python 包，主程序内加载 |
| 依赖安装 | 包内声明 Python 依赖，安装时列出并**经用户确认**后装入主程序环境 |
| 网页自动化 | 使用 webcat 方案：内置浏览器扩展 + 本地中继；扩展同时兼容 Chromium MV3 与 Firefox |
| 手机自动化 | `uiautomator dump + adb input`，截图 + OCR 作为兜底 |
| 能力模型 | 模块声明 `requires`，插件声明 `provides`；框架提供 ADB、浏览器中继等基础能力 |
| 答题 | 框架只提供“题干 + 选项 → 选项”的选择题辅助能力；复杂题型由模块自己调用大模型 |
| 大模型配置 | 默认只有一套全局文本模型；TTS/ASR/OCR 等多模态配置属于各自插件/模块 |
| 媒体能力 | 本地优先，可切换云端 |
| 提交策略 | **绝不自动提交**；只填答案，停在提交/发布前 |
| v1 应用 | 完整移植 U校园（网页）与智慧树（手机）的核心流程 |
| 打包 | 最终提供单文件/安装包；v1 先交付 Linux 可运行版本与打包脚本 |

## 4. 术语

| 术语 | 含义 |
| --- | --- |
| 包（package） | 一个 zip 分发包，类型为 `plugin`、`module` 或 `bundle` |
| 插件（plugin） | 向框架注入能力的包，例如 `tts_system`、`asr_whisper` |
| 模块（module） | 接入一个具体学习应用（U校园、智慧树）的包 |
| 能力（capability） | 稳定的字符串 ID，例如 `llm.chat`、`media.asr`、`web.bridge` |
| 提供者（provider） | 某个能力的具体实现对象 |
| 能力绑定（binding） | 当同一能力有多个提供者时，用户/默认选择哪一个 |
| 页面 Agent | 由模块携带、注入到目标网页中执行的 JS 脚本 |
| 中继（relay） | 主程序内的本地 HTTP 服务，负责扩展长轮询与页面 Agent 通信 |
| 会话（session） | 一次模块运行（从开始到停止）的上下文 |

## 5. 非目标（v1）

- 不做云端账号、云同步、在线插件市场。
- 不做无浏览器/无头浏览器方案；网页自动化依赖用户已登录的浏览器。
- 不做自动提交、自动交卷、自动发布讨论。
- 不承诺绕过网站风控或验证码。
- 不内置大模型权重；模型由用户配置或首次使用时下载。
- 不在 v1 做插件签名与沙箱；只加载用户明确信任的包。

## 6. 文档维护

- 架构级变更先改 `09-decisions.md`，再改对应设计文档，最后改代码。
- manifest / SDK 字段变更必须提升 `api_version` 或保持向后兼容。
- 每个模块的 README 放在包内，面向使用者；框架文档只描述契约。

## 7. 本轮评审重点

在进入 M1 编码前，建议重点确认以下 5 点：

1. **U校园“安全模式”边界**：v1 对 `dubbing`（朗读评分）、`roleplay`（角色扮演）、讨论区“发布”均停在提交前，只填/准备内容，不自动完成评分或发布。这是对参考项目“全自动”的主动收窄，是否符合预期？
2. **网页自动化形态**：模块携带页面 Agent（JS），由扩展注入；扩展保持通用。相比“全部用 Python + 通用 DOM 调用”，这种方案移植成本低，但模块会包含较多 JS。
3. **包运行形态**：Python 包在主程序内加载，无进程隔离；安装依赖需用户确认；安装/更新后重启生效。
4. **密钥存储**：v1 以 `0600` 权限的 JSON 明文保存 API Key，不接系统 keyring。
5. **打包形态**：优先 PyInstaller onedir + 安装包；onefile 仅作可选实验；模型不随包分发。

如无异议，下一阶段按 `08-development.md` 的 M1 开始搭建框架骨架。

---

## License / 许可

Copyright (C) 2026 qincnd <qincnd@qq.com>, XueZicheng <xuezicheng842@outlook.com>, AstercoreTeam.

This project is licensed under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`).
See [https://spdx.org/licenses/AGPL-3.0-only.html](https://spdx.org/licenses/AGPL-3.0-only.html).

