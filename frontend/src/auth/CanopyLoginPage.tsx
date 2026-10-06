import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import type { BootstrapStatus } from "../bootstrap/floraDesktop";
import canopyAppIcon from "../assets/canopyicon.png";
import ThemePicker from "../components/ThemePicker";
import LanguagePicker from "../components/LanguagePicker";
import { useLanguage } from "../context/LanguageContext";
import { getLdapStatus } from "../api/authApi";
import BranchNetwork from "./BranchNetwork";
import { ReadinessRow, type Readiness } from "./ReadinessRow";
import "./canopyLogin.css";

type Props = {
  onLogin: (username: string, password: string) => Promise<boolean> | boolean;
  loginEnabled?: boolean;
  bootstrapStatus?: BootstrapStatus;
};

// Canopy-only copy; shared login strings still come from LanguageContext.
const COPY = {
  en: {
    title: "Sign in to Canopy",
    lede: "One view over every ward, ICU, ER and OR in the hospital. Every Leaf grows into it.",
    readOnly: "Read-only clinical viewer",
    caps: "Caps Lock is on",
    leaves: "Leaves sync here from every bedside",
    localTime: "Hospital time",
    secure: "Sign-ins are checked against the hospital directory and recorded.",
  },
  th: {
    title: "เข้าสู่ระบบ Canopy",
    lede: "มุมมองเดียวครอบคลุมทุกหอผู้ป่วย ICU ER และห้องผ่าตัดของโรงพยาบาล ทุก Leaf เติบโตมารวมกันที่นี่",
    readOnly: "ระบบดูข้อมูลทางคลินิก (อ่านอย่างเดียว)",
    caps: "Caps Lock เปิดอยู่",
    leaves: "ข้อมูลจากทุกเตียงซิงก์มาที่นี่",
    localTime: "เวลาโรงพยาบาล",
    secure: "การเข้าสู่ระบบตรวจสอบกับฐานข้อมูลผู้ใช้ของโรงพยาบาลและถูกบันทึกไว้",
  },
} as const;

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export default function CanopyLoginPage({ onLogin, loginEnabled = true, bootstrapStatus }: Props) {
  const { t, language } = useLanguage();
  const copy = COPY[language === "th" ? "th" : "en"];
  const now = useClock();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [ldapEnabled, setLdapEnabled] = useState(false);

  useEffect(() => {
    if (!loginEnabled) return;
    let cancelled = false;
    void getLdapStatus().then(status => { if (!cancelled) setLdapEnabled(status.enabled); });
    return () => { cancelled = true; };
  }, [loginEnabled]);

  const isChecking = !loginEnabled && bootstrapStatus?.backendState === "starting";
  const systemState: Readiness = loginEnabled ? "ready" : isChecking ? "checking" : "unavailable";
  const serverDataState: Readiness = bootstrapStatus?.dataMode === "server" || !bootstrapStatus?.dataMode
    ? isChecking ? "checking" : bootstrapStatus?.dbExists !== false && loginEnabled ? "ready" : "unavailable"
    : "not-connected";

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!loginEnabled || isLoggingIn) return;
    setIsLoggingIn(true);
    setError("");
    try {
      const ok = await onLogin(username.trim(), password);
      if (!ok) setError(t("login.failed"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("login.failedRetry"));
    } finally {
      setIsLoggingIn(false);
    }
  };
  const trackCaps = (event: KeyboardEvent<HTMLInputElement>) => setCapsLock(event.getModifierState?.("CapsLock") ?? false);

  const inputClass = "w-full rounded-[11px] border border-[var(--app-border)] bg-[var(--app-control-bg)] px-[13px] py-[11px] text-[15px] leading-[22px] text-[var(--app-text)] outline-none transition focus:border-[var(--app-accent)] focus:ring-4 focus:ring-[var(--app-accent)]/20 disabled:opacity-60";
  const locale = language === "th" ? "th-TH" : undefined;

  return (
    <div className="canopy-login app-main app-theme-scope flex min-h-[100dvh] items-center justify-center px-[16px] py-[24px] sm:px-[24px]">
      <BranchNetwork shape="tree" />
      <main className="w-full max-w-[960px]">
        <div className="canopy-card overflow-hidden rounded-[22px] border border-[var(--app-border)]">
          <header className="flex items-center gap-[12px] border-b border-[var(--app-border)] px-[20px] py-[14px] sm:px-[26px]">
            <span className="inline-flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-[12px] border border-[var(--app-border)] bg-[var(--app-control-bg)]">
              <img src={canopyAppIcon} alt="" className="h-[38px] w-[38px] object-contain [image-rendering:pixelated]" />
            </span>
            <div className="min-w-0">
              <div className="text-[19px] font-extrabold leading-[23px] tracking-[-0.01em] text-[var(--app-text)]">{t("product.canopy.name")}</div>
              <div className="truncate text-[11.5px] text-[var(--app-muted)]">{t("product.canopy.description")}</div>
            </div>
            <span className="ml-auto hidden items-center gap-[6px] rounded-full border border-[var(--app-border)] px-[10px] py-[3px] text-[11px] font-semibold text-[var(--app-muted)] lg:inline-flex">
              <span aria-hidden="true" className="h-[7px] w-[7px] rounded-full bg-[var(--app-accent)]" />{copy.readOnly}
            </span>
            <div className="ml-auto flex items-center gap-[8px] lg:ml-0">
              <LanguagePicker loginScreen />
              <ThemePicker compact loginScreen />
            </div>
          </header>

          <div className="grid md:grid-cols-[minmax(0,1.55fr)_minmax(250px,0.9fr)]">
            <section className="flex min-w-0 flex-col p-[22px] sm:p-[32px]" aria-labelledby="login-title">
              <form onSubmit={handleSubmit} className="space-y-[14px]">
                <div className="mb-[8px]">
                  <h1 id="login-title" className="text-[26px] font-extrabold leading-[32px] tracking-[-0.02em] text-[var(--app-text)]">{copy.title}</h1>
                  <p className="mt-[6px] text-[13.5px] leading-[20px] text-[var(--app-muted)]">{copy.lede}</p>
                </div>
                <div>
                  <label htmlFor="flora-username" className="mb-[6px] block text-[12px] font-semibold text-[var(--app-text)]">{t("login.username")}</label>
                  <input id="flora-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false}
                    value={username} onChange={event => setUsername(event.target.value)} disabled={!loginEnabled || isLoggingIn} className={inputClass} />
                </div>
                <div>
                  <label htmlFor="flora-password" className="mb-[6px] block text-[12px] font-semibold text-[var(--app-text)]">{t("login.password")}</label>
                  <div className="relative">
                    <input id="flora-password" name="password" type={showPassword ? "text" : "password"} autoComplete="current-password"
                      value={password} onChange={event => setPassword(event.target.value)} onKeyUp={trackCaps} onKeyDown={trackCaps}
                      disabled={!loginEnabled || isLoggingIn} className={`${inputClass} pr-[72px]`} />
                    <button type="button" onClick={() => setShowPassword(value => !value)}
                      className="absolute inset-y-0 right-[6px] my-auto h-[32px] rounded-md px-[10px] text-[11.5px] font-semibold text-[var(--app-muted)] hover:text-[var(--app-text)]"
                      aria-label={showPassword ? t("login.hide") : t("login.show")}>
                      {showPassword ? t("login.hide") : t("login.show")}
                    </button>
                  </div>
                  {capsLock ? <p className="mt-[6px] text-[12px] text-amber-600 dark:text-amber-300">{copy.caps}</p> : null}
                </div>

                {error ? <p role="alert" className="rounded-xl border border-rose-400/40 bg-rose-500/10 px-[14px] py-[10px] text-[13px] text-rose-600 dark:text-rose-300">{error}</p> : null}

                <button type="submit" disabled={!loginEnabled || isLoggingIn || !username.trim() || !password}
                  className="canopy-submit flex h-[46px] w-full items-center justify-center gap-[10px] rounded-[12px] px-[14px] text-[14px] font-bold text-[var(--app-accent-contrast)] transition hover:-translate-y-px hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--app-accent)] disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-55 disabled:shadow-none">
                  {isLoggingIn ? <span className="canopy-spin" aria-hidden="true" /> : null}
                  {isLoggingIn ? t("login.submitting") : !loginEnabled ? t("login.waiting") : t("login.submit")}
                </button>
                {ldapEnabled ? <p className="text-center text-[11.5px] text-[var(--app-muted)]">{t("login.ldapEnabled")}</p> : null}
              </form>

              <p className="mt-auto flex items-center gap-[8px] pt-[22px] text-[12px] text-[var(--app-muted)]">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
                {copy.secure}
              </p>
            </section>

            <aside className="min-w-0 border-t border-[var(--app-border)] bg-[var(--app-control-bg)]/35 px-[20px] py-[24px] md:border-l md:border-t-0 md:py-[30px]" aria-label="Flora readiness">
              <h2 className="mb-[12px] text-[12px] font-bold uppercase tracking-[0.08em] text-[var(--app-muted)]">{t("status.title")}</h2>
              <div className="space-y-[8px]">
                <ReadinessRow label={t("product.canopy.name")} state={systemState} />
                <ReadinessRow label={t("status.serverData")} state={serverDataState} />
              </div>
              <div className="mt-[16px] rounded-[12px] border border-dashed border-[var(--app-border)] px-[14px] py-[12px] text-[12px] text-[var(--app-muted)]">
                <svg className="mb-[6px] text-[var(--app-accent)]" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <path d="M12 21v-7M12 14c-3 0-6-2-6-5.5S9 3 12 3s6 2 6 5.5-3 5.5-6 5.5ZM12 17l-3-2M12 16l3-2" /></svg>
                {copy.leaves}
              </div>
              <div className="mt-[16px]">
                <div className="font-mono text-[24px] font-semibold tabular-nums leading-[28px] text-[var(--app-text)]">
                  {now.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
                </div>
                <div className="text-[11.5px] text-[var(--app-muted)]">{copy.localTime} · {now.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}</div>
              </div>
            </aside>
          </div>
        </div>
      </main>
    </div>
  );
}
