import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFridayOpenClawPhaseController,
  type FridayMainlineHealthVerdict,
  type FridayPhaseAutomationPlatform,
  type FridayPhaseCommand,
  type FridayPhaseCommandResult,
  type FridayRepoInspection,
} from "../../../../src/automation/openclaw-adoption/index.js";

interface FakePlatformOptions {
  repo?: Partial<FridayRepoInspection>;
  hasChanges?: boolean;
}

const tempDirs: string[] = [];

function createTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-openclaw-phase-test-"));
  tempDirs.push(dir);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], {
    cwd: dir,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Friday Test",
      GIT_AUTHOR_EMAIL: "friday@example.com",
      GIT_COMMITTER_NAME: "Friday Test",
      GIT_COMMITTER_EMAIL: "friday@example.com",
    },
  });
  return dir;
}

function writeManifest(repoDir: string): string {
  const manifestPath = path.join(repoDir, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: "1.0",
    programId: "openclaw-adoption",
    title: "Test Program",
    repo: {
      mainBranch: "main",
      branchPrefix: "codex/openclaw-adoption-phase",
      mergeStrategy: "squash",
      requiredChecks: ["quality-gate"],
      failurePolicy: "limited-self-heal-then-pause",
      maxAutoRepairAttempts: 2,
    },
    guardrails: ["keep canonical routes intact"],
    phases: [
      {
        id: "phase0",
        number: 0,
        slug: "automation-bootstrap",
        title: "Automation Bootstrap",
        summary: "Build the controller.",
        dependsOn: [],
        allowedPaths: ["src/automation/openclaw-adoption"],
        successCriteria: ["controller exists"],
        implementation: { mode: "manual" },
        gates: {
          fastLocal: [{ label: "fast", command: "echo", args: ["fast"] }],
          prePr: [{ label: "pre", command: "echo", args: ["pre"] }],
          postMerge: [{ label: "post", command: "echo", args: ["post"] }],
        },
      },
      {
        id: "phase1",
        number: 1,
        slug: "skills-foundation",
        title: "Skills Foundation",
        summary: "Strengthen skills.",
        dependsOn: ["phase0"],
        allowedPaths: ["src/skills"],
        successCriteria: ["skills lifecycle closes"],
        implementation: { mode: "manual" },
        gates: {
          fastLocal: [],
          prePr: [],
          postMerge: [],
        },
      },
    ],
  }, null, 2)}\n`, "utf-8");
  return manifestPath;
}

function passedCommandResult(step: FridayPhaseCommand): FridayPhaseCommandResult {
  return {
    label: step.label,
    command: [step.command, ...step.args].join(" "),
    status: "passed",
    exitCode: 0,
    stdout: "",
    stderr: "",
    startedAt: "2026-03-24T00:00:00.000Z",
    finishedAt: "2026-03-24T00:00:01.000Z",
    optional: Boolean(step.optional),
  };
}

function createFakePlatform(options: FakePlatformOptions = {}): FridayPhaseAutomationPlatform {
  return {
    inspectRepo(repoRoot, mainBranch) {
      return {
        repoRoot,
        currentBranch: "codex/openclaw-adoption-phase-0-automation-bootstrap",
        localMainHead: `${mainBranch}-local-head`,
        remoteMainHead: `${mainBranch}-remote-head`,
        workingTreeClean: !options.hasChanges,
        gitAvailable: true,
        ghAvailable: true,
        ghAuthenticated: true,
        ...(options.repo ?? {}),
      };
    },
    syncMain() {},
    checkoutPhaseBranch() {},
    hasChanges() {
      return Boolean(options.hasChanges);
    },
    runCommand(step) {
      return passedCommandResult(step);
    },
    commitAll() {
      return "phase0-test-commit-sha";
    },
    pushBranch() {},
    createOrReusePullRequest() {
      return { number: 42, url: "https://example.com/pr/42", state: "OPEN", merged: false };
    },
    waitForPullRequestChecks() {
      return [{ name: "quality-gate", status: "passed", url: "https://example.com/checks/quality-gate" }];
    },
    mergePullRequest() {},
    waitForPullRequestMerge() {
      return { number: 42, url: "https://example.com/pr/42", state: "MERGED", merged: true };
    },
    waitForMainChecks(): FridayMainlineHealthVerdict {
      return {
        ok: true,
        branch: "main",
        headSha: "feedbeef1234",
        workflowRunId: 77,
        workflowUrl: "https://example.com/runs/77",
        workflowConclusion: "success",
        requiredChecks: [{ name: "quality-gate", status: "passed", url: "https://example.com/checks/quality-gate" }],
        issues: [],
      };
    },
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("createFridayOpenClawPhaseController", () => {
  it("reports a healthy doctor state when git and gh are ready", () => {
    const repoDir = createTempGitRepo();
    const manifestPath = writeManifest(repoDir);
    const controller = createFridayOpenClawPhaseController({
      cwd: repoDir,
      manifestPath,
      platform: createFakePlatform(),
      nowIso: () => "2026-03-24T00:00:00.000Z",
      runIdFactory: () => "run-1",
    });

    const report = controller.doctor();
    expect(report.ok).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.manifestPath).toBe(manifestPath);
  });

  it("starts the next phase and records implementing state", () => {
    const repoDir = createTempGitRepo();
    const manifestPath = writeManifest(repoDir);
    const controller = createFridayOpenClawPhaseController({
      cwd: repoDir,
      manifestPath,
      platform: createFakePlatform(),
      nowIso: () => "2026-03-24T00:00:00.000Z",
      runIdFactory: () => "run-1",
    });

    const result = controller.startNextPhase();
    expect(result.ok).toBe(true);
    expect(result.phaseId).toBe("phase0");
    expect(result.branchName).toBe("codex/openclaw-adoption-phase-0-automation-bootstrap");

    const state = controller.loadState();
    expect(state.phases.phase0?.status).toBe("implementing");
  });

  it("promotes a phase in dry-run mode through the local gates", () => {
    const repoDir = createTempGitRepo();
    const manifestPath = writeManifest(repoDir);
    const controller = createFridayOpenClawPhaseController({
      cwd: repoDir,
      manifestPath,
      platform: createFakePlatform(),
      nowIso: () => "2026-03-24T00:00:00.000Z",
      runIdFactory: () => "run-2",
    });

    const result = controller.promotePhase({ phaseId: "phase0", dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("ready_for_pr");
    expect(result.run.gates.map((gate) => gate.gateId)).toEqual(["fast_local", "pre_pr"]);

    const evidencePath = path.join(repoDir, ".friday", "automation", "openclaw-adoption", "evidence", "phase0", "latest.json");
    expect(fs.existsSync(evidencePath)).toBe(true);
  });

  it("promotes a phase end-to-end and unlocks the next phase", () => {
    const repoDir = createTempGitRepo();
    const manifestPath = writeManifest(repoDir);
    const controller = createFridayOpenClawPhaseController({
      cwd: repoDir,
      manifestPath,
      platform: createFakePlatform({ hasChanges: true }),
      nowIso: () => "2026-03-24T00:00:00.000Z",
      runIdFactory: () => "run-3",
    });

    const result = controller.promotePhase({ phaseId: "phase0", prepareNext: true });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("done");
    expect(result.run.prNumber).toBe(42);
    expect(result.run.mainline?.ok).toBe(true);

    const state = controller.loadState();
    expect(state.phases.phase0?.status).toBe("done");
    expect(state.phases.phase1?.status).toBe("implementing");
  });
});
