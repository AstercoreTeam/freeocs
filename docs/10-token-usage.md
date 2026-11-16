# 10 Token 统计、消费与限额

FreeOCS 会统计所有通过 `llm.chat` 能力发起的模型调用，并按用户设置的百万 token 单价估算消费。

## 1. 统计来源

`llm_openai` 等兼容 OpenAI 的提供者返回：

```json
{
  "usage": {
    "prompt_tokens": 123,
    "completion_tokens": 45,
    "total_tokens": 168
  }
}
```

框架在 `CapabilityRegistry.require("llm.chat")` 返回提供者时包一层 `MeteredLLM`：

- 调用前检查本月消费限额
- 调用后读取 `ChatResult.usage`
- 写入 `data_dir/usage.json`

因此无论是 U校园、智慧树、设置页测试模型，还是 AI 网页兜底，都会进入同一套统计。

## 2. 数据结构

```text
usage.json
├── totals         累计 prompt/completion/total/calls
├── months         按 YYYY-MM 保存每月 token
├── models         按模型保存 token/calls
└── recent         最近 50 次调用的 token 明细
```

只保存 token 数量，不保存对话内容。

## 3. 单价与消费

设置 → Token 消耗：

| 字段 | 说明 |
| --- | --- |
| 百万 token 单价（元） | 例如 2 表示每 1,000,000 token 2 元；0 表示只统计不计费 |
| 每月消费限额（元） | 0 表示不限制；达到限额后阻止新的模型调用 |

消费计算公式：

```text
cost = total_tokens / 1_000_000 × price_per_million
```

修改单价后，历史记录按新单价重新估算显示；实际账单以模型服务商为准。

## 4. 主界面

首页新增「Token 消耗」卡片：

- 本月 token（输入/输出）
- 本月消费
- 本月限额与剩余
- 累计 token、调用次数
- 当前百万 token 单价
- 限额进度条
- 达到限额时红色提示

首页每 4 秒自动刷新。

## 5. 限额行为

达到限额后，新的 `llm.chat` 调用会抛出：

```text
本月模型消费已达限额：x / y 元。请到设置 → Token 消耗中提高限额或等待下月。
```

不会继续请求模型。提高限额后立即恢复，不需要重启。

如果单价为 0、限额大于 0，则只统计、不执行金额限额，因为无法计算消费。

## 6. AI 网页兜底确认

当页面自动识别失败、需要把整页内容交给模型时：

1. 先把 HTML/元数据保存到
   `package-data/<module>/unsupported_pages/`
2. 页面弹出确认框，显示预计输入 token（粗略估算）
3. 用户确认后才发送给模型
4. 取消时不调用模型、不消耗 token

这一确认只针对“整页 AI 兜底”，普通逐题作答不重复确认。

## 7. 测试

```bash
.venv/bin/python -m pytest tests/test_usage.py tests/test_ucampus_module.py -q
```

覆盖：

- token 记录与持久化
- 消费计算
- 限额阻止调用
- `llm.chat` 自动计量
- 页面保存与 AI 兜底
