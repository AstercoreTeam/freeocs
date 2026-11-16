# 12 模型下载与配置

FreeOCS 安装包只包含运行时依赖，**不包含模型权重**。本文列出可选模型的下载地址、目录结构和设置页对应关系。

模型体积较大，请先确认磁盘空间。模型文件不需要放进安装目录，放在任意本地目录即可。

## 1. 模型一览

| 用途 | 模型/文件 | 来源 |
| --- | --- | --- |
| 本地语音转写 | faster-whisper-base | <https://huggingface.co/Systran/faster-whisper-base> |
| 英文 Kokoro | `kokoro.onnx` | <https://huggingface.co/PatnaikAshish/kokoclone/tree/main/model> |
| 英文 voices | `voices-v1.0.bin` | <https://huggingface.co/PatnaikAshish/kokoclone/tree/main/voice> |
| 中文 Kokoro | `kokoro-v1.1-zh.onnx` | <https://huggingface.co/PatnaikAshish/kokoclone/tree/main/model> |
| 中文 voices | `voices-v1.1-zh.bin` | <https://huggingface.co/PatnaikAshish/kokoclone/tree/main/voice> |
| Kanade 配置 | `config.yaml` | <https://huggingface.co/frothywater/kanade-12.5hz> |
| Kanade 权重 | `model.safetensors` | <https://huggingface.co/frothywater/kanade-12.5hz> |
| Vocoder（可选） | Vocos mel 24k | <https://huggingface.co/charactr/vocos-mel-24khz> |
| Kokoro vocab（中文/日文可选） | `config.json` | <https://huggingface.co/PatnaikAshish/kokoclone/tree/main/model> |

`tts_system` 使用系统语音，不需要下载模型。
`tts_openai`、`asr_openai`、`llm_openai` 使用云端 API，不需要本地模型。

## 2. 推荐目录

建议统一放在项目外的模型目录，例如：

```text
~/FreeOCS-models/
├── faster-whisper-base/
│   ├── model.bin
│   ├── config.json
│   ├── tokenizer.json
│   └── vocabulary.txt
├── kokoclone/
│   ├── model/
│   │   └── kokoro.onnx
│   └── voice/
│       └── voices-v1.0.bin
└── kanade/
    ├── config.yaml
    └── model.safetensors
```

中文语音可使用：

```text
kokoclone/model/kokoro-v1.1-zh.onnx
kokoclone/voice/voices-v1.1-zh.bin
```

## 3. 下载 faster-whisper

安装 Hugging Face CLI：

```bash
python -m pip install -U huggingface_hub
```

下载整个模型目录：

```bash
mkdir -p ~/FreeOCS-models/faster-whisper-base

hf download Systran/faster-whisper-base \
  --local-dir ~/FreeOCS-models/faster-whisper-base
```

确认：

```bash
ls ~/FreeOCS-models/faster-whisper-base/model.bin
```

设置：

```text
设置 → 本地语音转写 → 模型目录
```

选择 `~/FreeOCS-models/faster-whisper-base`。

目录中必须有 `model.bin`。

## 4. 下载 Kokoro 与 voices

### 英文

```bash
mkdir -p ~/FreeOCS-models/kokoclone

hf download PatnaikAshish/kokoclone \
  model/kokoro.onnx \
  --local-dir ~/FreeOCS-models/kokoclone

hf download PatnaikAshish/kokoclone \
  voice/voices-v1.0.bin \
  --local-dir ~/FreeOCS-models/kokoclone
```

### 中文

```bash
hf download PatnaikAshish/kokoclone \
  model/kokoro-v1.1-zh.onnx \
  --local-dir ~/FreeOCS-models/kokoclone

hf download PatnaikAshish/kokoclone \
  voice/voices-v1.1-zh.bin \
  --local-dir ~/FreeOCS-models/kokoclone
```

设置：

```text
设置 → 克隆语音（KokoClone）
  Kokoro ONNX 模型   → ~/FreeOCS-models/kokoclone/model/kokoro.onnx
  Kokoro voices 文件 → ~/FreeOCS-models/kokoclone/voice/voices-v1.0.bin
```

中文时选择中文模型和中文 voices，并把语言设为 `zh`。如果中文/日文合成提示缺少 vocab，
在「Kokoro vocab config（可选）」里选择模型仓库中的 `model/config.json`。

## 5. 下载 Kanade

```bash
mkdir -p ~/FreeOCS-models/kanade

hf download frothywater/kanade-12.5hz \
  config.yaml \
  --local-dir ~/FreeOCS-models/kanade

hf download frothywater/kanade-12.5hz \
  model.safetensors \
  --local-dir ~/FreeOCS-models/kanade
```

设置：

```text
设置 → 克隆语音（KokoClone）
  Kanade config.yaml      → ~/FreeOCS-models/kanade/config.yaml
  Kanade model.safetensors → ~/FreeOCS-models/kanade/model.safetensors
```

## 6. Vocoder

不填写「Vocoder 模型目录」时，KokoClone 会自动下载：

```text
charactr/vocos-mel-24khz
```

离线环境建议提前下载，然后在设置中选择本地目录。

## 7. 直接 URL 下载

如果 `hf` 命令不可用，可以使用 `curl`：

```bash
mkdir -p ~/FreeOCS-models/faster-whisper-base
curl -L -o ~/FreeOCS-models/faster-whisper-base/model.bin \
  https://huggingface.co/Systran/faster-whisper-base/resolve/main/model.bin

mkdir -p ~/FreeOCS-models/kokoclone/model
curl -L -o ~/FreeOCS-models/kokoclone/model/kokoro.onnx \
  https://huggingface.co/PatnaikAshish/kokoclone/resolve/main/model/kokoro.onnx

mkdir -p ~/FreeOCS-models/kokoclone/voice
curl -L -o ~/FreeOCS-models/kokoclone/voice/voices-v1.0.bin \
  https://huggingface.co/PatnaikAshish/kokoclone/resolve/main/voice/voices-v1.0.bin

mkdir -p ~/FreeOCS-models/kanade
curl -L -o ~/FreeOCS-models/kanade/config.yaml \
  https://huggingface.co/frothywater/kanade-12.5hz/resolve/main/config.yaml

curl -L -o ~/FreeOCS-models/kanade/model.safetensors \
  https://huggingface.co/frothywater/kanade-12.5hz/resolve/main/model.safetensors
```

## 8. 网络与镜像

如果 Hugging Face 访问不稳定，可以设置镜像：

```bash
export HF_ENDPOINT=https://hf-mirror.com
```

然后重新执行 `hf download`。

首次下载可能较慢；Kanade 权重体积较大。

## 9. 参考音频

克隆语音还需要一段参考音频，不需要下载：

- 3–10 秒
- 单人说话
- 无背景音乐或明显噪声
- WAV / MP3 均可

设置：

```text
设置 → 克隆语音（KokoClone）→ 参考音频（用于克隆）
```

## 10. 模型与许可

模型文件不随 FreeOCS 分发，使用前请阅读对应模型仓库的许可条款：

- faster-whisper：Systran/faster-whisper-base
- Kokoro：hexgrad/Kokoro-82M 及 KokoClone 模型仓库
- Kanade：frothywater/kanade-12.5hz
- Vocos：charactr/vocos-mel-24khz

模型许可与 FreeOCS 的 AGPL-3.0-only 许可相互独立。
