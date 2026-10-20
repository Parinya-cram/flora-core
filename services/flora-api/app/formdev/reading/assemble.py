"""The AI's part in reading a form (formdev/docs/FORM-STUDIO-V2.md §5), grounded in what the tools found.

The AI service (Canopy → AI service; any model, also a mid-size one on the hospital's own server) gets, for each page:
- the page's picture (to see the layout) and close-ups of the parts the tools were unsure of or did not use;
- every text line the OCR read, with its id and place, and the cells, blanks, grids and checkboxes (layout.py);
- the tools' plan (understand.py): sections and items, each with the evidence it uses and why it is unsure.

It does not read the page again or write the form from nothing: it answers with edits to the plan (rename, retype,
options, add from evidence nobody used, remove, set aside, English labels, section names). Every edit is checked here
before it is used:
- an item, a line or a cell it names must exist;
- a label must read like the printed text it points at (an OCR slip may be corrected: kept as "fixed_from"); only an
  item with no printed name (a list of options) may get a name of the AI's own;
- an added item must point at evidence; nothing the document does not show is added;
- every text line must end up in an item or set aside with a reason; lines still left over are sent back once.
Rejected edits are reported with the reason; the tools' plan stands where the AI's answer does not hold.
"""
from __future__ import annotations

import base64
import difflib
import io
import json
import re
import time
from typing import Any

from .. import ai_builder, case_blocks
from .understand import clean

PAGE_PX = 1600
CROP_PX = 900
MAX_CROPS = 10
TYPES = {"text", "textarea", "number", "decimal", "integer", "date", "time", "datetime", "select", "radio", "multiselect", "checkbox",
         "signature", "repeat", "matrix", "timeline", "case_block"}
SERIES = {"hr", "pr", "spo2", "nibp", "art", "cvp", "temperature", "et_co2", "bis"}
PARTS = {"events", "chart", "table"}
ANSWER = re.compile(r"<answer>\s*(.*?)\s*</answer>", re.S)
NO_NAME = "(ไม่มีป้าย)"

SYSTEM = """You turn a scanned or printed hospital form (Thai and/or English) into a digital form, together with tools.
The tools have read the page: every text line (ids L…), the ruled cells (C…), the places to write (blanks B…: underlines,
dotted lines), grids (G…: charts over time) and checkboxes (K…). Boxes are [x0, y0, x1, y1] in thousandths of the page.
They also made a plan: sections and items (ids I…), each with the evidence it uses, and the reasons they are unsure.

Your job: look at the page picture and make the plan match the paper exactly.
- Check every item marked unsure, every line in "unused", and the close-up pictures.
- "label" is the printed wording (fix only what the OCR misread, e.g. subscripts: "NO/AIR" is "N2O/AIR", "2" is "O2");
  its meaning in English goes in "label_en" (WT → label "WT", label_en "Body weight"). Thai stays Thai in "label".
- Fix field types: text, textarea, number, decimal, integer, date, time, datetime, radio (one answer), multiselect
  (several answers), select, checkbox (one tick), signature, repeat (a table filled row by row, with columns), matrix
  (a printed grid: fixed "rows" named on the paper × "columns"), timeline (a record over time
  with "rows", optional "chart" series from: hr, pr, spo2, nibp, art, cvp, temperature, et_co2, bis and "parts" from:
  events, chart, table), case_block (a printed table of the patient's own case records that Flora Leaf fills when the
  report is printed — give "block": one of BLOCKS and "block_columns": its column keys in the paper's order; use it for
  tables of diagnoses, operations, drugs given, fluids / blood, outputs, lab results, events, the care team, billing
  items or scores, instead of repeat).
- Printed words meant to be circled are options of a radio or multiselect field.
- Keep the paper's layout: where items sit, their sizes and tables come from the page and are kept by the tools; do not
  merge, split or reorder items to change the layout, only correct what they are.
- Give every field, option, row and section an English label (label_en), short, in form style ("Body weight").
- Name items that have no printed name (label "(ไม่มีป้าย)") from what they ask for, in a few words ("Airway",
  "Monitoring"), never by repeating their options; name every section the same way.
- A unit only when it is printed on the page (kg, cm, ml); do not add units from your own knowledge.
- Add an item only for printed evidence no item uses, and say which ids it uses. Never invent what is not on the page.
- Remove an item only when the page has nowhere to write it (no blank, box or empty cell), with the reason. Put text
  that is not a field (a form number,
  chart scale, legend marks) in "ignore" with the reason.

Reply with JSON only, between <answer> and </answer>, using only the keys you need:
{"title": "…", "title_en": "…",
 "sections": [{"section": 1, "title": "…", "title_en": "…"}],
 "edit": [{"item": "I1.5", "label": "…", "label_en": "…", "type": "…", "unit": "…",
           "options": [{"label": "…", "label_en": "…"}], "columns": [{"label": "…", "label_en": "…", "type": "…", "unit": "…"}],
           "rows": [{"label": "…", "label_en": "…", "unit": "…"}], "chart": ["nibp"], "parts": ["chart", "table"],
           "block": "medications", "block_columns": ["time", "name", "dose"]}],
 "remove": [{"item": "I1.9", "why": "…"}],
 "add": [{"section": 3, "after": "I1.30", "kind": "field", "type": "…", "label": "…", "label_en": "…", "source": ["L88"],
          "options": [{"label": "…", "label_en": "…"}]}],
 "ignore": [{"source": "L90", "why": "…"}]}"""
SYSTEM += "\n\nBLOCKS for case_block (key — meaning — column keys=default width %):\n" + case_blocks.catalog_text()


def _block_edit(item: dict[str, Any], entry: dict[str, Any], rejected: list[dict[str, Any]]) -> None:
    """A report component (case_block): a known block and some of its column keys; anything else stays a table."""
    if item.get("type") != "case_block":
        return
    block = entry.get("block") if entry.get("block") in case_blocks.CASE_BLOCKS else item.get("block")
    if block not in case_blocks.CASE_BLOCKS:
        item["type"] = "repeat"
        rejected.append({"item": item.get("id"), "why": f"case_block needs a block from {', '.join(case_blocks.CASE_BLOCKS)}: kept as a table"})
        return
    item["block"] = block
    keys = case_blocks.column_keys(block)
    chosen = [key for key in dict.fromkeys(entry.get("block_columns") or []) if key in keys]
    if chosen:
        item["block_columns"] = chosen


def _k(box: list[float]) -> list[int]:
    return [round(value * 1000) for value in box]


def _jpeg(image: Any, longest: int, gray: bool = False) -> bytes:
    scale = min(1.0, longest / max(image.size))
    if scale < 1:
        image = image.resize((max(1, int(image.width * scale)), max(1, int(image.height * scale))))
    buffer = io.BytesIO()
    (image.convert("L") if gray else image.convert("RGB")).save(buffer, format="JPEG", quality=82)
    return buffer.getvalue()


def _image_block(config: dict[str, Any], data: bytes) -> dict[str, Any]:
    encoded = base64.b64encode(data).decode("ascii")
    if config.get("api_format") == "openai":
        return {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{encoded}"}}
    return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": encoded}}


def _crop(image: Any, box: list[float]) -> bytes:
    width, height = image.size
    pad_x, pad_y = 0.02 * width, 0.015 * height
    region = image.crop((max(0, int(box[0] * width - pad_x)), max(0, int(box[1] * height - pad_y)),
                         min(width, int(box[2] * width + pad_x)), min(height, int(box[3] * height + pad_y))))
    return _jpeg(region, CROP_PX, gray=True)


def _compact_item(item: dict[str, Any]) -> dict[str, Any]:
    out = {"item": item["id"], "kind": item["kind"], "label": item["label"], "source": item["source"]}
    for key in ("type", "unit", "lines", "chart", "parts", "block"):
        if item.get(key):
            out[key] = item[key]
    if item.get("options"):
        out["options"] = [option["label"] for option in item["options"]]
    if item.get("columns"):
        out["columns"] = [column["label"] for column in item["columns"]]
    if item.get("rows"):
        out["rows"] = [row["label"] for row in item["rows"]]
    if item.get("unsure"):
        out["unsure"] = item["unsure"]
    return out


def evidence_text(evidence: dict[str, Any], sections: list[dict[str, Any]], missed: list[str], ignored: list[dict[str, Any]]) -> dict[str, Any]:
    """What the AI is told about one page, compact (boxes in thousandths, no words)."""
    return {
        "page": evidence["page"] + 1,
        "lines": [[line["id"], line["text"], _k(line["box"]), line.get("cell") or line.get("grid") or ""] for line in evidence["lines"]],
        "cells": [[cell["id"], _k(cell["box"])] for cell in evidence["cells"] if cell["lines"] or cell["empty"] > 0.5],
        "blanks": [[blank["id"], blank["kind"], _k(blank["box"]), blank.get("cell") or ""] for blank in evidence["blanks"]],
        "grids": [[grid["id"], _k(grid["box"]), f"{grid['rows']} rows x {grid['cols']} columns"] for grid in evidence["grids"]],
        "checkboxes": [[box["id"], _k(box["box"]), "ticked" if box["ticked"] else "empty", box.get("label") or ""] for box in evidence["checkboxes"]],
        "plan": [{"section": number, "items": [_compact_item(item) for item in section["items"]]} for number, section in enumerate(sections, start=1)],
        "unused": [line_id for line_id in missed],
        "set_aside": [[entry["source"], entry["why"]] for entry in ignored],
    }


def content(config: dict[str, Any], image: Any, evidence: dict[str, Any], sections: list[dict[str, Any]], missed: list[str],
            ignored: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """The request's content for one page, and what it carries (shown on the screen)."""
    lines = {line["id"]: line for line in evidence["lines"]}
    zoom: list[tuple[str, list[float]]] = []
    for line_id in missed:
        zoom.append((line_id, lines[line_id]["box"]))
    for section in sections:
        for item in section["items"]:
            if item.get("unsure") and item.get("type") != "timeline":
                zoom.append((item["id"], item["box"]))
    zoom = zoom[:MAX_CROPS]
    blocks: list[dict[str, Any]] = [{"type": "text", "text": f"Page {evidence['page'] + 1}:"}, _image_block(config, _jpeg(image, PAGE_PX))]
    for name, box in zoom:
        blocks.append({"type": "text", "text": f"Close-up of {name}:"})
        blocks.append(_image_block(config, _crop(image, box)))
    told = evidence_text(evidence, sections, missed, ignored)
    blocks.append({"type": "text", "text": json.dumps(told, ensure_ascii=False, separators=(",", ":"))})
    sent = {"lines": len(told["lines"]), "cells": len(told["cells"]), "blanks": len(told["blanks"]), "grids": len(told["grids"]),
            "checkboxes": len(told["checkboxes"]), "items": sum(len(section["items"]) for section in sections), "closeups": len(zoom),
            "page_px": PAGE_PX, "unused": len(missed)}
    return blocks, sent


def _norm(text: str) -> str:
    return re.sub(r"[\W_]+", "", (text or "").lower())


def similar(a: str, b: str) -> float:
    """How alike a label reads to the printed text (case, spacing and punctuation ignored): the characters in common,
    or the share of the label's words that are printed ("Cuff details" for "CUFF__ml., PACK, SIZE": a half)."""
    x, y = _norm(a), _norm(b)
    if not x or not y:
        return 0.0
    if x in y or y in x:
        return max(0.8, min(len(x), len(y)) / max(len(x), len(y)))
    words = [word for word in re.findall(r"\w{2,}", (a or "").lower()) if not word.isdigit()]
    printed = (b or "").lower()
    share = sum(1 for word in words if word in printed) / len(words) if words else 0.0
    return max(share, difflib.SequenceMatcher(None, x, y).ratio())


def parse(text: str) -> dict[str, Any]:
    match = ANSWER.search(text)
    body = match.group(1) if match else text
    body = re.sub(r"^```(?:json)?|```$", "", body.strip(), flags=re.M).strip()
    start, end = body.find("{"), body.rfind("}")
    value = json.loads(body[start:end + 1] if start >= 0 else body)
    if not isinstance(value, dict):
        raise ValueError("the answer is not a JSON object")
    return value


def _text(value: Any, limit: int = 200) -> str | None:
    return value.strip()[:limit] if isinstance(value, str) and value.strip() else None


def _label(value: Any) -> str | None:
    """A label as the AI gave it, without the dots and underscores that only show where to write."""
    text = _text(value)
    return clean(text) or None if text else None


def _labelled(entries: Any, limit: int = 60) -> list[dict[str, Any]] | None:
    if not isinstance(entries, list):
        return None
    out = []
    for entry in entries[:limit]:
        if isinstance(entry, str) and entry.strip():
            out.append({"label": entry.strip()[:200]})
        elif isinstance(entry, dict) and _text(entry.get("label")):
            out.append({key: (_text(value) if isinstance(value, str) else value) for key, value in entry.items()
                        if key in ("label", "label_en", "type", "unit") and value})
    return out


def apply(answer: dict[str, Any], evidence: dict[str, Any], sections: list[dict[str, Any]], ignored: list[dict[str, Any]]) -> dict[str, Any]:
    """The answer's edits applied to the page's sections (in place), checked: {applied, rejected, title, title_en}."""
    lines = {line["id"]: line for line in evidence["lines"]}
    known = set(lines) | {cell["id"] for cell in evidence["cells"]} | {blank["id"] for blank in evidence["blanks"]} \
        | {grid["id"] for grid in evidence["grids"]} | {box["id"] for box in evidence["checkboxes"]}
    items = {item["id"]: item for section in sections for item in section["items"]}
    applied: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []

    def printed(item: dict[str, Any]) -> str:
        return " ".join(lines[i]["text"] for i in item["source"] if i in lines)

    def place_to_write(item: dict[str, Any]) -> str | None:
        """The evidence that the paper asks for a value here: a blank, a checkbox, or an empty cell."""
        for i in item["source"]:
            if i.startswith(("B", "K")) or (i.startswith("C") and not cells.get(i, {}).get("lines") and i in cells):
                return i
        return None

    cells = {cell["id"]: cell for cell in evidence["cells"]}

    def grounded(label: str, item: dict[str, Any], original: str) -> bool:
        source = printed(item)
        if original == NO_NAME or not source or similar(original, source) < 0.5:
            return True  # nothing printed names it (the tools made the name up): the AI names it
        return similar(label, source) >= 0.5 or similar(label, original) >= 0.6

    for entry in answer.get("edit") or []:
        if not isinstance(entry, dict) or entry.get("item") not in items:
            rejected.append({"edit": entry, "why": "no such item"})
            continue
        item = items[entry["item"]]
        before = _compact_item(item)
        label = _label(entry.get("label"))
        options_now = [option["label"] for option in item.get("options") or []]
        if label and len(options_now) >= 2 and sum(1 for option in options_now if _norm(option) and _norm(option) in _norm(label)) >= 2:
            rejected.append({"item": item["id"], "why": f"label '{label}' repeats the options: a name says what is asked"})
            label = None
        if label and label != item["label"]:
            if grounded(label, item, item["label"]):
                if item["label"] != NO_NAME and _norm(label) != _norm(item["label"]):
                    item["fixed_from"] = item["label"]  # a misread corrected (not only its case or punctuation)
                item["label"] = label
            elif not re.search("[฀-๿]", label) and not _text(entry.get("label_en")):
                # Its meaning in English ("Weight" for "WT"): kept as the English label, the printed one stays.
                item["label_en"] = label
                rejected.append({"item": item["id"], "why": f"kept the printed label '{item['label']}'; '{label}' became its English label"})
            else:
                rejected.append({"item": item["id"], "why": f"label '{label}' is not what the page says ('{printed(item)[:60]}')"})
        if _text(entry.get("label_en")):
            item["label_en"] = _text(entry.get("label_en"))
        unit = _text(entry.get("unit"), 20)
        if unit and unit != item.get("unit"):
            if _norm(unit) and _norm(unit) in _norm(printed(item)):
                item["unit"] = unit
            else:
                rejected.append({"item": item["id"], "why": f"unit '{unit}' is not printed on the page"})
        if entry.get("type") in TYPES and item["kind"] == "field":
            item["type"] = entry["type"]
        for key in ("options", "columns", "rows"):
            values = _labelled(entry.get(key))
            if values is None:
                continue
            old = item.get(key) or []
            # Keep each entry's evidence where the count is unchanged; new entries point at the item's evidence.
            for index, value in enumerate(values):
                value["source"] = old[index]["source"] if index < len(old) and old[index].get("source") else item["source"][:1]
                if key == "rows" and index < len(old) and old[index].get("id"):
                    value.setdefault("id", old[index]["id"])
            item[key] = values
        if isinstance(entry.get("chart"), list):
            item["chart"] = [series for series in entry["chart"] if series in SERIES]
        _block_edit(item, entry, rejected)
        if isinstance(entry.get("parts"), list):
            item["parts"] = [part for part in entry["parts"] if part in PARTS] or item.get("parts")
        item["by"] = "ai"
        item["unsure"] = []
        applied.append({"edit": item["id"], "before": before, "after": _compact_item(item)})

    for entry in answer.get("remove") or []:
        if not isinstance(entry, dict) or entry.get("item") not in items:
            rejected.append({"remove": entry, "why": "no such item"})
            continue
        proof = place_to_write(items[entry["item"]])
        if proof:
            rejected.append({"remove": entry["item"], "why": f"the page has a place to write it ({proof}): it stays"})
            continue
        item = items.pop(entry["item"])
        for section in sections:
            section["items"] = [other for other in section["items"] if other is not item]
        why = _text(entry.get("why")) or "removed by the AI"
        ignored += [{"source": i, "why": why, "by": "ai"} for i in item["source"] if i in lines]
        applied.append({"remove": item["id"], "label": item["label"], "why": why})

    used = {i for section in sections for item in section["items"] for i in item["source"]}
    for entry in answer.get("add") or []:
        if not isinstance(entry, dict):
            continue
        source = [i for i in entry.get("source") or [] if isinstance(i, str) and i in known]
        label = _label(entry.get("label"))
        kind = entry.get("kind") if entry.get("kind") in ("field", "heading", "paragraph") else "field"
        if not source or not label:
            rejected.append({"add": label, "why": "an added item must point at printed evidence"})
            continue
        text_sources = [i for i in source if i in lines]
        printed_text = " ".join(lines[i]["text"] for i in text_sources)
        if text_sources and similar(label, printed_text) < 0.5 and not entry.get("options"):
            rejected.append({"add": label, "why": f"the label is not what the page says ('{printed_text[:60]}')"})
            continue
        boxes = [next(o["box"] for o in evidence[collection] if o["id"] == i) for i in source
                 for collection in ("lines", "cells", "blanks", "grids", "checkboxes") if any(o["id"] == i for o in evidence[collection])]
        new = {"id": f"A{evidence['page'] + 1}.{len(applied) + 1}", "kind": kind, "label": label, "source": source, "page": evidence["page"],
               "box": [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)],
               "anchor": lines[text_sources[0]]["box"] if text_sources else None, "by": "ai", "unsure": [], "confidence": 0.7}
        if kind == "field":
            new["type"] = entry.get("type") if entry.get("type") in TYPES else "text"
        for key in ("label_en", "unit"):
            if _text(entry.get(key)):
                new[key] = _text(entry.get(key))
        for key in ("options", "columns", "rows"):
            values = _labelled(entry.get(key))
            if values:
                new[key] = [{**value, "source": source[:1]} for value in values]
        if isinstance(entry.get("chart"), list):
            new["chart"] = [series for series in entry["chart"] if series in SERIES]
        _block_edit(new, entry, rejected)
        new = {key: value for key, value in new.items() if value is not None}
        number = entry.get("section") if isinstance(entry.get("section"), int) and 1 <= entry["section"] <= len(sections) else None
        after = entry.get("after") if entry.get("after") in items else None
        target = sections[number - 1] if number else next((s for s in sections if any(i["id"] == after for i in s["items"])), sections[-1] if sections else None)
        if target is None:
            continue
        position = next((index + 1 for index, other in enumerate(target["items"]) if other["id"] == after), len(target["items"]))
        target["items"].insert(position, new)
        items[new["id"]] = new
        used.update(source)
        applied.append({"add": new["id"], "label": label, "source": source})

    for entry in answer.get("ignore") or []:
        if isinstance(entry, dict) and entry.get("source") in lines and entry["source"] not in used:
            ignored.append({"source": entry["source"], "why": _text(entry.get("why")) or "set aside by the AI", "by": "ai"})

    for entry in answer.get("sections") or []:
        if isinstance(entry, dict) and isinstance(entry.get("section"), int) and 1 <= entry["section"] <= len(sections):
            section = sections[entry["section"] - 1]
            if _text(entry.get("title")):
                section["title"] = _text(entry.get("title"))
            if _text(entry.get("title_en")):
                section["title_en"] = _text(entry.get("title_en"))
    return {"applied": applied, "rejected": rejected, "title": _text(answer.get("title")), "title_en": _text(answer.get("title_en"))}


def coverage(evidence: dict[str, Any], sections: list[dict[str, Any]], ignored: list[dict[str, Any]]) -> dict[str, Any]:
    """Which text lines of the page the plan uses, sets aside, or misses."""
    used = {i for section in sections for item in section["items"] for i in item["source"]}
    for section in sections:
        for item in section["items"]:
            for key in ("options", "columns", "rows"):
                used.update(i for entry in item.get(key) or [] for i in entry.get("source") or [])
    aside = {entry["source"] for entry in ignored}
    ids = [line["id"] for line in evidence["lines"]]
    missed = [i for i in ids if i not in used and i not in aside]
    return {"lines": len(ids), "used": sum(1 for i in ids if i in used), "ignored": sum(1 for i in ids if i in aside and i not in used),
            "missed": missed, "share": round(1 - len(missed) / max(1, len(ids)), 3)}


TRANSIENT = re.compile(r"\b(429|502|503|504)\b|busy|did not answer in time", re.I)


def _ask(conversation: Any) -> str:
    """One answer; a busy or restarting AI server (429, 502-504) is asked once more after a short pause."""
    try:
        return conversation.ask()
    except ai_builder.BuildError as error:
        if not TRANSIENT.search(str(error)):
            raise
        time.sleep(RETRY_S)
        return conversation.ask()


RETRY_S = 8


def assemble_page(config: dict[str, Any], image: Any, evidence: dict[str, Any], sections: list[dict[str, Any]], ignored: list[dict[str, Any]],
                  missed: list[str], emit: Any = None) -> dict[str, Any]:
    """Ask the AI about one page and apply its checked edits to sections / ignored (in place):
    {sent, applied, rejected, title, title_en, coverage_before, coverage_after, usage, asked_again}."""
    before = coverage(evidence, sections, ignored)
    blocks, sent = content(config, image, evidence, sections, missed, ignored)
    if emit:
        emit("ai_started", evidence["page"], sent=sent)
    conversation = ai_builder.Conversation(config, [], "", system=SYSTEM, content=blocks, end_tag="</answer>")
    conversation.max_tokens = 8000
    text = _ask(conversation)
    try:
        answer = parse(text)
    except ValueError as error:
        conversation.follow_up(f"That was not valid JSON ({str(error)[:120]}). Send the whole answer again, JSON only, between <answer> and </answer>.")
        answer = parse(_ask(conversation))
    result = apply(answer, evidence, sections, ignored)
    after = coverage(evidence, sections, ignored)
    asked_again = False
    if after["missed"]:
        # Once: the lines nobody used yet, by id, with their text.
        lines = {line["id"]: line["text"] for line in evidence["lines"]}
        listing = ", ".join(f"{i} \"{lines[i]}\"" for i in after["missed"][:60])
        conversation.follow_up(f"These lines are still in no item and not set aside: {listing}. Add them to items (add, with their ids) or put "
                               "them in ignore with the reason. Same JSON format, only the new edits, between <answer> and </answer>.")
        try:
            more = apply(parse(_ask(conversation)), evidence, sections, ignored)
            result["applied"] += more["applied"]
            result["rejected"] += more["rejected"]
            asked_again = True
        except (ValueError, ai_builder.BuildError):
            pass
        after = coverage(evidence, sections, ignored)
    return {"sent": sent, **result, "coverage_before": before, "coverage_after": after, "usage": dict(conversation.usage), "asked_again": asked_again}
