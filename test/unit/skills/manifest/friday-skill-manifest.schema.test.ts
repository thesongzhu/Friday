import { describe, it, expect } from "vitest";
import {
  parseFridaySkillManifestV2,
  safeParseFridaySkillManifestV2,
} from "#skills";
import { makeManifest } from "../_helpers/make-manifest.helper.js";

describe("FRIDAY_SKILL_MANIFEST_V2_SCHEMA", () => {
  it("accepts a valid full manifest", () => {
    const manifest = makeManifest();
    const result = parseFridaySkillManifestV2(manifest);
    expect(result.id).toBe("test-skill");
    expect(result.schemaVersion).toBe("2.0");
  });

  it("rejects invalid schemaVersion", () => {
    const manifest = makeManifest({ schemaVersion: "3.0" as "2.0" });
    const result = safeParseFridaySkillManifestV2(manifest);
    expect(result.success).toBe(false);
  });

  it("rejects invalid promptOn tokens", () => {
    const manifest = makeManifest({
      permissions: {
        grants: [],
        promptOn: ["invalid.token" as "filesystem.write"],
      },
    });
    const result = safeParseFridaySkillManifestV2(manifest);
    expect(result.success).toBe(false);
  });

  it("rejects invalid enum fields (kind)", () => {
    const manifest = makeManifest({ kind: "invalid" as "conversation" });
    const result = safeParseFridaySkillManifestV2(manifest);
    expect(result.success).toBe(false);
  });

  it("rejects invalid enum fields (category)", () => {
    const manifest = makeManifest({ category: "gaming" as "utility" });
    const result = safeParseFridaySkillManifestV2(manifest);
    expect(result.success).toBe(false);
  });

  it("rejects missing required string fields", () => {
    const partial = { schemaVersion: "2.0" };
    const result = safeParseFridaySkillManifestV2(partial);
    expect(result.success).toBe(false);
  });

  it("accepts manifest with optional fields present", () => {
    const manifest = makeManifest({
      homepage: "https://example.com",
      license: "MIT",
      ui: { icon: "star", color: "#fff" },
      telemetry: { events: ["skill.started"] },
    });
    const result = safeParseFridaySkillManifestV2(manifest);
    expect(result.success).toBe(true);
  });

  it("accepts manifest with flow defined", () => {
    const manifest = makeManifest({
      flow: {
        startStep: "ask",
        steps: [
          {
            id: "ask",
            type: "ask",
            completion: {},
            transitions: { onSuccess: null },
          },
        ],
      },
    });
    const result = safeParseFridaySkillManifestV2(manifest);
    expect(result.success).toBe(true);
  });

  it("accepts manifest with MCP server requirements", () => {
    const manifest = makeManifest({
      requirements: {
        bins: [],
        env: [],
        config: [],
        os: ["darwin", "linux", "win32"],
        mcpServers: [{ name: "github", auth: "authenticated" }],
      },
    });
    const result = safeParseFridaySkillManifestV2(manifest);
    expect(result.success).toBe(true);
  });

  it("rejects invalid MCP auth requirements", () => {
    const manifest = makeManifest({
      requirements: {
        bins: [],
        env: [],
        config: [],
        os: ["darwin", "linux", "win32"],
        mcpServers: [{ name: "github", auth: "oauth" as "authenticated" }],
      },
    });
    const result = safeParseFridaySkillManifestV2(manifest);
    expect(result.success).toBe(false);
  });
});
