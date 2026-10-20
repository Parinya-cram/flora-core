# Form Studio: AI form builder and template library

Turns hospital documents into `flora.form/1` forms, checked by the same validator as every form, kept as
templates for review before anything reaches data entry or Flora Leaf.

> Reading a document with tools first (text layer, Thai OCR, shapes) and asking the AI only about the parts the tools
> are unsure of, the designer's AI panel and the variable-name standard: [FORM-STUDIO-V2.md](FORM-STUDIO-V2.md).
> The whole-document build below remains for documents the tools cannot read.

```
documents ──► check every file ──► AI writes the form ──► validator (≤ 2 automatic corrections)
                                                              │
   Workflow Studio ◄── publish ◄── form (draft v1) ◄── review against the originals ◄── draft template
   (Leaf tab, phase, note)
```

## 1. Documents (`app/formdev/documents.py`)

Every file is identified by its content (not its name): PDF, PNG / JPEG / WEBP / GIF, Word `.docx`, Excel `.xlsx`,
text / CSV, and `.form.json` (a `flora.form/1` definition). The check reports per file `ok | warning | error`:

| Finding | Status |
|---|---|
| encrypted / password-protected PDF, old `.doc` / `.xls`, empty, unreadable, unsupported type | error (stops the build) |
| more than 100 PDF pages, more than 20 MB per file, 30 MB in total, 10 files | error |
| PDF without a text layer (scan), small image, pictures inside a Word file, cut-short PDF | warning |

Word and Excel text (with tables as `a | b | c` rows) is extracted on the server with the standard library.
`POST /api/formdev/ai/inspect` runs the check alone (and validates `.form.json` files) without calling the AI.

## 2. Build (`app/formdev/ai_builder.py`, `POST /api/formdev/ai/generate`)

* Uses the shared AI service (Canopy → Account → AI service): the Anthropic API (PDFs and images are sent as
  documents / images) or an OpenAI-compatible host (the browser renders PDF pages to PNG with pdf.js, because those
  hosts cannot read PDF files).
* The model gets the format guide (built from the field-type registry, so it lists exactly what the validator
  accepts), the documents, the extracted text and the author's instructions, and answers with `<form_json>` and a
  `<report>`: document type, every fillable item on the paper → the field it became, what it was unsure about, and
  the suggested Leaf placement (phase and the built-in tab it follows).
* The definition is validated; problems go back to the model at most twice. Whatever remains is returned with the
  issues and fixed by the author in the designer.
* A single `.form.json` without instructions is imported as is (no AI).
* The result is stored as a **draft template** with the report, and the source documents are kept in the attachment
  store so reviewers see them beside the form. Nothing is published automatically.
* The request takes minutes; authentication and storage use short database connections, never one held across
  the AI call. Limits: `FORMDEV_AI_MAX_TOKENS` (default 32000), `FORMDEV_AI_TIMEOUT_S` (default 600).

Privacy: documents leave the hospital network when the AI service is a cloud API. Use blank forms; the builder
shows this warning next to the build button.

## 3. Template library (`app/formdev/templates.py`, table `formdev_template`)

`/api/formdev/templates` (Form Studio authors, `studio.manage`): list, get (with validation issues), create
(`manual | import`), update `{version, title?, description?, definition?, status?}` (optimistic: a stale `version`
is `409 version_conflict`), delete, `GET …/sources/{sha256}` (an original document), `POST …/forms {form_id, title?}`
(a Form Studio form, draft version 1).

* `status`: `draft` → `reviewed` only when the definition has no validation problems; changing the definition of a
  reviewed template makes it a draft again.
* Migrations: PostgreSQL `0087-formdev-template.sql` (also in `formdev/deploy/formdev-install.sql`), SQLite
  migration 7, MySQL `mysql_0003_template.sql`.

## 4. Form Studio screens (`frontend/src/formdev/ai/`)

* **Templates / AI** tab: the library, the paper forms that ship with Form Studio (add them to the library to edit
  them), and **Build from documents with AI** (drop files → per-file check → title, form id, instructions → build).
* Review: the original document beside a checklist (item on paper → field, items not captured in red), what the AI
  was unsure about, validation problems, the form on screen and as A4 PDF, and the Leaf placement (editable).
  Actions: edit in the designer (saved back to the template), mark reviewed, create a form, download `.form.json`.
* Designer: **Keep as template** saves the open form into the library.

## 5. Workflow Studio and Flora Leaf

The placement is stored in the form (`extensions["flora.leaf_placement"] = {phase, after_section}`), so it travels
with the published version. Workflow Studio offers it as the default when the form is added and shows it when the
workflow differs ("Use it"). Each workflow form has `phase`, `after_section` and a `hint`; Leaf shows the form's
tab right after `after_section` (forms placed nowhere, or after a tab the case does not show, come last) and the
hint above the form. See `docs/workflow-studio.md`.
