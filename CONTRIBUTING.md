# 贡献指南

感谢你愿意为 FreeOCS 做出贡献。

FreeOCS 是一个本地优先、插件化的学习助手。提交代码、文档、测试或插件包前，请先阅读本指南。

## 许可

本项目使用 **GNU Affero General Public License v3.0 only（AGPL-3.0-only）**。

提交贡献即表示你同意：

- 你的贡献以 AGPL-3.0-only 授权
- 你有权提交这些代码/文档
- 保留原作者的版权声明
- 不引入与 AGPL-3.0-only 不兼容的代码或资源

完整协议见 [LICENSE](LICENSE)。

## 开发环境

- Python 3.12
- Linux 优先；Windows 保留兼容层
- `uv` 管理虚拟环境（推荐）

```bash
cd FreeOCS
uv venv --python /usr/bin/python3.12 .venv
export UV_CACHE_DIR="$PWD/.uv-cache"
uv pip install --python .venv/bin/python -r requirements.txt
uv pip install --python .venv/bin/python -e ".[dev]"
```

Linux 桌面还需要：

```bash
# Debian/Ubuntu 示例
sudo apt install gir1.2-gtk-3.0 gir1.2-webkit2-4.1 ffmpeg
```

## 运行

```bash
# 源码包模式（推荐开发时使用）
FREEOCS_PACKAGES=source .venv/bin/python main.py --dev
```

首次启动会显示 AGPL-3.0-only 协议确认窗口。

## 目录约定

```text
freeocs/              框架核心：配置、服务、能力、模块宿主
web/                  pywebview 前端
packages/src/         内置插件和平台模块源码
extension/            浏览器扩展
scripts/              构建、E2E、UI smoke
tests/                单元/集成测试
docs/                 架构、平台、插件文档
```

新增平台模块或插件时：

- 平台文档放 `docs/mods/<platform>/`
- 插件文档放 `docs/plugins/<plugin>/`
- 在对应 `README.md` 索引中登记
- 不把平台专属逻辑写进浏览器扩展或框架核心

## 代码规范

```bash
.venv/bin/ruff check freeocs main.py packages/src tests scripts
.venv/bin/python -m pytest -q
node --check web/js/app.js
node --check packages/src/ucampus/web/page-agent.js
```

要求：

- 不引入自动提交、自动交卷、自动发布逻辑
- 页面 Agent 保持模块内聚，扩展只做通用传输
- 新能力使用 `PackageContext` / SDK，不直接依赖框架内部对象
- 不在日志中输出 API Key、参考答案以外的隐私数据
- 新增题型/页面适配必须补 fixture 或明确记录未验证项

## 源码头

所有源代码文件应带：

```text
Copyright 2026 AstercoreTeam
Copyright 2026 qincnd <qincnd@qq.com>
Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
SPDX-License-Identifier: AGPL-3.0-only
```

可使用 `addlicense` 和自定义头文件批量补充：

```bash
cat > /tmp/freeocs-header.txt <<'EOF'
Copyright 2026 AstercoreTeam
Copyright 2026 qincnd <qincnd@qq.com>
Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
SPDX-License-Identifier: AGPL-3.0-only
EOF

addlicense -f /tmp/freeocs-header.txt -y 2026 \
  -ignore '**/*.md' -ignore '**/*.json' -ignore '**/vendor/**' \
  -ignore '**/dist/**' -ignore '**/__pycache__/**' \
  freeocs packages/src web/js web/css web/pages scripts tests main.py extension/shared
```

## 测试

```bash
.venv/bin/python -m pytest -q
.venv/bin/python scripts/build_packages.py
PLAYWRIGHT_BROWSERS_PATH=$PWD/.playwright \
  FREEOCS_PACKAGES=source DISPLAY=:0 \
  .venv/bin/python scripts/e2e_ucampus.py
```

UI smoke：

```bash
DISPLAY=:0 .venv/bin/python scripts/smoke_ui.py
```

## 文档

- 文档使用简体中文
- 不引用任何外部参考项目、私有路径或第三方项目源码
- 需要说明依赖时，只写包名、用途、协议
- 架构变更先更新 `docs/09-decisions.md`
- 文档与代码不一致时，先修文档再改代码

## 提交 PR

请包含：

1. 变更目的
2. 影响的平台/插件
3. 测试命令与结果
4. 未验证项（尤其是真实 U校园/智慧树页面）
5. 是否涉及自动提交边界

不要提交：

- API Key、Cookie、参考资料、答题截图中的个人信息
- `.venv/`、缓存、`dist/`、构建产物
- 未确认授权的第三方代码/模型

## 行为准则

- 尊重其他贡献者
- 不协助绕过验证码、风控或付费限制
- 不把自动化用于违反平台条款的场景
- 对不可逆操作保持最高警惕
