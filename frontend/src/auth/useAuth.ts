import { useCallback, useEffect, useState } from "react";
import {
  clearStoredAuthToken,
  type AuthApiUser,
  loginWithPassword,
  logoutAuthSession,
  whoAmI,
  readStoredAuthToken,
  writeStoredAuthToken,
} from "../api/authApi";
import { writeAccountCookie, writeSessionAccount } from "../api/accountApi";

export type AuthUser = AuthApiUser;

function readStoredUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  if (!readStoredAuthToken()) return null;

  const raw = localStorage.getItem("flora_user");
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as AuthUser;
    if (!parsed || typeof parsed.username !== "string" || !parsed.username.trim()) {
      return null;
    }
    if (!parsed.name || typeof parsed.name !== "string") {
      return {
        username: parsed.username,
        name: parsed.username,
      };
    }
    return parsed;
  } catch {
    return null;
  }
}

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(() => readStoredUser());
  const ready = true;

  useEffect(() => {
    const refreshStoredUser = () => setUser(readStoredUser());
    window.addEventListener("flora:auth-changed", refreshStoredUser);
    return () => window.removeEventListener("flora:auth-changed", refreshStoredUser);
  }, []);

  const login = useCallback(async (username: string, password: string, accountCode?: string) => {
    const session = await loginWithPassword(username, password, accountCode);
    // Canopy remembers the account for the next sign-in; the session token carries it from now on.
    if (session.account) writeAccountCookie(session.account.code);
    writeSessionAccount(session.account ?? null);

    writeStoredAuthToken(session.sessionToken);
    localStorage.setItem("flora_user", JSON.stringify(session.user));
    window.dispatchEvent(new Event("flora:auth-changed"));
    setUser(session.user);
    return true;
  }, []);

  const logout = useCallback(() => {
    void logoutAuthSession().catch(() => {
      // local sign-out should still succeed even if backend session was already gone
    });
    clearStoredAuthToken();
    localStorage.removeItem("flora_user");
    writeSessionAccount(null);
    window.dispatchEvent(new Event("flora:auth-changed"));
    setUser(null);
  }, []);

  const syncSession = useCallback(async () => {
    const token = readStoredAuthToken();
    if (!token) {
      localStorage.removeItem("flora_user");
      setUser(null);
      return null;
    }

    try {
      const sessionUser = await whoAmI();
      localStorage.setItem("flora_user", JSON.stringify(sessionUser));
      window.dispatchEvent(new Event("flora:auth-changed"));
      setUser(sessionUser);
      return sessionUser;
    } catch {
      clearStoredAuthToken();
      localStorage.removeItem("flora_user");
      window.dispatchEvent(new Event("flora:auth-changed"));
      setUser(null);
      return null;
    }
  }, []);

  return {
    user,
    ready,
    isAuthenticated: !!user,
    login,
    logout,
    syncSession,
  };
}

