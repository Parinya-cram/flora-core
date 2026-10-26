/** "FLORA iCIS" as type, readable on every theme: FLORA in the theme's own text colour, iCIS in the logo's
 * cyan → blue (clear on light and dark backgrounds) with its pink dot. */
export default function Wordmark({ size = 16, className = "" }: { size?: number; className?: string }) {
  return <span className={`inline-flex items-baseline whitespace-nowrap font-black leading-none tracking-[0.03em] ${className}`}
    style={{ fontSize: size }} role="img" aria-label="Flora iCIS">
    <span aria-hidden="true" className="text-[var(--app-text)]">FLORA</span>
    <span aria-hidden="true" className="ml-[0.24em] bg-gradient-to-r from-[#1bb8d4] to-[#2f6fe8] bg-clip-text text-transparent">
      <span className="relative">ı<span className="absolute left-1/2 top-[0.04em] h-[0.19em] w-[0.19em] -translate-x-1/2 rounded-full bg-[#ef4a82]" /></span>CIS
    </span>
  </span>;
}
