import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { FridayDomainError } from "#errors";
import {
  loadFridayOpenClawPhaseManifest,
} from "./friday-openclaw-phase-manifest.js";
import type {
  FridayMainlineHealthVerdict,
  FridayMergeStrategy,
  FridayOpenClawPhaseControllerPaths,
  FridayPhaseAutomationPlatform,
  FridayPhaseControllerState,
  FridayPhaseDefinition,
  FridayPhaseDoctorReport,
  FridayPhaseManifest,
  FridayPhasePromotionResult,
  FridayPhaseRunRecord,
  FridayPhaseStartResult,
  FridayPhaseSummaryState,
  FridayPromotionGateResult,
  FridayPullRequestRecord,
  FridayRepoInspection,
} from "./friday-openclaw-phase.types.js";

export interface CreateFridayOpenClawPhaseControllerOptions {
  cwd?: string;
  manifestPath?: string;
  nowIso?: () => string;
  runIdFactory?: () => string;
  platform?: FridayPhaseAutomationPlatform;
}

export interface FridayOpenClawPhaseController {
  getPaths(): FridayOpenClawPhaseControllerPaths;
  loadManifest(): FridayPhaseManifest;
  loadState(): FridayPhaseControllerState;
  doctor(): FridayPhaseDoctorReport;
  listPhaseStates(): FridayPhaseSummaryState[];
  startNextPhase(input?: { dryRun?: boolean }): FridayPhaseStartResult;
  promotePhase(input: { phaseId: string; dryRun?: boolean; prepareNext?: boolean }): FridayPhasePromotionResult;
  runNextPhase(input?: { dryRun?: boolean; prepareNext?: boolean }): FridayPhaseStartResult | FridayPhasePromotionResult;
}

function defaultNowIso(): string {
  return new Date().toISOString();
}

function resolveRepoRoot(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    throw new FridayDomainError(
      "OPENCLAW_ADOPTION_REPO_NOT_FOUND",
      `Could not resolve git repository root from ${cwd}: ${error instanceof Error ? error.message : String(error)}`,
      { httpStatus: 500 },
    );
  }
}

function resolvePaths(options: CreateFridayOpenClawPhaseControllerOptions): FridayOpenClawPhaseControllerPaths {
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = resolveRepoRoot(cwd);
  const manifestPath = options.manifestPath
    ? (options.manifestPath.startsWith("/") ? options.manifestPath : join(repoRoot, options.manifestPath))
    : join(repoRoot, "docs", "ops", "openclaw-adoption-phase-manifest.json");
  const runtimeRoot = join(repoRoot, ".friday", "automation", "openclaw-adoption");
  return {
    repoRoot,
    manifestPath,
    runtimeRoot,
    statePath: join(runtimeRoot, "state.json"),
    evidenceRoot: join(runtimeRoot, "evidence"),
  };
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
}

function createEmptyState(nowIso: string): FridayPhaseControllerState {
  return {
    schemaVersion: "1.0",
    programId: "openclaw-adoption",
    phases: {},
    runs: [],
    updatedAt: nowIso,
  };
}

function loadStateFromDisk(paths: FridayOpenClawPhaseControllerPaths, nowIso: string): FridayPhaseControllerState {
  if (!existsSync(paths.statePath)) {
    return createEmptyState(nowIso);
  }

  try {
    const parsed = JSON.parse(readFileSync(paths.statePath, "utf-8")) as FridayPhaseControllerState;
    if (parsed.schemaVersion !== "1.0" || parsed.programId !== "openclaw-adoption") {
      return createEmptyState(nowIso);
    }
    return parsed;
  } catch {
    return createEmptyState(nowIso);
  }
}

function saveStateToDisk(paths: FridayOpenClawPhaseControllerPaths, state: FridayPhaseControllerState): void {
  ensureDirectory(paths.runtimeRoot);
  writeFileSync(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function renderGateMarkdown(gate: FridayPromotionGateResult): string[] {
  const lines = [
    `## ${gate.gateId}`,
    "",
    `- Status: ${gate.status}`,
  ];
  if (gate.results.length === 0) {
    lines.push("- Commands: none");
    lines.push("");
    return lines;
  }

  lines.push("- Commands:");
  for (const result of gate.results) {
    lines.push(`  - ${result.label}: ${result.status} (\`${result.command}\`)`);
  }
  lines.push("");
  return lines;
}

function writeRunEvidence(
  paths: FridayOpenClawPhaseControllerPaths,
  phase: FridayPhaseDefinition,
  run: FridayPhaseRunRecord,
): void {
  const phaseEvidenceDir = join(paths.evidenceRoot, phase.id);
  ensureDirectory(phaseEvidenceDir);
  const jsonPath = join(phaseEvidenceDir, `${run.runId}.json`);
  const markdownPath = join(phaseEvidenceDir, `${run.runId}.md`);
  const latestJsonPath = join(phaseEvidenceDir, "latest.json");
  const latestMarkdownPath = join(phaseEvidenceDir, "latest.md");

  const markdown = [
    `# ${phase.title}`,
    "",
    `- Phase: ${phase.id}`,
    `- Status: ${run.status}`,
    `- Branch: ${run.branchName}`,
    `- Dry Run: ${run.dryRun ? "yes" : "no"}`,
    `- Started At: ${run.startedAt}`,
    `- Updated At: ${run.updatedAt}`,
    ...(run.commitSha ? [`- Commit SHA: ${run.commitSha}`] : []),
    ...(run.prUrl ? [`- PR: ${run.prUrl}`] : []),
    ...(run.mergedSha ? [`- Merged SHA: ${run.mergedSha}`] : []),
    "",
    "## Blockers",
    "",
    ...(run.blockers.length > 0 ? run.blockers.map((blocker) => `- ${blocker}`) : ["- None"]),
    "",
    "## Notes",
    "",
    ...(run.notes.length > 0 ? run.notes.map((note) => `- ${note}`) : ["- None"]),
    "",
    ...run.gates.flatMap((gate) => renderGateMarkdown(gate)),
  ];

  if (run.mainline) {
    markdown.push("## Mainline Health");
    markdown.push("");
    markdown.push(`- Status: ${run.mainline.ok ? "passed" : "failed"}`);
    if (run.mainline.headSha) {
      markdown.push(`- Head SHA: ${run.mainline.headSha}`);
    }
    if (run.mainline.workflowUrl) {
      markdown.push(`- Workflow: ${run.mainline.workflowUrl}`);
    }
    for (const check of run.mainline.requiredChecks) {
      markdown.push(`- Check ${check.name}: ${check.status}`);
    }
    if (run.mainline.issues.length > 0) {
      markdown.push("- Issues:");
      for (const issue of run.mainline.issues) {
        markdown.push(`  - ${issue}`);
      }
    }
    markdown.push("");
  }

  writeFileSync(jsonPath, `${JSON.stringify(run, null, 2)}\n`, "utf-8");
  writeFileSync(markdownPath, `${markdown.join("\n").trimEnd()}\n`, "utf-8");
  writeFileSync(latestJsonPath, `${JSON.stringify(run, null, 2)}\n`, "utf-8");
  writeFileSync(latestMarkdownPath, `${markdown.join("\n").trimEnd()}\n`, "utf-8");
}

function findPhase(manifest: FridayPhaseManifest, phaseId: string): FridayPhaseDefinition {
  const phase = manifest.phases.find((item) => item.id === phaseId);
  if (!phase) {
    throw new FridayDomainError(
      "OPENCLAW_ADOPTION_PHASE_NOT_FOUND",
      `Unknown phase "${phaseId}" in ${manifest.programId}`,
      { httpStatus: 404 },
    );
  }
  return phase;
}

function deriveBranchName(manifest: FridayPhaseManifest, phase: FridayPhaseDefinition): string {
  return `${manifest.repo.branchPrefix}-${phase.number}-${phase.slug}`;
}

function getPhaseState(
  state: FridayPhaseControllerState,
  phase: FridayPhaseDefinition,
): FridayPhaseSummaryState {
  return state.phases[phase.id] ?? {
    phaseId: phase.id,
    status: "planned",
  };
}

function getReadyPhase(manifest: FridayPhaseManifest, state: FridayPhaseControllerState): FridayPhaseDefinition | null {
  for (const phase of manifest.phases) {
    const current = getPhaseState(state, phase);
    if (current.status === "done") {
      continue;
    }
    const depsDone = phase.dependsOn.every((phaseId) => state.phases[phaseId]?.status === "done");
    if (depsDone) {
      return phase;
    }
  }
  return null;
}

function buildDefaultCommitMessage(phase: FridayPhaseDefinition): string {
  return `feat: bootstrap ${phase.id} ${phase.slug.replace(/-/g, " ")}`;
}

function buildPrTitle(phase: FridayPhaseDefinition): string {
  return `[${phase.id}] ${phase.title}`;
}

function buildPrBody(manifest: FridayPhaseManifest, phase: FridayPhaseDefinition): string {
  const lines = [
    `## Summary`,
    "",
    phase.summary,
    "",
    "## Guardrails",
    "",
    ...manifest.guardrails.map((guardrail) => `- ${guardrail}`),
    "",
    "## Success Criteria",
    "",
    ...phase.successCriteria.map((item) => `- ${item}`),
  ];
  return lines.join("\n");
}

function defaultPlatform(): FridayPhaseAutomationPlatform {
  function runProcess(command: string, args: string[], repoRoot: string) {
    return spawnSync(command, args, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  function ensureOk(command: string, args: string[], repoRoot: string): string {
    const result = runProcess(command, args, repoRoot);
    if (result.status !== 0) {
      throw new FridayDomainError(
        "OPENCLAW_ADOPTION_COMMAND_FAILED",
        `${command} ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`,
        { httpStatus: 500 },
      );
    }
    return result.stdout.trim();
  }

  function readPr(branchName: string, repoRoot: string): FridayPullRequestRecord | null {
    const result = runProcess(
      "gh",
      ["pr", "view", branchName, "--json", "number,url,state,mergedAt"],
      repoRoot,
    );
    if (result.status !== 0) {
      return null;
    }
    const parsed = JSON.parse(result.stdout) as { number: number; url: string; state: string; mergedAt?: string | null };
    return {
      number: parsed.number,
      url: parsed.url,
      state: parsed.state,
      merged: Boolean(parsed.mergedAt),
    };
  }

  function listMainRuns(repoRoot: string, headSha: string) {
    const result = runProcess(
      "gh",
      ["run", "list", "--branch", "main", "--commit", headSha, "--workflow", "CI", "--json", "databaseId,status,conclusion,url"],
      repoRoot,
    );
    if (result.status !== 0 || result.stdout.trim().length === 0) {
      return [] as Array<{ databaseId: number; status: string; conclusion: string | null; url: string }>;
    }
    return JSON.parse(result.stdout) as Array<{ databaseId: number; status: string; conclusion: string | null; url: string }>;
  }

  return {
    inspectRepo(repoRoot, mainBranch) {
      let gitAvailable = true;
      let ghAvailable = true;
      let ghAuthenticated = false;
      let currentBranch = "";
      let localMainHead: string | undefined;
      let remoteMainHead: string | undefined;
      let workingTreeClean = false;

      try {
        currentBranch = ensureOk("git", ["branch", "--show-current"], repoRoot);
        localMainHead = ensureOk("git", ["rev-parse", mainBranch], repoRoot);
        try {
          ensureOk("git", ["fetch", "origin", mainBranch], repoRoot);
          remoteMainHead = ensureOk("git", ["rev-parse", `origin/${mainBranch}`], repoRoot);
        } catch {
          remoteMainHead = undefined;
        }
        workingTreeClean = ensureOk("git", ["status", "--porcelain"], repoRoot).length === 0;
      } catch {
        gitAvailable = false;
      }

      try {
        ensureOk("gh", ["--version"], repoRoot);
        ghAuthenticated = runProcess("gh", ["auth", "status"], repoRoot).status === 0;
      } catch {
        ghAvailable = false;
      }

      return {
        repoRoot,
        currentBranch,
        localMainHead,
        remoteMainHead,
        workingTreeClean,
        gitAvailable,
        ghAvailable,
        ghAuthenticated,
      };
    },

    syncMain(repoRoot, mainBranch) {
      ensureOk("git", ["fetch", "origin", mainBranch], repoRoot);
      ensureOk("git", ["checkout", mainBranch], repoRoot);
      ensureOk("git", ["pull", "--ff-only", "origin", mainBranch], repoRoot);
    },

    checkoutPhaseBranch(repoRoot, branchName, mainBranch) {
      const branchExists = runProcess("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], repoRoot).status === 0;
      if (branchExists) {
        ensureOk("git", ["checkout", branchName], repoRoot);
        return;
      }
      ensureOk("git", ["checkout", "-b", branchName, `origin/${mainBranch}`], repoRoot);
    },

    hasChanges(repoRoot) {
      return ensureOk("git", ["status", "--porcelain"], repoRoot).length > 0;
    },

    runCommand(step, options) {
      const startedAt = options.nowIso();
      const cwd = step.cwd
        ? join(options.repoRoot, step.cwd)
        : options.repoRoot;
      const result = spawnSync(step.command, step.args, {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...(step.env ?? {}) },
      });
      const finishedAt = options.nowIso();
      const passed = result.status === 0;
      return {
        label: step.label,
        command: [step.command, ...step.args].join(" "),
        status: passed ? "passed" : "failed",
        exitCode: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        startedAt,
        finishedAt,
        optional: Boolean(step.optional),
      };
    },

    commitAll(repoRoot, message) {
      ensureOk("git", ["add", "-A"], repoRoot);
      ensureOk("git", ["commit", "-m", message], repoRoot);
      return ensureOk("git", ["rev-parse", "HEAD"], repoRoot);
    },

    pushBranch(repoRoot, branchName) {
      ensureOk("git", ["push", "--set-upstream", "origin", branchName], repoRoot);
    },

    createOrReusePullRequest(input) {
      const existing = readPr(input.branchName, input.repoRoot);
      if (existing) {
        return existing;
      }
      ensureOk(
        "gh",
        ["pr", "create", "--base", input.baseBranch, "--head", input.branchName, "--title", input.title, "--body", input.body],
        input.repoRoot,
      );
      const created = readPr(input.branchName, input.repoRoot);
      if (!created) {
        throw new FridayDomainError("OPENCLAW_ADOPTION_PR_CREATE_FAILED", `Could not read PR for ${input.branchName}`, {
          httpStatus: 500,
        });
      }
      return created;
    },

    waitForPullRequestChecks(input) {
      const watch = runProcess(
        "gh",
        ["pr", "checks", input.branchName, "--required", "--watch", "--interval", "15", "--fail-fast"],
        input.repoRoot,
      );
      if (watch.status !== 0) {
        const statusResult = runProcess(
          "gh",
          ["pr", "checks", input.branchName, "--required", "--json", "name,bucket,link"],
          input.repoRoot,
        );
        if (statusResult.status !== 0) {
          throw new FridayDomainError(
            "OPENCLAW_ADOPTION_CHECKS_FAILED",
            `Required PR checks failed for ${input.branchName}: ${watch.stderr.trim() || watch.stdout.trim() || "unknown error"}`,
            { httpStatus: 500 },
          );
        }
      }

      const finalStatus = ensureOk(
        "gh",
        ["pr", "checks", input.branchName, "--required", "--json", "name,bucket,link"],
        input.repoRoot,
      );
      const parsed = JSON.parse(finalStatus) as Array<{ name: string; bucket: string; link?: string }>;
      return input.requiredChecks.map((required) => {
        const match = parsed.find((item) => item.name === required);
        if (!match) {
          return { name: required, status: "missing" as const };
        }
        if (match.bucket === "pass") {
          return { name: required, status: "passed" as const, url: match.link };
        }
        if (match.bucket === "pending") {
          return { name: required, status: "pending" as const, url: match.link };
        }
        return { name: required, status: "failed" as const, url: match.link };
      });
    },

    mergePullRequest(input) {
      const strategyFlag = input.strategy === "merge"
        ? "--merge"
        : input.strategy === "rebase"
          ? "--rebase"
          : "--squash";
      ensureOk("gh", ["pr", "merge", String(input.prNumber), strategyFlag, "--delete-branch"], input.repoRoot);
    },

    waitForPullRequestMerge(repoRoot, branchName) {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const pr = readPr(branchName, repoRoot);
        if (pr && pr.merged) {
          return pr;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_000);
      }
      throw new FridayDomainError(
        "OPENCLAW_ADOPTION_MERGE_TIMEOUT",
        `Timed out waiting for ${branchName} to merge`,
        { httpStatus: 500 },
      );
    },

    waitForMainChecks(input) {
      const issues: string[] = [];
      let selectedRun: { databaseId: number; status: string; conclusion: string | null; url: string } | undefined;

      for (let attempt = 0; attempt < 40; attempt += 1) {
        const runs = listMainRuns(input.repoRoot, input.headSha);
        selectedRun = runs[0];
        if (selectedRun && selectedRun.status === "completed") {
          break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
      }

      if (!selectedRun) {
        return {
          ok: false,
          branch: input.branch,
          headSha: input.headSha,
          requiredChecks: input.requiredChecks.map((name) => ({ name, status: "missing" as const })),
          issues: ["No CI workflow run found on main for merged commit"],
        };
      }

      const runViewRaw = ensureOk(
        "gh",
        ["run", "view", String(selectedRun.databaseId), "--json", "jobs,conclusion,url"],
        input.repoRoot,
      );
      const runView = JSON.parse(runViewRaw) as {
        conclusion: string | null;
        url: string;
        jobs: Array<{ name: string; conclusion: string | null; status: string; url?: string }>;
      };

      const checks = input.requiredChecks.map((required) => {
        const job = runView.jobs.find((item) => item.name === required);
        if (!job) {
          issues.push(`Required check "${required}" missing from main CI run`);
          return { name: required, status: "missing" as const };
        }
        if (job.conclusion === "success") {
          return { name: required, status: "passed" as const, url: job.url };
        }
        if (job.status !== "completed") {
          issues.push(`Required check "${required}" is still pending on main`);
          return { name: required, status: "pending" as const, url: job.url };
        }
        issues.push(`Required check "${required}" concluded ${job.conclusion ?? "unknown"} on main`);
        return { name: required, status: "failed" as const, url: job.url };
      });

      if (runView.conclusion !== "success") {
        issues.push(`CI workflow concluded ${runView.conclusion ?? "unknown"} on main`);
      }

      return {
        ok: issues.length === 0,
        branch: input.branch,
        headSha: input.headSha,
        workflowRunId: selectedRun.databaseId,
        workflowUrl: runView.url,
        workflowConclusion: runView.conclusion ?? undefined,
        requiredChecks: checks,
        issues,
      };
    },
  };
}

export function createFridayOpenClawPhaseController(
  options: CreateFridayOpenClawPhaseControllerOptions = {},
): FridayOpenClawPhaseController {
  const nowIso = options.nowIso ?? defaultNowIso;
  const runIdFactory = options.runIdFactory ?? randomUUID;
  const paths = resolvePaths(options);
  const platform = options.platform ?? defaultPlatform();

  function loadManifest(): FridayPhaseManifest {
    return loadFridayOpenClawPhaseManifest(paths.manifestPath);
  }

  function loadState(): FridayPhaseControllerState {
    return loadStateFromDisk(paths, nowIso());
  }

  function saveState(state: FridayPhaseControllerState): void {
    state.updatedAt = nowIso();
    saveStateToDisk(paths, state);
  }

  function writeRunAndState(phase: FridayPhaseDefinition, run: FridayPhaseRunRecord, state: FridayPhaseControllerState): void {
    writeRunEvidence(paths, phase, run);
    saveState(state);
  }

  function doctor(): FridayPhaseDoctorReport {
    const manifest = loadManifest();
    const repo = platform.inspectRepo(paths.repoRoot, manifest.repo.mainBranch);
    const blockers: string[] = [];
    const warnings: string[] = [];

    if (!existsSync(paths.manifestPath)) {
      blockers.push(`Manifest not found at ${paths.manifestPath}`);
    }
    if (!repo.gitAvailable) {
      blockers.push("git is unavailable in the current environment");
    }
    if (!repo.ghAvailable) {
      blockers.push("GitHub CLI (gh) is unavailable in the current environment");
    }
    if (repo.ghAvailable && !repo.ghAuthenticated) {
      blockers.push("GitHub CLI is installed but not authenticated");
    }
    if (!repo.workingTreeClean) {
      warnings.push("Working tree is not clean");
    }
    if (repo.localMainHead && repo.remoteMainHead && repo.localMainHead !== repo.remoteMainHead) {
      warnings.push("Local main does not match origin/main");
    }

    return {
      ok: blockers.length === 0,
      inspectedAt: nowIso(),
      manifestPath: paths.manifestPath,
      repo,
      blockers,
      warnings,
    };
  }

  function listPhaseStates(): FridayPhaseSummaryState[] {
    const manifest = loadManifest();
    const state = loadState();
    return manifest.phases.map((phase) => {
      const current = getPhaseState(state, phase);
      return {
        ...current,
        branchName: current.branchName ?? deriveBranchName(manifest, phase),
      };
    });
  }

  function startNextPhase(input: { dryRun?: boolean } = {}): FridayPhaseStartResult {
    const manifest = loadManifest();
    const state = loadState();
    const nextPhase = getReadyPhase(manifest, state);
    if (!nextPhase) {
      return {
        ok: false,
        dryRun: Boolean(input.dryRun),
        message: "All tracked phases are already complete or blocked by unmet dependencies.",
      };
    }

    const branchName = deriveBranchName(manifest, nextPhase);
    const repo = platform.inspectRepo(paths.repoRoot, manifest.repo.mainBranch);
    if (!repo.workingTreeClean) {
      return {
        ok: false,
        dryRun: Boolean(input.dryRun),
        phaseId: nextPhase.id,
        branchName,
        status: "blocked",
        message: "Working tree is not clean; cannot start the next phase safely.",
      };
    }

    if (!input.dryRun) {
      platform.syncMain(paths.repoRoot, manifest.repo.mainBranch);
      platform.checkoutPhaseBranch(paths.repoRoot, branchName, manifest.repo.mainBranch);
    }

    state.phases[nextPhase.id] = {
      phaseId: nextPhase.id,
      status: "implementing",
      branchName,
      updatedAt: nowIso(),
    };
    saveState(state);

    return {
      ok: true,
      dryRun: Boolean(input.dryRun),
      phaseId: nextPhase.id,
      branchName,
      status: "implementing",
      message: input.dryRun
        ? `Dry run: would prepare ${nextPhase.id} on ${branchName}.`
        : `Prepared ${nextPhase.id} on ${branchName}.`,
    };
  }

  function runGate(
    gateId: FridayPromotionGateResult["gateId"],
    commands: FridayPhaseDefinition["gates"]["fastLocal"],
  ): FridayPromotionGateResult {
    const results = commands.map((step) => platform.runCommand(step, { repoRoot: paths.repoRoot, nowIso }));
    const failed = results.some((result) => result.status === "failed" && !result.optional);
    return {
      gateId,
      status: failed ? "failed" : "passed",
      results,
    };
  }

  function updatePhaseState(
    state: FridayPhaseControllerState,
    phase: FridayPhaseDefinition,
    run: FridayPhaseRunRecord,
  ): void {
    state.phases[phase.id] = {
      phaseId: phase.id,
      status: run.status,
      latestRunId: run.runId,
      branchName: run.branchName,
      prNumber: run.prNumber,
      prUrl: run.prUrl,
      mergedSha: run.mergedSha,
      updatedAt: run.updatedAt,
      completedAt: run.status === "done" ? run.updatedAt : state.phases[phase.id]?.completedAt,
      blockedReason: run.blockers[0],
    };
    state.runs = [...state.runs.filter((item) => item.runId !== run.runId), run];
  }

  function promotePhase(input: {
    phaseId: string;
    dryRun?: boolean;
    prepareNext?: boolean;
  }): FridayPhasePromotionResult {
    const manifest = loadManifest();
    const phase = findPhase(manifest, input.phaseId);
    const state = loadState();
    const branchName = deriveBranchName(manifest, phase);
    const existingState = getPhaseState(state, phase);
    const attempt = state.runs.filter((item) => item.phaseId === phase.id).length + 1;
    const run: FridayPhaseRunRecord = {
      runId: runIdFactory(),
      phaseId: phase.id,
      phaseNumber: phase.number,
      branchName,
      status: "verifying",
      dryRun: Boolean(input.dryRun),
      startedAt: nowIso(),
      updatedAt: nowIso(),
      attempt,
      gates: [],
      blockers: [],
      notes: [],
    };

    const dependenciesDone = phase.dependsOn.every((phaseId) => state.phases[phaseId]?.status === "done");
    if (!dependenciesDone) {
      run.status = "blocked";
      run.blockers.push(`Dependencies incomplete for ${phase.id}: ${phase.dependsOn.join(", ")}`);
      run.updatedAt = nowIso();
      updatePhaseState(state, phase, run);
      writeRunAndState(phase, run, state);
      return { ok: false, dryRun: Boolean(input.dryRun), phaseId: phase.id, status: run.status, branchName, run };
    }

    if (!input.dryRun) {
      platform.checkoutPhaseBranch(paths.repoRoot, branchName, manifest.repo.mainBranch);
    }

    run.gates.push(runGate("fast_local", phase.gates.fastLocal));
    if (run.gates.at(-1)?.status === "failed") {
      run.status = "blocked";
      run.blockers.push("Fast local gate failed.");
      run.updatedAt = nowIso();
      updatePhaseState(state, phase, run);
      writeRunAndState(phase, run, state);
      return { ok: false, dryRun: Boolean(input.dryRun), phaseId: phase.id, status: run.status, branchName, run };
    }

    run.gates.push(runGate("pre_pr", phase.gates.prePr));
    if (run.gates.at(-1)?.status === "failed") {
      run.status = "blocked";
      run.blockers.push("Pre-PR gate failed.");
      run.updatedAt = nowIso();
      updatePhaseState(state, phase, run);
      writeRunAndState(phase, run, state);
      return { ok: false, dryRun: Boolean(input.dryRun), phaseId: phase.id, status: run.status, branchName, run };
    }

    if (input.dryRun) {
      run.status = "ready_for_pr";
      run.notes.push("Dry run completed before commit/push/PR steps.");
      run.updatedAt = nowIso();
      updatePhaseState(state, phase, run);
      writeRunAndState(phase, run, state);
      return { ok: true, dryRun: true, phaseId: phase.id, status: run.status, branchName, run };
    }

    if (!platform.hasChanges(paths.repoRoot) && existingState.prNumber == null) {
      run.status = "blocked";
      run.blockers.push("No local changes detected to promote and no existing PR is associated with this phase.");
      run.updatedAt = nowIso();
      updatePhaseState(state, phase, run);
      writeRunAndState(phase, run, state);
      return { ok: false, dryRun: false, phaseId: phase.id, status: run.status, branchName, run };
    }

    if (platform.hasChanges(paths.repoRoot)) {
      run.commitSha = platform.commitAll(paths.repoRoot, buildDefaultCommitMessage(phase));
      run.notes.push(`Committed phase changes on ${branchName}.`);
    } else {
      run.notes.push(`No new commit created; reusing existing PR path for ${branchName}.`);
    }

    platform.pushBranch(paths.repoRoot, branchName);
    run.status = "pr_open";
    const pr = platform.createOrReusePullRequest({
      repoRoot: paths.repoRoot,
      branchName,
      baseBranch: manifest.repo.mainBranch,
      title: buildPrTitle(phase),
      body: buildPrBody(manifest, phase),
    });
    run.prNumber = pr.number;
    run.prUrl = pr.url;

    run.status = "waiting_ci";
    const prChecks = platform.waitForPullRequestChecks({
      repoRoot: paths.repoRoot,
      branchName,
      requiredChecks: manifest.repo.requiredChecks,
    });
    const failedPrChecks = prChecks.filter((check) => check.status !== "passed");
    if (failedPrChecks.length > 0) {
      run.status = "blocked";
      run.blockers.push(`Required PR checks failed or are incomplete: ${failedPrChecks.map((item) => item.name).join(", ")}`);
      run.updatedAt = nowIso();
      updatePhaseState(state, phase, run);
      writeRunAndState(phase, run, state);
      return { ok: false, dryRun: false, phaseId: phase.id, status: run.status, branchName, run };
    }

    platform.mergePullRequest({
      repoRoot: paths.repoRoot,
      prNumber: pr.number,
      branchName,
      strategy: manifest.repo.mergeStrategy as FridayMergeStrategy,
    });
    platform.waitForPullRequestMerge(paths.repoRoot, branchName);

    run.status = "merged_waiting_main";
    platform.syncMain(paths.repoRoot, manifest.repo.mainBranch);
    run.mergedSha = platform.inspectRepo(paths.repoRoot, manifest.repo.mainBranch).localMainHead;
    if (!run.mergedSha) {
      run.status = "blocked";
      run.blockers.push("Could not resolve merged main SHA after merge.");
      run.updatedAt = nowIso();
      updatePhaseState(state, phase, run);
      writeRunAndState(phase, run, state);
      return { ok: false, dryRun: false, phaseId: phase.id, status: run.status, branchName, run };
    }

    run.mainline = platform.waitForMainChecks({
      repoRoot: paths.repoRoot,
      branch: manifest.repo.mainBranch,
      headSha: run.mergedSha,
      requiredChecks: manifest.repo.requiredChecks,
    });
    if (!run.mainline.ok) {
      run.status = "blocked";
      run.blockers.push(...run.mainline.issues);
      run.updatedAt = nowIso();
      updatePhaseState(state, phase, run);
      writeRunAndState(phase, run, state);
      return { ok: false, dryRun: false, phaseId: phase.id, status: run.status, branchName, run };
    }

    run.gates.push(runGate("post_merge_main", phase.gates.postMerge));
    if (run.gates.at(-1)?.status === "failed") {
      run.status = "blocked";
      run.blockers.push("Post-merge main gate failed.");
      run.updatedAt = nowIso();
      updatePhaseState(state, phase, run);
      writeRunAndState(phase, run, state);
      return { ok: false, dryRun: false, phaseId: phase.id, status: run.status, branchName, run };
    }

    run.status = "done";
    run.updatedAt = nowIso();
    run.notes.push(`Merged to ${manifest.repo.mainBranch} and verified required checks.`);
    updatePhaseState(state, phase, run);

    if (input.prepareNext !== false) {
      const nextPhase = getReadyPhase(manifest, state);
      if (nextPhase && nextPhase.id !== phase.id) {
        const nextBranch = deriveBranchName(manifest, nextPhase);
        platform.checkoutPhaseBranch(paths.repoRoot, nextBranch, manifest.repo.mainBranch);
        state.phases[nextPhase.id] = {
          phaseId: nextPhase.id,
          status: "implementing",
          branchName: nextBranch,
          updatedAt: nowIso(),
        };
        run.notes.push(`Unlocked ${nextPhase.id} on ${nextBranch} and checked out the next phase branch.`);
      }
    }

    writeRunAndState(phase, run, state);
    return { ok: true, dryRun: false, phaseId: phase.id, status: run.status, branchName, run };
  }

  function runNextPhase(input: { dryRun?: boolean; prepareNext?: boolean } = {}) {
    const manifest = loadManifest();
    const state = loadState();
    const nextPhase = getReadyPhase(manifest, state);
    if (!nextPhase) {
      return {
        ok: false,
        dryRun: Boolean(input.dryRun),
        message: "No runnable phase found.",
      } satisfies FridayPhaseStartResult;
    }

    const phaseState = getPhaseState(state, nextPhase);
    if (phaseState.status === "implementing") {
      return promotePhase({
        phaseId: nextPhase.id,
        dryRun: input.dryRun,
        prepareNext: input.prepareNext,
      });
    }
    return startNextPhase({ dryRun: input.dryRun });
  }

  return {
    getPaths() {
      return paths;
    },
    loadManifest,
    loadState,
    doctor,
    listPhaseStates,
    startNextPhase,
    promotePhase,
    runNextPhase,
  };
}

export function formatFridayOpenClawDoctorReport(report: FridayPhaseDoctorReport): string {
  const relManifest = report.repo.gitAvailable
    ? relative(report.repo.repoRoot, report.manifestPath) || "."
    : report.manifestPath;
  const lines = [
    `Manifest: ${relManifest}`,
    `Repo root: ${report.repo.repoRoot}`,
    `Current branch: ${report.repo.currentBranch || "(unknown)"}`,
    `Working tree: ${report.repo.workingTreeClean ? "clean" : "dirty"}`,
    `GitHub CLI: ${report.repo.ghAvailable ? (report.repo.ghAuthenticated ? "authenticated" : "installed but unauthenticated") : "missing"}`,
    `Main heads: local=${report.repo.localMainHead ?? "unknown"} remote=${report.repo.remoteMainHead ?? "unknown"}`,
  ];
  if (report.blockers.length > 0) {
    lines.push("Blockers:");
    for (const blocker of report.blockers) {
      lines.push(`- ${blocker}`);
    }
  }
  if (report.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of report.warnings) {
      lines.push(`- ${warning}`);
    }
  }
  return lines.join("\n");
}

export function formatFridayOpenClawPhaseStates(states: FridayPhaseSummaryState[]): string {
  if (states.length === 0) {
    return "No phases found.";
  }
  return states.map((state) => {
    const extras = [
      state.branchName ? `branch=${state.branchName}` : null,
      state.prNumber ? `pr=#${String(state.prNumber)}` : null,
      state.mergedSha ? `merged=${state.mergedSha.slice(0, 7)}` : null,
    ].filter((value): value is string => Boolean(value));
    return `${state.phaseId}: ${state.status}${extras.length > 0 ? ` (${extras.join(", ")})` : ""}`;
  }).join("\n");
}
