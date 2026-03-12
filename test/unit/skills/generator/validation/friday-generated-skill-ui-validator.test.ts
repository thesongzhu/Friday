import { describe, it, expect } from "vitest";

import { validateUiSchema } from "#skills/generator";

import type { SkillManifestV2 } from "#skills";
import type { FridaySkillUiSchemaV1 } from "#skills/generator";

function makeManifest(
  overrides: Partial<SkillManifestV2> = {},
): SkillManifestV2 {
  return {
    schemaVersion: "2.0",
    id: "test-skill",
    name: "Test",
    description: "A test",
    version: "1.0.0",
    kind: "automation",
    category: "utility",
    author: { name: "Test" },
    tags: [],
    runtime: {
      kind: "node",
      entrypoint: "index.mjs",
      minHubVersion: "0.1.0",
      apiVersion: "1",
      timeoutMsDefault: 30000,
    },
    triggers: { intents: [], phrases: [], channels: [] },
    invocation: {
      userInvocable: true,
      modelInvocable: true,
      priority: 50,
      modes: ["intent"],
    },
    requirements: { bins: [], env: [], config: [], os: ["darwin", "linux"] },
    inputs: [
      { key: "name", type: "string", required: true, label: "Name" },
      { key: "count", type: "number", required: false, label: "Count" },
    ],
    outputs: [
      { key: "result", type: "string", description: "The result" },
      { key: "total", type: "number", description: "Total count" },
    ],
    permissions: { grants: [], promptOn: [] },
    executionTargets: { allowedSatelliteTypes: [], requiredCapabilities: [] },
    ...overrides,
  };
}

function makeUiSchema(
  overrides: Partial<FridaySkillUiSchemaV1> = {},
): FridaySkillUiSchemaV1 {
  return {
    schemaVersion: "1.0",
    title: "Test Skill",
    sections: [
      { id: "main", label: "Main", fieldIds: ["f-name", "f-count"] },
    ],
    fields: [
      { id: "f-name", inputKey: "name", kind: "text", label: "Name", required: true },
      { id: "f-count", inputKey: "count", kind: "number", label: "Count", required: false },
    ],
    outputs: [
      { id: "o-result", outputKey: "result", label: "Result", widget: "text" },
      { id: "o-total", outputKey: "total", label: "Total", widget: "text" },
    ],
    actions: [
      { id: "run", label: "Run", style: "primary" },
      { id: "reset", label: "Reset", style: "secondary" },
    ],
    ...overrides,
  };
}

describe("validateUiSchema", () => {
  it("returns no issues for valid schema", () => {
    const issues = validateUiSchema(makeUiSchema(), makeManifest());
    expect(issues).toHaveLength(0);
  });

  it("detects invalid schemaVersion", () => {
    const schema = makeUiSchema();
    // Force wrong version for testing
    const badSchema = { ...schema, schemaVersion: "2.0" as "1.0" };
    const issues = validateUiSchema(badSchema, makeManifest());
    expect(issues.some((i) => i.code === "UI_INVALID_SCHEMA_VERSION")).toBe(true);
  });

  it("detects missing title", () => {
    const schema = makeUiSchema({ title: "" });
    const issues = validateUiSchema(schema, makeManifest());
    expect(issues.some((i) => i.code === "UI_MISSING_TITLE")).toBe(true);
  });

  it("detects field inputKey mismatch", () => {
    const schema = makeUiSchema({
      fields: [
        { id: "f-bad", inputKey: "nonexistent", kind: "text", label: "Bad", required: true },
      ],
      sections: [{ id: "main", label: "Main", fieldIds: ["f-bad"] }],
    });
    const issues = validateUiSchema(schema, makeManifest());
    expect(issues.some((i) => i.code === "UI_FIELD_INPUT_KEY_MISMATCH")).toBe(true);
  });

  it("detects output key mismatch", () => {
    const schema = makeUiSchema({
      outputs: [
        { id: "o-bad", outputKey: "nonexistent", label: "Bad", widget: "text" },
      ],
    });
    const issues = validateUiSchema(schema, makeManifest());
    expect(issues.some((i) => i.code === "UI_OUTPUT_KEY_MISMATCH")).toBe(true);
  });

  it("detects duplicate field ids", () => {
    const schema = makeUiSchema({
      fields: [
        { id: "f-dup", inputKey: "name", kind: "text", label: "Name 1", required: true },
        { id: "f-dup", inputKey: "count", kind: "number", label: "Name 2", required: false },
      ],
      sections: [{ id: "main", label: "Main", fieldIds: ["f-dup"] }],
    });
    const issues = validateUiSchema(schema, makeManifest());
    expect(issues.some((i) => i.code === "UI_DUPLICATE_FIELD_ID")).toBe(true);
  });

  it("detects duplicate output ids", () => {
    const schema = makeUiSchema({
      outputs: [
        { id: "o-dup", outputKey: "result", label: "Result 1", widget: "text" },
        { id: "o-dup", outputKey: "total", label: "Result 2", widget: "json" },
      ],
    });
    const issues = validateUiSchema(schema, makeManifest());
    expect(issues.some((i) => i.code === "UI_DUPLICATE_OUTPUT_ID")).toBe(true);
  });

  it("detects duplicate section ids", () => {
    const schema = makeUiSchema({
      sections: [
        { id: "sec-dup", label: "Section 1", fieldIds: ["f-name"] },
        { id: "sec-dup", label: "Section 2", fieldIds: ["f-count"] },
      ],
    });
    const issues = validateUiSchema(schema, makeManifest());
    expect(issues.some((i) => i.code === "UI_DUPLICATE_SECTION_ID")).toBe(true);
  });

  it("warns when section references unknown field", () => {
    const schema = makeUiSchema({
      sections: [
        { id: "main", label: "Main", fieldIds: ["f-name", "f-unknown"] },
      ],
    });
    const issues = validateUiSchema(schema, makeManifest());
    expect(issues.some((i) => i.code === "UI_SECTION_REFERENCES_UNKNOWN_FIELD")).toBe(true);
    expect(issues.find((i) => i.code === "UI_SECTION_REFERENCES_UNKNOWN_FIELD")!.severity).toBe("warning");
  });

  it("warns when no actions defined", () => {
    const schema = makeUiSchema({ actions: [] });
    const issues = validateUiSchema(schema, makeManifest());
    expect(issues.some((i) => i.code === "UI_NO_ACTIONS")).toBe(true);
    expect(issues.find((i) => i.code === "UI_NO_ACTIONS")!.severity).toBe("warning");
  });

  it("allows valid inputKeys that exist in manifest", () => {
    const schema = makeUiSchema();
    const issues = validateUiSchema(schema, makeManifest());
    expect(issues.some((i) => i.code === "UI_FIELD_INPUT_KEY_MISMATCH")).toBe(false);
  });

  it("allows valid outputKeys that exist in manifest", () => {
    const schema = makeUiSchema();
    const issues = validateUiSchema(schema, makeManifest());
    expect(issues.some((i) => i.code === "UI_OUTPUT_KEY_MISMATCH")).toBe(false);
  });
});
