-- AI Studio dashboard settings, e.g. {"leafId": "leaf-or-01"}: the board follows that Leaf's current
-- case (timers from its chart events) and, between cases, the next case booked for its room.
BEGIN;

ALTER TABLE ai_studio_dashboard ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
