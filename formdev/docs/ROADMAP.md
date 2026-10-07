# FormDev target architecture and roadmap

Target (agreed 2026-10-06):

```
┌─────────────────────────────────────────────┐
│              FORM DESIGNER                  │
│   Drag & Drop / JSON / Text / Template      │
└──────────────────────┬──────────────────────┘
                       ▼
┌─────────────────────────────────────────────┐
│             FORM SCHEMA ENGINE              │
│ Form / Section / Category / Field / Rule    │
└──────────────────────┬──────────────────────┘
          ┌────────────┴────────────┐
          ▼                         ▼
┌───────────────────┐      ┌───────────────────┐
│   RENDER ENGINE   │      │   QUERY ENGINE    │
│ Web / Print / PDF │      │ Filter / Index    │
│ Mobile / Offline  │      │ Aggregate / Page  │
└───────────────────┘      └─────────┬─────────┘
                                     ▼
                         ┌─────────────────────┐
                         │     DATA LAYER      │
                         │ SQLite / PostgreSQL │
                         │ MySQL / API / File  │
                         └─────────────────────┘
```

## Status per box

| Box | Part | Status | Where / plan |
| --- | --- | --- | --- |
| Form designer | JSON | Done | Design panel (validate, create, publish), Preview tab (load JSON or a published form) |
| | Drag & Drop | Done (Designer) | Drag & drop designer with conditions, calculations, lookups, permissions, try-it, A4, auto-migration on publish ([DESIGNER.md](DESIGNER.md)) |
| | Text | Planned: Phase 5 | Text DSL with JSON ↔ text round trip |
| | Template | Planned: Phase 5 | Template registry; clone and edit |
| Form schema engine | Form, Section, Field | Done (Phase 1) | `flora.form/1`, [FORM-SCHEMA.md](../spec/FORM-SCHEMA.md) |
| | Category | Done (Phase 2) | A named sub-group inside a section (section → category → field) |
| | Rule | Done (Phase 2) | Validation, visibility, dependency (lookups), formula engine, permission, logic graph; Python and TypeScript twins ([LOGIC.md](../spec/LOGIC.md)) |
| Render engine | Web, Mobile, Offline | Done (Phases 1, 3) | `FormRenderer` (responsive), IndexedDB offline client |
| | Print | Done (Phase 1) | `FormPrint` (A4 sheets, `@page`) |
| | PDF | Done (Designer) | `render/formPdf.ts`: A4 PDF from a form or a record (pdf-lib + bundled Noto Sans Thai, text shaped by fontkit); "ดาวน์โหลด PDF" in the record view and the designer |
| Query engine | Filter, Index, Aggregate, Page | Implemented (Phase 4), not accepted | 47 confirmed defects and the performance report remain |
| Data layer | SQLite, PostgreSQL, API | Done (Phase 3) | `SQLiteAdapter`, `PostgreSQLAdapter`, `RestApiAdapter` |
| | MySQL | Planned: data-layer phase | `SqlDataAdapter` subclass with PyMySQL; same contract suite |
| | File | Planned: data-layer phase | (1) storage for file/image/signature bytes (today only a `pending:` reference), (2) a file-based adapter (JSON files) for the simplest standalone setup |

## Order

1. ~~Phase 2: form logic engine (Rule), beginning with Category.~~ Done.
2. ~~Designer phase: drag & drop designer with rules editor, PDF output.~~ Done.
3. Data-layer phase: MySQL adapter, attachment storage, file adapter.
4. Phase 4 fixes (47 findings) and the large-data performance report.
5. Phase 5: Text DSL, templates, AI generator.

Each phase ends with a report in the format of Flow-Form.md section 9 (A–I, PASS/FAIL per criterion, only after executed tests).
