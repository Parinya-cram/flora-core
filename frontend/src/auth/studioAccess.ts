import type { AuthUser } from "./useAuth";

/** studio.manage: create and update in Form, Report and Workflow Studio (system_admin and clinical_admin by default).
 *  Mirrors services/flora-api/app/routes/studio_access.py; the server re-checks every write. */
export const STUDIO_PERMISSION = "studio.manage";
const LEGACY_ADMIN_ROLES = ["admin", "system_admin"];

export function canAuthorStudio(user: AuthUser | null | undefined): boolean {
  if (!user) return false;
  if (LEGACY_ADMIN_ROLES.includes(String(user.role || "").trim().toLowerCase())) return true;
  return (user.permissions ?? []).includes(STUDIO_PERMISSION) || (user.roleCodes ?? []).some(code => LEGACY_ADMIN_ROLES.includes(code));
}

/** AI Studio: studio authors and anyone who may generate reports (mirrors routes/ai_studio.py). */
export function canUseAiStudio(user: AuthUser | null | undefined): boolean {
  return canAuthorStudio(user) || (user?.permissions ?? []).includes("report.generate");
}
