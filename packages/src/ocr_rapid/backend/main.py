# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

"""Local OCR provider: RapidOCR first, tesseract as fallback."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
import threading
import uuid
from pathlib import Path

from freeocs.sdk import OCRBlock, OCRResult, PackageContext, ProviderError

_lock = threading.Lock()


class RapidOCR:
    def __init__(self, api: PackageContext) -> None:
        self.api = api
        self._engine = None
        self._engine_lang = ""

    def _language(self) -> str:
        return str(self.api.settings.get("lang", "ch") or "ch").strip()

    def _min_confidence(self) -> float:
        try:
            return float(self.api.settings.get("min_confidence", 0.5) or 0.5)
        except (TypeError, ValueError):
            return 0.5

    # -- rapidocr ----------------------------------------------------------
    def _get_rapidocr(self):
        lang = self._language()
        with _lock:
            if self._engine is not None and self._engine_lang == lang:
                return self._engine
            try:
                from rapidocr_onnxruntime import RapidOCR as Engine
            except ImportError as exc:
                raise ProviderError(
                    "未安装 rapidocr-onnxruntime，请执行：pip install rapidocr-onnxruntime pillow numpy",
                    provider="ocr_rapid",
                ) from exc
            model_dir = self.api.data_dir / "models" / "rapidocr"
            model_dir.mkdir(parents=True, exist_ok=True)
            try:
                self._engine = Engine()
            except Exception as exc:  # noqa: BLE001
                raise ProviderError(f"初始化 RapidOCR 失败：{exc}", provider="ocr_rapid") from exc
            self._engine_lang = lang
            return self._engine

    def _rapidocr(self, image: bytes) -> OCRResult:
        try:
            import numpy as np
            from PIL import Image
        except ImportError as exc:
            raise ProviderError("RapidOCR 需要 pillow 与 numpy", provider="ocr_rapid") from exc
        try:
            import io

            with Image.open(io.BytesIO(image)) as pil:
                array = np.array(pil.convert("RGB"))
        except Exception as exc:  # noqa: BLE001
            raise ProviderError(f"无法读取截图：{exc}", provider="ocr_rapid") from exc
        engine = self._get_rapidocr()
        try:
            output = engine(array)
        except Exception as exc:  # noqa: BLE001
            raise ProviderError(f"RapidOCR 推理失败：{exc}", provider="ocr_rapid") from exc
        raw = output[0] if isinstance(output, tuple) else output
        blocks: list[OCRBlock] = []
        texts: list[str] = []
        threshold = self._min_confidence()
        for item in raw or []:
            try:
                box, text, score = item[0], str(item[1]), float(item[2])
            except (TypeError, ValueError, IndexError):
                continue
            if not text.strip() or score < threshold:
                continue
            points = [(float(p[0]), float(p[1])) for p in box]
            xs = [p[0] for p in points]
            ys = [p[1] for p in points]
            blocks.append(
                OCRBlock(
                    text=text.strip(),
                    box=(min(xs), min(ys), max(xs), max(ys)),
                    confidence=score,
                )
            )
            texts.append(text.strip())
        return OCRResult(text="\n".join(texts), blocks=blocks)

    # -- tesseract ---------------------------------------------------------
    def _tesseract(self, image: bytes) -> OCRResult:
        lang = self._language()
        try:
            import io

            import pytesseract
            from PIL import Image
        except ImportError:
            pytesseract = None
            Image = None
        if pytesseract is not None and Image is not None:
            try:
                with Image.open(io.BytesIO(image)) as pil:
                    data = pytesseract.image_to_data(
                        pil, lang=lang, output_type=pytesseract.Output.DICT
                    )
                blocks: list[OCRBlock] = []
                texts: list[str] = []
                threshold = self._min_confidence()
                for index, text in enumerate(data.get("text", [])):
                    text = str(text or "").strip()
                    if not text:
                        continue
                    try:
                        confidence = float(data["conf"][index]) / 100.0
                    except (KeyError, ValueError, IndexError):
                        confidence = 0.0
                    if confidence < threshold:
                        continue
                    x = float(data["left"][index])
                    y = float(data["top"][index])
                    w = float(data["width"][index])
                    h = float(data["height"][index])
                    blocks.append(OCRBlock(text=text, box=(x, y, x + w, y + h), confidence=confidence))
                    texts.append(text)
                return OCRResult(text="\n".join(texts), blocks=blocks)
            except Exception as exc:  # noqa: BLE001
                raise ProviderError(f"tesseract 识别失败：{exc}", provider="ocr_rapid") from exc

        binary = shutil.which("tesseract")
        if not binary:
            raise ProviderError(
                "未安装 OCR 引擎：请安装 rapidocr-onnxruntime 或系统 tesseract",
                provider="ocr_rapid",
            )
        temp = Path(tempfile.gettempdir()) / f"freeocs-ocr-{uuid.uuid4().hex}.png"
        temp.write_bytes(image)
        try:
            result = subprocess.run(
                [binary, str(temp), "stdout", "-l", lang, "--psm", "6"],
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
            )
            if result.returncode != 0:
                raise ProviderError(
                    f"tesseract 失败：{(result.stderr or '').strip()[:500]}",
                    provider="ocr_rapid",
                )
            return OCRResult(text=(result.stdout or "").strip(), blocks=[])
        finally:
            temp.unlink(missing_ok=True)

    def extract(self, image: bytes, *, language: str | None = None) -> OCRResult:
        if not image:
            raise ProviderError("截图为空", provider="ocr_rapid")
        engine = str(self.api.settings.get("engine", "auto") or "auto")
        if engine == "rapidocr":
            return self._rapidocr(image)
        if engine == "tesseract":
            return self._tesseract(image)
        try:
            return self._rapidocr(image)
        except ProviderError as exc:
            try:
                return self._tesseract(image)
            except ProviderError:
                raise exc from None

    def close(self) -> None:
        with _lock:
            self._engine = None
            self._engine_lang = ""


def setup(api: PackageContext) -> None:
    api.provide("media.ocr", RapidOCR(api))
