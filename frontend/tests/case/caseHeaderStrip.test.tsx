/** The case summary strip on case pages other than the Chart: one line (LOS, patient, allergy) in the user's card
 * order, the full cards when the user opened them — remembered per user. */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import type { CaseStatus } from "../../src/api/caseApi";
import type { AuthUser } from "../../src/auth/useAuth";
import CaseHeaderStrip from "../../src/components/case/CaseHeaderStrip";
import { caseHeaderOrderStorageKey, readCaseHeaderExpanded, writeCaseHeaderExpanded } from "../../src/components/case/caseHeaderOrder";
import { LanguageProvider } from "../../src/context/LanguageContext";

const stored = new Map<string, string>();
const storage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => void stored.set(key, value),
  removeItem: (key: string) => void stored.delete(key),
};
Object.assign(globalThis, { window: { localStorage: storage, addEventListener() {}, removeEventListener() {} }, localStorage: storage });

const openCase: Exclude<CaseStatus, { status: "IDLE" }> = { status: "ACTIVE", case_id: 7, hn: "6512345", start_time: Date.now() - (4 * 60 + 45) * 60_000 };
const render = (username: string) => renderToString(createElement(LanguageProvider, null,
  createElement(CaseHeaderStrip, { caseStatus: openCase, sessionUser: { username } as AuthUser })));

describe("case header strip", () => {
  beforeEach(() => stored.clear());

  it("is one line by default: LOS, patient and allergy, with a button for the cards", () => {
    const html = render("nurse");
    expect(html).toContain("case-header-line");
    expect(html).toContain("HN 6512345");
    expect(html).toContain("4 hr 45 min");
    expect(html).toContain("Allergy");
    expect(html).toContain("Show details");
    expect(html).not.toContain("case-header-grid");
    expect(html).not.toContain("Diagnosis");
  });

  it("shows the five cards when the user opened them, for that user only", () => {
    writeCaseHeaderExpanded("nurse", true);
    const html = render("nurse");
    expect(html).toContain("case-header-grid");
    expect(html.match(/case-header-card-slot/g)).toHaveLength(5);
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain("case-header-line");
    expect(render("doctor")).toContain("case-header-line");
  });

  it("keeps the user's card order from the Chart", () => {
    stored.set(caseHeaderOrderStorageKey("nurse"), JSON.stringify(["allergy", "patient", "diagnosis", "operation", "los"]));
    const html = render("nurse");
    expect(html.indexOf(">Allergy<")).toBeLessThan(html.indexOf("HN 6512345"));
    expect(html.indexOf("HN 6512345")).toBeLessThan(html.indexOf(">LOS<"));
  });

  it("remembers the choice per user", () => {
    expect(readCaseHeaderExpanded("nurse")).toBe(false);
    writeCaseHeaderExpanded("nurse", true);
    expect(readCaseHeaderExpanded("nurse")).toBe(true);
    expect(readCaseHeaderExpanded("doctor")).toBe(false);
    writeCaseHeaderExpanded("nurse", false);
    expect(readCaseHeaderExpanded("nurse")).toBe(false);
  });
});
