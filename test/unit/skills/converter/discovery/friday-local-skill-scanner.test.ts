import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { scanLocalSkills } from "../../../../../src/skills/converter/discovery/friday-local-skill-scanner.js";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "friday-local-skill-scanner-"));
  tempRoots.push(root);
  return root;
}

function writeFixture(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

function writeFridayRoot(root: string): void {
  writeFixture(join(root, "package.json"), JSON.stringify({ name: "@thesongzhu/friday" }, null, 2));
  writeFixture(join(root, "scripts", "ops", "friday-first-run.sh"), "#!/usr/bin/env bash\n");
  writeFixture(join(root, "src", "hub", "friday-hub-bootstrap.ts"), "export {};\n");
  writeFixture(join(root, "ui", "src", "routes", "setup-page.tsx"), "export function SetupPage() { return null; }\n");
}

function writeSkill(root: string, name: string, description = "Local test skill"): string {
  const skillPath = join(root, "skills", name, "SKILL.md");
  writeFixture(skillPath, `---\ndescription: ${description}\n---\n# ${name}\n`);
  return skillPath;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("scanLocalSkills", () => {
  it("does not import Friday's bundled runtime skills from the current working directory", () => {
    const root = makeTempRoot();
    const home = join(root, "home");
    const fridayRoot = join(home, "Friday");

    writeFridayRoot(fridayRoot);
    const bundledSkill = writeSkill(fridayRoot, "autofix-readiness-review", "Bundled Friday skill");

    const result = scanLocalSkills({
      homeDir: home,
      cwd: fridayRoot,
      projectDirs: [],
    });

    expect(result.items.map((item) => item.sourcePath)).not.toContain(bundledSkill);
    expect(result.items).toHaveLength(0);
    expect(result.directoriesScanned).not.toContain(join(fridayRoot, "skills"));
  });

  it("skips Friday clones inside project search roots while keeping external project skills", () => {
    const root = makeTempRoot();
    const home = join(root, "home");
    const projectsDir = join(home, "Projects");
    const fridayClone = join(projectsDir, "Friday");
    const externalProject = join(projectsDir, "customer-tooling");

    writeFridayRoot(fridayClone);
    const fridaySkill = writeSkill(fridayClone, "bundled-friday-skill", "Should not appear");
    const externalSkill = writeSkill(externalProject, "customer-review", "Should appear");

    const result = scanLocalSkills({
      homeDir: home,
      cwd: join(home, "Downloads", "Friday"),
      projectDirs: [projectsDir],
    });

    expect(result.items.map((item) => item.sourcePath)).not.toContain(fridaySkill);
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourcePath: externalSkill,
          sourceTool: "local-project",
          converterHint: "clawdbot-skill-md",
        }),
      ]),
    );
  });

  it("labels OpenClaw only for positively identified OpenClaw projects and scans user Codex skills", () => {
    const root = makeTempRoot();
    const home = join(root, "home");
    const projectsDir = join(home, "Projects");
    const genericProject = join(projectsDir, "plain-skills-repo");
    const openClawProject = join(projectsDir, "openclaw-helpers");

    const genericSkill = writeSkill(genericProject, "plain-skill", "Generic local project skill");
    const openClawSkill = writeSkill(openClawProject, "claw-skill", "OpenClaw project skill");
    const codexUserSkill = join(home, ".codex", "skills", "user-review", "SKILL.md");
    const codexSystemSkill = join(home, ".codex", "skills", ".system", "hidden-system-skill", "SKILL.md");
    writeFixture(codexUserSkill, "# User Review\n");
    writeFixture(codexSystemSkill, "# Hidden System Skill\n");

    const result = scanLocalSkills({
      homeDir: home,
      cwd: join(home, "workspace"),
      projectDirs: [projectsDir],
    });

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourcePath: genericSkill, sourceTool: "local-project" }),
        expect.objectContaining({ sourcePath: openClawSkill, sourceTool: "openclaw" }),
        expect.objectContaining({ sourcePath: codexUserSkill, sourceTool: "codex" }),
      ]),
    );
    expect(result.items.map((item) => item.sourcePath)).not.toContain(codexSystemSkill);
  });
});
