import { useCallback, useEffect, useState } from "react";
import { getAuthWards, type AuthApiUser, type CanopyWardRow } from "../api/authApi";
import { ALL_WARDS, readSelectedWard, writeSelectedWard } from "../api/wardSelection";

export type CanopyWardState = {
  /** True once the selection has been validated against the server (or a fallback was applied). */
  ready: boolean;
  allUnits: boolean;
  rows: CanopyWardRow[];
  /** "all" or a care-unit key. */
  selected: string;
  selectedName: string | null;
  select: (key: string) => void;
};

type Loaded = { username: string; allUnits: boolean; rows: CanopyWardRow[]; selected: string };

function resolveSelection(stored: string, allUnits: boolean, rows: CanopyWardRow[]): string {
  if (stored === ALL_WARDS && allUnits) return ALL_WARDS;
  if (stored !== ALL_WARDS && rows.some(row => row.key === stored)) return stored;
  if (allUnits) return ALL_WARDS;
  return rows[0]?.key || ALL_WARDS;
}

/** Canopy ward scope: loads the user's permitted wards and keeps a validated, persisted selection. */
export function useCanopyWard(user: AuthApiUser | null, enabled: boolean): CanopyWardState {
  const username = enabled ? user?.username || "" : "";
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!username) return;
    let cancelled = false;
    const apply = (allUnits: boolean, rows: CanopyWardRow[]) => {
      if (cancelled) return;
      const selected = resolveSelection(readSelectedWard(), allUnits, rows);
      writeSelectedWard(selected);
      setLoaded({ username, allUnits, rows, selected });
    };
    getAuthWards()
      .then(result => apply(result.allUnits, result.rows))
      .catch(() => {
        // Fall back to the ward access carried on the session user.
        const access = user?.wardAccess;
        apply(access?.allUnits === true, (access?.units || []).map(unit => ({
          ...unit, buildingName: null, hospitalName: null, leafCount: 0,
        })));
      });
    return () => { cancelled = true; };
    // Re-validate only when the signed-in identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username]);

  const select = useCallback((key: string) => {
    setLoaded(current => {
      if (!current) return current;
      const next = resolveSelection(key, current.allUnits, current.rows);
      writeSelectedWard(next);
      return { ...current, selected: next };
    });
  }, []);

  const active = loaded && loaded.username === username ? loaded : null;
  const selected = active?.selected || ALL_WARDS;
  return {
    ready: !enabled || !!active,
    allUnits: active?.allUnits === true,
    rows: active?.rows || [],
    selected,
    selectedName: selected === ALL_WARDS ? null : active?.rows.find(row => row.key === selected)?.name || selected,
    select,
  };
}
