"""AI form builder (Form Studio): turns checked source documents into a flora.form/1 definition.

The model reads the documents (PDFs and images directly, Word / Excel / text as extracted text, an existing form
JSON as the starting point) and answers with the definition and a report: what kind of document it is, which item on
the paper became which field, what it was unsure about, and where the form belongs on Flora Leaf (Workflow Studio
phase and the built-in tab it follows). The definition is checked with the same validator as every saved form;
problems go back to the model for a correction, at most MAX_REPAIRS times. Whatever is left is returned with the
issues so the author fixes it in the designer: the result is always a draft to review, never published as is.

Uses the shared AI service (ai_service: Anthropic API or an OpenAI-compatible host). Nothing here holds a database
connection while the model works.
"""
from __future__ import annotations

import base64
import io
import json
import os
import re
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any

from .. import ai_service
from ..workflows import PHASES, SECTION_IDS, SECTIONS
from . import case_blocks, field_types
from .definition import (CONDITION_OPERATORS, FORM_ID, FORMAT, PAGE_BANDS, PRINT_STYLES, REPEAT_VIEWS, TIMELINE_PARTS, TIMELINE_SERIES, Issue,
                         fields as definition_fields, parse_json_strict)
from .documents import SourceFile

from ..concepts import CONCEPTS as _CONCEPTS

CONCEPT_KEYS = [concept["key"] for concept in _CONCEPTS]

MAX_REPAIRS = 2
MAX_TOKENS = int(os.getenv("FORMDEV_AI_MAX_TOKENS", "32000"))
FALLBACK_MAX_TOKENS = 8192
TIMEOUT_S = float(os.getenv("FORMDEV_AI_TIMEOUT_S", "600"))
# OpenAI-compatible hosts (self-hosted vision models) take minutes on a full-resolution scan and proxies in front of
# them give up after 100 s: pages are scaled so the longest side is at most this (fewer pixels per page as pages
# add up). Measured on a Qwen3.6-35B host: a 2209 px scan > 100 s, 1280 px 28 s, 1024 px 13 s.
IMAGE_MAX_PX = int(os.getenv("FORMDEV_AI_IMAGE_MAX_PX", "1280"))
PLACEMENT_KEY = "flora.leaf_placement"
FORM_RE = re.compile(r"<form_json>\s*(.*?)\s*</form_json>", re.S)
REPORT_RE = re.compile(r"<report>\s*(.*?)\s*</report>", re.S)
FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$")


class BuildError(Exception):
    """The build could not produce a definition; the message is safe to show to authors."""


def _field_types_table() -> str:
    lines = []
    for name, spec in field_types.FIELD_TYPES.items():
        props = ", ".join(spec["props"]) or "-"
        lines.append(f"- {name}: own properties {props}")
    return "\n".join(lines)


def _sections_table() -> str:
    return "\n".join(f"- {section['id']}: {section['label']}" for section in SECTIONS)


# The model's instructions. Static (no dates or ids) so the AI host can cache it across builds.
SYSTEM_PROMPT = f"""You are the form builder of Flora Form Studio, a hospital's electronic forms system (anaesthesia,
perioperative and ward documents in Thai and English). You read source documents (paper forms as PDF or photos, Word or
Excel templates, notes) and write ONE electronic form in the "{FORMAT}" JSON format that captures every item a person
fills in on the paper, laid out like the paper so the printed PDF matches it.

FORMAT ({FORMAT}). Top level:
{{"format":"{FORMAT}","form_id":"lower_snake_case","schema_version":1,"title":"...","description":"...",
 "paper":{{"size":"A4","orientation":"portrait"|"landscape","margin_mm":{{"top":10,"right":10,"bottom":12,"left":10}}}},
 "layout":{{"type":"grid","columns":24}},"extensions":{{"flora.subject_field":"hn"}},"sections":[...]}}
Section: {{"id":"snake_case","title":"...","description"?,"print_style"?:{"|".join(PRINT_STYLES)},"hide_title"?:true,
 "repeat_on_pages"?:{"|".join(PAGE_BANDS)} (top-level sections only: a patient header / signature footer on every page),
 "page_break"?:"before|after|avoid","fields":[...],"sections"?:[nested sections],"visibility"?:{{"when":condition}}}}
Field: {{"id":"variable name (see NAMES)","type":"<type>","label":"text as printed","label_en"?:"English","layout":{{"span":1-24,"row"?,"col"?,"row_span"?}},
 "required"?:true,"description"?,"unit"?,"placeholder"?,"indexed"?:true,"visibility"?:{{"when":condition}}, ...type properties}}
Field types and their own properties (any other property is an error):
{_field_types_table()}
Common properties for every value field: id, label, description, required, readonly, hidden, layout, visibility, indexed.
Options (select, radio, multiselect): "options":[{{"value":"snake_case","label":"as printed","label_en"?:"English"}}]; an "Other ......" choice is
 {{"value":"other","label":"Other","has_input":true}}; "option_columns":1-6 lays check boxes out in columns like the paper.
 Use radio for one choice shown as boxes, select for long lists, multiselect for "tick all that apply".
checkbox: one yes/no box. integer / decimal (with "decimals") / number: "min", "max", "unit". date, time, datetime: no
 extra properties. textarea for free text over one line. signature for a signature line.
group: "fields":[...] boxes several fields together (e.g. a column of the paper). repeat: rows of a table the user adds
 to, "fields":[...] are the columns, "view":"{'|'.join(REPEAT_VIEWS)}" (table for paper tables), "min_items"/"max_items".
matrix: a fixed grid of scores or ticks (rows x columns, e.g. a score per time point):
 {{"type":"matrix","rows":[{{"id","label","cell"?}}],"cols":[{{"id","label"}}],"cell":{{"type":"integer|number|text|select","options"?,"min"?,"max"?}},
 "totals"?:[{{"id","label","of":[numeric row ids]}}]}} (row/col ids snake_case; a select cell with numeric option values can be totalled).
timeline (only for anaesthesia records with vital-sign trends over time): {{"type":"timeline","timeline":{{"parts":[{", ".join(f'"{part}"' for part in TIMELINE_PARTS)}],
 "chart":[some of {", ".join(TIMELINE_SERIES)}],"rows":[{{"id":"et_co2"}},...],"step_min":5-60,"source":"leaf"}}}}.
calculated: "formula" over other field ids, e.g. "weight / ((height / 100) ^ 2)", with "decimals".
barcode: prints another field's value as bars, e.g. {{"id":"hn_barcode","type":"barcode","label":"HN barcode","source":"hn","symbology":"i2of5",
 "height_mm":8}} where the paper has a patient barcode or a sticker box (i2of5 = digits, as Flora Leaf's HN; code128 for values with letters).
logo: a picture kept in the form ("src" data URL). Never invent one: leave the hospital logo out, the author adds it in the designer.
case_block (REPORT COMPONENT): a table Flora Leaf fills with the case's own records when the form is printed as a report
 (nobody types into it). Use it where the paper has a printed table of case data — a list of diagnoses or operations,
 drugs given, fluids / blood, outputs, lab results, events, the care team, billing items, scores — instead of a repeat:
 {{"id":"medications_table","type":"case_block","label":"ยาที่ให้","label_en":"Medications given","block":"medications",
 "block_columns":[{{"key":"time","width":15}},{{"key":"name","width":45}},{{"key":"dose","width":25}},{{"key":"note","width":15}}],
 "min_rows":5,"max_rows":15,"layout":{{"span":24}}}}. block is one of the blocks below; block_columns lists some of that
 block's column keys in the paper's order with "width" = percent of the table as measured on the paper (they add to 100),
 and "label" when the paper's heading differs; min_rows = the ruled rows printed on the paper (left empty to write on
 when the case has fewer), max_rows = the most that fit. Blocks (key=default width %):
{case_blocks.catalog_text()}
Condition: {{"field":"field_id","operator":one of {", ".join(CONDITION_OPERATORS)},"value"?}} or {{"and":[...]}} / {{"or":[...]}}.

ONE PAGE. A report printed from Flora Leaf should fit the paper it copies: when the paper is one page, keep it one page
(paper.density "fit_page" shrinks the type when needed) and size case_block rows (min_rows / max_rows) to the space the
paper gives each table; the proportions of a row are its spans (span 12 of 24 = half the width).

LAYOUT LIKE THE PAPER. 24 grid columns per row; give every field layout.span so items that share a line on paper share a
row (spans on one line add up to 24). A tall item beside several lines (a photo, a body diagram, a box of notes) takes
layout {{"row":r,"col":c,"span":s,"row_span":n}} and the items beside it take their own row and col. Printed headings
inside a section are "heading" fields (level 1-3), printed instructions "paragraph" fields (content), rules "divider"
fields. Use print_style "boxed" for bordered blocks, a header section with repeat_on_pages "header" for patient details
printed on every page, and a footer section for signatures. Keep the order of the paper. Keep labels exactly as printed
in "label" (Thai stays Thai) and give the English in "label_en" (and "title_en" for sections) — never both languages in
one label. Units go in "unit", not in the label.

NAMES (the variable-name standard). An id is English lower snake_case and says what the value is, never the input type
(not text_2, date, field_1): pain_score, assessor_name, consent_date. A field holding case data gets "bind" and is named
after it: {", ".join(CONCEPT_KEYS)} (e.g. bind "patient.weight_kg" → id "patient_weight_kg"). A vague name (date, time,
name, note, other) gets its section's name first: consent_date, witness_name.

RULES.
- Capture every fillable item: blanks, check boxes, tables, scores, signatures, dates and times. Do not invent items that
  are not in the documents; do not drop any. Printed text (instructions, legends) becomes paragraph fields.
- Ids follow NAMES and are unique across the form.
- Patient identifiers: an HN field is {{"id":"hn","type":"text","required":true,"indexed":true}} and the form gets
  "extensions":{{"flora.subject_field":"hn"}}. Index (indexed:true) only key fields people search by (HN, AN, dates).
- Mark required only what the paper marks as required (*, "ต้องกรอก") or what is plainly essential (HN).
- When the documents are unreadable in places, still build the rest and list those places in the report.

WHERE THE FORM IS FILLED IN (Flora Leaf). Leaf shows the case's anaesthesia record as tabs; Workflow Studio adds this
form as another tab. Suggest the phase ({", ".join(sorted(PHASES))}) and the built-in tab it should follow:
{_sections_table()}

ANSWER with exactly two blocks and nothing else:
<form_json>
{{ the complete form definition as strict JSON }}
</form_json>
<report>
{{"document_type":"what the document is","summary":"one or two sentences","language":"th|en|th+en",
 "coverage":[{{"source":"file name p.1","item":"item as printed","field":"field_id or null when not captured","note":"optional"}}],
 "uncertain":[{{"field":"field_id or null","note":"what to check"}}],
 "placement":{{"phase":"preop|intraop|postop|any","after_section":"one of the tab ids above or null","reason":"..."}}}}
</report>
List every fillable item of the documents in coverage, in paper order."""


def _request_text(files: list[SourceFile], instructions: str, form_id: str | None, title: str | None,
                  start: dict[str, Any] | None = None, focus: list[str] | None = None, measured: bool = False) -> str:
    """What the author asks: build from the documents, build from a description alone, or change an existing form
    (start), possibly only the fields they selected (focus)."""
    parts = ["Build the form from the documents above." if files else "Change the form below as the author asks." if start
             else "Build the form the author describes below (there are no documents)."]
    if start is not None and measured:
        # A draft the reading tools made from the pages (reading/): the paper's layout measured, its content to check.
        parts.append(f"\n--- a draft the tools read from the pages above (OCR, ruled lines, tables): every item's place and size "
                     f"(layout), the tables, the paper and the bordered sections (print_style) are measured from the paper ---\n"
                     + json.dumps(start, ensure_ascii=False)
                     + "\nLook at the pages and correct what the tools misread: labels (keep the printed wording, give label_en), field "
                       "types, options, table columns and rows, units, section titles; add what is missing and remove what is not "
                       "a field. Keep each item's id and layout, the paper and print_style, so the form looks like the document.")
    elif start is not None:
        parts.append(f"\n--- the current {FORMAT} form ---\n" + json.dumps(start, ensure_ascii=False)
                     + "\nKeep every id, label, option value and layout the author does not ask to change, so its records stay valid.")
        if focus:
            parts.append("The author selected these fields; the instructions are about them: " + ", ".join(focus))
    for source in files:
        if source.text:
            parts.append(f"\n--- {source.name} ({source.kind}, extracted text) ---\n{source.text}")
        if source.definition is not None:
            parts.append(f"\n--- {source.name}: an existing {FORMAT} definition; start from it and correct or extend it ---\n"
                         + json.dumps(source.definition, ensure_ascii=False))
    if form_id:
        parts.append(f"\nUse form_id \"{form_id}\".")
    if title:
        parts.append(f"Use the title \"{title}\".")
    if instructions.strip():
        parts.append(f"\nThe author's instructions (follow them unless they break the format):\n{instructions.strip()}")
    return "\n".join(parts)


def _anthropic_content(files: list[SourceFile], text: str) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = []
    for source in files:
        data = base64.standard_b64encode(source.content).decode("ascii")
        if source.kind == "pdf":
            content.append({"type": "document", "title": source.name, "source": {"type": "base64", "media_type": "application/pdf", "data": data}})
        elif source.kind == "image":
            content.append({"type": "text", "text": f"Image: {source.name}"})
            content.append({"type": "image", "source": {"type": "base64", "media_type": source.media_type, "data": data}})
    content.append({"type": "text", "text": text})
    return content


def image_limit(pages: int) -> int:
    """Longest side for each page image when a request carries `pages` of them."""
    return IMAGE_MAX_PX if pages <= 1 else max(768, int(IMAGE_MAX_PX * (0.8 if pages <= 3 else 0.6)))


def fit_image(data: bytes, media_type: str, longest: int) -> tuple[str, bytes]:
    """The image scaled down so its longest side is at most `longest` (JPEG), or as is when small or unreadable."""
    try:
        from PIL import Image  # installed with reportlab
        image = Image.open(io.BytesIO(data))
        if max(image.size) <= longest:
            return media_type, data
        image = image.convert("RGB")
        image.thumbnail((longest, longest))
        out = io.BytesIO()
        image.save(out, "JPEG", quality=85)
        return "image/jpeg", out.getvalue()
    except Exception:  # noqa: BLE001 - an image Pillow cannot read is sent unchanged; the host reports it
        return media_type, data


def _openai_content(files: list[SourceFile], text: str) -> list[dict[str, Any]]:
    pages: list[tuple[str, str, bytes]] = []
    for source in files:
        if source.kind == "pdf":
            # Pages rendered by the browser; for a scan, the page images inside the PDF itself.
            images = [("image/png", page) for page in source.page_images] or [("image/jpeg", page) for page in source.scan_images]
            pages += [(f"{source.name} p.{index + 1}", media, data) for index, (media, data) in enumerate(images)]
        elif source.kind == "image":
            pages.append((source.name, source.media_type, source.content))
    longest = image_limit(len(pages))
    content: list[dict[str, Any]] = []
    for label, media_type, data in pages:
        media_type, data = fit_image(data, media_type, longest)
        content.append({"type": "text", "text": f"Image: {label}"})
        content.append({"type": "image_url", "image_url": {"url": f"data:{media_type};base64,{base64.b64encode(data).decode('ascii')}"}})
    content.append({"type": "text", "text": text})
    return content


def needs_page_images(config: dict[str, Any]) -> bool:
    """OpenAI-compatible hosts cannot read PDF files: the browser sends each page as a PNG."""
    return config.get("api_format") == "openai"


class Conversation:
    """One build's exchange with the AI service (the first request, then corrections)."""

    def __init__(self, config: dict[str, Any], files: list[SourceFile], text: str, *, system: str | None = None,
                 content: list[dict[str, Any]] | None = None, end_tag: str = "</form_json>"):
        """system / content / end_tag let other AI steps share this client (reading/refine.py: line crops and a
        compact JSON instead of whole documents, answered between its own tags)."""
        self.config = config
        self.openai = config.get("api_format") == "openai"
        self.system = system or SYSTEM_PROMPT
        self.end_tag = end_tag
        if content is None:
            content = _openai_content(files, text) if self.openai else _anthropic_content(files, text)
        self.messages: list[dict[str, Any]] = [{"role": "user", "content": content}]
        self.max_tokens = MAX_TOKENS
        self.usage = {"input_tokens": 0, "output_tokens": 0, "requests": 0}

    def ask(self) -> str:
        self.usage["requests"] += 1
        return self._openai() if self.openai else self._anthropic()

    def follow_up(self, text: str) -> None:
        self.messages.append({"role": "user", "content": text})

    def _anthropic(self) -> str:
        import anthropic

        client = ai_service.anthropic_client(self.config, timeout=TIMEOUT_S)
        system = [{"type": "text", "text": self.system, "cache_control": {"type": "ephemeral"}}]
        try:
            try:
                with client.messages.stream(model=self.config["model"], max_tokens=self.max_tokens, system=system, messages=self.messages) as stream:
                    reply = stream.get_final_message()
            except anthropic.BadRequestError as error:
                # Older models have smaller output limits.
                if "max_tokens" not in str(error) or self.max_tokens == FALLBACK_MAX_TOKENS:
                    raise
                self.max_tokens = FALLBACK_MAX_TOKENS
                with client.messages.stream(model=self.config["model"], max_tokens=self.max_tokens, system=system, messages=self.messages) as stream:
                    reply = stream.get_final_message()
        except anthropic.AuthenticationError as error:
            raise BuildError("The AI service rejected the API key (Canopy → AI service).") from error
        except anthropic.BadRequestError as error:
            raise BuildError(f"The AI service refused the request: {getattr(error, 'message', error)}") from error
        except anthropic.RateLimitError as error:
            raise BuildError("The AI service is busy (rate limit); try again in a minute.") from error
        except anthropic.APIStatusError as error:
            raise BuildError(f"The AI service returned an error ({error.status_code}).") from error
        except anthropic.APIConnectionError as error:
            raise BuildError("Cannot reach the AI service.") from error
        if reply.stop_reason == "refusal":
            raise BuildError("The AI service declined to process these documents.")
        self.usage["input_tokens"] += (reply.usage.input_tokens or 0) + (getattr(reply.usage, "cache_read_input_tokens", 0) or 0)
        self.usage["output_tokens"] += reply.usage.output_tokens or 0
        self.messages.append({"role": "assistant", "content": reply.content})
        text = "".join(block.text for block in reply.content if getattr(block, "type", "") == "text")
        if reply.stop_reason == "max_tokens" and self.end_tag not in text:
            raise BuildError("The form is too large for one answer from this AI model; split the documents and build them one at a time.")
        return text

    def _openai(self) -> str:
        """Streamed: proxies in front of AI hosts (Cloudflare: 100 s) close a request that sends nothing back for
        a while (HTTP 524), and writing a whole form takes longer than that."""
        if not self.config.get("host"):
            raise BuildError("The AI service host is not configured.")
        body = json.dumps({"model": self.config["model"], "max_tokens": self.max_tokens, "temperature": 0, "stream": True,
                           "stream_options": {"include_usage": True},
                           "messages": [{"role": "system", "content": self.system}, *self.messages]}).encode("utf-8")
        headers = {"Content-Type": "application/json", "Accept": "text/event-stream, application/json", "User-Agent": ai_service.USER_AGENT}
        if self.config.get("api_key"):
            headers["Authorization"] = f"Bearer {self.config['api_key']}"
        if self.usage["requests"] == 1:
            self._warm_up(headers)
        for base in ai_service.openai_bases(self.config["host"]):
            request = urllib.request.Request(f"{base}/chat/completions", data=body, headers=headers, method="POST")
            try:
                with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
                    text, usage, finish = read_chat_stream(response)
            except urllib.error.HTTPError as error:
                if error.code in {404, 405}:
                    continue
                if error.code in {401, 403}:
                    raise BuildError("The AI service rejected the request (check the API key).") from error
                if error.code in {502, 503, 504, 520, 522, 524}:
                    raise BuildError(f"The AI service did not answer in time ({error.code}); it may be busy or the documents too large — try again or with fewer pages.") from error
                if error.code in {521, 523, 530}:
                    # Cloudflare: the AI server or the tunnel to it is down (e.g. error 1033), not this request.
                    raise BuildError(f"The AI server cannot be reached right now ({error.code}: its host or tunnel is down); try again later.") from error
                detail = error.read(300).decode("utf-8", "replace").strip()
                hint = "; check that the model reads images" if 400 <= error.code < 500 else ""
                raise BuildError(f"The AI service returned an error ({error.code}){': ' + detail if detail else ''}{hint}.") from error
            except (OSError, ValueError) as error:
                raise BuildError(f"Cannot reach the AI service ({type(error).__name__}).") from error
            self.usage["input_tokens"] += int(usage.get("prompt_tokens") or 0)
            self.usage["output_tokens"] += int(usage.get("completion_tokens") or 0)
            text = re.sub(r"<think>.*?</think>\s*", "", text, flags=re.S)
            if finish == "length" and self.end_tag not in text:
                raise BuildError("The form is too large for one answer from this AI model; split the documents and build them one at a time.")
            self.messages.append({"role": "assistant", "content": text})
            return text
        raise BuildError("No chat endpoint found at the AI service host.")


    def _warm_up(self, headers: dict[str, str]) -> None:
        """A one-token request first: hosts that swap models in and out spend up to a minute loading one, which would
        otherwise count against the build's own time limit at the proxy. Failures are ignored (the build reports)."""
        body = json.dumps({"model": self.config["model"], "max_tokens": 1, "messages": [{"role": "user", "content": "hi"}]}).encode("utf-8")
        for base in ai_service.openai_bases(self.config["host"]):
            try:
                with urllib.request.urlopen(urllib.request.Request(f"{base}/chat/completions", data=body, headers=headers, method="POST"), timeout=180) as response:
                    response.read()
                return
            except urllib.error.HTTPError as error:
                if error.code not in {404, 405}:
                    return
            except (OSError, ValueError):
                return


def read_chat_stream(response: Any) -> tuple[str, dict[str, Any], str | None]:
    """(text, usage, finish_reason) of an OpenAI-compatible chat answer: server-sent events, or one JSON body from
    hosts that ignore "stream". Reasoning text (reasoning_content) is left out."""
    if "text/event-stream" not in (response.headers.get("Content-Type") or ""):
        payload = json.load(response)
        choice = (payload.get("choices") or [{}])[0]
        return str((choice.get("message") or {}).get("content") or ""), payload.get("usage") or {}, choice.get("finish_reason")
    parts: list[str] = []
    usage: dict[str, Any] = {}
    finish = None
    for raw in response:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        try:
            event = json.loads(data)
        except ValueError:
            continue
        if isinstance(event.get("error"), dict):
            raise BuildError(f"The AI service stopped with an error: {str(event['error'].get('message') or '')[:200]}")
        usage = event.get("usage") or usage
        for choice in event.get("choices") or []:
            parts.append(str((choice.get("delta") or {}).get("content") or ""))
            finish = choice.get("finish_reason") or finish
    return "".join(parts), usage, finish


def _json_block(pattern: re.Pattern[str], text: str) -> tuple[Any, list[Issue]]:
    match = pattern.search(text)
    if not match:
        return None, [Issue("$", "invalid_json", "block missing")]
    return parse_json_strict(FENCE_RE.sub("", match.group(1).strip()))


def slug(text: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    if not value or not value[0].isalpha():
        value = f"form_{value}" if value else "form"
    return value[:64] if len(value) >= 2 else f"{value}_form"


def normalize(definition: dict[str, Any], form_id: str | None, title: str | None) -> dict[str, Any]:
    """The parts the author chose and the fixed top-level values, whatever the model wrote."""
    definition["format"] = FORMAT
    definition["schema_version"] = 1
    if form_id:
        definition["form_id"] = form_id
    elif not isinstance(definition.get("form_id"), str) or not FORM_ID.match(definition["form_id"]):
        definition["form_id"] = slug(str(definition.get("title") or "")) if definition.get("title") else f"ai_form_{int(time.time())}"
    if title:
        definition["title"] = title
    definition.setdefault("layout", {"type": "grid", "columns": 24})
    definition.setdefault("paper", {"size": "A4", "orientation": "portrait"})
    return definition


def clean_report(report: Any, definition: dict[str, Any]) -> dict[str, Any]:
    """The model's report, limited to known keys, with field references checked against the definition."""
    report = report if isinstance(report, dict) else {}
    ids = {field.get("id") for field in definition_fields(definition)}
    text = lambda value, limit=500: str(value)[:limit] if isinstance(value, (str, int, float)) else ""  # noqa: E731
    coverage = []
    for item in report.get("coverage") or []:
        if not isinstance(item, dict):
            continue
        field_id = item.get("field") if isinstance(item.get("field"), str) and item.get("field") else None
        coverage.append({"source": text(item.get("source"), 200), "item": text(item.get("item")), "field": field_id,
                         "found": field_id in ids if field_id else False, "note": text(item.get("note"))})
    uncertain = [{"field": item.get("field") if isinstance(item.get("field"), str) else None, "note": text(item.get("note"))}
                 for item in report.get("uncertain") or [] if isinstance(item, dict)]
    placement = report.get("placement") if isinstance(report.get("placement"), dict) else {}
    phase = placement.get("phase") if placement.get("phase") in PHASES else "any"
    after = placement.get("after_section") if placement.get("after_section") in SECTION_IDS else None
    return {
        "document_type": text(report.get("document_type"), 200), "summary": text(report.get("summary"), 1000),
        "language": text(report.get("language"), 20), "coverage": coverage[:500], "uncertain": uncertain[:200],
        "placement": {"phase": phase, "after_section": after, "reason": text(placement.get("reason"))},
        "missing": sum(1 for item in coverage if not item["found"]),
        "unknown_fields": sorted({item["field"] for item in coverage if item["field"] and not item["found"]}),
    }


def build(config: dict[str, Any], files: list[SourceFile], *, instructions: str = "", form_id: str | None = None, title: str | None = None,
          validate: Callable[[dict[str, Any]], list[dict[str, Any]]], start: dict[str, Any] | None = None, focus: list[str] | None = None,
          measured: bool = False) -> dict[str, Any]:
    """Ask the model for a definition and its report; correct validation problems up to MAX_REPAIRS times.

    Returns {definition, report, issues, attempts, usage, model}. Raises BuildError when no definition came back."""
    if not (config.get("model") or "").strip():
        raise BuildError("The AI service is not configured (Canopy → Account → AI service).")
    started = time.monotonic()
    conversation = Conversation(config, files, _request_text(files, instructions, form_id, title, start, focus, measured))
    definition: dict[str, Any] | None = None
    report: Any = None
    issues: list[dict[str, Any]] = []
    attempts = 0
    while attempts <= MAX_REPAIRS:
        attempts += 1
        answer = conversation.ask()
        value, parse_issues = _json_block(FORM_RE, answer)
        report_value, _ = _json_block(REPORT_RE, answer)
        if report_value is not None:
            report = report_value
        if not isinstance(value, dict) or any(issue.code == "invalid_json" for issue in parse_issues):
            if attempts > MAX_REPAIRS:
                break
            conversation.follow_up("Your answer did not contain a valid JSON object inside <form_json>...</form_json>. "
                                   "Answer again with both blocks; the JSON must be strict (double quotes, no comments, no trailing commas).")
            continue
        definition = normalize(value, form_id, title)
        issues = validate(definition)
        if not issues or attempts > MAX_REPAIRS:
            break
        listed = "\n".join(f"- {issue['path']}: {issue['code']}: {issue['message']}" for issue in issues[:60])
        conversation.follow_up(f"The validator found {len(issues)} problem(s) in the form:\n{listed}\n"
                               "Fix every one and answer again with the complete corrected <form_json> and the <report>. "
                               "Keep everything that was right.")
    if definition is None:
        raise BuildError("The AI service did not return a usable form definition; try again or add instructions.")
    report_clean = clean_report(report, definition)
    placement = {key: report_clean["placement"][key] for key in ("phase", "after_section")}
    extensions = definition.setdefault("extensions", {})
    if isinstance(extensions, dict):
        # A key of its own under extensions: it cannot add a problem, so the issues found above still hold.
        extensions[PLACEMENT_KEY] = placement
    else:
        # extensions is already reported invalid; the suggestion is kept in the report, not lost silently.
        report_clean["placement_not_stored"] = True
    return {"definition": definition, "report": report_clean, "issues": issues, "attempts": attempts,
            "usage": {**conversation.usage, "seconds": round(time.monotonic() - started, 1)}, "model": config.get("model")}
