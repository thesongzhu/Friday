import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFridaySkillConverterService } from "#skills/converter";
import { createFridaySkillConverterRegistry } from "#skills/converter";
import { createFridaySkillImportInstaller } from "#skills/converter";
import { createFridaySkillPackageArchiver } from "#skills/converter";
import { createClawdbotSkillMdConverter } from "#skills/converter";
import { createNativeSkillPackageConverter } from "#skills/converter";
import { createFridayN8nNodeConverter } from "#skills/converter";
import { createFridayOpenAiGptActionConverter } from "#skills/converter";
import { createFridayCodeRepoConverter } from "#skills/converter";
import { createFridayUndocumentedApiConverter } from "#skills/converter";
import { createFridayRecordingConverter } from "#skills/converter";
import type { FridaySkillConverterContext } from "#skills/converter";
import type { SkillManifestV2 } from "#skills";

const NOW_ISO = "2026-02-17T12:00:00.000Z";

function makeValidManifest(overrides: Partial<SkillManifestV2> = {}): SkillManifestV2 {
  return {
    schemaVersion: "2.0",
    id: "service-test-skill",
    name: "Service Test Skill",
    description: "Test skill for service tests",
    version: "1.0.0",
    kind: "conversation",
    category: "utility",
    author: { name: "Test" },
    tags: ["test"],
    runtime: {
      kind: "shell",
      entrypoint: "run.sh",
      minHubVersion: "1.0.0",
      apiVersion: "1",
      timeoutMsDefault: 30_000,
    },
    triggers: { intents: [], phrases: [], channels: ["*"] },
    invocation: {
      userInvocable: true,
      modelInvocable: true,
      priority: 50,
      modes: ["intent"],
    },
    requirements: { bins: [], env: [], config: [], os: ["darwin", "linux", "win32"] },
    inputs: [],
    outputs: [{ key: "result", type: "string" }],
    permissions: { grants: [], promptOn: [] },
    schemas: { input: null, state: null, output: null },
    flow: null,
    executionTargets: {
      allowedSatelliteTypes: ["phone", "desktop", "rpi", "cloud-vm"],
      requiredCapabilities: [],
    },
    telemetry: { events: [] },
    ...overrides,
  };
}

describe("FridaySkillConverterService", () => {
  let testDir: string;
  let managedDir: string;
  let workspaceDir: string;
  let ctx: FridaySkillConverterContext;

  beforeEach(() => {
    testDir = join(tmpdir(), `friday-test-service-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    managedDir = join(testDir, "managed");
    workspaceDir = join(testDir, "workspace");
    mkdirSync(managedDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });

    ctx = {
      workspaceDir,
      managedSkillsDir: managedDir,
      nowIso: () => NOW_ISO,
    };
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function createService(options: { onRegistryRefresh?: () => Promise<void> } = {}) {
    const registry = createFridaySkillConverterRegistry();
    registry.register(createNativeSkillPackageConverter());
    registry.register(createClawdbotSkillMdConverter());
    registry.register(createFridayN8nNodeConverter());
    registry.register(createFridayOpenAiGptActionConverter());
    registry.register(createFridayCodeRepoConverter());
    registry.register(createFridayUndocumentedApiConverter());
    registry.register(createFridayRecordingConverter());

    const installer = createFridaySkillImportInstaller();
    const archiver = createFridaySkillPackageArchiver();

    return createFridaySkillConverterService({
      registry,
      installer,
      archiver,
      context: ctx,
      onRegistryRefresh: options.onRegistryRefresh,
    });
  }

  // ─── listConverters ───

  describe("listConverters", () => {
    it("returns all registered converters", () => {
      const service = createService();
      const converters = service.listConverters();

      expect(converters.length).toBe(7);

      const ids = converters.map((c) => c.id);
      expect(ids).toContain("native-friday-package");
      expect(ids).toContain("clawdbot-skill-md");
      expect(ids).toContain("n8n-node");
      expect(ids).toContain("openai-gpt-action");
      expect(ids).toContain("code-repo");
      expect(ids).toContain("undocumented-api");
      expect(ids).toContain("desktop-recording");

      // Each should have source formats
      for (const converter of converters) {
        expect(converter.sourceFormats.length).toBeGreaterThan(0);
        expect(converter.displayName).toBeTruthy();
      }
    });
  });

  // ─── detect ───

  describe("detect", () => {
    it("detects native Friday package", async () => {
      const skillDir = join(testDir, "native-skill");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "skill.manifest.json"), JSON.stringify(makeValidManifest()));

      const service = createService();
      const detection = await service.detect({ uri: skillDir });

      expect(detection).not.toBeNull();
      expect(detection!.format).toBe("friday-package");
      expect(detection!.converterId).toBe("native-friday-package");
    });

    it("detects Clawdbot SKILL.md", async () => {
      const skillDir = join(testDir, "clawdbot-skill");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "SKILL.md"), `---
name: test
---

A test skill.
`);

      const service = createService();
      const detection = await service.detect({ uri: skillDir });

      expect(detection).not.toBeNull();
      expect(detection!.format).toBe("clawdbot-skill-md");
    });

    it("detects n8n node", async () => {
      const filePath = join(testDir, "node.json");
      writeFileSync(filePath, JSON.stringify({
        name: "testNode",
        displayName: "Test Node",
        properties: [],
      }));

      const service = createService();
      const detection = await service.detect({ uri: filePath });

      expect(detection).not.toBeNull();
      expect(detection!.format).toBe("n8n-node");
    });

    it("detects OpenAPI spec", async () => {
      const filePath = join(testDir, "spec.json");
      writeFileSync(filePath, JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Test API", version: "1.0" },
        paths: { "/test": { get: { operationId: "test" } } },
      }));

      const service = createService();
      const detection = await service.detect({ uri: filePath });

      expect(detection).not.toBeNull();
      expect(detection!.format).toBe("openai-gpt-action");
    });

    it("returns null for unrecognized source", async () => {
      const filePath = join(testDir, "unknown.txt");
      writeFileSync(filePath, "not a skill source");

      const service = createService();
      const detection = await service.detect({ uri: filePath });

      expect(detection).toBeNull();
    });
  });

  // ─── convert ───

  describe("convert", () => {
    it("converts a Clawdbot SKILL.md", async () => {
      const skillDir = join(testDir, "clawdbot-skill");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "SKILL.md"), `---
name: weather
---

Get weather.

\`\`\`bash
curl wttr.in
\`\`\`
`);

      const service = createService();
      const result = await service.convert({
        source: { uri: skillDir },
      });

      expect(result.converterId).toBe("clawdbot-skill-md");
      expect(result.drafts).toHaveLength(1);
      expect(result.validation).toHaveLength(1);
      expect(result.validation[0]!.skillId).toBeTruthy();
      expect(result.quality).toBeDefined();
      expect(result.quality!.score).toBeGreaterThanOrEqual(0);
      expect(result.quality!.score).toBeLessThanOrEqual(100);
    });

    it("throws when no converter matches", async () => {
      const filePath = join(testDir, "unknown.txt");
      writeFileSync(filePath, "unknown content");

      const service = createService();
      await expect(service.convert({ source: { uri: filePath } })).rejects.toThrow(
        "No converter detected",
      );
    });

    it("validates converted drafts", async () => {
      const skillDir = join(testDir, "validate-skill");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "SKILL.md"), `---
name: valid-skill
---

A valid skill.

\`\`\`bash
echo hello
\`\`\`
`);

      const service = createService();
      const result = await service.convert({
        source: { uri: skillDir },
      });

      expect(result.validation).toHaveLength(1);
      // Validation should have run
      expect(Array.isArray(result.validation[0]!.issues)).toBe(true);
    });
  });

  // ─── import ───

  describe("import", () => {
    it("imports a Clawdbot SKILL.md to managed dir", async () => {
      const skillDir = join(testDir, "import-skill");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "SKILL.md"), `---
name: import-test
skillKey: import-test
---

Test import.

\`\`\`bash
echo "imported"
\`\`\`
`);

      const refreshMock = vi.fn().mockResolvedValue(undefined);
      const service = createService({ onRegistryRefresh: refreshMock });

      const result = await service.import({
        source: { uri: skillDir },
        target: "managed",
      });

      expect(result.converterId).toBe("clawdbot-skill-md");
      expect(result.detectedFormat).toBe("clawdbot-skill-md");
      expect(result.imports).toHaveLength(1);
      expect(result.imports[0]!.installed).toBe(true);
      expect(result.imports[0]!.skillId).toBe("import-test");
      expect(result.registryRefreshed).toBe(true);
      expect(refreshMock).toHaveBeenCalledOnce();
    });

    it("does not refresh registry when refreshRegistry is false", async () => {
      const skillDir = join(testDir, "no-refresh-skill");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "SKILL.md"), `---
name: no-refresh
skillKey: no-refresh
---

\`\`\`bash
echo test
\`\`\`
`);

      const refreshMock = vi.fn().mockResolvedValue(undefined);
      const service = createService({ onRegistryRefresh: refreshMock });

      const result = await service.import({
        source: { uri: skillDir },
        refreshRegistry: false,
      });

      expect(result.imports[0]!.installed).toBe(true);
      expect(result.registryRefreshed).toBe(false);
      expect(refreshMock).not.toHaveBeenCalled();
    });

    it("throws when no converter detected for import", async () => {
      const filePath = join(testDir, "unknown.txt");
      writeFileSync(filePath, "unknown content");

      const service = createService();
      await expect(service.import({ source: { uri: filePath } })).rejects.toThrow(
        "No converter detected",
      );
    });
  });

  // ─── pack ───

  describe("pack", () => {
    it("packs a valid skill directory", async () => {
      const skillDir = join(testDir, "pack-skill");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "skill.manifest.json"), JSON.stringify(makeValidManifest({
        id: "pack-test",
      }), null, 2));
      writeFileSync(join(skillDir, "skill.ui.json"), JSON.stringify({
        schemaVersion: "1.0",
        title: "Pack Test",
        sections: [],
        fields: [],
        outputs: [],
        actions: [],
      }));
      writeFileSync(join(skillDir, "run.sh"), "#!/bin/bash\necho hello");

      const outputFile = join(testDir, "output", "pack-test-1.0.0.friday.tgz");
      const service = createService();

      const result = await service.pack({ skillDir, outputFile });

      expect(result.packageFile).toBe(outputFile);
      expect(result.checksumSha256).toBeTruthy();
    });

    it("throws for non-existent skill directory", async () => {
      const service = createService();
      await expect(service.pack({
        skillDir: "/nonexistent/skill",
        outputFile: join(testDir, "output.friday.tgz"),
      })).rejects.toThrow("Failed to load skill package");
    });
  });
});
