import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateFridaySkillPackage } from "#skills";
import type { FridayLoadedSkillPackage } from "#skills";
import { makeManifest } from "../_helpers/make-manifest.helper.js";

function makeLoadedPackage(
  skillDir: string,
  overrides: Partial<FridayLoadedSkillPackage> = {},
): FridayLoadedSkillPackage {
  return {
    skillDir,
    loadMode: "manifest-v2",
    manifest: makeManifest(),
    declaredFiles: [],
    ...overrides,
  };
}

describe("validateFridaySkillPackage", () => {
  let skillDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "friday-test-pipeline-ws-"));
    skillDir = mkdtempSync(join(workspaceDir, "skill-"));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("passes for a valid package with compatible versions", () => {
    // Create the manifest file so stage 2 passes
    writeFileSync(join(skillDir, "skill.manifest.json"), "{}");

    const loaded = makeLoadedPackage(skillDir);
    const result = validateFridaySkillPackage({
      loaded,
      workspaceDir,
      hubVersion: "1.0.0",
      supportedApiVersions: ["1"],
    });
    expect(result.ok).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("includes manifest stage validation (stage 1)", () => {
    writeFileSync(join(skillDir, "skill.manifest.json"), "{}");

    // Create a manifest with invalid schema version to trigger stage 1 error
    const manifest = { ...makeManifest(), schemaVersion: "9.0" } as unknown as ReturnType<typeof makeManifest>;
    const loaded = makeLoadedPackage(skillDir, { manifest });
    const result = validateFridaySkillPackage({
      loaded,
      workspaceDir,
      hubVersion: "1.0.0",
      supportedApiVersions: ["1"],
    });
    const manifestIssues = result.issues.filter((i) => i.stage === "manifest");
    expect(manifestIssues.length).toBeGreaterThan(0);
  });

  it("warns about missing entrypoint (stage 2)", () => {
    writeFileSync(join(skillDir, "skill.manifest.json"), "{}");

    const manifest = makeManifest({
      runtime: {
        kind: "node",
        entrypoint: "missing-file.ts",
        minHubVersion: "1.0.0",
        apiVersion: "1",
        timeoutMsDefault: 30_000,
      },
    });
    const loaded = makeLoadedPackage(skillDir, { manifest });
    const result = validateFridaySkillPackage({
      loaded,
      workspaceDir,
      hubVersion: "1.0.0",
      supportedApiVersions: ["1"],
    });
    // Missing entrypoint is a warning, not an error
    const entryIssue = result.issues.find((i) => i.code === "ENTRYPOINT_NOT_FOUND");
    expect(entryIssue).toBeDefined();
    expect(entryIssue!.severity).toBe("warning");
    expect(entryIssue!.stage).toBe("required-files");
  });

  it("does not warn about empty entrypoint for builtin skills", () => {
    writeFileSync(join(skillDir, "skill.manifest.json"), "{}");

    // Default makeManifest has builtin kind with empty entrypoint
    const loaded = makeLoadedPackage(skillDir);
    const result = validateFridaySkillPackage({
      loaded,
      workspaceDir,
      hubVersion: "1.0.0",
      supportedApiVersions: ["1"],
    });
    const entryIssue = result.issues.find((i) => i.code === "ENTRYPOINT_NOT_FOUND");
    expect(entryIssue).toBeUndefined();
  });

  it("collects engine compat errors (stage 5)", () => {
    writeFileSync(join(skillDir, "skill.manifest.json"), "{}");

    const manifest = makeManifest({
      runtime: {
        kind: "node",
        entrypoint: "",
        minHubVersion: "99.0.0",
        apiVersion: "1",
        timeoutMsDefault: 30_000,
      },
    });

    const loaded = makeLoadedPackage(skillDir, { manifest });
    const result = validateFridaySkillPackage({
      loaded,
      workspaceDir,
      hubVersion: "1.0.0",
      supportedApiVersions: ["1"],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "HUB_VERSION_TOO_LOW")).toBe(true);
  });

  it("runs stages in deterministic order: manifest → required-files → step-graph → schema-compile → engine-compat", () => {
    writeFileSync(join(skillDir, "skill.manifest.json"), "{}");

    // Create a scenario with multiple stage issues
    const manifest = makeManifest({
      runtime: {
        kind: "node",
        entrypoint: "missing.ts",
        minHubVersion: "99.0.0",
        apiVersion: "1",
        timeoutMsDefault: 30_000,
      },
      flow: {
        startStep: "nonexistent",
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

    const loaded = makeLoadedPackage(skillDir, { manifest });
    const result = validateFridaySkillPackage({
      loaded,
      workspaceDir,
      hubVersion: "1.0.0",
      supportedApiVersions: ["1"],
    });

    // Verify stages appear in expected order
    const stages = result.issues.map((i) => i.stage);
    const stageOrder = ["manifest", "required-files", "step-graph", "schema-compile", "engine-compat"];
    const filtered = stages.filter((s) => stageOrder.includes(s));

    for (let i = 1; i < filtered.length; i++) {
      const prevIdx = stageOrder.indexOf(filtered[i - 1]!);
      const currIdx = stageOrder.indexOf(filtered[i]!);
      expect(currIdx).toBeGreaterThanOrEqual(prevIdx);
    }
  });

  it("returns compiledSchemas even when empty", () => {
    writeFileSync(join(skillDir, "skill.manifest.json"), "{}");
    const loaded = makeLoadedPackage(skillDir);
    const result = validateFridaySkillPackage({
      loaded,
      workspaceDir,
      hubVersion: "1.0.0",
      supportedApiVersions: ["1"],
    });
    expect(result.compiledSchemas).toBeDefined();
  });
});
