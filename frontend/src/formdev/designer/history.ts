/** Undo / redo for the definition being designed. Rapid edits of the same text are merged into one step. */
import { useCallback, useState } from "react";
import type { FormDefinition } from "../core/types";

const LIMIT = 200;
const MERGE_MS = 800;
type State = { present: FormDefinition | null; past: FormDefinition[]; future: FormDefinition[]; lastKey: string | null; lastAt: number };

export function useHistory() {
  const [state, setState] = useState<State>({ present: null, past: [], future: [], lastKey: null, lastAt: 0 });
  /** Record a change; `mergeKey` (e.g. "label:<field>") folds quick successive edits of one setting into one step. */
  const commit = useCallback((next: FormDefinition, mergeKey: string | null = null) => setState(current => {
    if (current.present === null) return { present: next, past: [], future: [], lastKey: null, lastAt: 0 };
    const now = Date.now();
    const merge = mergeKey !== null && mergeKey === current.lastKey && now - current.lastAt < MERGE_MS;
    return { present: next, past: merge ? current.past : [...current.past, current.present].slice(-LIMIT), future: [], lastKey: mergeKey, lastAt: now };
  }), []);
  const reset = useCallback((next: FormDefinition | null) => setState({ present: next, past: [], future: [], lastKey: null, lastAt: 0 }), []);
  const undo = useCallback(() => setState(current => current.past.length && current.present
    ? { present: current.past[current.past.length - 1], past: current.past.slice(0, -1), future: [current.present, ...current.future], lastKey: null, lastAt: 0 } : current), []);
  const redo = useCallback(() => setState(current => current.future.length && current.present
    ? { present: current.future[0], past: [...current.past, current.present], future: current.future.slice(1), lastKey: null, lastAt: 0 } : current), []);
  return { definition: state.present, canUndo: state.past.length > 0, canRedo: state.future.length > 0, commit, reset, undo, redo };
}
