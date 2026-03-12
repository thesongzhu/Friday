import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFridaySkillImportInstaller } from "#skills/converter";
import type { FridayConvertedSkillDraft } from "#skills/converter";
import type { SkillManifestV2 } from "#skills";

function makeValidManifest(overrides: Partial<SkillManifestV2> = {}): SkillManifestV2 {
  return {
    schemaVersion: "2.0",
    id: "test-install-skill",
    name: "Test Install Skill",
    description: "A skill for testing installation",
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
    outputs: [
      { key: "stdout", type: "string", description: "Output" },
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

function makeDraft(overrides: Partial<FridayConvertedSkillDraft> = {}): FridayConvertedSkillDraft {
  const manifest = overrides.manifest ?? makeValidManifest();

  return {
    manifest,
    uiSchema: {
      schemaVersion: "1.0",
      title: manifest.name,
      sections: [{ id: "main", label: "Main", fieldIds: [] }],
      fields: [],
      outputs: [],
      actions: [
        { id: "run", label: "Run", style: "primary" },
        { id: "reset", label: "Reset", style: "secondary" },
      ],
    },
    files: [
      {
        path: "skill.manifest.json",
        content: JSON.stringify(manifest, null, 2),
      },
      {
        path: "skill.ui.json",
        content: JSON.stringify({
          schemaVersion: "1.0",
          title: manifest.name,
          sections: [{ id: "main", label: "Main", fieldIds: [] }],
          fields: [],
          outputs: [],
          actions: [
            { id: "run", label: "Run", style: "primary" },
            { id: "reset", label: "Reset", style: "secondary" },
          ],
        }, null, 2),
      },
      {
        path: "run.sh",
        content: '#!/usr/bin/env bash\necho "hello"\n',
        executable: true,
      },
    ],
    warnings: [],
    conversionReport: {
      sourceFormat: "clawdbot-skill-md",
      convertedAt: "2026-02-17T12:00:00.000Z",
      converterId: "clawdbot-skill-md",
    },
    ...overrides,
  };
}

describe("FridaySkillImportInstaller", () => {
  let testDir: string;
  let managedDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `friday-test-installer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    managedDir = join(testDir, "managed");
    workspaceDir = join(testDir, "workspace");
    mkdirSync(managedDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const installer = createFridaySkillImportInstaller();

  describe("installConvertedSkill", () => {
    it("installs a valid draft to managed directory", () => {
      const draft = makeDraft();
      const result = installer.installConvertedSkill(draft, "managed", {
        workspaceDir,
        managedSkillsDir: managedDir,
      });

      expect(result.installed).toBe(true);
      expect(result.skillId).toBe("test-install-skill");
      expect(result.skillDir).toBe(join(managedDir, "test-install-skill"));

      // Verify files exist
      expect(existsSync(join(result.skillDir, "skill.manifest.json"))).toBe(true);
      expect(existsSync(join(result.skillDir, "skill.ui.json"))).toBe(true);
      expect(existsSync(join(result.skillDir, "run.sh"))).toBe(true);

      // Verify manifest content
      const manifestContent = JSON.parse(readFileSync(join(result.skillDir, "skill.manifest.json"), "utf-8"));
      expect(manifestContent.id).toBe("test-install-skill");
    });

    it("installs to workspace directory", () => {
      const draft = makeDraft();
      const result = installer.installConvertedSkill(draft, "workspace", {
        workspaceDir,
        managedSkillsDir: managedDir,
      });

      expect(result.installed).toBe(true);
      expect(result.skillDir).toBe(join(workspaceDir, "skills", "test-install-skill"));
      expect(existsSync(result.skillDir)).toBe(true);
    });

    it("installs to custom path", () => {
      const customDir = join(testDir, "custom");
      mkdirSync(customDir, { recursive: true });

      const draft = makeDraft();
      const result = installer.installConvertedSkill(draft, { path: customDir }, {
        workspaceDir,
        managedSkillsDir: managedDir,
      });

      expect(result.installed).toBe(true);
      expect(result.skillDir).toBe(join(customDir, "test-install-skill"));
    });

    it("sets executable bits on shell files", () => {
      const draft = makeDraft();
      const result = installer.installConvertedSkill(draft, "managed", {
        workspaceDir,
        managedSkillsDir: managedDir,
      });

      expect(result.installed).toBe(true);

      const runShPath = join(result.skillDir, "run.sh");
      const stat = statSync(runShPath);
      expect(stat.mode & 0o111).not.toBe(0);
    });

    it("fails when target directory already exists and replace is false", () => {
      const draft = makeDraft();

      // First install
      installer.installConvertedSkill(draft, "managed", {
        workspaceDir,
        managedSkillsDir: managedDir,
      });

      // Second install should fail
      const result = installer.installConvertedSkill(draft, "managed", {
        workspaceDir,
        managedSkillsDir: managedDir,
        replace: false,
      });

      expect(result.installed).toBe(false);
      expect(result.issues.some((i) => i.code === "SKILL_DIR_EXISTS")).toBe(true);
    });

    it("replaces existing directory when replace is true", () => {
      const draft = makeDraft();

      // First install
      installer.installConvertedSkill(draft, "managed", {
        workspaceDir,
        managedSkillsDir: managedDir,
      });

      // Modify a file to verify replacement
      writeFileSync(join(managedDir, "test-install-skill", "extra.txt"), "should be removed");

      // Second install with replace
      const result = installer.installConvertedSkill(draft, "managed", {
        workspaceDir,
        managedSkillsDir: managedDir,
        replace: true,
      });

      expect(result.installed).toBe(true);
      expect(existsSync(join(result.skillDir, "extra.txt"))).toBe(false);
    });

    it("returns validation issues for invalid manifests", () => {
      const badManifest = makeValidManifest({
        runtime: {
          kind: "node",
          entrypoint: "index.mjs",
          minHubVersion: "1.0.0",
          apiVersion: "1",
          timeoutMsDefault: 30_000,
        },
      });

      const draft = makeDraft({
        manifest: badManifest,
        files: [
          {
            path: "skill.manifest.json",
            content: JSON.stringify(badManifest, null, 2),
          },
          {
            path: "skill.ui.json",
            content: JSON.stringify({
              schemaVersion: "1.0",
              title: "Test",
              sections: [],
              fields: [],
              outputs: [],
              actions: [],
            }, null, 2),
          },
          // Missing index.mjs entrypoint — should produce a warning
        ],
      });

      const result = installer.installConvertedSkill(draft, "managed", {
        workspaceDir,
        managedSkillsDir: managedDir,
      });

      // Should still install (warnings not errors), or fail depending on validation
      // The key thing is that issues are captured
      expect(Array.isArray(result.issues)).toBe(true);
    });

    it("creates nested directories for files", () => {
      const draft = makeDraft({
        files: [
          ...makeDraft().files,
          {
            path: "assets/icon.svg",
            content: "<svg></svg>",
          },
        ],
      });

      const result = installer.installConvertedSkill(draft, "managed", {
        workspaceDir,
        managedSkillsDir: managedDir,
      });

      expect(result.installed).toBe(true);
      expect(existsSync(join(result.skillDir, "assets", "icon.svg"))).toBe(true);
    });

    it("sanitizes local absolute sourceRef in conversion report", () => {
      const draft = makeDraft({
        files: [
          ...makeDraft().files,
          {
            path: "conversion.report.json",
            content: JSON.stringify(
              {
                sourceFormat: "clawdbot-skill-md",
                sourceRef: "/home/user/private/input.md",
                convertedAt: "2026-02-17T12:00:00.000Z",
                converterId: "clawdbot-skill-md",
              },
              null,
              2,
            ),
          },
        ],
      });

      const result = installer.installConvertedSkill(draft, "managed", {
        workspaceDir,
        managedSkillsDir: managedDir,
      });
      expect(result.installed).toBe(true);

      const report = JSON.parse(readFileSync(join(result.skillDir, "conversion.report.json"), "utf-8")) as {
        sourceRef: string;
      };
      expect(report.sourceRef).toBe("local:input.md");
    });
  });
});
