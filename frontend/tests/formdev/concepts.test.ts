/** The concept layer on both sides: the Leaf's dictionary (concepts.ts) and values (caseData.ts caseValues) agree with
 * Canopy's twin (services/flora-api/app/concepts.py), through formdev/spec/fixtures/concepts.json written by
 * formdev/scripts/build_concept_fixtures.py. Times are the hospital's. */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { caseValues, type CaseHead } from "../../src/formdev/leaf/caseData";
import { CONCEPTS, DRAFT_KEYS } from "../../src/formdev/leaf/concepts";

const fixture = JSON.parse(readFileSync(new URL("../../../formdev/spec/fixtures/concepts.json", import.meta.url), "utf8")) as {
  concepts: unknown[]; draft_keys: Record<string, string>; now: number;
  cases: Array<{ name: string; head: CaseHead; loaded: unknown; values: Record<string, { value: string | number; source: string }> }>;
};

const zone = process.env.TZ;
beforeAll(() => { process.env.TZ = "Asia/Bangkok"; vi.useFakeTimers({ now: fixture.now, toFake: ["Date"] }); });
afterAll(() => { process.env.TZ = zone; vi.useRealTimers(); });

describe("concepts: Leaf and Canopy agree", () => {
  it("on the dictionary", () => {
    expect(CONCEPTS).toEqual(fixture.concepts);
  });

  it("on where the record draft keeps each concept", () => {
    expect(DRAFT_KEYS).toEqual(fixture.draft_keys);
  });

  for (const item of fixture.cases) {
    it(`on the values of a case: ${item.name}`, () => {
      expect(caseValues(item.head, item.loaded as never)).toEqual(item.values);
    });
  }
});
