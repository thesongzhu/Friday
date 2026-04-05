import { describe, it, expect } from "vitest";
import {
  applyFridaySkillManifestDefaults,
  FRIDAY_SKILL_MANIFEST_DEFAULTS,
} from "#skills";

describe("applyFridaySkillManifestDefaults", () => {
  it("applies all defaults to a minimal manifest input", () => {
    const raw = {
      id: "my-skill",
      name: "My Skill",
      description: "Does things",
      version: "1.0.0",
    };

    const result = applyFridaySkillManifestDefaults(raw);

    expect(result.id).toBe("my-skill");
    expect(result.name).toBe("My Skill");
    expect(result.description).toBe("Does things");
    expect(result.version).toBe("1.0.0");
    expect(result.schemaVersion).toBe("2.0");
    expect(result.kind).toBe("conversation");
    expect(result.category).toBe("utility");
    expect(result.author).toEqual({ name: "unknown" });
    expect(result.tags).toEqual([]);
    expect(result.runtime.kind).toBe("builtin");
    expect(result.runtime.entrypoint).toBe("");
    expect(result.runtime.minHubVersion).toBe("1.0.0");
    expect(result.runtime.apiVersion).toBe("1");
    expect(result.runtime.timeoutMsDefault).toBe(30_000);
    expect(result.triggers.intents).toEqual([]);
    expect(result.triggers.phrases).toEqual([]);
    expect(result.triggers.channels).toEqual(["*"]);
    expect(result.invocation.userInvocable).toBe(true);
    expect(result.invocation.modelInvocable).toBe(true);
    expect(result.invocation.priority).toBe(50);
    expect(result.invocation.modes).toEqual(["intent"]);
    expect(result.requirements.bins).toEqual([]);
    expect(result.requirements.env).toEqual([]);
    expect(result.requirements.config).toEqual([]);
    expect(result.requirements.os).toEqual(["darwin", "linux", "win32"]);
    expect(result.requirements.mcpServers).toEqual([]);
    expect(result.inputs).toEqual([]);
    expect(result.outputs).toEqual([]);
    expect(result.permissions.grants).toEqual([]);
    expect(result.permissions.promptOn).toEqual([]);
    expect(result.schemas).toBeNull();
    expect(result.flow).toBeNull();
    expect(result.executionTargets.allowedSatelliteTypes).toEqual(["phone", "desktop", "rpi", "cloud-vm"]);
    expect(result.executionTargets.requiredCapabilities).toEqual([]);
    expect(result.telemetry).toEqual({ events: [] });
  });

  it("preserves explicit values over defaults", () => {
    const raw = {
      id: "custom",
      name: "Custom",
      description: "Custom skill",
      version: "2.0.0",
      kind: "workflow",
      category: "automation",
      runtime: { kind: "python", entrypoint: "main.py", timeoutMsDefault: 60_000 },
      tags: ["custom-tag"],
    };

    const result = applyFridaySkillManifestDefaults(raw);

    expect(result.kind).toBe("workflow");
    expect(result.category).toBe("automation");
    expect(result.runtime.kind).toBe("python");
    expect(result.runtime.entrypoint).toBe("main.py");
    expect(result.runtime.timeoutMsDefault).toBe(60_000);
    expect(result.tags).toEqual(["custom-tag"]);
    // Defaults still applied for unspecified nested fields
    expect(result.runtime.apiVersion).toBe("1");
    expect(result.runtime.minHubVersion).toBe("1.0.0");
  });

  it("FRIDAY_SKILL_MANIFEST_DEFAULTS constant is frozen", () => {
    expect(Object.isFrozen(FRIDAY_SKILL_MANIFEST_DEFAULTS)).toBe(true);
  });

  it("preserves explicit MCP requirements over defaults", () => {
    const result = applyFridaySkillManifestDefaults({
      id: "mcp-skill",
      name: "MCP Skill",
      description: "Requires GitHub",
      version: "1.0.0",
      requirements: {
        mcpServers: [{ name: "github", auth: "authenticated" }],
      },
    });

    expect(result.requirements.mcpServers).toEqual([
      { name: "github", auth: "authenticated" },
    ]);
  });
});
