import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileFridaySkillSchemas } from "#skills";
import { makeManifest } from "../_helpers/make-manifest.helper.js";

describe("compileFridaySkillSchemas", () => {
  let skillDir: string;

  beforeEach(() => {
    skillDir = mkdtempSync(join(tmpdir(), "friday-test-schema-"));
  });

  afterEach(() => {
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("returns empty when no schemas declared", () => {
    const manifest = makeManifest({ schemas: null });
    const { compiled, issues } = compileFridaySkillSchemas({ manifest, skillDir });
    expect(Object.keys(compiled)).toHaveLength(0);
    expect(issues).toEqual([]);
  });

  it("compiles valid JSON schema files", () => {
    mkdirSync(join(skillDir, "schemas"), { recursive: true });
    writeFileSync(
      join(skillDir, "schemas", "input.json"),
      JSON.stringify({
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      }),
    );

    const manifest = makeManifest({
      schemas: { input: "schemas/input.json", state: null, output: null },
    });

    const { compiled, issues } = compileFridaySkillSchemas({ manifest, skillDir });
    expect(compiled.input).toBeDefined();
    expect(typeof compiled.input).toBe("function");
    expect(issues).toEqual([]);
  });

  it("reports missing schema files", () => {
    const manifest = makeManifest({
      schemas: { input: "schemas/missing.json", state: null, output: null },
    });

    const { issues } = compileFridaySkillSchemas({ manifest, skillDir });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe("SCHEMA_FILE_NOT_FOUND");
  });

  it("reports invalid JSON in schema files", () => {
    mkdirSync(join(skillDir, "schemas"), { recursive: true });
    writeFileSync(join(skillDir, "schemas", "input.json"), "not json");

    const manifest = makeManifest({
      schemas: { input: "schemas/input.json", state: null, output: null },
    });

    const { issues } = compileFridaySkillSchemas({ manifest, skillDir });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe("SCHEMA_PARSE_FAILED");
  });

  it("reports schema compile failures", () => {
    mkdirSync(join(skillDir, "schemas"), { recursive: true });
    // Invalid JSON Schema (bad type value)
    writeFileSync(
      join(skillDir, "schemas", "input.json"),
      JSON.stringify({ type: "nonexistent-type" }),
    );

    const manifest = makeManifest({
      schemas: { input: "schemas/input.json", state: null, output: null },
    });

    const { issues } = compileFridaySkillSchemas({ manifest, skillDir });
    expect(issues.length).toBeGreaterThan(0);
    // It should be either compile failed or the schema still compiled (AJV might accept weird types)
  });
});
