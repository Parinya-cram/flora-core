/**
 * Patient age from a birthdate, on a given day (the procedure / admission day), or a manually entered age
 * when the birthdate is unknown. Birthdates are stored as ISO yyyy-mm-dd; HIS and older Leaf records may
 * carry dd/mm/yyyy, and Thai records Buddhist-era years — both are read here.
 */

export type Age = { years: number; months: number; days: number };

/** ISO yyyy-mm-dd, or "" when the text is not a valid birthdate. */
export function normalizeBirthdate(raw: string | null | undefined): string {
  const text = String(raw || "").trim();
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  let year: number, month: number, day: number;
  if (match) {
    [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
    if (!match) return "";
    [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  }
  if (year > 2400) year -= 543; // Buddhist era
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Completed years / months / days between the birthdate and `atMs`; null if unknown or after `atMs`. */
export function ageAt(birthdate: string | null | undefined, atMs: number): Age | null {
  const iso = normalizeBirthdate(birthdate);
  if (!iso || !Number.isFinite(atMs)) return null;
  const [year, month, day] = iso.split("-").map(Number);
  const at = new Date(atMs);
  let years = at.getFullYear() - year;
  let months = at.getMonth() - (month - 1);
  let days = at.getDate() - day;
  if (days < 0) {
    months -= 1;
    days += new Date(at.getFullYear(), at.getMonth(), 0).getDate(); // days in the previous month
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  return years < 0 ? null : { years, months, days };
}

/** "54y 3m"; infants "3m 12d"; newborns "12d". */
export function formatAge(age: Age): string {
  if (age.years >= 1) return [`${age.years}y`, age.months ? `${age.months}m` : ""].filter(Boolean).join(" ");
  if (age.months >= 1) return [`${age.months}m`, age.days ? `${age.days}d` : ""].filter(Boolean).join(" ");
  return `${age.days}d`;
}

/** The age to store: from the birthdate on `atMs` when there is one, otherwise the manual age as typed. */
export function ageTextAt(birthdate: string | null | undefined, atMs: number, manualAge?: string | null): string {
  const age = ageAt(birthdate, atMs);
  return age ? formatAge(age) : String(manualAge || "").trim();
}

export const todayIso = (nowMs: number) => {
  const d = new Date(nowMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
