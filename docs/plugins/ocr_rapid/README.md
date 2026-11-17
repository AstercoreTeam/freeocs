# ocr_rapid

## 能力

```text
media.ocr
```

本地 OCR：RapidOCR 优先，tesseract 作为回退。

## 依赖

- `rapidocr-onnxruntime`
- `pillow`
- `numpy`
- 可选：`pytesseract` + 系统 tesseract

## 设置

- 引擎：auto / rapidocr / tesseract
- 语言：`ch` / `en` / `chi_sim+eng`
- 最低置信度（0-1）

## 流程

```text
image bytes
  → Pillow 转 RGB
  → RapidOCR 推理
  → 过滤低置信度
  → OCRResult(text, blocks)
```

失败时可回退 tesseract（若安装）。

## 适用

- Android 模块控件树读取失败时的截图兜底
- 页面图片/文字识别

## 源码

`packages/src/ocr_rapid/backend/main.py`

---

## License / 许可

Copyright (C) 2026 qincnd <qincnd@qq.com>, XueZicheng <xuezicheng842@outlook.com>, AstercoreTeam.

This project is licensed under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`).
See [https://spdx.org/licenses/AGPL-3.0-only.html](https://spdx.org/licenses/AGPL-3.0-only.html).

