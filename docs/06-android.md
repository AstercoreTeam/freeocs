# 06 Android / ADB 传输层

> 现状：FreeOCS 保留通用 ADB 传输能力，但当前内置模块不使用 Android 自动化。智慧树已迁移到浏览器扩展，见[智慧树模块实现](mods/wisdomtree/README.md)。以下内容是供未来 Android 模块参考的传输设计，不代表智慧树当前实现。

## 1. 目标

Android 模块可通过 ADB 完成：

1. 发现并选择一台已授权的 Android 设备。
2. 读取当前页面的控件树（`uiautomator dump`），解析题型、题干、选项、按钮及精确坐标。
3. 通过 `adb shell input tap` 等命令操作页面。
4. 控件树不可用时，用截图 + OCR 兜底（文字与坐标）。
5. 检测到提交/交卷页面时**停止，不点击**。

不依赖 adbutils、Appium、scrcpy；只调用 `adb` 可执行文件，便于打包和跨平台。

## 2. 设备管理

### 2.1 发现设备

```bash
adb devices -l
```

输出示例：

```text
List of devices attached
R58M1234567            device product:beyond1q model:SM_G9730 device:beyond1 transport_id:2
192.168.1.20:5555      device product:... transport_id:3
```

解析为：

```json
[
  {
    "serial": "R58M1234567",
    "state": "device",
    "model": "SM_G9730",
    "product": "beyond1q",
    "device": "beyond1",
    "transport_id": "2"
  }
]
```

状态处理：

| state | 含义 | UI 行为 |
| --- | --- | --- |
| `device` | 已授权可用 | 可选 |
| `unauthorized` | 未授权 | 提示在手机上点“允许 USB 调试” |
| `offline` | 离线 | 提示重插/重启 adb |
| `no permissions` | udev 权限问题 | Linux 提示配置 udev 规则 |

### 2.2 选择设备

- 设置 `android.device_serial` 为空时：要求恰好一台 `device`；0 台或多台都报错并列出设备。
- 指定 serial 时：使用 `adb -s <serial>`。
- v1 同时只操作一台设备；UI 可刷新/切换。
- 无线调试：
  - Android 11+：`adb pair <ip:port>` 输入配对码，再 `adb connect <ip:port>`。
  - 旧版：`adb tcpip 5555` + `adb connect <ip>:5555`。
  - 指南页给出命令模板，不自动执行。

### 2.3 adb 路径

- 设置 `android.adb_path` 为空：使用 `PATH` 中的 `adb`。
- Windows 发布包可携带 `tools/adb.exe` 及 DLL；框架优先使用设置路径，其次包内路径，最后 PATH。
- 启动时检测 `adb version`；失败在设置页/模块页提示。

## 3. ADB 封装

### 3.1 命令执行

```python
subprocess.run(
    [adb_path, "-s", serial, "shell", command],
    capture_output=True,
    timeout=timeout,
    check=False,
)
```

规则：

- 永远传列表，不拼接 shell 字符串（避免注入/引号问题）。
- stdout/stderr 用 `utf-8`，失败再用 `latin-1` 容错。
- 退出码非 0 抛 `AdbError(command, returncode, stderr)`。
- 所有命令有超时；超时 kill 进程并抛错。
- 连续失败 3 次标记设备离线，提示重新连接。
- 不自动执行 `adb kill-server`（可能影响用户其他工具）。

### 3.2 屏幕尺寸

```bash
adb shell wm size
# Physical size: 1080x2340
# Override size: 1080x2160
```

优先使用 `Override size`（如果存在），否则 `Physical size`。缓存结果，旋转时重新获取。

### 3.3 控件树

```bash
adb shell uiautomator dump /sdcard/window_dump.xml
adb shell cat /sdcard/window_dump.xml
```

注意：

- 部分设备 dump 到 `/sdcard` 失败，回退 `/data/local/tmp/window_dump.xml`。
- 页面动画/加载中会报 `could not get idle state`；等待 0.3–1s 重试，最多 3 次。
- 输出可能混入 `UI hierchary dumped to: ...` 提示；只取 `<hierarchy ...>` 到 `</hierarchy>`。
- XML 可能含非法控制字符；解析前过滤。
- 单次 dump 约 0.5–2 秒，不要在高频循环中无节制调用。

### 3.4 截图

```bash
adb exec-out screencap -p
```

- 返回 PNG 字节；校验 `\x89PNG\r\n\x1a\n`。
- 大屏幕截图 2–8 MB；不要频繁保存到磁盘，OCR 后即丢弃（除非调试开关）。
- 某些设备 `exec-out` 不支持，回退：
  ```bash
  adb shell screencap -p /sdcard/screen.png
  adb pull /sdcard/screen.png <tmp>
  ```

### 3.5 输入

| 操作 | 命令 | 说明 |
| --- | --- | --- |
| 点击 | `input tap x y` | 坐标取整；带随机偏移 |
| 滑动 | `input swipe x1 y1 x2 y2 duration` | 毫秒 |
| 返回 | `input keyevent 4` | KEYCODE_BACK |
| 主页 | `input keyevent 3` | KEYCODE_HOME |
| 文本 | `input text <escaped>` | 仅 ASCII；空格用 `%s` |
| 中文 | ADBKeyboard 广播 | 需用户安装 ADBKeyboard |

点击策略：

- 默认在半径 `click_jitter` 像素内随机偏移（默认 2px），并限制在屏幕内。
- 点击后等待 0.3–1.0 秒再 dump；不同页面可配置。
- 不点击屏幕外坐标；bounds 中心点越界时跳过并记录。

中文输入（可选）：

```bash
# 安装 ADBKeyboard 并设为默认输入法后
adb shell am broadcast -a ADB_INPUT_TEXT --es msg '中文内容'
# 或 base64 变体（不同版本）
adb shell am broadcast -a ADB_INPUT_B64 --es msg '<base64>'
```

AndroidKeyboard 可用于需要输入中文的模块；该能力目前不是智慧树模块的实现路径。

## 4. 控件树解析

### 4.1 数据结构

```python
@dataclass
class Option:
    text: str
    x: int
    y: int
    raw_id: str = ""

@dataclass
class Button:
    text: str
    x: int
    y: int

@dataclass
class PageData:
    page_type: str = "unknown"
    question: str = ""
    question_type: str = ""
    options: list[Option] = field(default_factory=list)
    buttons: list[Button] = field(default_factory=list)
    screen_width: int = 0
    screen_height: int = 0
    raw_text: str = ""

    def signature(self) -> str: ...
```

坐标来自 `bounds="[x1,y1][x2,y2]"` 的中心：

```python
x = (x1 + x2) // 2
y = (y1 + y2) // 2
```

### 4.2 Reader 注册

Reader 属于**模块**，不属于框架核心；核心只提供 XML。

```python
class PageReader:
    name: str

    def can_handle(self, root) -> bool:
        """根据 package/resource-id/文本判断是否本页面。"""

    def parse(self, root, screen_width: int, screen_height: int) -> PageData:
        ...
```

模块内部维护 registry：

```python
readers = [ExampleReader()]
reader = next((r for r in readers if r.can_handle(root)), None)
```

### 4.3 通用解析技巧

- 过滤空文本与 WebView 占位：`undefined`、`null`、`NaN`、`true`、`false`。
- 选项通常满足 `^[A-Za-z][.、)．]?\s*(.+)$`；正文过长（>100 字）可能是题干，排除。
- WebView 中选项的 `clickable` 常为 `false`，不能只从 `clickable=true` 的节点找选项。
- 按钮用文本关键词：`下一题`、`上一题`、`提交`、`交卷`、`完成`、`答题卡`、`继续`。
- 题干：取选项上方、非按钮/题型/题号的 `TextView`，按 y 排序拼接。
- 题号（`1/10`）单独过滤。
- 题目签名用于去重：题干 + 题型 + 选项 + 按钮；页面无变化时避免重复点击。

### 4.4 模块专用解析器

解析器由具体 Android 模块实现。当前智慧树模块面向网页，不提供 Android Reader；未来新增 Android 模块时，应基于其目标应用的控件树编写独立 Reader。

## 5. Agent 设计参考

本节是未来 Android 模块的设计参考，不对应当前内置智慧树模块；智慧树使用浏览器页面 Agent 和普通 `llm.chat` 调用。

### 5.1 工具

| 工具 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `read_page` | 无 | `{question_type, question, options, buttons}` | dump + 解析；不返回坐标 |
| `click_option` | `option_text` | `{ok, clicked}` | 按文本精确/包含匹配；本地计算坐标 |
| `click_next` | 无 | `{ok, button, finished}` | 提交类按钮返回 `finished=true`，**不点击** |
| `finish` | `reason` | `{ok}` | 结束 |

### 5.2 循环

```text
system prompt（手机答题助手）
user: 开始答题，请先 read_page
assistant: tool_call read_page
tool: 题目/选项/按钮
assistant: tool_call click_option("B ...")
tool: ok
assistant: tool_call click_next
tool: ok, finished=false
... 重复 ...
检测到提交/交卷 → click_next 返回 finished=true → Agent 停止
```

- 每次点击后重新 `read_page` 确认页面变化。
- 防止无限循环：`max_tool_rounds` 默认 30；同一页面签名重复 3 次则停止。
- 进入下一题后清空旧上下文（保留 system + 本轮工具链），降低 token。
- 模型不支持 function calling 时，启动前提示（可发一次带 tools 的探测请求）。

### 5.3 不提交

- `click_next` 只点击 `下一题/下一步/继续`。
- 按钮文本包含 `提交/交卷/完成/结束` 时返回 `finished=true`，不点击。
- 若页面出现“确定提交/确认交卷”弹窗，停止并通过 UI 提示用户。
- 不点击“答题卡”等可能触发提交的控件。
- 记录“等待手动提交”状态，模块 `running=false`。

## 6. OCR 兜底参考

### 6.1 触发条件

- 控件树 dump 失败/为空。
- Reader 匹配不到，或 `PageData` 既无题干也无选项。
- 设置 `android.ocr_fallback=true`。
- 设备性能允许（截图 + OCR 约 1–5 秒）。

### 6.2 流程

```text
screenshot (PNG)
  → ctx.require("media.ocr").extract(png)
  → OCRResult(text, blocks)
  → 模块构造题干/选项（可按行、按字母前缀）
  → 调 llm.chat 得到答案
  → 在 blocks 中找匹配选项文本的框
  → 计算中心点 → tap
  → 重新截图确认
```

注意：

- OCR 没有控件语义，选项/题干分割容易出错；只在兜底时使用。
- 匹配不到选项文本或置信度低 → 停止并上报，不猜测点击。
- OCR box 是截图像素坐标；与 `input tap` 坐标系一致（全屏截图）。
- 若截图包含状态栏/导航栏，坐标仍是全屏坐标，不要减去偏移。
- OCR 结果可用于“只显示文字给模型”，但点击必须能定位。

### 6.3 可选：视觉模型

未来可增加 `media.vision` 能力，直接把截图交给多模态模型返回选项/坐标；v1 不做。

## 7. 线程、超时与停止参考

- 模块工作线程执行 Agent 循环；每步检查 `stop_event`。
- 单步超时：
  - dump 15s；截图 20s；tap 5s；LLM 300s。
- 网络/模型失败：重试 1 次（可配置），仍失败则停止。
- 停止时：
  - 设置事件；当前 `subprocess.run` 等待超时或 kill。
  - 不再发起新的点击。
  - 状态置为 `idle`，消息“已停止”。

## 8. 设置项示例（模块）

| key | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `device_serial` | text | 空 | 留空自动选择唯一设备 |
| `click_jitter` | integer | 2 | 点击随机偏移像素 |
| `dump_timeout` | number | 15 | 秒 |
| `screenshot_timeout` | number | 20 | 秒 |
| `page_load_timeout` | number | 8 | 等待页面稳定 |
| `poll_interval` | number | 0.8 | 每次操作后等待 |
| `max_tool_rounds` | integer | 30 | 防循环 |
| `ocr_fallback` | boolean | true | 控件树失败时启用 OCR |
| `temperature` | number | 0.0 | 模型温度 |
| `interval_min` / `interval_max` | number | 0.2 / 0.6 | 操作间随机等待（秒） |

这些是未来 Android 模块的设置示例。全局 `android.*` 设置（adb 路径、默认设备、点击偏移等）由框架提供；模块设置可覆盖/补充。

## 9. 测试策略参考

### 9.1 无设备单测

- 固定 XML fixtures：
  - 单选题、多选题、判断题、无选项页、提交页、WebView 占位文本。
- 断言：题型、题干、选项文本/坐标、按钮、`finished` 判定。
- 非法 XML/截断 XML 不崩溃。

### 9.2 假 ADB

- 实现一个 `FakeAdbDevice`：
  - 按脚本依次返回 XML/截图。
  - 记录 `tap`/`swipe` 调用。
- 注入到模块，验证：
  - 点击坐标正确。
  - 提交页不点击。
  - 重复页面签名停止。

### 9.3 真机手动清单

- USB 授权/未授权/离线。
- 竖屏/横屏/刘海屏坐标。
- 题目加载慢、动画中 dump 失败重试。
- 多选/不定项。
- 交卷页停止。
- 断开数据线后错误提示。
- 无线 ADB。

## 10. 平台注意事项

| 平台 | 注意 |
| --- | --- |
| Linux | udev 规则；`adb` 在 PATH；Wayland 不影响 ADB |
| Windows | 随包 `adb.exe` 及 `AdbWinApi.dll`/`AdbWinUsbApi.dll`；路径含中文/空格用列表参数 |
| macOS | `adb` 通过 Homebrew/platform-tools；USB 权限通常无需额外配置 |

## 11. 安全与合规

- 只操作已授权设备；不绕过锁屏/验证码。
- 不自动提交/交卷；不在考试场景默认启用。
- 点击随机偏移仅用于降低机械感，不用于规避风控。
- 日志不记录账号密码；题目文本可记录用于诊断，用户可关闭。
