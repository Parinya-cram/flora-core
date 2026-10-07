import type { AuthUser } from "../auth/useAuth";
import { canAuthorStudio } from "../auth/studioAccess";
import { useLanguage } from "../context/LanguageContext";
import FormDevWorkspace from "../formdev/ui/FormDevWorkspace";

export default function CanopyFormDevView({ sessionUser }: { sessionUser: AuthUser | null }) {
  const { language } = useLanguage();
  const role = String(sessionUser?.role || "").trim().toLowerCase();
  const principal = {
    user_id: null,
    username: sessionUser?.username || "unknown",
    roles: sessionUser?.roleCodes?.length ? sessionUser.roleCodes : role ? [role] : [],
    permissions: sessionUser?.permissions ?? [],
  };
  // The server re-checks every permission; this principal only drives instant validation in the UI.
  // Studio authors (studio.manage: system and clinical administrators) get the designer.
  return <FormDevWorkspace username={principal.username} isAdmin={canAuthorStudio(sessionUser)} principal={principal} language={language} />;
}
