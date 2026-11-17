# 平台实现文档（mods）

本目录记录每个学习平台在 FreeOCS 中的**实际实现方式**，不写产品愿望，只写：

- 页面/控件结构
- 自动化流程与状态机
- 题型识别与作答策略
- 安全边界
- 已知限制与开发入口

设计基线、SDK、包格式等通用内容仍放在上级 `docs/`；这里按平台拆分，方便后续扩展新平台。

## 平台索引

| 平台 | 接入方式 | 模块包 | 实现文档 |
| --- | --- | --- | --- |
| U校园 | 浏览器扩展 + 本地中继 + 页面 Agent | `packages/src/ucampus` | [ucampus/README.md](ucampus/README.md) |
| 智慧树 | 浏览器扩展 + 本地中继 + 页面 Agent | `packages/src/wisdomtree` | [wisdomtree/README.md](wisdomtree/README.md) |

## 文档约定

状态标记：

- ✅ 已实现并验证
- ⚠️ 已实现但有限制，或依赖外部能力
- 🧭 已设计、代码在改，尚未完成验证
- ❌ 未支持

每个平台至少包含：

```text
<platform>/
  README.md              实现总览、文件地图、安全边界
  page-structure.md      页面层级与导航（网页平台）
  question-types.md      题型矩阵（网页平台）
  automation-flow.md     自动化状态机与续跑策略
```

手机平台如果页面结构由运行时控件树决定，可只写 `README.md` + `automation-flow.md`，不必硬编码页面结构。

## 新增平台

1. 新建 `docs/mods/<platform>/`。
2. 写清传输层：浏览器中继 / ADB / 其它。
3. 写清页面层级、题型、提交边界。
4. 在 `packages/src/<platform>/` 建模块包，manifest 使用 `type: module`。
5. 在本索引表登记。
6. 至少补一个 fake 传输层测试；真实页面验证单独记录。

## 安全总则

所有平台统一遵守：

- 不自动点击“提交 / 交卷 / 发布 / 评分提交 / 结束”。
- 答案只填入页面，停在不可逆操作前。
- 用户手动提交后，才允许进入下一模块并继续自动作答。
- 不绕过验证码、风控或登录限制。
- 保存用于开发的不支持页面时，注意个人信息脱敏。

---

## License / 许可

Copyright (C) 2026 qincnd <qincnd@qq.com>, XueZicheng <xuezicheng842@outlook.com>, AstercoreTeam.

This project is licensed under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`).
See [https://spdx.org/licenses/AGPL-3.0-only.html](https://spdx.org/licenses/AGPL-3.0-only.html).

