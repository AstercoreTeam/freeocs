# 02 包格式（插件 / 模块）

## 1. 设计目标

- 插件和应用模块使用**同一种 zip 包格式**，可以独立开发、独立构建、独立安装。
- 包内是 Python 代码，主程序在进程内加载；不要求单独进程或 RPC。
- 包的 manifest 是唯一事实来源；框架不读取包内任意 Python 代码来决定依赖。
- 安装前可静态校验：路径、manifest、API 版本、能力依赖、Python 依赖。
- 内置包与外部包走同一套加载/生命周期，避免“两套机制”。

## 2. 包类型

| `type` | 含义 | 出现在“应用”页 | 可提供能力 | 可有页面 Agent / 面板 |
| --- | --- | --- | --- | --- |
| `plugin` | 能力插件（LLM、ASR、OCR、TTS 等） | 否（在“插件”页） | 是 | 否 |
| `module` | 应用模块（U校园、智慧树等） | 是 | 可选 | 是 |
| `bundle` | 既是模块又提供能力 | 是 | 是 | 是 |

v1 内置包建议：

| 包 ID | 类型 | provides | requires |
| --- | --- | --- | --- |
| `llm_openai` | plugin | `llm.chat` | — |
| `answer_basic` | plugin | `answer.choice` | `llm.chat` |
| `asr_whisper` | plugin | `media.asr` | — |
| `asr_openai` | plugin | `media.asr` | — |
| `ocr_rapid` | plugin | `media.ocr` | — |
| `tts_system` | plugin | `media.tts` | — |
| `tts_openai` | plugin | `media.tts` | — |
| `ucampus` | module | — | `llm.chat`, `media.asr`, `media.tts`, `web.bridge` |
| `wisdomtree` | module | — | `llm.chat`, `web.bridge` |

## 3. zip 目录结构

zip 根目录直接放 `manifest.json`，不要多套一层目录。

```text
<package>.focpkg  (zip)
├── manifest.json
├── backend/
│   ├── __init__.py
│   ├── main.py               # 入口，manifest.entry = "main:setup"
│   ├── module.py             # 可选：模块实现
│   ├── readers/              # 可选：Android 页面解析器
│   └── ...
├── web/                      # 可选：面板与页面 Agent 资源
│   ├── panel.js
│   ├── panel.css
│   └── page-agent.js
├── requirements.txt          # 可选；与 manifest.dependencies 保持一致
├── README.md                 # 面向使用者
├── LICENSE
└── icon.png                  # 可选，应用页图标（建议 128x128 PNG）
```

规则：

- 文件路径必须是相对路径；禁止绝对路径、`..`、符号链接、设备文件。
- zip 解压后总大小默认上限 200 MB（模型文件不应打进包内）。
- `backend/__init__.py` 必须存在；包内导入使用相对导入（`from .module import ...`）。
- 不要用 `backend` 作为硬编码包名；加载器会为每个包创建独立的模块命名空间。
- 静态资源统一放 `web/`；后端不要依赖包外的相对路径。
- 包的运行时数据写入 `ctx.data_dir`，不要写进包目录（包目录可能只读/被替换）。

## 4. manifest.json

### 4.1 完整示例：模块

```json
{
  "schema_version": 1,
  "api_version": 1,
  "id": "ucampus",
  "name": "U校园",
  "version": "1.0.0",
  "type": "module",
  "description": "U校园网页自动学习：识别题目、听力转写、作答与回填，不自动提交。",
  "author": "FreeOCS",
  "license": "AGPL-3.0-only",
  "homepage": "",
  "icon": "icon.png",
  "entry": "main:setup",
  "platform": "web",
  "requires": ["llm.chat", "media.asr", "media.tts", "web.bridge"],
  "optional_requires": ["answer.choice"],
  "provides": {},
  "dependencies": [],
  "min_app_version": "0.2.0",
  "web": {
    "allowed_hosts": ["*.unipus.cn", "unipus.cn"]
  },
  "page_agents": [
    {
      "id": "ucampus",
      "matches": ["*://*.unipus.cn/*"],
      "entry": "web/page-agent.js"
    }
  ],
  "panels": [
    {
      "id": "console",
      "title": "运行状态",
      "entry": "web/panel.js",
      "styles": ["web/panel.css"]
    }
  ],
  "settings": []
}
```

### 4.2 完整示例：插件

```json
{
  "schema_version": 1,
  "api_version": 1,
  "id": "tts_system",
  "name": "系统语音合成",
  "version": "1.0.0",
  "type": "plugin",
  "description": "使用操作系统自带 TTS 引擎生成 WAV，离线可用。",
  "author": "FreeOCS",
  "license": "AGPL-3.0-only",
  "entry": "main:setup",
  "platform": "any",
  "requires": [],
  "provides": {
    "media.tts": {
      "version": 1,
      "title": "系统语音",
      "description": "pyttsx3 / SAPI5 / espeak-ng"
    }
  },
  "dependencies": ["pyttsx3>=2.90,<3"],
  "settings": [
    {
      "id": "tts_system",
      "title": "系统语音",
      "order": 210,
      "fields": [
        {
          "key": "voice",
          "type": "text",
          "label": "语音 ID",
          "default": "",
          "placeholder": "留空使用系统默认语音",
          "help": "Linux 可用 espeak-ng 的语音名，Windows 可用 SAPI 语音名。"
        }
      ]
    }
  ]
}
```

### 4.3 字段说明

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `schema_version` | int | 是 | manifest 结构版本，v1 固定为 `1` |
| `api_version` | int | 是 | SDK/加载器契约版本，v1 固定为 `1` |
| `id` | string | 是 | 唯一包 ID；`^[a-z][a-z0-9_-]{1,63}$`；不可与内置包冲突 |
| `name` | string | 是 | 显示名，可中文 |
| `version` | string | 是 | 语义化版本，例如 `1.2.0` |
| `type` | string | 是 | `plugin` / `module` / `bundle` |
| `description` | string | 是 | 一句话说明 |
| `author` | string | 否 | 作者/组织 |
| `license` | string | 否 | SPDX 标识 |
| `homepage` | string | 否 | 项目主页 |
| `icon` | string | 否 | 包内相对路径，PNG |
| `entry` | string | 是 | `模块路径:属性名`，相对于 `backend/`；必须可调用 |
| `platform` | string | 否 | `any`（默认）/ `web` / `android` |
| `requires` | string[] | 否 | 必需能力 ID；缺失则包不可用 |
| `optional_requires` | string[] | 否 | 可选能力；缺失不阻止加载，但运行时应处理 |
| `provides` | object | 否 | 能力 ID → `{version,title,description}`；运行时必须实际注册 |
| `dependencies` | string[] | 否 | PEP 508 Python 依赖；安装时展示，不自动静默安装 |
| `min_app_version` | string | 否 | 最低 FreeOCS 版本 |
| `web.allowed_hosts` | string[] | 否 | 页面 Agent 允许的站点；用于本地 API 的 Origin 校验，支持 `*` 前缀 |
| `page_agents` | object[] | 否 | 页面 Agent 列表（仅 module/bundle） |
| `panels` | object[] | 否 | 模块面板列表（仅 module/bundle） |
| `settings` | object[] | 否 | 静态设置 section；也可运行时注册 |

#### page_agents 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 包内唯一 |
| `matches` | 是 | Chrome match pattern 风格，如 `*://*.unipus.cn/*`；用于匹配页面 URL |
| `entry` | 是 | 包内 `web/` 下的 JS 文件 |
| `run_at` | 否 | `document_start`（默认）/ `document_idle` |

页面 Agent 只在模块启用时被下发；是否真正执行由 Agent 自己检查模块状态决定。

#### panels 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 模块内唯一 |
| `title` | 是 | Tab 标题 |
| `entry` | 是 | 面板 JS，需调用 `window.FreeOCS.registerPanel(...)` |
| `styles` | 否 | CSS 文件列表 |
| `order` | 否 | 排序，数字小的在前 |

## 5. 入口与生命周期契约

### 5.1 入口

`entry: "main:setup"` 表示：

1. 加载器把包内 `backend/` 作为一个独立 Python 包导入。
2. 导入 `backend/main.py`。
3. 调用该模块的 `setup(api)` 函数，`api` 是 `PackageContext`。

```python
# backend/main.py
from freeocs.sdk import PackageContext

def setup(api: PackageContext) -> None:
    if api.type == "plugin":
        api.provide("media.tts", SystemTTS(api))
        api.register_settings(SETTINGS)
    elif api.type == "module":
        api.register_module(UcampusModule(api))
    else:
        raise RuntimeError("请按 type 分别实现")
```

### 5.2 `setup` 的约束

- 必须快速返回（< 2 秒），不要在这里做网络请求、模型加载、ADB 连接。
- 不要启动线程；模块在 `start()` 中启动工作线程。
- `provide` 必须在 `setup` 内完成，且与 manifest 的 `provides` 完全一致。
- `register_settings` 可以在 `setup` 内调用；也可在模块启动后调用（不推荐动态变更）。
- 抛异常会被框架捕获，包标记为加载失败，不影响其他包。

### 5.3 插件生命周期

| 阶段 | 调用 |
| --- | --- |
| 加载 | `setup(api)` → `api.provide(...)`、`api.register_settings(...)` |
| 配置变化 | 提供者对象可选实现 `on_settings_changed(values: dict)` |
| 框架关闭 | 可选实现 `close()` |
| 启用/禁用 | 禁用后提供者从注册表移除；运行中的模块应失败并提示 |

### 5.4 模块生命周期

见 `03-capability-sdk.md`。模块由 `api.register_module(module)` 注册，框架在“应用”页展示。

## 6. 能力声明与解析

### 6.1 能力 ID

- 小写点分字符串：`llm.chat`、`answer.choice`、`media.asr`、`media.ocr`、`media.tts`。
- 核心能力：`web.bridge`、`android.adb`。
- 未来可扩展：`storage.kv`、`notify.desktop`、`media.vision`。

v1 **不解析版本约束**；`provides[cap].version` 仅用于展示。`api_version` 用于整体兼容性。未来如需 `requires: ["media.asr>=2"]`，在提升 `api_version` 时引入。

### 6.2 解析规则

1. 汇总所有已加载包的 `provides` 与核心能力。
2. 对每个包检查 `requires` 是否全部存在；缺失则包状态为 `unavailable`，记录 `missing`。
3. 同一能力有多个提供者时：
   - 若设置 `capabilities.<cap>` 指定了包 ID，使用它。
   - 否则使用“第一个已启用且内置优先”的提供者，并在设置页标注“自动选择”。
   - 提供者被禁用/卸载时回退；若没有可用提供者，依赖包变为不可用。
4. `optional_requires` 缺失不阻止加载；模块必须在运行时优雅降级（例如没有 OCR 时只使用控件树）。

### 6.3 运行时注册校验

- `api.provide(cap, provider)` 的 `cap` 必须在 manifest `provides` 中声明，否则抛 `PackageError`。
- `provider` 必须实现该能力的必需方法；框架用 `hasattr` 做最小校验。
- 同一包内重复提供同一能力报错。
- 注册表中保留提供者元数据（包 ID、版本、标题）用于设置页展示。

## 7. 设置声明

### 7.1 静态声明（manifest.settings）

字段定义与 `03-capability-sdk.md` 的 schema 一致。包 ID 自动作为设置命名空间：

```json
{
  "settings": [
    {
      "id": "wisdomtree",
      "title": "智慧树",
      "order": 300,
      "fields": [
        {
          "key": "click_jitter",
          "type": "number",
          "label": "点击随机偏移（像素）",
          "default": 2,
          "min": 0,
          "max": 20,
          "step": 1
        }
      ]
    }
  ]
}
```

值保存在 `settings.json` 的：

```json
{
  "packages": {
    "wisdomtree": {
      "click_jitter": 2
    }
  }
}
```

### 7.2 运行时注册

```python
api.register_settings({
    "id": "ucampus",
    "title": "U校园",
    "order": 300,
    "fields": [...]
})
```

规则：

- 一个包可以注册多个 section；`id` 在全局唯一，建议以包 ID 为前缀。
- `id` 冲突时后注册者失败并记录错误。
- 设置值按 section 所属包隔离，模块不能读写其他包的设置。
- 密码字段在 UI 中只显示“已配置”，保存空值表示保留原值。

## 8. Python 依赖

### 8.1 声明

- 优先使用 `manifest.dependencies`（PEP 508 列表）。
- `requirements.txt` 仅作为人类可读的镜像；安装器以 manifest 为准。
- 内置包的重依赖放在 `pyproject.toml` 的可选 extra 中，构建时按需包含；外部包由用户确认安装。

### 8.2 安装流程

1. 安装预览列出依赖。
2. 用户勾选“允许安装依赖”（默认不勾选，或明确提示）。
3. 使用当前解释器执行：
   ```text
   <sys.executable> -m pip install --disable-pip-version-check --no-input <deps...>
   ```
4. 超时 10 分钟；输出写入安装日志；失败则中止，不启用包。
5. 安装成功后记录 `dependencies_installed` 与时间，便于诊断。
6. 卸载包**不自动卸载** Python 依赖（可能被其他包使用）。

### 8.3 安全提示

- 依赖安装会执行包作者的构建脚本；安装界面必须明确警告。
- v1 不支持私有 index 配置；如需，用户在外部自行配置 pip。

## 9. 安装、更新、卸载

### 9.1 目录

```text
<data>/packages/
├── registry.json              # 已安装包索引
├── ucampus/
│   ├── 1.0.0/                 # 解压后的包内容
│   │   ├── manifest.json
│   │   ├── backend/
│   │   └── web/
│   └── current                # 文本文件，内容为当前版本号
└── ...
```

- `current` 用文本文件而不是符号链接，兼容 Windows。
- 每个版本独立目录，便于回滚。
- 安装/更新使用 `<id>/.staging-<uuid>/`，校验通过后原子重命名。

### 9.2 安装步骤

1. 用户选择 `.focpkg` / `.zip`。
2. 校验：
   - 是合法 zip；条目数 < 5000；解压后 < 200 MB。
   - 无绝对路径、`..`、符号链接、可执行位异常。
   - `manifest.json` 存在且 JSON 合法。
   - `schema_version`/`api_version` 支持。
   - `id` 合法；同 ID 已安装时比较版本（禁止降级，除非显式确认）。
   - `entry` 文件存在；`page_agents`/`panels` 的 entry 存在。
   - `provides`/`requires` 语法合法；计算安装后的依赖是否可满足（警告而非硬阻止）。
3. 展示摘要与风险确认。
4. 可选安装依赖。
5. 解压到 staging；再次校验文件 hash；替换 `current`。
6. 更新 `registry.json`；UI 提示重启。
7. 失败：删除 staging，保留旧版本，错误写入日志。

### 9.3 更新

- 同一 ID、更高版本：保留旧版本目录，更新 `current`；设置值保留。
- 数据目录 `<data>/package-data/<id>/` 保留，不随版本删除。
- 更新后需要重启（v1）。

### 9.4 卸载

- 只能卸载外部包；内置包只能禁用。
- 移除 `<data>/packages/<id>/` 与 `registry.json` 条目。
- 询问是否保留 `<data>/package-data/<id>/` 与设置；默认保留设置。
- 不自动卸载 Python 依赖。

## 10. 加载器实现要点

### 10.1 独立命名空间

不要把所有包的 `backend` 都放进 `sys.path`，否则包名冲突。加载器为每个包创建唯一模块名：

```python
import importlib.util
import sys
from pathlib import Path

def load_backend(package_id: str, backend_dir: Path):
    module_name = f"freeocs_pkg_{package_id}"
    init_file = backend_dir / "__init__.py"
    spec = importlib.util.spec_from_file_location(
        module_name,
        init_file,
        submodule_search_locations=[str(backend_dir)],
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module
```

入口解析：

```python
entry_module, _, attr = manifest["entry"].partition(":")
module = importlib.import_module(f"freeocs_pkg_{package_id}.{entry_module}")
setup = getattr(module, attr)
setup(context)
```

注意：

- 包内相对导入正常；绝对导入 `import backend.xxx` 不可用。
- 同名包不会互相覆盖。
- 运行中卸载不删除 `sys.modules` 条目；因此 v1 要求重启生效。

### 10.2 加载顺序

1. 先加载所有 `plugin`，再加载 `bundle`，最后 `module`。
2. 同一类型按 `id` 排序；`setup` 内部不得假设其他包已加载。
3. 所有 `setup` 完成后，统一做依赖解析与绑定。
4. 失败包记录 `load_error`，继续加载其他包。

### 10.3 只读与路径

- 内置包源码目录在开发模式下只读加载。
- 外部包解压目录对进程可写，但约定不写入；运行时数据走 `ctx.data_dir`。
- 包内静态资源通过 `ctx.asset_url("panel.js")` 生成 `http://127.0.0.1:<port>/packages/<id>/<version>/web/panel.js`。

## 11. 版本与兼容

- `schema_version` 变化：manifest 结构不兼容，旧应用拒绝加载。
- `api_version` 变化：SDK 接口不兼容，旧应用拒绝加载。
- 包 `version` 使用 SemVer；框架不解析语义，只用于展示/更新比较。
- 应用版本 `< min_app_version` 时拒绝启用，并提示升级。
- 向后兼容原则：新增 manifest 字段可选；新增能力 ID 不破坏旧包；删除/改名能力必须提升 `api_version`。

## 12. 校验错误码（建议）

| 错误码 | 含义 |
| --- | --- |
| `PKG_ZIP_INVALID` | 不是合法 zip / 解压失败 |
| `PKG_PATH_UNSAFE` | 路径穿越、绝对路径、符号链接 |
| `PKG_TOO_LARGE` | 超过大小/条目限制 |
| `PKG_MANIFEST_MISSING` | 缺少 manifest.json |
| `PKG_MANIFEST_INVALID` | 字段缺失/类型错误 |
| `PKG_API_UNSUPPORTED` | api_version/schema_version 不支持 |
| `PKG_ID_CONFLICT` | ID 已存在且不允许覆盖 |
| `PKG_ENTRY_MISSING` | entry 文件不存在 |
| `PKG_DEP_MISSING` | 必需能力缺失（安装后警告） |
| `PKG_LOAD_FAILED` | setup 抛异常 |
| `PKG_DEP_INSTALL_FAILED` | pip 安装失败 |

UI 应展示错误码 + 人类可读说明 + 日志路径。

## 13. 开发与构建

### 13.1 从源码构建 zip

```bash
python scripts/build_packages.py            # 构建全部
python scripts/build_packages.py ucampus    # 只构建一个
```

脚本行为：

1. 读取 `packages/src/<id>/manifest.json`。
2. 校验 manifest。
3. 收集 `manifest.json`、`backend/`、`web/`、`README.md`、`LICENSE`、`icon.png`、`requirements.txt`。
4. 排除 `__pycache__`、`.pyc`、`.venv`、测试数据、`.DS_Store`。
5. 输出 `packages/dist/<id>-<version>.focpkg`（zip，deflate）。
6. 打印 SHA256 与文件大小。

### 13.2 开发模式

- 设置环境变量 `FREEOCS_PACKAGES=source` 或使用 `--dev` 启动，直接加载 `packages/src/<id>/`，改代码后重启应用即可，无需每次打包。
- 发布/测试安装流程时使用 `FREEOCS_PACKAGES=dist`，强制走 zip 加载路径。

### 13.3 最小模块模板

```text
my_module/
├── manifest.json
├── backend/
│   ├── __init__.py
│   └── main.py
├── web/
│   └── panel.js
└── README.md
```

`backend/main.py`：

```python
from freeocs.sdk import Module, ModuleContext

class MyModule(Module):
    id = "my_module"
    name = "我的应用"

    def start(self) -> None:
        self.ctx.log("info", "开始")

    def stop(self) -> None:
        pass

    def status(self) -> dict:
        return {"running": False, "message": "空闲"}

def setup(api: ModuleContext) -> None:
    api.register_module(MyModule(api))
```

完整契约见 `03-capability-sdk.md`。
