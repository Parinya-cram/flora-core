import { BACKEND_BASE } from "./backendBase";

/** A Canopy account (hospital). Each has its own database schema; nothing crosses between them. */
export type CanopyAccount = { code: string; name: string };

export const PLATFORM_ACCOUNT = "platform";
export const ACCOUNT_HEADER = "X-Flora-Account";
const COOKIE = "flora_account";
const INFO_KEY = "flora_account_info";

/** The account code this browser signed in to last (the login form's default). */
export function readAccountCookie(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.split(";").map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`));
  return match ? decodeURIComponent(match.slice(COOKIE.length + 1)).trim().toLowerCase() : "";
}

export function writeAccountCookie(code: string) {
  if (typeof document === "undefined") return;
  const value = encodeURIComponent(code.trim().toLowerCase());
  document.cookie = `${COOKIE}=${value}; Path=/; Max-Age=${365 * 24 * 3600}; SameSite=Lax`;
}

/** The signed-in account, kept beside the session for the top bar. */
export function readSessionAccount(): CanopyAccount | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(INFO_KEY) || "null") as CanopyAccount | null;
    return parsed && typeof parsed.code === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function writeSessionAccount(account: CanopyAccount | null) {
  try {
    if (account) localStorage.setItem(INFO_KEY, JSON.stringify(account));
    else localStorage.removeItem(INFO_KEY);
  } catch {
    // Display only; the session token carries the real account.
  }
}

export function parseAccount(raw: unknown): CanopyAccount | null {
  const value = raw as Partial<CanopyAccount> | null;
  if (!value || typeof value.code !== "string" || !value.code) return null;
  return { code: value.code, name: typeof value.name === "string" && value.name ? value.name : value.code };
}

/** Name of an account code, for the login form; null when unknown or suspended. */
export async function lookupAccount(code: string, signal?: AbortSignal): Promise<CanopyAccount | null> {
  const clean = code.trim().toLowerCase();
  if (!clean) return null;
  if (clean === PLATFORM_ACCOUNT) return { code: clean, name: "Platform administration" };
  const res = await fetch(`${BACKEND_BASE}/api/auth/account/${encodeURIComponent(clean)}`, { signal });
  if (!res.ok) return null;
  return parseAccount(await res.json().catch(() => null));
}
