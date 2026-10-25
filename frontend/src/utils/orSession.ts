import type { OrSession } from "../api/orScheduleApi";

export const isAnaesthesia = (roleId: string) => /anesth|anaesth/i.test(roleId);

/** The surgical team (or the anaesthesia team) of a booking, as one line. */
export function teamLine(session: OrSession, anaesthesia: boolean): string {
  const people = session.team.filter(member => isAnaesthesia(member.role_id) === anaesthesia).map(member => member.name || member.staff_code || "");
  // Without a booked team: the surgeon / anaesthetist named on the admission.
  return people.filter(Boolean).join(", ") || (anaesthesia ? session.admission.anaesthetist : session.admission.surgeon) || "";
}

const pad = (n: number) => String(n).padStart(2, "0");
export const clock = (ms: number | null | undefined) => { if (!ms) return "—"; const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const dayStart = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const isoDay = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/** A schedule day runs 06:00 → 05:59 the next morning; a 02:00 booking belongs to the day before. */
export const DAY_START_HOUR = 6;
const HOUR = 3_600_000;
export const scheduleDayOf = (ms: number) => dayStart(ms - DAY_START_HOUR * HOUR);
export const scheduleWindow = (day: number) => [day + DAY_START_HOUR * HOUR, day + (24 + DAY_START_HOUR) * HOUR] as const;
