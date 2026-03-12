import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  mapLegacyPermissionV1ToV2,
  adaptFridayLegacySkill,
} from "#skills";
import type { LegacySkillPermissionV1 } from "#skills";

describe("mapLegacyPermissionV1ToV2", () => {
  it("maps tool permissions to grants", () => {
    const legacy: LegacySkillPermissionV1 = {
      tools: ["web_search", "read_file"],
      memoryScope: "none",
      network: false,
      filesystem: "none",
    };
    const result = mapLegacyPermissionV1ToV2(legacy, "/workspace");
    const toolGrants = result.grants.filter((g) => g.resource === "tool");
    expect(toolGrants).toHaveLength(1);
    expect(toolGrants[0]!.selectors?.toolAllowlist).toEqual(["web_search", "read_file"]);
  });

  it("maps wildcard tools without allowlist", () => {
    const legacy: LegacySkillPermissionV1 = {
      tools: ["*"],
      memoryScope: "none",
      network: false,
      filesystem: "none",
    };
    const result = mapLegacyPermissionV1ToV2(legacy, "/workspace");
    const toolGrants = result.grants.filter((g) => g.resource === "tool");
    expect(toolGrants).toHaveLength(1);
    expect(toolGrants[0]!.selectors).toBeUndefined();
  });

  it("maps memory read scope", () => {
    const legacy: LegacySkillPermissionV1 = {
      tools: [],
      memoryScope: "read",
      network: false,
      filesystem: "none",
    };
    const result = mapLegacyPermissionV1ToV2(legacy, "/workspace");
    const memGrants = result.grants.filter((g) => g.resource === "memory");
    expect(memGrants).toHaveLength(1);
    expect(memGrants[0]!.action).toBe("read");
  });

  it("maps memory readwrite scope", () => {
    const legacy: LegacySkillPermissionV1 = {
      tools: [],
      memoryScope: "readwrite",
      network: false,
      filesystem: "none",
    };
    const result = mapLegacyPermissionV1ToV2(legacy, "/workspace");
    const memGrants = result.grants.filter((g) => g.resource === "memory");
    expect(memGrants).toHaveLength(2);
  });

  it("maps network access with prompt and wildcard hostAllowlist", () => {
    const legacy: LegacySkillPermissionV1 = {
      tools: [],
      memoryScope: "none",
      network: true,
      filesystem: "none",
    };
    const result = mapLegacyPermissionV1ToV2(legacy, "/workspace");
    const netGrant = result.grants.find((g) => g.resource === "network");
    expect(netGrant).toBeDefined();
    expect(netGrant!.selectors?.hostAllowlist).toEqual(["*"]);
    expect(result.promptOn).toContain("network.connect");
  });

  it("maps workspace filesystem permissions", () => {
    const legacy: LegacySkillPermissionV1 = {
      tools: [],
      memoryScope: "none",
      network: false,
      filesystem: "workspace",
    };
    const result = mapLegacyPermissionV1ToV2(legacy, "/workspace");
    const fsGrants = result.grants.filter((g) => g.resource === "filesystem");
    expect(fsGrants).toHaveLength(2); // read + write
    expect(result.promptOn).toContain("filesystem.write");
  });

  it("maps scoped filesystem permissions", () => {
    const legacy: LegacySkillPermissionV1 = {
      tools: [],
      memoryScope: "none",
      network: false,
      filesystem: "scoped",
      filesystemScopes: ["/allowed/path"],
    };
    const result = mapLegacyPermissionV1ToV2(legacy, "/workspace");
    const fsGrants = result.grants.filter((g) => g.resource === "filesystem");
    expect(fsGrants).toHaveLength(2);
    expect(fsGrants[0]!.selectors?.pathPrefixes).toEqual(["/allowed/path"]);
  });
});

describe("adaptFridayLegacySkill", () => {
  let skillDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "friday-test-workspace-"));
    skillDir = mkdtempSync(join(workspaceDir, "skill-"));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("returns error when SKILL.md is missing", () => {
    const result = adaptFridayLegacySkill({ skillDir, workspaceDir });
    expect(result.ok).toBe(false);
  });

  it("adapts a basic SKILL.md to SkillManifestV2 per §2.2.1", () => {
    const md = `---
name: My Legacy Skill
---
A skill that does things.`;
    writeFileSync(join(skillDir, "SKILL.md"), md);

    const result = adaptFridayLegacySkill({ skillDir, workspaceDir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifest.name).toBe("My Legacy Skill");
      expect(result.value.manifest.version).toBe("0.0.0");
      expect(result.value.manifest.author.name).toBe("unknown");
      expect(result.value.manifest.schemaVersion).toBe("2.0");
      expect(result.value.manifest.runtime.kind).toBe("builtin");
      expect(result.value.manifest.runtime.entrypoint).toBe("");
      expect(result.value.manifest.triggers.channels).toEqual(["*"]);
      expect(result.value.manifest.invocation.priority).toBe(50);
    }
  });

  it("maps invocation flags from frontmatter", () => {
    const md = `---
name: Private Skill
userInvocable: false
disableModelInvocation: true
---
Not callable.`;
    writeFileSync(join(skillDir, "SKILL.md"), md);

    const result = adaptFridayLegacySkill({ skillDir, workspaceDir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.invocation.userInvocable).toBe(false);
      expect(result.value.invocation.disableModelInvocation).toBe(true);
      expect(result.value.manifest.invocation.userInvocable).toBe(false);
      expect(result.value.manifest.invocation.modelInvocable).toBe(false);
    }
  });

  it("extracts metadata from frontmatter", () => {
    const md = `---
name: Meta Skill
always: true
emoji: 🚀
homepage: https://example.com
---
A skill.`;
    writeFileSync(join(skillDir, "SKILL.md"), md);

    const result = adaptFridayLegacySkill({ skillDir, workspaceDir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.metadata?.always).toBe(true);
      expect(result.value.metadata?.emoji).toBe("🚀");
      expect(result.value.metadata?.homepage).toBe("https://example.com");
    }
  });

  it("applies default kind and category when not specified", () => {
    const md = `---
name: Default Skill
---
Body.`;
    writeFileSync(join(skillDir, "SKILL.md"), md);

    const result = adaptFridayLegacySkill({ skillDir, workspaceDir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifest.kind).toBe("conversation");
      expect(result.value.manifest.category).toBe("utility");
    }
  });

  it("includes default legacy permission grants per §2.2.1", () => {
    const md = `---
name: Perm Skill
---
Body.`;
    writeFileSync(join(skillDir, "SKILL.md"), md);

    const result = adaptFridayLegacySkill({ skillDir, workspaceDir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const grants = result.value.manifest.permissions.grants;
      expect(grants).toHaveLength(2);
      expect(grants[0]!.id).toBe("legacy-tools");
      expect(grants[1]!.id).toBe("legacy-memory");
    }
  });
});
