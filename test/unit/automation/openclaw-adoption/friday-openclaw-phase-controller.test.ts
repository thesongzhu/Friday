import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFridayOpenClawPhaseController,
  type FridayMergedPullRequestRecord,
  type FridayMainlineHealthVerdict,
  type FridayPhaseAutomationPlatform,
  type FridayPhaseCommand,
  type FridayPhaseCommandResult,
  type FridayPullRequestDetail,
  type FridayRepoInspection,
} from "../../../../src/automation/openclaw-adoption/index.js";

interface FakePlatformOptions {
  repo?: Partial<FridayRepoInspection>;
  hasChanges?: boolean;
  changedPaths?: string[];
  dirtyWorkingTree?: boolean;
  prChecksQueue?: Array<Array<{ name: string; status: "passed" | "failed" | "pending" | "missing"; url?: string }>>;
  mainlineQueue?: FridayMainlineHealthVerdict[];
  mergeShouldFail?: boolean;
  mergedPullRequests?: FridayMergedPullRequestRecord[];
  pullRequestDetails?: Record<number, FridayPullRequestDetail>;
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

function writeManifest(repoDir: string, phaseCount = 2): string {
  const phases = [
    {
      id: "phase0",
      number: 0,
      slug: "automation-bootstrap",
      title: "Automation Bootstrap",
      summary: "Build the controller.",
      dependsOn: [],
      allowedPaths: ["src/automation/openclaw-adoption"],
      taskpackPath: "docs/ops/openclaw-adoption/taskpacks/phase-0.json",
      successCriteria: ["controller exists"],
      implementation: {
        mode: "hybrid",
        repairPolicy: {
          enabled: true,
          maxAttempts: 2,
          failureCodes: ["implementation_failed", "architecture_blocked", "branch_gate_failed", "required_checks_missing", "required_checks_failed", "merge_failed", "mainline_red", "closure_failed"],
        },
      },
      promotion: {
        requiredChecks: ["quality-gate"],
        mergeStrategy: "squash",
        mainlineHealthPolicy: "required-checks-green",
        stabilizeSuffix: "stabilize",
      },
      closure: {
        requiredEvidence: ["phase-0/run.json", "phase-0/evidence/latest.json"],
      },
      gates: {
        fastLocal: [{ label: "fast", command: "echo", args: ["fast"] }],
        prePr: [{ label: "pre", command: "echo", args: ["pre"] }],
        postMerge: [{ label: "post", command: "echo", args: ["post"] }],
        finalClosure: [{ label: "close", command: "echo", args: ["close"] }],
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
      taskpackPath: "docs/ops/openclaw-adoption/taskpacks/phase-1.json",
      successCriteria: ["skills lifecycle closes"],
      implementation: {
        mode: "hybrid",
      },
      promotion: {
        requiredChecks: ["quality-gate"],
        mergeStrategy: "squash",
        mainlineHealthPolicy: "required-checks-green",
        stabilizeSuffix: "stabilize",
      },
      closure: {
        requiredEvidence: ["phase-1/run.json"],
      },
      gates: {
        fastLocal: [],
        prePr: [],
        postMerge: [],
      },
    },
  ].slice(0, phaseCount);

  const taskpackRoot = path.join(repoDir, "docs", "ops", "openclaw-adoption", "taskpacks");
  fs.mkdirSync(taskpackRoot, { recursive: true });
  fs.writeFileSync(path.join(taskpackRoot, "phase-0.json"), `${JSON.stringify({
    schemaVersion: "1.0",
    phaseId: "phase0",
    title: "Automation Bootstrap",
    executionMode: "automated",
    goal: "Bootstrap controller taskpacks.",
    allowedPaths: ["src/automation/openclaw-adoption"],
    implementationWorkers: [
      {
        id: "phase0-worker",
        title: "Phase 0 worker",
        runner: "command",
        mode: "implementation",
        steps: [{ label: "worker", command: "echo", args: ["worker"] }],
      },
    ],
    repairWorker: {
      id: "phase0-repair",
      title: "Phase 0 repair",
      runner: "command",
      mode: "repair",
      steps: [{ label: "repair", command: "echo", args: ["repair"] }],
    },
    successCriteria: ["controller exists"],
    gates: {
      fastLocal: [{ label: "fast", command: "echo", args: ["fast"] }],
      prePr: [{ label: "pre", command: "echo", args: ["pre"] }],
      postMerge: [{ label: "post", command: "echo", args: ["post"] }],
      finalClosure: [{ label: "close", command: "echo", args: ["close"] }],
    },
    closureEvidence: ["phase-0/run.json", "phase-0/evidence/latest.json", "phase-0/evidence/latest-impact.json"],
    forbiddenBoundaries: [
      {
        id: "phase0-no-api-routes",
        description: "Phase 0 cannot edit API route surfaces.",
        pathPrefixes: ["src/api/http/routes"],
        verdict: "blocked",
      },
    ],
  }, null, 2)}\n`, "utf-8");

  fs.writeFileSync(path.join(taskpackRoot, "phase-1.json"), `${JSON.stringify({
    schemaVersion: "1.0",
    phaseId: "phase1",
    title: "Skills Foundation",
    executionMode: "spec_only",
    goal: "Define skills taskpack.",
    allowedPaths: ["src/skills"],
    implementationWorkers: [
      {
        id: "phase1-worker",
        title: "Phase 1 worker",
        runner: "command",
        mode: "implementation",
        steps: [{ label: "worker", command: "echo", args: ["worker"] }],
      },
    ],
    successCriteria: ["skills lifecycle closes"],
    closureEvidence: ["phase-1/run.json"],
    forbiddenBoundaries: [
      {
        id: "phase1-no-plugin-drift",
        description: "Phase 1 cannot touch plugins.",
        pathPrefixes: ["src/plugins"],
        verdict: "blocked",
      },
    ],
  }, null, 2)}\n`, "utf-8");

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
    phases,
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

function createMainlineVerdict(ok: boolean): FridayMainlineHealthVerdict {
  return {
    ok,
    branch: "main",
    headSha: ok ? "main-head-ok-1234" : "main-head-failed-1234",
    workflowRunId: ok ? 77 : 78,
    workflowUrl: ok ? "https://example.com/runs/77" : "https://example.com/runs/78",
    workflowConclusion: ok ? "success" : "failure",
    requiredChecks: [{ name: "quality-gate", status: ok ? "passed" : "failed", url: "https://example.com/checks/quality-gate" }],
    issues: ok ? [] : ["quality-gate failed on main"],
  };
}

function createFakePlatform(options: FakePlatformOptions = {}): FridayPhaseAutomationPlatform {
  let prChecksIndex = 0;
  let mainlineIndex = 0;
  return {
    inspectRepo(repoRoot, mainBranch) {
      return {
        repoRoot,
        currentBranch: "codex/openclaw-adoption-phase-0-automation-bootstrap",
        localMainHead: `${mainBranch}-local-head`,
        remoteMainHead: `${mainBranch}-remote-head`,
        workingTreeClean: !options.dirtyWorkingTree,
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
    listChangedPaths() {
      return [...(options.changedPaths ?? [])];
    },
    runCommand(step) {
      return passedCommandResult(step);
    },
    commitAll() {
      return "phase0-test-commit-sha";
    },
    pushBranch() {},
    createOrReusePullRequest(input) {
      return { number: 42, url: `https://example.com/pr/${input.branchName}`, state: "OPEN", merged: false };
    },
    waitForPullRequestChecks() {
      const queued = options.prChecksQueue?.[prChecksIndex];
      prChecksIndex += 1;
      return queued ?? [{ name: "quality-gate", status: "passed", url: "https://example.com/checks/quality-gate" }];
    },
    mergePullRequest() {
      if (options.mergeShouldFail) {
        throw new Error("merge failed");
      }
    },
    waitForPullRequestMerge(repoRoot, branchName) {
      return { number: 42, url: `https://example.com/pr/${branchName}`, state: "MERGED", merged: true };
    },
    listMergedPullRequests() {
      return [...(options.mergedPullRequests ?? [])];
    },
    readPullRequestDetail(_repoRoot, prNumber) {
      const detail = options.pullRequestDetails?.[prNumber];
      if (!detail) {
        throw new Error(`missing PR detail for ${String(prNumber)}`);
      }
      return detail;
    },
    waitForMainChecks() {
      const verdict = options.mainlineQueue?.[mainlineIndex];
      mainlineIndex += 1;
      return verdict ?? createMainlineVerdict(true);
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
    expect(report.warnings).toContain("phase1 taskpack is spec_only and cannot auto-promote yet.");
  });

  it("promotes a phase in dry-run mode and writes phase runtime evidence", () => {
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
    expect(result.run.gates.map((gate) => gate.gateId)).toEqual(["implementation", "architecture_impact", "fast_local", "pre_pr"]);
    expect(result.run.workers.map((worker) => worker.workerId)).toEqual(["phase0-worker"]);
    expect(result.run.taskpackRevision).toBeTruthy();
    expect(result.run.architectureImpact?.verdict).toBe("no_impact");

    const runPath = path.join(repoDir, ".friday", "automation", "openclaw-adoption", "phase-0", "run.json");
    expect(fs.existsSync(runPath)).toBe(true);
    const impactPath = path.join(repoDir, ".friday", "automation", "openclaw-adoption", "phase-0", "evidence", "latest-impact.json");
    expect(fs.existsSync(impactPath)).toBe(true);
  });

  it("runs the next phase end-to-end and leaves spec-only successors planned", () => {
    const repoDir = createTempGitRepo();
    const manifestPath = writeManifest(repoDir);
    const controller = createFridayOpenClawPhaseController({
      cwd: repoDir,
      manifestPath,
      platform: createFakePlatform({ hasChanges: true }),
      nowIso: () => "2026-03-24T00:00:00.000Z",
      runIdFactory: () => "run-3",
    });

    const result = controller.runNextPhase({ prepareNext: true });
    expect("run" in result).toBe(true);
    if (!("run" in result)) {
      return;
    }
    expect(result.ok).toBe(true);
    expect(result.status).toBe("done");
    expect(result.run.prNumber).toBe(42);
    expect(result.run.mainline?.ok).toBe(true);

    const state = controller.loadState();
    expect(state.phases.phase0?.status).toBe("done");
    expect(state.phases.phase1?.status).not.toBe("implementing");
  });

  it("auto-stabilizes after a failing mainline verdict", () => {
    const repoDir = createTempGitRepo();
    const manifestPath = writeManifest(repoDir, 1);
    const controller = createFridayOpenClawPhaseController({
      cwd: repoDir,
      manifestPath,
      platform: createFakePlatform({
        hasChanges: true,
        mainlineQueue: [createMainlineVerdict(false), createMainlineVerdict(true)],
      }),
      nowIso: () => "2026-03-24T00:00:00.000Z",
      runIdFactory: (() => {
        const ids = ["run-4", "run-5"];
        return () => ids.shift() ?? "run-x";
      })(),
    });

    const result = controller.promotePhase({ phaseId: "phase0", prepareNext: false });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("done");
    expect(result.branchName).toContain("-stabilize");
    expect(result.run.stabilizeBranchName).toContain("-stabilize");

    const state = controller.loadState();
    expect(state.phases.phase0?.status).toBe("done");
    expect(state.phases.phase0?.repairAttempts).toBe(0);
  });

  it("dry-runs a committed spec-only taskpack without allowing merge promotion", () => {
    const repoDir = createTempGitRepo();
    const manifestPath = writeManifest(repoDir);
    const statePath = path.join(repoDir, ".friday", "automation", "openclaw-adoption", "program.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify({
      schemaVersion: "1.0",
      programId: "openclaw-adoption",
      phases: {
        phase0: {
          phaseId: "phase0",
          status: "done",
          branchName: "codex/openclaw-adoption-phase-0-automation-bootstrap",
          updatedAt: "2026-03-24T00:00:00.000Z",
          completedAt: "2026-03-24T00:00:00.000Z",
        },
      },
      runs: [],
      updatedAt: "2026-03-24T00:00:00.000Z",
    }, null, 2)}\n`, "utf-8");

    const controller = createFridayOpenClawPhaseController({
      cwd: repoDir,
      manifestPath,
      platform: createFakePlatform(),
      nowIso: () => "2026-03-24T00:00:00.000Z",
      runIdFactory: () => "run-5a",
    });

    const dryRun = controller.promotePhase({ phaseId: "phase1", dryRun: true, prepareNext: false });
    expect(dryRun.ok).toBe(true);
    expect(dryRun.status).toBe("ready_for_pr");
    expect(dryRun.run.taskpackPath).toContain("phase-1.json");

    const blocked = controller.promotePhase({ phaseId: "phase1", dryRun: false, prepareNext: false });
    expect(blocked.ok).toBe(false);
    expect(blocked.run.status).toBe("blocked");
    expect(blocked.run.blockers).toContain("Taskpack for phase1 is spec_only and cannot auto-promote yet.");
  });

  it("blocks when tracked changes exceed the committed taskpack boundary", () => {
    const repoDir = createTempGitRepo();
    const manifestPath = writeManifest(repoDir, 1);
    const controller = createFridayOpenClawPhaseController({
      cwd: repoDir,
      manifestPath,
      platform: createFakePlatform({
        changedPaths: ["src/api/http/routes/friday-plugin-routes.ts"],
      }),
      nowIso: () => "2026-03-24T00:00:00.000Z",
      runIdFactory: () => "run-5b",
    });

    const result = controller.promotePhase({ phaseId: "phase0", dryRun: true });
    expect(result.ok).toBe(false);
    expect(result.run.failureCode).toBe("architecture_blocked");
    expect(result.run.blockedBoundary).toBe("phase0-no-api-routes");
    expect(result.run.architectureImpact?.verdict).toBe("blocked");
  });

  it("writes a blocked closeout report when not all phases are complete", () => {
    const repoDir = createTempGitRepo();
    const manifestPath = writeManifest(repoDir);
    const controller = createFridayOpenClawPhaseController({
      cwd: repoDir,
      manifestPath,
      platform: createFakePlatform(),
      nowIso: () => "2026-03-24T00:00:00.000Z",
      runIdFactory: () => "run-6",
    });

    const result = controller.closeout();
    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.blockers).toContain("phase0 is not complete");

    const reportPath = path.join(repoDir, ".friday", "automation", "openclaw-adoption", "final-closeout", "latest.json");
    expect(fs.existsSync(reportPath)).toBe(true);
  });

  it("reconciles merged phases from pull request history during closeout", () => {
    const repoDir = createTempGitRepo();
    const manifestPath = writeManifest(repoDir);
    const controller = createFridayOpenClawPhaseController({
      cwd: repoDir,
      manifestPath,
      platform: createFakePlatform({
        mergedPullRequests: [
          {
            number: 100,
            title: "[phase0] Automation Bootstrap",
            url: "https://example.com/pr/100",
            state: "MERGED",
            merged: true,
            headRefName: "codex/openclaw-adoption-phase-0-automation-bootstrap",
            baseRefName: "main",
            mergedAt: "2026-03-24T01:00:00.000Z",
            mergeCommitSha: "phase0merge1234",
          },
          {
            number: 101,
            title: "Phase 1 shipped",
            url: "https://example.com/pr/101",
            state: "MERGED",
            merged: true,
            headRefName: "codex/openclaw-adoption-phase-1-alt-branch-name",
            baseRefName: "main",
            mergedAt: "2026-03-24T02:00:00.000Z",
            mergeCommitSha: "phase1merge1234",
          },
        ],
        pullRequestDetails: {
          100: {
            number: 100,
            title: "[phase0] Automation Bootstrap",
            url: "https://example.com/pr/100",
            state: "MERGED",
            merged: true,
            headRefName: "codex/openclaw-adoption-phase-0-automation-bootstrap",
            baseRefName: "main",
            mergedAt: "2026-03-24T01:00:00.000Z",
            mergeCommitSha: "phase0merge1234",
            changedPaths: [
              "src/automation/openclaw-adoption/friday-openclaw-phase-controller.ts",
            ],
          },
          101: {
            number: 101,
            title: "Phase 1 shipped",
            url: "https://example.com/pr/101",
            state: "MERGED",
            merged: true,
            headRefName: "codex/openclaw-adoption-phase-1-alt-branch-name",
            baseRefName: "main",
            mergedAt: "2026-03-24T02:00:00.000Z",
            mergeCommitSha: "phase1merge1234",
            changedPaths: [
              "src/skills/runtime/friday-skill-runtime.ts",
            ],
          },
        },
      }),
      nowIso: () => "2026-03-24T03:00:00.000Z",
      runIdFactory: () => "run-7",
    });

    const result = controller.closeout({ dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("done");
    expect(result.notes).toContain("Reconciled phase0 from merged PR #100.");
    expect(result.notes).toContain("Reconciled phase1 from merged PR #101.");

    const state = controller.loadState();
    expect(state.phases.phase0).toBeUndefined();
  });

  it("blocks closeout when reconciled merged PR history escapes the taskpack boundary", () => {
    const repoDir = createTempGitRepo();
    const manifestPath = writeManifest(repoDir);
    const controller = createFridayOpenClawPhaseController({
      cwd: repoDir,
      manifestPath,
      platform: createFakePlatform({
        mergedPullRequests: [
          {
            number: 100,
            title: "[phase0] Automation Bootstrap",
            url: "https://example.com/pr/100",
            state: "MERGED",
            merged: true,
            headRefName: "codex/openclaw-adoption-phase-0-automation-bootstrap",
            baseRefName: "main",
            mergedAt: "2026-03-24T01:00:00.000Z",
            mergeCommitSha: "phase0merge1234",
          },
        ],
        pullRequestDetails: {
          100: {
            number: 100,
            title: "[phase0] Automation Bootstrap",
            url: "https://example.com/pr/100",
            state: "MERGED",
            merged: true,
            headRefName: "codex/openclaw-adoption-phase-0-automation-bootstrap",
            baseRefName: "main",
            mergedAt: "2026-03-24T01:00:00.000Z",
            mergeCommitSha: "phase0merge1234",
            changedPaths: [
              "src/api/http/routes/friday-plugin-routes.ts",
            ],
          },
        },
      }),
      nowIso: () => "2026-03-24T03:00:00.000Z",
      runIdFactory: () => "run-8",
    });

    const result = controller.closeout({ dryRun: true });
    expect(result.ok).toBe(false);
    expect(result.blockers).toContain("phase0 merged PR violates the committed taskpack boundary.");
  });
});
