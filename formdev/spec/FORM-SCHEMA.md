# FormDev form schema (Phase 1)

Format `flora.form/1`. JSON Schema: [form-definition.schema.json](form-definition.schema.json). Rules the JSON Schema
cannot express are enforced by twin validators, Python
([definition.py](../../services/flora-api/app/formdev/definition.py)) and TypeScript
([validate.ts](../../frontend/src/formdev/core/validate.ts)), which run the same fixtures in
[fixtures/](fixtures). Every Phase 1 property is optional, so definitions written before Phase 1 stay valid
and stored records need no migration.

Reference example: [examples/phase1-showcase/v1.form.json](../examples/phase1-showcase/v1.form.json).

## 1.1 Top level

| Property | Meaning |
| --- | --- |
| `format`, `form_id`, `schema_version`, `title`, `description` | Identity (unchanged) |
| `metadata` | Free-form object (owner, department, tags), preserved verbatim |
| `paper` | `"A4"` (and A5, Letter, screen) or an object, see 1.6 |
| `style_id` or `style: {id, override}` | Form style (registry id) plus an instance override, see 1.8–1.9. One of them is required; if both are given they must agree |
| `font_id` | Font registry id that overrides the style's `fontId` |
| `layout` | `{type: "grid", columns: 12, gap_mm}`, see 1.5 |
| `calculators` | `[{id, name?, description?, formula, output?: {type, decimals, unit}}]`; formulas reference field keys and are evaluated by the Phase 2 engine (never `eval`) |
| `permission` | `{view, create, edit, delete, export}`: lists of role codes (enforced in Phase 2) |
| `sections` | Sections (nestable, see 1.5) |
| `migration`, `extensions`, `offline` | Unchanged |

## 1.2 ID system

| Id | Pattern | Scope |
| --- | --- | --- |
| `form_id` | `^[a-z][a-z0-9_]{1,63}$` | Installation |
| `section_id` | `^[a-z][a-z0-9_]{0,63}$` | Form (all nesting levels) |
| field `id` | same | Form (all levels, including group and repeat children): the field's permanent identity |
| field `key` | same | Data scope: the name in record data, formulas, conditions, queries and policies. **Defaults to `id`** |
| `record_id` | UUID | Installation (client-generated, offline-safe) |
| `style_id`, `font_id` | `^[a-z][a-z0-9_.-]{1,63}$` (for example `style.a4.medical`) | Registry |
| `calculator_id` | `^[a-z][a-z0-9_]{0,63}$` | Form |

Renaming a field's key changes the data key, so it needs a `rename_field` migration in the next version
(the publish guard enforces this). Changing only its `id` does not touch data.

## 1.3 Field types (registry)

The registry is [field-types.json](field-types.json); the runtimes' tables must equal it (tested). A row
says how values are stored (`value`), their Phase 4 query family, their index column family, and which
properties apply. Adding a type means one registry row, one value validator and one renderer input.

| Type | Stored value | Indexable | Type-specific properties |
| --- | --- | --- | --- |
| `text`, `textarea` | string | text only | `max_length`, `placeholder` (`unit` and `derive` for text) |
| `number`, `integer`, `decimal` | number | yes | `unit`, `min`, `max`, `placeholder`, `decimals` (decimal, default 2) |
| `date`, `datetime`, `time` | ISO string | yes | — |
| `select`, `radio` | option value | yes | `options` or `lookup` (Phase 2.3) |
| `multiselect` | list of option values | no | `options` or `lookup` (Phase 2.3) |
| `checkbox`, `switch` | boolean | yes | — |
| `file`, `image` | `{name, mime, size, ref}` (list when `multiple`) | no | `accept` (MIME list; image defaults to `image/*`), `max_size_kb`, `multiple` |
| `signature` | `{data: PNG/SVG data URL, signed_at?, signer?}` | no | `max_size_kb` (default 256) |
| `calculated` | number | yes | `formula` or `calculator`, `unit`, `decimals` |
| `group` | none (children are stored in the same scope) | — | `fields`, `columns` |
| `repeat` | list of item objects keyed by child keys | no (children neither) | `fields`, `columns`, `min_items`, `max_items` |

Properties that do not apply to a type are refused (`property_not_supported`). Groups and repeats nest at
most four levels deep. File bytes are not part of the record: `ref` points at storage provided by the host
(the renderer marks new files `pending:` until they are uploaded).

## 1.4 Visible, readonly, required, display policy

`visible` (or the older `hidden`), `readonly` and `required` work as before; `required` can also live in
`validation`. The display policy says where a value appears:

```json
"display": { "form": false, "table": false, "detail": false, "query": true, "export": true }
```

`form` defaults to the field's visibility; the other contexts default to `true`. Effects: the form and the A4
print skip `form: false`, the record table shows `table: true` fields, the read-only record view shows
`detail: true` fields, the Phase 4 query catalog leaves out `query: false` fields, and export jobs refuse
`export: false` fields (`field_not_exportable`). Values are always stored.

## 1.5 Layout

The form grid is `layout: {type: "grid", columns: 12, gap_mm}` (1–24 columns). A section may change its
grid (`columns`) or lay out its fields as one `row` or one `column`; groups and repeats have their own
`columns`. Sections nest (`sections` inside a section).

A field places itself with `layout: {col, row, span, page_break, responsive}`; `responsive` has `desktop`,
`tablet`, `mobile` and `print` rules (`span`, `col`, `hidden`). Without a rule: mobile uses full width;
other modes use `layout.span`, else full width for textarea, multiselect, group, repeat and signature, else
`columns / style token columns`. The validator refuses spans wider than the grid (`invalid_span`),
placements past the last column (`layout_out_of_bounds`) and explicit cells that overlap (`layout_overlap`).
Modes are chosen by width (desktop ≥ 1024 px, tablet ≥ 640 px) or fixed by the preview.

## 1.6 A4

```json
"paper": { "size": "A4", "orientation": "portrait",
  "margin_mm": { "top": 18, "right": 12, "bottom": 16, "left": 15 },
  "header": { "left": "{title}", "right": "{record_id}", "height_mm": 8 },
  "footer": { "center": "หน้า {page}/{pages}", "first_page": true } }
```

A4 is 210 × 297 mm (landscape swaps the sides). Margins come from the definition, then the style's
`pageMargin*` tokens, then 15 mm. Band text may use `{title} {form_id} {version} {page} {pages} {date} {record_id}`
(others are refused). Page breaks: `page_break` on a section (`before`, `after`, `avoid`) or a field
(`layout.page_break`). The print layout is a separate renderer
([FormPrint.tsx](../../frontend/src/formdev/ui/FormPrint.tsx)): fixed sheets in mm, values drawn as on paper
(○/● for options, ☐/☑ for check boxes, dotted lines to write on when empty, repeats as tables), and `@page`
rules so `window.print()` produces A4 with the bands and page numbers in the page margin boxes.

## 1.7 Font registry

[registry/fonts.json](../registry/fonts.json) keeps four things apart: the registry id, `metadata` (family,
category, scripts, weights, licence), `assets` (`bundled` package, `system` font, uninstalled
`web_alternative`) and the `fallback` chain. Forms and styles only name a `font_id`. The 13 Thai national
fonts plus TH Sarabun New are registered as metadata only: no font files are in the repository (a test checks
this) and nothing is downloaded. They resolve to the workstation's installed copy and otherwise fall back to the
bundled Noto Sans Thai. Their licence text must be checked before any file is bundled (`license_verified: false`).

## 1.8 Style registry and 1.9 inheritance

A style ([registry/styles.json](../registry/styles.json)) is
`{name, category: base|form|section|field, inherit?, paper?, tokens, components?}`. Tokens are listed in
[style-tokens.json](style-tokens.json) (pt for type sizes, mm for lengths); `components` hold token
subsets for `label`, `input`, `section`, `header` and `footer`. Shipped styles include `style.base`,
`style.a4.default`, `style.a4.medical`, `style.a4.official`, `style.a4.compact`, `field.text.default`,
`field.number.large` and `section.header`; the older ids `form.a4.medical`, `form.a4.official` and
`form.screen.default` are kept as aliases.

The cascade is base style → form style → section style → field style → instance override. A style's chain
(`inherit`) is applied first, then `override`, so changing one property is
`"style": {"id": "form.a4.medical", "override": {"fontSize": 14}}` instead of a copied style. Overrides are
checked against the token list (`unknown_style_token`, `invalid_style_token`); registry rows are checked for
unknown parents and cycles (`style_cycle`) and when an administrator saves them.

Administrators add or change styles and fonts at run time with `PUT /api/formdev/styles/{style_id}` and
`PUT /api/formdev/fonts/{font_id}` (validated the same way; a style's version goes up by one). A later
registry release replaces a built-in style only when it carries a higher version.

The registry JSON is the single source for five generated copies (`formdev/scripts/sync_registry_seed.py`):
the seed blocks of `0060-formdev.sql` and `sqlite_schema.sql`, the upgrade migrations
`0062-formdev-registry.sql` and `sqlite_0003_registry.sql` (a row is replaced only by a newer registry
version), and `frontend/src/formdev/registry/defaults.ts` for offline use.

## 1.10 Validator

Checks required properties, types, enums, unknown properties (`unknown_property`), properties that do not
apply (`property_not_supported`), duplicate ids and keys, invalid ids, and broken references: style ids,
font ids (also inside overrides), calculator references (`unknown_calculator`), field references in conditions
(`unknown_field_reference`, resolved within the repeat item, then the form), the subject field, migration
targets and layout bounds. Duplicate JSON object keys, which `JSON.parse`/`json.loads` would silently collapse,
are reported by `parse_json_strict` / `parseJsonStrict` (`duplicate_json_key`); `POST /api/formdev/validate`
reports them and `POST /forms` and `PUT /forms/{id}/versions/{v}` refuse them.

Messages: every code has Thai and English text in [messages.json](messages.json) (generated into both
runtimes; a test fails if a code has no text). The UI shows Thai when Canopy's language is Thai; the API adds
`message_th` to described issues. Every issue has a readable `location`, for example
`Section "การประเมินแรกรับ" › Section "ยาที่ใช้ประจำ" › Field "รายการยา" (meds) › Field "ขนาด" (dose) › layout.span`, or for
record data `Field "รายการยา" (meds) › Item 2 › Field "ขนาด" (dose)`.

| Code | Meaning |
| --- | --- |
| `invalid_field_key`, `duplicate_field_key` | Key pattern; key repeated in one data scope |
| `property_not_supported` | Property does not apply to the field type |
| `container_requires_fields`, `too_deep` | Group/repeat without children; nesting past four levels |
| `invalid_decimals`, `invalid_accept`, `invalid_max_size` | Type-specific property values |
| `calculated_formula_conflict`, `unknown_calculator`, `invalid_calculator_id`, `duplicate_calculator_id`, `invalid_formula` | Calculators |
| `conflicting_visibility` | `visible`, `hidden` and `display.form` disagree |
| `invalid_layout`, `invalid_columns`, `invalid_span`, `layout_out_of_bounds`, `layout_overlap`, `invalid_page_break` | Layout |
| `invalid_margin`, `invalid_band`, `unknown_template_token` | Paper |
| `style_mismatch`, `unknown_style_token`, `invalid_style_token` | Styles |
| `invalid_condition`, `invalid_operator`, `unknown_field_reference` | Visibility conditions |
| `invalid_permission`, `invalid_role` | Permissions |
| `invalid_rule`, `rule_not_supported`, `invalid_pattern`, `conflicting_rule` | Validation rules |
| `duplicate_json_key`, `invalid_json` | Strict parsing |
| `too_many_decimals`, `invalid_file`, `file_type_not_allowed`, `file_too_large`, `invalid_signature`, `too_many_items`, `too_few_items` | Record values |

## 1.11 Preview

The Form Dev page has a **Preview** tab ([FormPreview.tsx](../../frontend/src/formdev/ui/FormPreview.tsx)):
paste JSON, load a `.json` file or pick a published form, see readable problems, and render the form as
Desktop, Tablet, Mobile or A4 Print (with a Print button). It works offline with the bundled registry and
uses the server's registry when reachable. Opening a record shows its read-only detail view, with Edit and
A4 / Print.

Validation rules beyond `required`, `min`, `max` and `max_length` (pattern, email, numeric, length and date
ranges, custom rules), conditional visibility, calculators, dependencies, Answer + Other and permissions are
validated structurally here and run by the Phase 2 logic engine ([LOGIC.md](LOGIC.md)). Text fields may
also carry `derive` (a value from a lookup table, Phase 2.3).
