/**
 * The hospital's name and logo, set once in Canopy and kept on every Leaf (0090, app/hospital_profile.py). A form's
 * logo field whose src is "hospital" prints this logo, and the `{hospital}` token of a header or footer prints the
 * name, so a form designed once prints with each hospital's own identity (offline too: the Leaf keeps its copy).
 */
export type HospitalProfile = { name_th: string; name_en: string; logo: string | null; updated_at?: number | null };

/** The value of a logo field's src that means "the hospital's logo" rather than a picture kept in the form. */
export const HOSPITAL_LOGO = "hospital";

let current: HospitalProfile | null = null;
const listeners = new Set<() => void>();

export function setHospitalProfile(profile: Partial<HospitalProfile> | null | undefined): void {
  const next = profile && (profile.name_th || profile.name_en || profile.logo)
    ? { name_th: profile.name_th || "", name_en: profile.name_en || "", logo: profile.logo || null, updated_at: profile.updated_at ?? null }
    : null;
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  listeners.forEach(listener => listener());
}

export function hospitalProfile(): HospitalProfile | null {
  return current;
}

export function subscribeHospitalProfile(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The picture a logo field shows: its own, or the hospital's for src "hospital" (none until one is set). */
export function logoSource(src: string | undefined): string | undefined {
  return src === HOSPITAL_LOGO ? current?.logo || undefined : src;
}

/** The hospital's name in the print language (Thai first unless English is asked for), or "" when none is set. */
export function hospitalName(language?: string): string {
  if (!current) return "";
  return language && !language.toLowerCase().startsWith("th") ? current.name_en || current.name_th : current.name_th || current.name_en;
}

/** "ชื่อไทย (English name)" for headers and menus; either half alone when only one is set. */
export function hospitalDisplayName(profile: HospitalProfile | null | undefined, fallback?: string | null): string {
  const th = profile?.name_th?.trim() || "", en = profile?.name_en?.trim() || "";
  return th && en ? `${th} (${en})` : th || en || fallback?.trim() || "";
}
