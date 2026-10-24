import { useEffect, useState } from "react";
import { getCaseWorklist, type WorklistCase } from "../../api/workflowApi";

/**
 * Due/overdue scheduled forms per active case (GET /api/case/worklist), polled once a minute and shared by every
 * component that shows it (Ward page, case switcher). Fails silently: an older Leaf without the endpoint shows nothing.
 */

const POLL_MS = 60_000;
type Worklist = Map<number, WorklistCase>;

let current: Worklist = new Map();
const listeners = new Set<(value: Worklist) => void>();
let timer: number | null = null;

async function poll() {
  try {
    const cases = await getCaseWorklist();
    current = new Map(cases.map(item => [Number(item.case_id), item]));
  } catch {
    current = new Map();
  }
  for (const listener of listeners) listener(current);
}

export function useCaseWorklist(enabled = true): Worklist {
  const [value, setValue] = useState<Worklist>(current);
  useEffect(() => {
    if (!enabled) return;
    listeners.add(setValue);
    if (timer == null) {
      void poll();
      timer = window.setInterval(() => void poll(), POLL_MS);
    }
    return () => {
      listeners.delete(setValue);
      if (!listeners.size && timer != null) { window.clearInterval(timer); timer = null; }
    };
  }, [enabled]);
  return enabled ? value : new Map();
}

/** "2 overdue · 1 due" with each form's title, for a tooltip. */
export function worklistTitle(item: WorklistCase | undefined): string {
  if (!item) return "";
  return item.forms.filter(form => form.due || form.overdue)
    .map(form => `${form.title || form.form_id}: ${[form.overdue ? `${form.overdue} overdue` : "", form.due ? `${form.due} due` : ""].filter(Boolean).join(", ")}`)
    .join("\n");
}
