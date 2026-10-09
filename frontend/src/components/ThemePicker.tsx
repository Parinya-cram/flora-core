import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTheme } from "../context/ThemeContext";
import ClinicalReferenceTooltip from "./common/ClinicalReferenceTooltip";

type Props = { compact?: boolean; loginScreen?: boolean };

export default function ThemePicker({ compact = false, loginScreen = false }: Props) {
  const { color, setColor, schemes, fontScale, increaseFont, decreaseFont, resetFont, fontScaleMin, fontScaleMax } = useTheme();
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, right: 8 });
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = schemes.find(option => option.code === color);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const placeMenu = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const estimatedMenuHeight = 238;
      const below = rect.bottom + 8;
      const top = below + estimatedMenuHeight <= window.innerHeight - 8
        ? below
        : Math.max(8, rect.top - estimatedMenuHeight - 8);
      setMenuPosition({
        top,
        right: Math.max(8, window.innerWidth - rect.right),
      });
    };
    placeMenu();
    window.addEventListener("resize", placeMenu);
    window.addEventListener("scroll", placeMenu, true);
    return () => {
      window.removeEventListener("resize", placeMenu);
      window.removeEventListener("scroll", placeMenu, true);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <ClinicalReferenceTooltip text={`Theme: ${current?.displayName || "Select theme"}`} compact disabled={open}>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-label={`Theme: ${current?.displayName || "Select theme"}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`inline-flex items-center justify-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-text)] transition hover:border-[var(--app-accent)] ${loginScreen ? "h-[40px] w-[40px]" : compact ? "h-8 w-9" : "min-h-10 px-3 text-xs font-semibold"}`}
      >
        <svg viewBox="0 0 24 24" className={loginScreen ? "h-[18px] w-[18px] shrink-0" : compact ? "h-5 w-5 shrink-0" : "h-4 w-4 shrink-0"} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M12 3a9 9 0 1 0 9 9c0-1.1-.9-2-2-2h-1.5a2 2 0 0 1-2-2V6a3 3 0 0 0-3-3Z" />
          <circle cx="7.5" cy="11" r=".8" fill="currentColor" />
          <circle cx="10" cy="6.8" r=".8" fill="currentColor" />
          <circle cx="7.8" cy="16" r=".8" fill="currentColor" />
        </svg>
        {!compact ? <span>{current?.displayName || "Theme"}</span> : null}
        {!compact ? <span aria-hidden="true">⌄</span> : null}
      </button>
      </ClinicalReferenceTooltip>
      {open ? createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label="Choose Flora theme"
          className="fixed z-[10000] w-[180px] max-w-[calc(100vw-16px)] rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-[6px] shadow-2xl"
          style={{ top: menuPosition.top, right: menuPosition.right }}
        >
          <div className="mb-[6px] flex items-center justify-between gap-[6px] rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-[9px] py-[6px]">
            <span className="text-[12px] text-[var(--app-text)]">Text size</span>
            <div className="flex items-center gap-[4px]">
              <button
                type="button"
                onClick={decreaseFont}
                disabled={fontScale <= fontScaleMin}
                aria-label="Smaller text"
                className="flex h-[22px] w-[22px] items-center justify-center rounded border border-[var(--app-border)] bg-[var(--app-panel-bg)] text-[12px] font-bold text-[var(--app-text)] hover:border-[var(--app-accent)] disabled:opacity-40"
              >A−</button>
              <button
                type="button"
                onClick={resetFont}
                aria-label="Reset text size"
                title="Reset to 100%"
                className="min-w-[42px] rounded px-[4px] text-center text-[11px] tabular-nums text-[var(--app-muted)] hover:text-[var(--app-text)]"
              >{Math.round(fontScale * 100)}%</button>
              <button
                type="button"
                onClick={increaseFont}
                disabled={fontScale >= fontScaleMax}
                aria-label="Larger text"
                className="flex h-[22px] w-[22px] items-center justify-center rounded border border-[var(--app-border)] bg-[var(--app-panel-bg)] text-[14px] font-bold text-[var(--app-text)] hover:border-[var(--app-accent)] disabled:opacity-40"
              >A+</button>
            </div>
          </div>
          {schemes.map(option => {
            const selected = option.code === color;
            return (
              <button
                key={option.code}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  if (loginScreen) {
                    window.sessionStorage.setItem("flora.loginThemeColor", option.code);
                  }
                  setColor(option.code);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-[9px] rounded-lg px-[9px] py-[7px] text-left text-[12px] text-[var(--app-text)] hover:bg-[var(--app-control-bg)] ${selected ? "bg-[var(--app-control-bg)] font-bold" : ""}`}
              >
                <span className="flex h-[20px] w-[34px] shrink-0 overflow-hidden rounded border border-[var(--app-border)]" aria-hidden="true">
                  {option.colors.map((swatch, index) => <span key={`${swatch}-${index}`} className="h-full flex-1" style={{ backgroundColor: swatch }} />)}
                </span>
                <span className="flex-1">{option.displayName}</span>
                {selected ? <span aria-hidden="true" className="text-[var(--app-accent)]">✓</span> : null}
              </button>
            );
          })}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
