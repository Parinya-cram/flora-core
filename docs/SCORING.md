# Clinical scores

NEWS2, MEWS, qSOFA, GCS, Modified Aldrete and similar scores. A score is one versioned JSON
document (`flora-score/1`, `services/flora-api/app/scoring.py`), not tables of items and
conditions. Simple items use bands or options; anything more (NEWS2 SpO2 scale 2, P/F ratio)
uses a Form Studio formula, so forms and scores share one formula language.

## Definition

```json
{ "format": "flora-score/1", "id": "news2", "name": "NEWS2", "reference": "RCP 2017",
  "mode": "auto", "interval_min": 15, "missing": "partial",
  "inputs": { "rr": { "source": "param", "param": "rr", "window_min": 60, "agg": "latest", "round": 0 },
              "sbp": { "source": "param", "param": "nibp_sys", "fallback": ["art_sys"], "window_min": 60 } },
  "items": [ { "key": "rr", "label": "Respiration rate", "input": "rr",
               "bands": [ {"max": 8, "points": 3}, {"min": 9, "max": 11, "points": 1}, {"min": 12, "max": 20, "points": 0} ] } ],
  "bands": [ {"max": 4, "label": "Low", "level": "info"}, {"min": 7, "label": "High", "level": "critical"} ],
  "flags": [ {"when": "max_points >= 3 and total < 5", "label": "Single parameter 3", "level": "warning"} ] }
```

**`inputs`**

A `param` input reads the effective timeline: device values plus charted values and overrides, with masked readings left out. It uses the latest reading, or the min, max or average, within `window_min` before each time point. Older readings count as missing. A `manual` input is entered when a clinician runs the score.

**`items`**

Each item gets its points one of three ways:
- `bands`: inclusive min and max; the first match wins.
- `options`: an exact value.
- `formula`: a Form Studio formula that can see the input keys and earlier `points.<key>`.

A formula item is missing when any input it names is missing. Use `requires` to list only the inputs it really needs.

**Results**

- `total` is the sum of the item points, or the result of `total.formula` when one is given.
- `bands` interpret the total.
- `flags` are alerts. Their formulas can use `total`, `max_points` and `missing_count`.

**Missing items**

- `missing: partial` shows the total of the items that have values and marks the result partial.
- `missing: none` gives no total until every item has a value.

**Modes**

- `auto` scores are computed every `interval_min` minutes, at clock-aligned times.
- `manual` scores are only computed when a clinician runs them (for example Aldrete at PACU discharge).

**Library**

The bundled library is in `app/scoring_library/*.json`: NEWS2, MEWS, qSOFA, GCS and Aldrete, each with its reference. Hand-computed test cases are in `tests/scoring/score-cases.json` and run with `pytest tests/test_scoring.py`.

## Flow

1. **Canopy, Workflow Studio → Scores** (`routes/scores_canopy.py`, `/api/fleet/workflows/scores`, writes need `studio.manage`):
   - add a score from the library (as a draft), or create a new one;
   - edit it and test it with **Try it**;
   - **Publish**. The published copy carries its `version`.
2. **A workflow** lists the scores it uses (`definition.scores`). Publishing the workflow requires every listed score to be published.
3. **Ward exchange**: `workflows.leaf_delivery` sends `scores` to the Leaf, which caches them in `leaf_workflow_state.payload.scores`. When a case starts, the Leaf copies its workflow's scores into the case as `bundled_scores`.
4. **Leaf `ScoreWriter`** (`app/score_writer.py`) runs every 60 s for active cases:
   - writes `case_score_result` rows with the total, band, items, the inputs used (value, parameter and time), what was missing, and the alerts;
   - covers the whole stay on its first pass, then the last 6 h, so edits and masks show within about a minute;
   - updates a stored result only with the same score version, so old results keep their version.
   - Settings: `FLORA_SCORE_WRITER_ENABLED`, `SCORE_WRITER_INTERVAL_SECONDS`, `SCORE_WRITER_RECENT_HOURS`.
5. **Leaf API** (`routes/scores_leaf.py`):
   - `GET /api/case/{id}/scores`
   - `POST /api/case/{id}/scores/{score_id}/evaluate` with `{ts?, values?, save?}`; `save` records a manual result, which is audited.
   - `POST …/scores/recalculate` recomputes the whole case.
   - `DELETE …/scores/results/{id}` deletes a manual result.
   - `GET /api/case/scores/status`
6. **Chart**: each score is a Σ row below the vital signs, coloured by level, with an `*` on partial totals.
   - The tooltip lists the items.
   - Clicking a cell opens the score at that time: the readings used and when they were taken, fields for values that are not charted, and **Record at this time**.
7. **Canopy and handover**: the case snapshot carries `scores`, and the handover export carries `case_score_result`.

Migration: `infrastructure/postgres/0084-scoring.sql`. It adds `canopy_score_definition` and `case_score_result`, plus hand-charted parameters: `avpu`, `gcs`, `gcs_e`, `gcs_v`, `gcs_m`, `o2_supplemental` and `pain_score`. These start hidden; turn them on in the parameter master where they are charted.

Scores support clinical decisions; they are not device alarms. Have the clinical team review each library score before publishing it.
