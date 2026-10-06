import { useEffect, useRef, useState, type FormEvent } from "react";
import type { BootstrapStatus } from "../bootstrap/floraDesktop";
import floraAppIcon from "../assets/floraicon.png";
import canopyAppIcon from "../assets/canopyicon.png";
import ThemePicker from "../components/ThemePicker";
import LanguagePicker from "../components/LanguagePicker";
import { useLanguage } from "../context/LanguageContext";
import { getSurfaceInfo } from "../edition/config";
import { getLdapStatus } from "../api/authApi";
import CanopyLoginPage from "./CanopyLoginPage";
import BranchNetwork from "./BranchNetwork";
import "./canopyLogin.css";
import { ReadinessRow, type Readiness } from "./ReadinessRow";

type Props = {
  onLogin: (username: string, password: string) => Promise<boolean> | boolean;
  loginEnabled?: boolean;
  bootstrapStatus?: BootstrapStatus;
};

// Canopy has its own, grander sign-in (growing tree); Leaf keeps the compact workstation page.
export default function LoginPage(props: Props) {
  return getSurfaceInfo().code === "canopy" ? <CanopyLoginPage {...props} /> : <WorkstationLoginPage {...props} />;
}

function WorkstationLoginPage({ onLogin, loginEnabled = true, bootstrapStatus }: Props) {
  const { t } = useLanguage();
  const surface = getSurfaceInfo();
  const appIcon = surface.code === "canopy" ? canopyAppIcon : floraAppIcon;
  const productName = t(`product.${surface.code}.name`);
  const productDescription = t(`product.${surface.code}.description`);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [ldapEnabled, setLdapEnabled] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loginEnabled) return;
    let cancelled = false;
    void getLdapStatus().then(status => { if (!cancelled) setLdapEnabled(status.enabled); });
    return () => { cancelled = true; };
  }, [loginEnabled]);

  const isChecking = !loginEnabled && bootstrapStatus?.backendState === "starting";
  const systemState: Readiness = loginEnabled ? "ready" : isChecking ? "checking" : "unavailable";
  const dataMode = bootstrapStatus?.dataMode || "local";
  const localDataState: Readiness = dataMode === "local"
    ? isChecking ? "checking" : bootstrapStatus?.dbExists && loginEnabled ? "ready" : "unavailable"
    : "not-connected";
  const serverDataState: Readiness = dataMode === "server"
    ? isChecking ? "checking" : bootstrapStatus?.dbExists && loginEnabled ? "ready" : "unavailable"
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

  return (
    <div className="canopy-login app-main app-theme-scope flex min-h-[100dvh] items-center justify-center px-[16px] py-[16px] sm:px-[24px]">
      <BranchNetwork shape="flower" fitTo={cardRef} />
      <main className="w-full max-w-[900px]">
        <div ref={cardRef} className="overflow-hidden rounded-[20px] border border-[var(--app-border)] bg-[var(--app-panel-bg)] shadow-2xl">
          <header className="flex items-center justify-between border-b border-[var(--app-border)] px-[22px] py-[14px] sm:px-[26px]">
            <div className="flex items-center gap-[10px]">
                <span className="inline-flex h-[40px] w-[40px] items-center justify-center rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)]">
                  <img src={appIcon} alt="" className="h-[34px] w-[34px] object-contain [image-rendering:pixelated]" />
                </span>
                <div>
                  <div className="text-[17px] font-bold leading-[21px] text-[var(--app-text)]">{productName}</div>
                  <div className="text-[11px] text-[var(--app-muted)]">{productDescription}</div>
                </div>
            </div>
            <div className="flex items-center gap-[8px]">
              <LanguagePicker loginScreen />
              <ThemePicker compact loginScreen />
            </div>
          </header>
          <div className="grid md:grid-cols-[minmax(0,1.6fr)_minmax(240px,0.85fr)]">
          <section className="min-w-0 p-[22px] sm:p-[26px]" aria-labelledby="login-title">

            <form onSubmit={handleSubmit} className="space-y-[12px]">
              <h1 id="login-title" className="mb-[15px] text-[18px] font-semibold leading-[24px] text-[var(--app-text)]">{t("login.title")}</h1>
              <div>
                <label htmlFor="flora-username" className="mb-[5px] block text-[12px] font-semibold text-[var(--app-text)]">{t("login.username")}</label>
                <input
                  id="flora-username"
                  name="username"
                  autoComplete="username"
                  value={username}
                  onChange={event => setUsername(event.target.value)}
                  disabled={!loginEnabled || isLoggingIn}
                  className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-[12px] py-[9px] text-[14px] leading-[20px] text-[var(--app-text)] outline-none transition focus:border-[var(--app-accent)] focus:ring-2 focus:ring-[var(--app-accent)]/20 disabled:opacity-60"
                />
              </div>
              <div>
                <label htmlFor="flora-password" className="mb-[5px] block text-[12px] font-semibold text-[var(--app-text)]">{t("login.password")}</label>
                <div className="relative">
                  <input
                    id="flora-password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    value={password}
                    onChange={event => setPassword(event.target.value)}
                    disabled={!loginEnabled || isLoggingIn}
                    className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-[12px] py-[9px] pr-[68px] text-[14px] leading-[20px] text-[var(--app-text)] outline-none transition focus:border-[var(--app-accent)] focus:ring-2 focus:ring-[var(--app-accent)]/20 disabled:opacity-60"
                  />
                  <button type="button" onClick={() => setShowPassword(value => !value)} className="absolute inset-y-0 right-[6px] my-auto h-[30px] rounded-md px-[9px] text-[11px] font-semibold text-[var(--app-muted)] hover:text-[var(--app-text)]" aria-label={showPassword ? t("login.hide") : t("login.show")}>
                    {showPassword ? t("login.hide") : t("login.show")}
                  </button>
                </div>
              </div>

              {error ? <p role="alert" className="rounded-xl border border-rose-400/40 bg-rose-500/10 px-[14px] py-[10px] text-[13px] text-rose-600 dark:text-rose-300">{error}</p> : null}

              <button
                type="submit"
                disabled={!loginEnabled || isLoggingIn || !username.trim() || !password}
                className="w-full rounded-lg bg-[var(--app-accent)] px-[14px] py-[9px] text-[13px] font-bold leading-[20px] text-[var(--app-accent-contrast)] transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--app-accent)] disabled:cursor-not-allowed disabled:opacity-55"
              >
                {isLoggingIn ? t("login.submitting") : !loginEnabled ? t("login.waiting") : t("login.submit")}
              </button>
              {ldapEnabled ? <p className="text-center text-[11px] text-[var(--app-muted)]">{t("login.ldapEnabled")}</p> : null}
            </form>
            <details className="mt-[14px] rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)]/50 p-[10px] md:hidden">
              <summary className="cursor-pointer text-[12px] font-semibold text-[var(--app-text)]">
                {productName} {systemState === "ready" ? t("status.ready") : systemState === "checking" ? t("status.checking") : t("status.unavailable")}
              </summary>
              <div className="mt-[10px] space-y-[8px]">
                {surface.code === "leaf" ? <ReadinessRow label={t("status.localData")} state={localDataState} /> : null}
                <ReadinessRow label={t("status.serverData")} state={serverDataState} />
              </div>
            </details>
          </section>

          <aside className="hidden min-w-0 flex-col border-l border-[var(--app-border)] bg-[var(--app-control-bg)]/35 px-[20px] py-[26px] md:flex" aria-label="Flora readiness">
            <h2 className="mb-[15px] text-[18px] font-semibold leading-[24px] text-[var(--app-text)]">{t("status.title")}</h2>
            <div className="space-y-[9px]">
              <ReadinessRow label={productName} state={systemState} />
              {surface.code === "leaf" ? <ReadinessRow label={t("status.localData")} state={localDataState} /> : null}
              <ReadinessRow label={t("status.serverData")} state={serverDataState} />
            </div>
          </aside>
          </div>
        </div>
      </main>
    </div>
  );
}
