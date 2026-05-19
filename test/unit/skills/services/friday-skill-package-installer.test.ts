import { describe, it, expect } from "vitest";
import { createFridaySkillPackageInstaller } from "../../../../src/skills/services/friday-skill-package-installer.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createFridaySkillPackageArchiver } from "../../../../src/skills/converter/services/friday-skill-package-archive.js";
import type { FridaySkillPackageArchiver } from "../../../../src/skills/converter/services/friday-skill-package-archive.js";

describe("createFridaySkillPackageInstaller", () => {
  function makeInstaller() {
    const dir = mkdtempSync(join(tmpdir(), "friday-pkg-test-"));
    return createFridaySkillPackageInstaller({ managedSkillsDir: dir });
  }

  it("rejects version with scoped package format", () => {
    const installer = makeInstaller();
    expect(() =>
      installer.stage("my-skill", "@scope/name", Buffer.from("test")),
    ).toThrow("Invalid version");
  });

  it("allows a normal version string", () => {
    const installer = makeInstaller();
    // Should not throw
    const dir = installer.stage("my-skill", "1.0.0", Buffer.from("test"));
    expect(dir).toBeTruthy();
  });

  it("allows a prerelease version string", () => {
    const installer = makeInstaller();
    const dir = installer.stage("my-skill", "1.0.0-beta.1", Buffer.from("test"));
    expect(dir).toBeTruthy();
  });

  it("allows scoped skillId", () => {
    const installer = makeInstaller();
    const dir = installer.stage("@scope/my-skill", "1.0.0", Buffer.from("test"));
    expect(dir).toBeTruthy();
  });

  it("rejects skill IDs that would alias to another install directory", () => {
    const installer = makeInstaller();
    expect(() =>
      installer.stage("my+skill", "1.0.0", Buffer.from("test")),
    ).toThrow("Invalid skillId");
    expect(() =>
      installer.stage("my--skill", "1.0.0", Buffer.from("test")),
    ).toThrow("Invalid skillId");
  });

  it("normalizes validated IDs before deriving package paths", () => {
    const installer = makeInstaller();
    const dir = installer.stage("My-Skill", "1.0.0", Buffer.from("test"));
    expect(dir).toContain(join(".staging", "my-skill", "1.0.0"));
  });

  it("activates by unpacking the archived skill contents into the final directory", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "friday-pkg-activate-"));
    const skillDir = join(baseDir, "source-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "skill.manifest.json"), JSON.stringify({
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
    writeFileSync(join(skillDir, "index.js"), "export default {};\n");

    const archivePath = join(baseDir, "source-skill.friday.tgz");
    createFridaySkillPackageArchiver().packSkill(skillDir, archivePath);

    const installer = createFridaySkillPackageInstaller({ managedSkillsDir: baseDir });
    installer.stage("source-skill", "1.0.0", Buffer.from(readFileSync(archivePath)));
    const finalDir = installer.activate("source-skill", "1.0.0");

    expect(existsSync(join(finalDir, "skill.manifest.json"))).toBe(true);
    expect(existsSync(join(finalDir, "index.js"))).toBe(true);
    expect(existsSync(join(finalDir, "package.tgz"))).toBe(true);
  });

  it("preserves the current installation when unpacking a replacement package fails", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "friday-pkg-preserve-"));
    const skillDir = join(baseDir, "source-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "skill.manifest.json"), JSON.stringify({
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
    writeFileSync(join(skillDir, "index.js"), "export default { version: 'old' };\n");

    const archivePath = join(baseDir, "source-skill.friday.tgz");
    createFridaySkillPackageArchiver().packSkill(skillDir, archivePath);

    const installer = createFridaySkillPackageInstaller({ managedSkillsDir: baseDir });
    installer.stage("source-skill", "1.0.0", Buffer.from(readFileSync(archivePath)));
    const finalDir = installer.activate("source-skill", "1.0.0");

    const failingArchiver: FridaySkillPackageArchiver = {
      packSkill: () => {
        throw new Error("not used");
      },
      unpackSkill: () => {
        throw new Error("simulated unpack failure");
      },
    };

    const reinstall = createFridaySkillPackageInstaller({
      managedSkillsDir: baseDir,
      archiver: failingArchiver,
    });
    reinstall.stage("source-skill", "1.0.0", Buffer.from("broken-package"));

    expect(() => reinstall.activate("source-skill", "1.0.0")).toThrow("simulated unpack failure");
    expect(readFileSync(join(finalDir, "index.js"), "utf-8")).toContain("version: 'old'");
    expect(existsSync(join(baseDir, ".staging", "source-skill", "1.0.0", "package.tgz"))).toBe(true);
  });
});
