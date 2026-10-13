# OR billing checklist

Digital version of the hospital's paper "Anesthesia Check List (Billing)": nurses or
anesthetists tick the drugs, fluids, supplies and techniques used in a case, with
quantities, times and four signatures. The Leaf records it per case; Canopy owns the
item master and receives every order.

## Data

| Table | Where | Purpose |
| --- | --- | --- |
| `billing_group` | Canopy (master) → Leaf copy | Groups on the form (Gas, Induction Agent … PACU care), `form_column` 1–4 |
| `billing_item` | Canopy (master) → Leaf copy | 106 seeded items: `unit`, `qty_mode` (`count` / `hours` / `used`), `variant_label` (e.g. "No." for IV cath size), `io_item_code` (link to the I/O catalogue), `charge_code`, `unit_price` |
| `case_billing_order` | Leaf | One live order per case: status `draft` / `submitted`, anesthesia and surgery times, discharge location, `signers` (surgeon, anesthesiologist, nurse 1, nurse 2) |
| `case_billing_order_item` | Leaf | Order lines: item code (or free text), variant, qty, unit, price snapshot, `source` (`manual` / `io_suggestion`) |
| `canopy_case_billing` (+ `_item`) | Canopy | Structured copy of each case's order for billing staff and reports |

Migration: `infrastructure/postgres/0080-billing.sql` (seed generated from
`infrastructure/catalog/billing-anesthesia-checklist.csv` by
`scripts/catalog/build_billing_migration_seed.py`). Permission `billing.manage` edits the master.

## Sync

- **Master, Canopy → Leaf**: rides on the directory exchange (`billing_catalog`, versioned by the
  latest `updated_at`); the Leaf upserts by `code` and never deletes (`app/billing.py`).
- **Orders, Leaf → Canopy**: the case snapshot carries `billing` (`GET /api/case/{id}/billing`);
  sync ingest projects it into `canopy_case_billing`. Handover export carries the order too.

## Screens and API

- Leaf **Billing** (case sidebar): the form's four columns of tick boxes and quantities; **Fill from
  chart** adds times (Start/End Anesthesia, Start/End Surgery events), signers (case staff),
  technique (form anesthesia types) and doses charted in I/O; autosave; **Submit** locks it,
  **Reopen** unlocks; **Print** gives the A4 paper layout.
- Canopy **OR Billing**: orders by date / status / patient with item totals, order detail and print;
  **Item master** to edit name, unit, charge code, price, I/O link and active flag.
- Leaf: `GET /api/case/billing/catalog`, `GET|PUT /api/case/{id}/billing`, `POST …/submit`, `POST …/reopen`.
- Canopy: `GET /api/fleet/billing/catalog`, `PUT /api/fleet/control/billing/items/{code}`,
  `PUT /api/fleet/control/billing/groups/{code}`, `GET /api/fleet/billing/orders[/{global_case_id}]`.

## Itemize templates (Workflow Studio)

Canopy → Workflow Studio → **Itemize templates** holds standing-order lists for the checklist
(`canopy_billing_template`, migration `0081-billing-templates.sql`, format
`flora-billing-template/1`, `app/billing_templates.py`):

- Groups in display order, each with billing-master items in order; per item a default
  quantity and **Preselect** (ticked when the case's billing is first opened).
- **Leaf may add other items** lets the Leaf add any master item ("Additional items").
- Draft → Publish (validated: items exist and are active, no duplicates) → Archive (refused while a
  published workflow uses it); Duplicate to start a variant.
- A workflow picks its template under **Billing** (`definition.billing.template_id`); many
  workflows can share one. Publishing a workflow needs its template published.

Delivery: published templates referenced by a ward's workflows ride on the ward exchange
(`workflows.leaf_delivery` → `billing_templates`); the Leaf caches them and the case keeps a
copy from its start (`bundled_billing_template`). The Billing screen shows the newest cached copy
of the case's workflow template; a case without a workflow uses the ward's default workflow;
without any template it shows the whole master.
