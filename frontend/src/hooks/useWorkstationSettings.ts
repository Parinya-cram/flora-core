import { useEffect, useState } from "react";
import {
  getWorkstationContext,
  WORKSTATION_CONTEXT_STORAGE_KEY,
  type WorkstationContext,
} from "../api/workstationApi";
import { getSurfaceInfo } from "../edition/config";

const FALLBACK_CONTEXT: WorkstationContext = {
  hospitalName: "",
  buildingName: "",
  careUnitName: "",
  roomName: "",
  bedName: "",
  timezone: "Asia/Bangkok",
  dateFormat: "DD/MM/YYYY",
  timeFormat: "24h",
  updatedAt: 0,
};

let cachedContext: WorkstationContext | null = null;
let pendingRequest: Promise<WorkstationContext> | null = null;

function readCachedContext(): WorkstationContext {
  if (cachedContext) return cachedContext;
  try {
    const raw = window.localStorage.getItem(WORKSTATION_CONTEXT_STORAGE_KEY);
    if (raw) return { ...FALLBACK_CONTEXT, ...JSON.parse(raw) } as WorkstationContext;
  } catch {
    // A storage failure must not prevent the clinical screen from loading.
  }
  return FALLBACK_CONTEXT;
}

function loadContext() {
  // The workstation (its bed, and date and time formats) is a Leaf's own setting: Canopy has no such route and
  // keeps the defaults, rather than asking for it and getting 404 on every page.
  if (getSurfaceInfo().code !== "leaf") return Promise.resolve(readCachedContext());
  if (!pendingRequest) {
    pendingRequest = getWorkstationContext()
      .then(context => {
        cachedContext = context;
        try {
          window.localStorage.setItem(WORKSTATION_CONTEXT_STORAGE_KEY, JSON.stringify(context));
        } catch {
          // The in-memory value is still usable when storage is unavailable.
        }
        return context;
      })
      .finally(() => {
        pendingRequest = null;
      });
  }
  return pendingRequest;
}

export function useWorkstationSettings(): WorkstationContext {
  const [context, setContext] = useState<WorkstationContext>(readCachedContext);

  useEffect(() => {
    let active = true;
    loadContext().then(next => {
      if (active) setContext(next);
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  return context;
}
