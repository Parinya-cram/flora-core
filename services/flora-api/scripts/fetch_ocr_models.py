"""Fetch the OCR models into the image (Dockerfile), checked by SHA256, so reading a document never downloads at run time.

PP-OCRv5 text detector (mobile) and the Thai recogniser, as published for RapidOCR 3.10.0 (default_models.yaml), both
Apache-2.0. Thai, Latin letters, digits and common symbols are in the recogniser's dictionary (kept in the model).

    python scripts/fetch_ocr_models.py /opt/flora-ocr
"""
from __future__ import annotations

import hashlib
import sys
import urllib.request
from pathlib import Path

BASE = "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv5"
MODELS = {
    "det.onnx": (f"{BASE}/det/ch_PP-OCRv5_det_mobile.onnx", "4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae"),
    "rec_th.onnx": (f"{BASE}/rec/th_PP-OCRv5_rec_mobile.onnx", "de541dd83161c241ff426f7ecfd602a0ba77d686cf3ab9a6c255ea82fd08006e"),
}


def main(target: str) -> None:
    folder = Path(target)
    folder.mkdir(parents=True, exist_ok=True)
    for name, (url, sha256) in MODELS.items():
        path = folder / name
        if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != sha256:
            with urllib.request.urlopen(url, timeout=120) as response:  # noqa: S310 (fixed https URL)
                content = response.read()
            if hashlib.sha256(content).hexdigest() != sha256:
                raise SystemExit(f"{name}: checksum mismatch, refusing the download")
            path.write_bytes(content)
        print(f"{name}: {path.stat().st_size // 1024} KB ok")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/opt/flora-ocr")
