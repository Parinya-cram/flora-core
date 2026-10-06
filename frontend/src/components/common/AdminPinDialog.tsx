import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

const PIN_PATTERN = /^\d{4,8}$/;

type Props = {
  open: boolean;
  title?: string;
  message?: string;
  error?: string;
  onSubmit: (pin: string) => void;
  onCancel: () => void;
};

/** Masked numeric admin-PIN prompt (4–8 digits). The entered PIN is handed to the caller and never stored. */
export default function AdminPinDialog({
  open,
  title = "Admin PIN required",
  message = "Enter an administrator PIN to save user changes on this Leaf.",
  error = "",
  onSubmit,
  onCancel,
}: Props) {
  const [pin, setPin] = useState("");
  const [localError, setLocalError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    // Each prompt starts empty so a PIN never lingers between saves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPin("");
    setLocalError("");
    window.setTimeout(() => inputRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, error, onCancel]);

  if (!open || typeof document === "undefined") return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!PIN_PATTERN.test(pin)) {
      setLocalError("PIN must be 4–8 digits.");
      return;
    }
    const value = pin;
    setPin("");
    onSubmit(value);
  };

  const shownError = localError || error;
  return createPortal(
    <div className="app-theme-scope fixed inset-0 z-[1300] flex items-center justify-center bg-black/55 p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] shadow-2xl">
        <div className="border-b border-[var(--app-border)] px-4 py-3">
          <div className="text-sm font-semibold text-[var(--app-text)]">{title}</div>
          <div className="mt-1 text-xs text-[var(--app-muted)]">{message}</div>
        </div>
        <div className="space-y-2 px-4 py-4">
          <input
            ref={inputRef}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            pattern="\d*"
            maxLength={8}
            aria-label="Admin PIN"
            placeholder="••••"
            value={pin}
            onChange={event => { setPin(event.target.value.replace(/\D/g, "").slice(0, 8)); setLocalError(""); }}
            className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-center font-mono text-lg tracking-[0.5em] text-[var(--app-text)]"
          />
          {shownError ? <div role="alert" className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{shownError}</div> : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--app-border)] px-4 py-3">
          <button type="button" onClick={onCancel} className="rounded border border-[var(--app-border)] px-3 py-1.5 text-sm text-[var(--app-text)]">Cancel</button>
          <button type="submit" disabled={pin.length < 4} className="rounded bg-[var(--app-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--app-accent-contrast)] disabled:opacity-50">Confirm</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
