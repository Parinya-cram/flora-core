# FormDev logic engine (Phase 2)

The logic lives in the definition and runs in two twin engines, Python
(`services/flora-api/app/formdev/logic/`) and TypeScript (`frontend/src/formdev/logic/`), checked against the
same fixtures. The client runs it for live feedback and offline use; the server runs it again on every write
and its result wins. No `eval`, no `new Function`, no executable code in form JSON.

## 2.0 Category

A section may hold `categories`: named sub-groups between section and field (section → category → field).

```json
{ "id": "vitals", "title": "สัญญาณชีพ", "categories": [
  { "id": "bp", "title": "ความดันโลหิต", "layout": { "columns": 12 }, "fields": [ ... ] } ] }
```

Keys: `id`, `title`, `description`, `fields` (required, non-empty), `layout`, `style`, `visibility`,
`permission`, `page_break`, `repeat`. Category ids are unique in the form. Category fields share the section's
data scope. Render order inside a section: fields, then categories, then nested sections.

## 2.4 Formula language

Formulas reference **field keys**.

| Element | Syntax |
| --- | --- |
| Numbers | `12`, `3.5`, `1e3` |
| Text | `'text'` or `"text"` (`\'`, `\"`, `\\` escapes) |
| Literals | `TRUE`, `FALSE`, `NULL` (keywords are case-insensitive) |
| Field | `weight_kg`; inside a repeat item a name resolves to the item first, then the form |
| Repeat column | `meds.dose` (from outside the repeat): the list of that child's values |
| Arithmetic | `+ - * / % ^` (`^` is right-associative and binds tighter than unary `-`; `%` is the remainder) |
| Comparison | `= == != <> < <= > >=` |
| Logic | `AND`, `OR`, `NOT` (short-circuit) |
| Functions | `IF(c, a, b)`, `MIN`, `MAX`, `SUM`, `AVG`, `COUNT` (1+ arguments; lists are flattened, nulls ignored), `ROUND(x[, digits])` (half away from zero), `FLOOR`, `CEIL`, `ABS`, `SQRT`, `COALESCE(a, ...)`, `ISBLANK(x)`, `AGE(date[, on])` (completed years), `DAYS(from, to)`, `TODAY()` |

Precedence, lowest first: `OR`, `AND`, `NOT`, comparison, `+ -`, `* / %`, unary `-`, `^`.

Values are numbers, text, booleans, null, or lists (repeat columns). Rules that keep results predictable:

- Arithmetic with null, or with a non-number, gives null; dividing by zero gives null; a non-finite result is null.
  So BMI stays empty until weight and height are both entered.
- `=` is true for equal values of the same type, and for null = null. Ordering comparisons (`< <= > >=`) with
  null give null, so a rule with a missing input passes and `AND`/`OR`/`IF` treat it as false.
- `AGE` of a date after the reference date is null.
- `AND`, `OR`, `NOT` treat null, false, 0, empty text and empty lists as false.
- `SUM` of nothing is 0. `AVG`, `MIN`, `MAX` of nothing are null.
- Dates are ISO text; `TODAY()` is the date in Asia/Bangkok, or the engine's injected clock in tests.

Limits: 2000 characters, 1000 tokens and 64 levels of nesting (`formula_too_complex`). Definition checks:
`formula_syntax` (with the column), `unknown_function`, `invalid_arguments`, `unknown_field_reference`.

## 2.5 Calculators

`calculators: [{id, formula, output: {type, decimals, unit}}]`, referenced by `"calculator": "<id>"` from a
`calculated` field (or an inline `formula`). The result is rounded to the field's `decimals`, else the
calculator's. Output type `text` or `boolean` is allowed (for example a BMI class); only numeric outputs can be
indexed. [registry/calculators.json](../registry/calculators.json) holds templates (BMI, BMI class, MAP, BSA,
age, percentage, total score, Morse fall risk level, sub-score) with named parameters and checked examples;
instantiating one maps parameters to field keys. No calculator is written in UI code.

## 2.1 Validation engine

The field rules from Phase 1 (`required`, `min`, `max`, `min_length`, `max_length`, `pattern`, `email`,
`numeric`, `min_date`, `max_date`, `message`) all run. Custom rules:

```json
"validation": { "rules": [ { "assert": "bp_sys > bp_dia", "message": "ความดันตัวบนต้องมากกว่าตัวล่าง" } ] }
```

Form-level `rules: [{id, assert, message, fields: [keys]}]` check several fields; each issue is reported on
every listed field. A rule whose formula is null (missing inputs) passes. Errors are bound to `$.data.<key>`
(`$.data.<repeat>[i].<key>` inside repeats).

## 2.2 Visibility

`visibility.when` (Phase 1 structure) is evaluated against the current values. Operators: equals, not_equals,
gt, gte, lt, lte, in, not_in, exists (has a value), empty; `and` / `or` nest. A hidden section or category hides
everything in it. Hidden fields are not shown, not required and not validated. **Values are kept**
unless the field sets `clear_when_hidden: true`.

## 2.3 Dependency

Example: [examples/phase2-dependency](../examples/phase2-dependency/v1.form.json) (province → district →
sub-district → postcode, scheme → benefits, lookups inside a repeat section).

- **Option conditions.** An `options` entry may carry `when` (a 2.2 condition); only matching options are
  offered. The same mechanism covers diagnosis → treatment.
- **Lookup options.** `lookup: {source, value, label?, filter?: {column: field_key}}` on select, radio and
  multiselect fields (instead of `options`) offers the distinct `value` column of the rows of lookup table
  `source` whose filter columns equal the named fields' values. A filter on an empty value matches nothing
  (no districts until a province is chosen). Inside a repeat item a key resolves to the item first.
- **Derived values.** `derive: {lookup, column, match: {column: field_key}}` on text fields sets the value
  to `column` of the first row matching every `match` pair (empty when none does). The server recomputes it,
  as it does calculated values.
- **Trigger and clear.** Evaluation follows the logic graph, so a source is settled before its dependants.
  A value (or multiselect selection) no longer offered is cleared, then derived values are recomputed. The
  renderer passes the evaluated record back on every edit, so a cleared value does not return when the
  source is switched back. Submitting with a cleared required field reports `required`.
- **Missing tables.** A lookup table that is not available to the engine is skipped: its options are not
  checked and its derived values are left as they are (an offline device that has not pulled the table
  yet keeps what the user chose; the server, which always has the registry, decides).

### Lookup tables

`{lookup_id, version, metadata: {title, columns: [{name, label}], authoritative, notice?, source?}, entries:
[{column: text}]}` (≤ 50 000 rows, ≤ 32 columns, text values ≤ 500 characters). Stored in `formdev_lookup`,
served by `GET /lookups` and `GET /lookups/{id}`, replaced by administrators with `PUT /lookups/{id}`
(version + 1), packed into formpacks, pulled into IndexedDB with the catalog for offline use.

[registry/lookups/thai_address.json](../registry/lookups/thai_address.json) is a **13-row sample**
(`authoritative: false`) for development and tests only. Load the official list with
[scripts/import_lookup.py](../scripts/import_lookup.py) from your own CSV copy (it maps CSV headers to
columns, drops blank and duplicate rows, validates as the server does, and writes a registry file or
uploads to the API). Nothing is downloaded by FormDev.

## 2.6 Answer + Other

An option may set `has_input: true`. The answer stays `"other"` (still searchable and indexable); the text is
stored in `data._other.<key>` (inside an item: `item._other.<key>`). `input_required: true` makes the text
mandatory (`other_text_required`). Text for an option that is not selected is dropped.

## 2.7 Repeat

`repeat` fields (Phase 1) plus repeat **sections and categories**: `"repeat": {"key", "min_items", "max_items"}`
turns the block into a list stored under `key`. Items can be added, removed and reordered; logic inside an item
sees the item first, then the form.

## 2.8 Permission

Codes are Flora's RBAC role codes (`system_admin`, `clinical_admin`, `clinician`, `viewer`, ...) or permission
codes. Levels: form (`view`, `create`, `edit`, `delete`, `export`), section and category (`view`, `edit`), field
and group (`view`, `edit`, `export`).

```json
"permission": { "view": ["clinician", "clinical_admin"], "edit": ["clinician"] }
```

- For each action the **innermost** level that sets a list decides (field → group → category → section → form);
  a level without that action inherits it, and nothing set anywhere means allowed. An inner list can therefore
  widen as well as narrow. Administrators (`system_admin`, or `formdev.manage`) pass everything.
- Editing and exporting a field need viewing it. A repeat can be edited only when every child in it can (items
  are added, removed and reordered as a whole).
- Record actions: `create` and `delete` are the form's. A record can be `edit`ed when at least one field is
  editable (fields inherit the form's `edit`, so without field grants the form's list decides).

Enforcement (twins `logic/permission.py` / `permission.ts`, fixture `spec/fixtures/permission-cases.json`):

| Where | What |
| --- | --- |
| Renderer (`roles` prop) | Fields the user may not view are not rendered (a group, category or section with nothing viewable disappears); fields they may not edit are disabled; a form they may not view shows a notice. Print leaves out what they may not view. Without `roles` (designer preview) nothing is filtered. |
| Reads (`/records`, revisions, conflicts, sync acks) | Fields the user may not view are removed, including repeat children (`meds.cost`) and their Other text. A form they may not view is `forbidden` (403). |
| Sync writes | `create` / `edit` / `delete` refused → the op is acknowledged `rejected` with `forbidden`. Fields the user may not view or edit keep their stored values on update and are dropped on create. |
| Query and export | The form's `view` joins the source's query access, its `export` the export access; a field's `view` joins the field's read access and its `export` is checked per selected field (`field_not_exportable`). |

The server uses the latest published version's permissions.

## 2.9 Versioning

A record is evaluated with its own schema version. Calculated values are recomputed by the server from that
version and overwrite client values.

## 2.10 Logic graph

Nodes are field keys; edges come from formulas, calculators, visibility conditions, option conditions,
lookups, derivations and rules. A cycle is refused when the definition is validated (`circular_dependency`,
with the cycle path), and evaluation follows the graph's topological order.
