"""A page image made easier to read before OCR and layout (formdev/docs/FORM-STUDIO-V2.md §5):

- straightened: a scan fed a little crooked tilts every ruled line, so lines break into pieces, text rows run into each
  other and a box no longer lines up with its label. The tilt is measured from the long ruled lines (a form has many)
  or, on a page of text only, from the rows of text, and undone when it is between 0.1° and 5°;
- evened out: a photographed page is darker at one corner; the paper's own shade is divided out so thresholds work the
  same everywhere on the page. A clean scan is left as it is.
"""
from __future__ import annotations

import math
from typing import Any

MM_PER_INCH = 25.4
MAX_SKEW = 5.0
MIN_SKEW = 0.1


def _gray(image: Any):
    import numpy as np

    return np.asarray(image.convert("L"))


def _binary(gray: Any, mm: float):
    import cv2

    block = max(15, int(3 * mm) | 1)
    return cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, block, 12)


def skew_from_rules(binary: Any, mm: float) -> float | None:
    """The tilt in degrees (clockwise positive in the image) of the long horizontal ruled lines, or None when the page
    has fewer than three of them."""
    import cv2
    import numpy as np

    horizontal = cv2.morphologyEx(binary, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(20, int(12 * mm)), 1)))
    # A tilted line is a staircase of short runs: close the steps so each line is one piece.
    horizontal = cv2.dilate(horizontal, cv2.getStructuringElement(cv2.MORPH_RECT, (int(3 * mm), 3)))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(horizontal, connectivity=8)
    angles: list[tuple[float, float]] = []
    for index in range(1, count):
        x, y, w, h, _ = stats[index]
        if w < 40 * mm or h > 0.1 * w:
            continue
        ys, xs = np.nonzero(labels[y:y + h, x:x + w] == index)
        if len(xs) < 50:
            continue
        slope = np.polyfit(xs.astype(float), ys.astype(float), 1)[0]
        angles.append((math.degrees(math.atan(slope)), float(w)))
    if len(angles) < 3:
        return None
    angles.sort()
    total = sum(weight for _, weight in angles)
    running = 0.0
    for angle, weight in angles:  # the length-weighted median
        running += weight
        if running >= total / 2:
            return angle
    return angles[-1][0]


def skew_from_text(binary: Any) -> float:
    """The tilt that makes the rows of text sharpest (projection profile), for pages without ruled lines."""
    import cv2
    import numpy as np

    small = cv2.resize(binary, (binary.shape[1] // 4, binary.shape[0] // 4), interpolation=cv2.INTER_AREA)
    height, width = small.shape
    best, best_score = 0.0, -1.0
    for step in range(-12, 13):  # -3° .. 3° in quarter degrees
        angle = step / 4
        matrix = cv2.getRotationMatrix2D((width / 2, height / 2), angle, 1.0)
        turned = cv2.warpAffine(small, matrix, (width, height), flags=cv2.INTER_NEAREST, borderValue=0)
        profile = turned.sum(axis=1).astype(float)
        score = float(np.var(profile))
        if score > best_score:
            best, best_score = angle, score
    return best


def rotate(image: Any, degrees: float) -> Any:
    """The image turned by degrees (counter-clockwise positive, as on screen), the corners filled with white."""
    import cv2
    import numpy as np
    from PIL import Image

    array = np.asarray(image.convert("RGB"))
    height, width = array.shape[:2]
    matrix = cv2.getRotationMatrix2D((width / 2, height / 2), degrees, 1.0)
    turned = cv2.warpAffine(array, matrix, (width, height), flags=cv2.INTER_CUBIC, borderValue=(255, 255, 255))
    return Image.fromarray(turned)


def even_out(image: Any, mm: float) -> tuple[Any, bool]:
    """Divide out the paper's shade when it varies across the page (a photo); a scan with an even page is unchanged."""
    import cv2
    import numpy as np
    from PIL import Image

    gray = _gray(image)
    small = cv2.resize(gray, (max(1, gray.shape[1] // 8), max(1, gray.shape[0] // 8)), interpolation=cv2.INTER_AREA)
    # The paper: the brightest values around each point (ink is thin, so a large closing removes it).
    paper = cv2.morphologyEx(small, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (max(3, int(2 * mm)), max(3, int(2 * mm)))))
    paper = cv2.medianBlur(paper, 5)
    low, high = np.percentile(paper, [5, 95])
    if high - low < 25:
        return image, False
    paper = cv2.resize(paper, (gray.shape[1], gray.shape[0]), interpolation=cv2.INTER_LINEAR)
    evened = cv2.divide(gray, np.maximum(paper, 1), scale=255)
    return Image.fromarray(evened).convert("RGB"), True


def prepare(image: Any, dpi: int) -> tuple[Any, dict[str, Any]]:
    """(the page ready for OCR and layout, {skew, straightened, evened})."""
    mm = dpi / MM_PER_INCH
    image, evened = even_out(image, mm)
    binary = _binary(_gray(image), mm)
    skew = skew_from_rules(binary, mm)
    measured_by = "rules"
    if skew is None:
        skew, measured_by = skew_from_text(binary), "text"
    straightened = MIN_SKEW <= abs(skew) <= MAX_SKEW
    if straightened:
        image = rotate(image, skew)
    return image, {"skew": round(skew, 2), "measured_by": measured_by, "straightened": straightened, "evened": evened}
