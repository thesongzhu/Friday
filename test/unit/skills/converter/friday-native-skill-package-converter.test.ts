import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFridaySkillPackageArchiver, createNativeSkillPackageConverter } from "#skills/converter";
import type { FridaySkillConverterContext } from "#skills/converter";
import type { SkillManifestV2 } from "#skills";

const NOW_ISO = "2026-02-17T12:00:00.000Z";

function makeCtx(overrides: Partial<FridaySkillConverterContext> = {}): FridaySkillConverterContext {
  return {
    workspaceDir: "/workspace",
    managedSkillsDir: "/managed",
    nowIso: () => NOW_ISO,
    ...overrides,
  };
}

function makeValidManifest(overrides: Partial<SkillManifestV2> = {}): SkillManifestV2 {
  return {
    schemaVersion: "2.0",
    id: "test-skill",
    name: "Test Skill",
    description: "A test skill",
    version: "1.0.0",
    kind: "conversation",
    category: "utility",
    author: { name: "Test Author" },
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
    inputs: [
      { key: "name", type: "string", required: true, label: "Name" },
    ],
    outputs: [
      { key: "result", type: "string", description: "The result" },
    ],
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

describe("NativeSkillPackageConverter", () => {
  let testDir: string;
  const converter = createNativeSkillPackageConverter();
  const archiver = createFridaySkillPackageArchiver();

  beforeEach(() => {
    testDir = join(tmpdir(), `friday-test-native-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // ─── detect ───

  describe("detect", () => {
    it("returns null for source without uri", async () => {
      const result = await converter.detect({});
      expect(result).toBeNull();
    });

    it("returns null when no manifest exists", async () => {
      const result = await converter.detect({ uri: testDir });
      expect(result).toBeNull();
    });

    it("detects manifest with schemaVersion 2.0 at full confidence", async () => {
      writeFileSync(join(testDir, "skill.manifest.json"), JSON.stringify(makeValidManifest()));

      const result = await converter.detect({ uri: testDir });
      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(1.0);
      expect(result!.format).toBe("friday-package");
      expect(result!.converterId).toBe("native-friday-package");
    });

    it("detects manifest without schemaVersion 2.0 at lower confidence", async () => {
      writeFileSync(join(testDir, "skill.manifest.json"), JSON.stringify({
        schemaVersion: "1.0",
        id: "old-skill",
      }));

      const result = await converter.detect({ uri: testDir });
      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(0.6);
    });

    it("returns null for invalid JSON manifest", async () => {
      writeFileSync(join(testDir, "skill.manifest.json"), "not json{{{");

      const result = await converter.detect({ uri: testDir });
      expect(result).toBeNull();
    });

    it("detects when uri points directly to manifest file", async () => {
      const manifestPath = join(testDir, "skill.manifest.json");
      writeFileSync(manifestPath, JSON.stringify(makeValidManifest()));

      const result = await converter.detect({ uri: manifestPath });
      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(1.0);
    });
  });

  // ─── convert ───

  describe("convert", () => {
    it("throws when source has no uri", async () => {
      await expect(converter.convert({}, makeCtx())).rejects.toThrow(
        "NativeSkillPackageConverter requires a source URI",
      );
    });

    it("throws when manifest is not found", async () => {
      const emptyDir = join(testDir, "empty");
      mkdirSync(emptyDir, { recursive: true });
      await expect(converter.convert({ uri: emptyDir }, makeCtx())).rejects.toThrow(
        "skill.manifest.json not found",
      );
    });

    it("throws for invalid JSON manifest", async () => {
      writeFileSync(join(testDir, "skill.manifest.json"), "not json");
      await expect(converter.convert({ uri: testDir }, makeCtx())).rejects.toThrow(
        "Invalid JSON",
      );
    });

    it("passthrough converts a valid native package", async () => {
      const manifest = makeValidManifest();
      writeFileSync(join(testDir, "skill.manifest.json"), JSON.stringify(manifest, null, 2));

      const uiSchema = {
        schemaVersion: "1.0",
        title: "Test Skill",
        sections: [{ id: "main", label: "Main", fieldIds: ["field-name"] }],
        fields: [{ id: "field-name", inputKey: "name", kind: "text", label: "Name", required: true }],
        outputs: [],
        actions: [{ id: "run", label: "Run", style: "primary" }],
      };
      writeFileSync(join(testDir, "skill.ui.json"), JSON.stringify(uiSchema, null, 2));

      const runSh = "#!/bin/bash\necho hello";
      writeFileSync(join(testDir, "run.sh"), runSh);
      chmodSync(join(testDir, "run.sh"), 0o755);

      const result = await converter.convert({ uri: testDir }, makeCtx());

      expect(result.converterId).toBe("native-friday-package");
      expect(result.detectedFormat).toBe("friday-package");
      expect(result.drafts).toHaveLength(1);

      const draft = result.drafts[0]!;
      expect(draft.manifest.id).toBe("test-skill");
      expect(draft.manifest.name).toBe("Test Skill");
      expect(draft.warnings).toHaveLength(0);

      // Files should include all package files
      const filePaths = draft.files.map((f) => f.path);
      expect(filePaths).toContain("skill.manifest.json");
      expect(filePaths).toContain("skill.ui.json");
      expect(filePaths).toContain("run.sh");

      // run.sh should be marked executable
      const runShFile = draft.files.find((f) => f.path === "run.sh")!;
      expect(runShFile.executable).toBe(true);

      // Conversion report
      expect(draft.conversionReport.sourceFormat).toBe("friday-package");
      expect(draft.conversionReport.convertedAt).toBe(NOW_ISO);
    });

    it("unpacks and converts a .friday.tgz archive produced by friday pack", async () => {
      const skillDir = join(testDir, "native-skill");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "skill.manifest.json"), JSON.stringify(makeValidManifest(), null, 2));
      writeFileSync(join(skillDir, "skill.ui.json"), JSON.stringify({
        schemaVersion: "1.0",
        title: "Test Skill",
        sections: [],
        fields: [],
        outputs: [],
        actions: [],
      }, null, 2));
      writeFileSync(join(skillDir, "run.sh"), "#!/bin/bash\necho archive");
      chmodSync(join(skillDir, "run.sh"), 0o755);

      const archive = archiver.packSkill(skillDir, join(testDir, "packed-skill")).packageFile;
      const result = await converter.convert({ uri: archive }, makeCtx());

      expect(result.detectedFormat).toBe("friday-package");
      expect(result.drafts).toHaveLength(1);
      expect(result.drafts[0]!.manifest.id).toBe("test-skill");
      expect(result.drafts[0]!.files.map((f) => f.path)).toContain("run.sh");
    });

    it("generates minimal UI schema when skill.ui.json is missing", async () => {
      writeFileSync(join(testDir, "skill.manifest.json"), JSON.stringify(makeValidManifest()));
      writeFileSync(join(testDir, "run.sh"), "#!/bin/bash\necho hello");

      const result = await converter.convert({ uri: testDir }, makeCtx());
      const draft = result.drafts[0]!;

      expect(draft.warnings).toContain("skill.ui.json not found — generating minimal UI schema");
      expect(draft.uiSchema.schemaVersion).toBe("1.0");
      expect(draft.uiSchema.title).toBe("Test Skill");
      expect(draft.uiSchema.fields).toHaveLength(1);
      expect(draft.uiSchema.fields[0]!.inputKey).toBe("name");
    });

    it("skips hidden files and node_modules", async () => {
      writeFileSync(join(testDir, "skill.manifest.json"), JSON.stringify(makeValidManifest()));
      writeFileSync(join(testDir, "skill.ui.json"), JSON.stringify({
        schemaVersion: "1.0",
        title: "Test",
        sections: [],
        fields: [],
        outputs: [],
        actions: [],
      }));
      writeFileSync(join(testDir, ".gitignore"), "dist/");
      mkdirSync(join(testDir, "node_modules", "dep"), { recursive: true });
      writeFileSync(join(testDir, "node_modules", "dep", "index.js"), "module.exports = {}");

      const result = await converter.convert({ uri: testDir }, makeCtx());
      const filePaths = result.drafts[0]!.files.map((f) => f.path);

      expect(filePaths).not.toContain(".gitignore");
      expect(filePaths).not.toContain("node_modules/dep/index.js");
    });

    it("collects files from subdirectories", async () => {
      writeFileSync(join(testDir, "skill.manifest.json"), JSON.stringify(makeValidManifest()));
      writeFileSync(join(testDir, "skill.ui.json"), JSON.stringify({
        schemaVersion: "1.0",
        title: "Test",
        sections: [],
        fields: [],
        outputs: [],
        actions: [],
      }));

      mkdirSync(join(testDir, "assets"), { recursive: true });
      writeFileSync(join(testDir, "assets", "icon.txt"), "icon data");

      const result = await converter.convert({ uri: testDir }, makeCtx());
      const filePaths = result.drafts[0]!.files.map((f) => f.path);

      expect(filePaths).toContain("assets/icon.txt");
    });
  });
});
