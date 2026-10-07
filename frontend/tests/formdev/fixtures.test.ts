/** The same fixtures the Python suite uses: both runtimes must agree on every case. */
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/formdev/core/migrate";
import { indexEntries, validateDefinition, validateRecord } from "../../src/formdev/core/validate";
import type { FormDefinition, RecordData } from "../../src/formdev/core/types";
import { fonts, loadJson, styles } from "./helpers";

const styleIds = styles.map(style => style.style_id);
const fontIds = fonts.map(font => font.font_id);
const codes = (issues: Array<{ code: string }>) => issues.map(issue => issue.code).sort();

describe("definition fixtures", () => {
  for (const testCase of loadJson<Array<{ name: string; definition: unknown; codes: string[] }>>("spec/fixtures/definition-cases.json")) {
    it(testCase.name, () => {
      expect(codes(validateDefinition(testCase.definition, styleIds, fontIds))).toEqual([...testCase.codes].sort());
    });
  }
});

describe("record fixtures", () => {
  const fixture = loadJson<{ definition: string; cases: Array<{ name: string; status: string; data: unknown; codes: string[] }> }>("spec/fixtures/record-cases.json");
  const definition = loadJson<FormDefinition>(fixture.definition);
  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      expect(codes(validateRecord(definition, testCase.data, testCase.status))).toEqual([...testCase.codes].sort());
    });
  }
});

describe("index fixtures", () => {
  const fixture = loadJson<{ definition: string; cases: Array<{ name: string; data: Record<string, unknown>; expected: unknown }> }>("spec/fixtures/index-cases.json");
  const definition = loadJson<FormDefinition>(fixture.definition);
  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      expect(indexEntries(definition, testCase.data)).toEqual(testCase.expected);
    });
  }
});

describe("migration fixtures", () => {
  const fixture = loadJson<{ definitions: Record<string, string>; cases: Array<{ name: string; from: number; to: number; input: RecordData; expected: RecordData }> }>("spec/fixtures/migration-cases.json");
  const definitions = new Map(Object.entries(fixture.definitions).map(([version, path]) => [Number(version), loadJson<FormDefinition>(path)]));
  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      const input = structuredClone(testCase.input);
      expect(migrate(testCase.input, testCase.from, testCase.to, version => definitions.get(version)!)).toEqual(testCase.expected);
      expect(testCase.input).toEqual(input);
    });
  }
  it("refuses downgrades", () => {
    expect(() => migrate({}, 2, 1, version => definitions.get(version)!)).toThrow(/older schema/);
  });
});

describe("examples", () => {
  it("both example versions are valid", () => {
    for (const version of [1, 2]) expect(validateDefinition(loadJson(`examples/patient-assessment/v${version}.form.json`), styleIds, fontIds)).toEqual([]);
  });
});
