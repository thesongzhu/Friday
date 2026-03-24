import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFridaySkillPackageArchiver } from "../../../../src/skills/converter/services/friday-skill-package-archive.js";

const renameControl = vi.hoisted(() => ({
  failOnFinalMove: false,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    renameSync: vi.fn((from: string, to: string) => {
      const normalizedFrom = from.replace(/\\/g, "/");
      const normalizedTo = to.replace(/\\/g, "/");
      if (
        renameControl.failOnFinalMove
        && normalizedFrom.includes("/.activating/")
        && !normalizedTo.includes("/.backup/")
      ) {
        throw new Error("simulated final move failure");
      }
      return actual.renameSync(from, to);
    }),
  };
});

let createFridaySkillPackageInstaller: typeof import("../../../../src/skills/services/friday-skill-package-installer.js").createFridaySkillPackageInstaller;

describe("createFridaySkillPackageInstaller rollback behavior", () => {
  let baseDir: string;

  beforeAll(async () => {
    ({ createFridaySkillPackageInstaller } = await import("../../../../src/skills/services/friday-skill-package-installer.js"));
  });

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "friday-pkg-rollback-"));
    renameControl.failOnFinalMove = false;
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("restores the previous installation if the final move fails after backup creation", () => {
    const archiver = createFridaySkillPackageArchiver();
    const initialSkillDir = join(baseDir, "source-skill-old");
    mkdirSync(initialSkillDir, { recursive: true });
    writeFileSync(join(initialSkillDir, "skill.manifest.json"), JSON.stringify({
      schemaVersion: "2.0",
      id: "source-skill",
      name: "Source Skill",
      description: "test",
      version: "1.0.0",
      kind: "conversation",
      category: "utility",
      author: { name: "Test" },
      tags: [],
      runtime: { kind: "node", entrypoint: "index.js", minHubVersion: "0.1.0", apiVersion: "1", timeoutMsDefault: 30000 },
      triggers: { intents: ["test"], phrases: ["test"], channels: [] },
      invocation: { userInvocable: true, modelInvocable: false, priority: 50, modes: ["intent"] },
      requirements: { bins: [], env: [], config: [], os: ["darwin"] },
      inputs: [],
      outputs: [],
      permissions: { grants: [], promptOn: [] },
      executionTargets: { allowedSatelliteTypes: ["desktop"], requiredCapabilities: [] },
    }));
    writeFileSync(join(initialSkillDir, "index.js"), "export default { version: 'old' };\n");

    const nextSkillDir = join(baseDir, "source-skill-new");
    mkdirSync(nextSkillDir, { recursive: true });
    writeFileSync(join(nextSkillDir, "skill.manifest.json"), JSON.stringify({
      schemaVersion: "2.0",
      id: "source-skill",
      name: "Source Skill",
      description: "test",
      version: "1.0.0",
      kind: "conversation",
      category: "utility",
      author: { name: "Test" },
      tags: [],
      runtime: { kind: "node", entrypoint: "index.js", minHubVersion: "0.1.0", apiVersion: "1", timeoutMsDefault: 30000 },
      triggers: { intents: ["test"], phrases: ["test"], channels: [] },
      invocation: { userInvocable: true, modelInvocable: false, priority: 50, modes: ["intent"] },
      requirements: { bins: [], env: [], config: [], os: ["darwin"] },
      inputs: [],
      outputs: [],
      permissions: { grants: [], promptOn: [] },
      executionTargets: { allowedSatelliteTypes: ["desktop"], requiredCapabilities: [] },
    }));
    writeFileSync(join(nextSkillDir, "index.js"), "export default { version: 'new' };\n");

    const initialArchive = join(baseDir, "source-skill-old.friday.tgz");
    const nextArchive = join(baseDir, "source-skill-new.friday.tgz");
    archiver.packSkill(initialSkillDir, initialArchive);
    archiver.packSkill(nextSkillDir, nextArchive);

    const installer = createFridaySkillPackageInstaller({ managedSkillsDir: baseDir });
    installer.stage("source-skill", "1.0.0", Buffer.from(readFileSync(initialArchive)));
    const finalDir = installer.activate("source-skill", "1.0.0");

    installer.stage("source-skill", "1.0.0", Buffer.from(readFileSync(nextArchive)));
    renameControl.failOnFinalMove = true;

    expect(() => installer.activate("source-skill", "1.0.0")).toThrow("simulated final move failure");
    expect(readFileSync(join(finalDir, "index.js"), "utf-8")).toContain("version: 'old'");
    expect(existsSync(join(baseDir, ".staging", "source-skill", "1.0.0", "package.tgz"))).toBe(true);

    const activatingRoot = join(baseDir, ".activating", "source-skill");
    const backupRoot = join(baseDir, ".backup", "source-skill");
    expect(existsSync(activatingRoot) ? readdirSync(activatingRoot) : []).toHaveLength(0);
    expect(existsSync(backupRoot) ? readdirSync(backupRoot) : []).toHaveLength(0);
  });
});
