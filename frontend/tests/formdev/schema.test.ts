/**
 * The published JSON Schema (formdev/spec/form-definition.schema.json) is exercised by a real JSON Schema
 * validator. ajv is already installed (it ships with ESLint); the schema only uses keywords draft-07 also has.
 */
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { allProps, FIELD_TYPES } from "../../src/formdev/core/fieldTypes";
import { example, loadJson } from "./helpers";

const schema = loadJson<Record<string, unknown> & { $defs: { field: { properties: Record<string, unknown> & { type: { enum: string[] } } } } }>("spec/form-definition.schema.json");
// ajv 6 knows draft-07 only; every keyword the schema uses exists there, so drop the 2020-12 marker.
const portable: Record<string, unknown> = { ...schema };
delete portable.$schema;
const validate = new Ajv({ allErrors: true }).compile(portable);
const cases = loadJson<Array<{ name: string; definition: unknown; valid: boolean; codes: string[] }>>("spec/fixtures/definition-cases.json");

/** Fixture cases whose problem is structural, so the JSON Schema alone must reject them too. */
const STRUCTURAL = [
  "wrong format", "bad form id", "schema version zero", "empty title", "bad paper", "unknown top-level property", "no sections", "reserved field id",
  "unknown field type", "select without options", "unknown field property", "trailing newline in form id",
  "p1: invalid key", "p1: radio needs options", "p1: option with unknown property", "p1: decimals out of range", "p1: bad accept list", "p1: bad max size",
  "p1: group needs children", "p1: display context unknown", "p1: display flag not boolean", "p1: form grid columns out of range",
  "p1: section layout type", "p1: responsive mode unknown", "p1: page break value", "p1: orientation", "p1: paper size", "p1: margin out of range", "p1: band height",
  "p1: style missing", "p1: visibility operator", "p1: visibility needs when", "p1: permission role code", "p1: permission list empty",
  "p1: field permission has no create", "p1: rule value", "p1: calculator output", "p1: metadata must be an object",
];

describe("JSON Schema", () => {
  it("accepts the examples", () => {
    for (const definition of [example(1), example(2), loadJson("examples/phase1-showcase/v1.form.json")]) {
      expect(validate(definition), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  for (const testCase of cases.filter(item => item.valid)) {
    it(`accepts valid case: ${testCase.name}`, () => expect(validate(testCase.definition), JSON.stringify(validate.errors)).toBe(true));
  }

  for (const name of STRUCTURAL) {
    it(`rejects: ${name}`, () => {
      const testCase = cases.find(item => item.name === name);
      expect(testCase, name).toBeDefined();
      expect(validate(testCase?.definition)).toBe(false);
    });
  }

  it("lists exactly the registered field types and properties", () => {
    const field = schema.$defs.field.properties;
    expect([...field.type.enum].sort()).toEqual([...FIELD_TYPES].sort());
    expect(Object.keys(field).sort()).toEqual([...allProps()].sort());
  });
});
