import floraIcisLogo from "../assets/logos/flora-icis-logo.png";

/** The Flora iCIS wordmark, whole (never cropped), on a light plate so its dark lettering reads on any theme,
 * followed by the part of the system this screen belongs to (Leaf, Canopy, …). */
export default function BrandLogo({ part, height = 34, className = "" }: { part?: string; height?: number; className?: string }) {
  return <span className={`inline-flex min-w-0 shrink-0 items-center gap-2 ${className}`}>
    <span className="inline-flex shrink-0 items-center rounded-lg bg-white px-1.5 py-1 shadow-sm ring-1 ring-black/5">
      <img src={floraIcisLogo} alt="Flora iCIS — Integrated Clinical Information System" style={{ height }} className="w-auto object-contain" />
    </span>
    {part ? <span className="truncate text-[11px] font-extrabold uppercase tracking-[0.16em] text-[var(--app-accent)]">{part}</span> : null}
  </span>;
}
