"""Thai and English OCR on CPU: RapidOCR 3.10 with the PP-OCRv5 detector and Thai recogniser (Apache-2.0), loaded
from FLORA_OCR_MODELS (fetched into the image by scripts/fetch_ocr_models.py, never at run time). The recogniser's
dictionary holds Thai, Latin letters, digits and common symbols. About 0.3-1 s per A4 page at 200 dpi."""
from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Any

from . import thai

_lock = threading.Lock()
_engine: Any = None


def models_dir() -> Path:
    return Path(os.environ.get("FLORA_OCR_MODELS", "/opt/flora-ocr"))


def available() -> bool:
    folder = models_dir()
    if not ((folder / "det.onnx").exists() and (folder / "rec_th.onnx").exists()):
        return False
    try:
        import rapidocr  # noqa: F401
    except ImportError:
        return False
    return True


def _get() -> Any:
    global _engine
    if _engine is None:
        from rapidocr import LangDet, LangRec, ModelType, OCRVersion, RapidOCR

        folder = models_dir()
        _engine = RapidOCR(params={
            "Det.model_path": str(folder / "det.onnx"), "Det.ocr_version": OCRVersion.PPOCRV5, "Det.lang_type": LangDet.CH,
            "Det.model_type": ModelType.MOBILE,
            "Rec.model_path": str(folder / "rec_th.onnx"), "Rec.ocr_version": OCRVersion.PPOCRV5, "Rec.lang_type": LangRec.TH,
            "Rec.model_type": ModelType.MOBILE,
            "Global.use_cls": False, "Global.log_level": "error",
        })
    return _engine


def read(image: Any) -> list[dict[str, Any]]:
    """Text lines of a page image: [{box (page fractions), text, score, raw, fixes}], top to bottom, left to right.
    text is cleaned (thai.normalize, tone marks a dictionary can restore); raw is what the model read."""
    width, height = image.size
    with _lock:  # one recognition at a time: the ONNX sessions are shared
        result = _get()(image.convert("RGB"))  # a PIL image: a bare array would be read as BGR
    lines = []
    for box, raw, score in zip(result.boxes if result.boxes is not None else [], result.txts or (), result.scores or ()):
        xs = [float(point[0]) for point in box]
        ys = [float(point[1]) for point in box]
        cleaned = thai.normalize(str(raw))
        fixed, fixes = thai.fix_marks(cleaned)
        lines.append({"box": [round(min(xs) / width, 5), round(min(ys) / height, 5), round(max(xs) / width, 5), round(max(ys) / height, 5)],
                      "text": fixed, "raw": str(raw), "score": round(float(score), 4), "fixes": fixes, "source": "ocr"})
    lines.sort(key=lambda line: (round(line["box"][1] * 80), line["box"][0]))
    return lines
