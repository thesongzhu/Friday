import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { FridayDomainError } from "#errors";
import { loadFridayOpenClawPhaseManifest } from "./friday-openclaw-phase-manifest.js";
import { loadFridayOpenClawPhaseTaskpack } from "./friday-openclaw-phase-taskpack.js";
import type {
  FridayArchitectureImpactReport,
  FridayArchitectureImpactVerdict,
  FridayMainlineHealthVerdict,
  FridayMergedPullRequestRecord,
  FridayMergeStrategy,
  FridayOpenClawPhaseControllerPaths,
  FridayPhaseAutomationPlatform,
  FridayPhaseCloseoutResult,
  FridayPhaseCommand,
  FridayPhaseCommandResult,
  FridayPhaseControllerState,
  FridayPhaseDefinition,
  FridayPhaseDoctorReport,
  FridayPhaseManifest,
  FridayPhasePromotionResult,
  FridayPhaseRunRecord,
  FridayPhaseStartResult,
  FridayPhaseStatus,
  FridayPhaseSummaryState,
  FridayPhaseTaskpack,
  FridayPhaseWorkerRunResult,
  FridayPhaseWorkerSpec,
  FridayPromotionFailureCode,
  FridayPromotionGateResult,
  FridayPullRequestDetail,
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
  resumePhase(input?: { phaseId?: string; dryRun?: boolean; prepareNext?: boolean }): FridayPhaseStartResult | FridayPhasePromotionResult;
  stabilizePhase(input: { phaseId: string; dryRun?: boolean; prepareNext?: boolean }): FridayPhasePromotionResult;
  closeout(input?: { dryRun?: boolean }): FridayPhaseCloseoutResult;
  runNextPhase(input?: { dryRun?: boolean; prepareNext?: boolean }): FridayPhaseStartResult | FridayPhasePromotionResult;
}

function defaultNowIso(): string {
  return new Date().toISOString();
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
    programPath: join(runtimeRoot, "program.json"),
    evidenceRoot: join(runtimeRoot, "evidence"),
    finalCloseoutRoot: join(runtimeRoot, "final-closeout"),
    taskpackRoot: join(repoRoot, "docs", "ops", "openclaw-adoption", "taskpacks"),
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
  const candidatePaths = [paths.programPath, paths.statePath];
  for (const candidatePath of candidatePaths) {
    if (!existsSync(candidatePath)) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(candidatePath, "utf-8")) as FridayPhaseControllerState;
      if (parsed.schemaVersion === "1.0" && parsed.programId === "openclaw-adoption") {
        return parsed;
      }
    } catch (err) {
      console.warn("[friday][openclaw-phase-controller] operation failed:", err instanceof Error ? err.message : String(err));
      continue;
    }
  }
  return createEmptyState(nowIso);
}

/**
 * Atomic-write helper: write `contents` to `path` such that a partial write
 * cannot leave `path` in a half-written state.
 *
 * Pattern: write to a sibling tmp path, then `rename` onto the target. On
 * POSIX, `rename` is atomic with respect to other readers — `path` either
 * resolves to the prior content or the new content, never a torn middle.
 *
 * On any write/rename failure the tmp path is best-effort unlinked so a
 * crash partway through does not litter the directory with orphans.
 */
function writeStateFileAtomicSync(path: string, contents: string): void {
  const tmpPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmpPath, contents, "utf-8");
    renameSync(tmpPath, path);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup; surface the original error
    }
    throw err;
  }
}

function saveStateToDisk(paths: FridayOpenClawPhaseControllerPaths, state: FridayPhaseControllerState): void {
  ensureDirectory(paths.runtimeRoot);
  const json = `${JSON.stringify(state, null, 2)}\n`;
  // B2 torn-write boundary: write each file atomically (tmp + rename). The
  // existing `loadStateFromDisk` reads programPath first then falls back to
  // statePath, so write statePath BEFORE programPath — a crash between the
  // two writes leaves programPath holding the prior-good content while
  // statePath holds the new content. Either path on its own remains a
  // valid JSON document after this change.
  writeStateFileAtomicSync(paths.statePath, json);
  writeStateFileAtomicSync(paths.programPath, json);
}

function phaseRuntimePaths(paths: FridayOpenClawPhaseControllerPaths, phase: FridayPhaseDefinition) {
  const phaseRoot = join(paths.runtimeRoot, `phase-${String(phase.number)}`);
  const evidenceDir = join(phaseRoot, "evidence");
  const legacyEvidenceDir = join(paths.evidenceRoot, phase.id);
  return {
    phaseRoot,
    runPath: join(phaseRoot, "run.json"),
    evidenceDir,
    legacyEvidenceDir,
  };
}

function resolveTaskpackPath(paths: FridayOpenClawPhaseControllerPaths, phase: FridayPhaseDefinition): string {
  return phase.taskpackPath
    ? join(paths.repoRoot, phase.taskpackPath)
    : join(paths.taskpackRoot, `phase-${String(phase.number)}.json`);
}

function loadTaskpackBundle(paths: FridayOpenClawPhaseControllerPaths, phase: FridayPhaseDefinition): {
  path: string;
  revision: string;
  taskpack: FridayPhaseTaskpack;
} {
  const taskpackPath = resolveTaskpackPath(paths, phase);
  const raw = readFileSync(taskpackPath, "utf-8");
  const revision = createHash("sha256").update(raw).digest("hex").slice(0, 12);
  return {
    path: taskpackPath,
    revision,
    taskpack: loadFridayOpenClawPhaseTaskpack(taskpackPath),
  };
}

function renderArchitectureImpactMarkdown(report: FridayArchitectureImpactReport): string[] {
  const lines = [
    "# Architecture Impact",
    "",
    `- Verdict: ${report.verdict}`,
    `- Summary: ${report.summary}`,
    "",
    "## Changed Paths",
    "",
    ...(report.changedPaths.length > 0 ? report.changedPaths.map((path) => `- ${path}`) : ["- None"]),
    "",
    "## Out Of Bounds",
    "",
    ...(report.outOfBoundsPaths.length > 0 ? report.outOfBoundsPaths.map((path) => `- ${path}`) : ["- None"]),
    "",
    "## Contract Diff",
    "",
    `- Verdict: ${report.contractDiff.verdict}`,
    ...(report.contractDiff.notes.length > 0 ? report.contractDiff.notes.map((note) => `- ${note}`) : ["- None"]),
    "",
    "## Boundary Matches",
    "",
  ];

  if (report.matches.length === 0) {
    lines.push("- None");
  } else {
    for (const match of report.matches) {
      lines.push(`- ${match.id}: ${match.verdict}`);
      lines.push(`  - ${match.description}`);
      for (const path of match.matchedPaths) {
        lines.push(`  - ${path}`);
      }
    }
  }

  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push(...(report.notes.length > 0 ? report.notes.map((note) => `- ${note}`) : ["- None"]));
  return lines;
}

function renderGateMarkdown(gate: FridayPromotionGateResult): string[] {
  const lines = [
    `## ${gate.gateId}`,
    "",
    `- Status: ${gate.status}`,
    ...(gate.failureCode ? [`- Failure Code: ${gate.failureCode}`] : []),
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

function renderWorkerMarkdown(worker: FridayPhaseWorkerRunResult): string[] {
  const lines = [
    `## Worker ${worker.workerId}`,
    "",
    `- Title: ${worker.title}`,
    `- Mode: ${worker.mode}`,
    `- Runner: ${worker.runner}`,
    `- Status: ${worker.status}`,
    `- Started At: ${worker.startedAt}`,
    `- Finished At: ${worker.finishedAt}`,
  ];
  if (worker.notes.length > 0) {
    lines.push("- Notes:");
    for (const note of worker.notes) {
      lines.push(`  - ${note}`);
    }
  }
  if (worker.steps.length > 0) {
    lines.push("- Commands:");
    for (const step of worker.steps) {
      lines.push(`  - ${step.label}: ${step.status} (\`${step.command}\`)`);
    }
  }
  lines.push("");
  return lines;
}

function writeRunEvidence(
  paths: FridayOpenClawPhaseControllerPaths,
  phase: FridayPhaseDefinition,
  run: FridayPhaseRunRecord,
): void {
  const runtime = phaseRuntimePaths(paths, phase);
  ensureDirectory(runtime.phaseRoot);
  ensureDirectory(runtime.evidenceDir);
  ensureDirectory(runtime.legacyEvidenceDir);

  const markdown = [
    `# ${phase.title}`,
    "",
    `- Phase: ${phase.id}`,
    `- Status: ${run.status}`,
    `- Branch: ${run.branchName}`,
    ...(run.stabilizeBranchName ? [`- Stabilize Branch: ${run.stabilizeBranchName}`] : []),
    ...(run.taskpackPath ? [`- Taskpack: ${relative(paths.repoRoot, run.taskpackPath) || run.taskpackPath}`] : []),
    ...(run.taskpackRevision ? [`- Taskpack Revision: ${run.taskpackRevision}`] : []),
    `- Dry Run: ${run.dryRun ? "yes" : "no"}`,
    `- Started At: ${run.startedAt}`,
    `- Updated At: ${run.updatedAt}`,
    `- Attempt: ${String(run.attempt)}`,
    `- Repair Attempts: ${String(run.repairAttempts)}`,
    ...(run.failureCode ? [`- Failure Code: ${run.failureCode}`] : []),
    ...(run.impactVerdict ? [`- Impact Verdict: ${run.impactVerdict}`] : []),
    ...(run.blockedBoundary ? [`- Blocked Boundary: ${run.blockedBoundary}`] : []),
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
    "## Closure Evidence",
    "",
    ...(run.closureEvidence.length > 0 ? run.closureEvidence.map((item) => `- ${item}`) : ["- None"]),
    "",
    ...run.workers.flatMap((worker) => renderWorkerMarkdown(worker)),
    ...run.gates.flatMap((gate) => renderGateMarkdown(gate)),
  ];

  if (run.prChecks.length > 0) {
    markdown.push("## PR Checks");
    markdown.push("");
    for (const check of run.prChecks) {
      markdown.push(`- ${check.name}: ${check.status}`);
    }
    markdown.push("");
  }

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

  const json = `${JSON.stringify(run, null, 2)}\n`;
  const md = `${markdown.join("\n").trimEnd()}\n`;
  writeFileSync(runtime.runPath, json, "utf-8");
  writeFileSync(join(runtime.evidenceDir, `${run.runId}.json`), json, "utf-8");
  writeFileSync(join(runtime.evidenceDir, `${run.runId}.md`), md, "utf-8");
  writeFileSync(join(runtime.evidenceDir, "latest.json"), json, "utf-8");
  writeFileSync(join(runtime.evidenceDir, "latest.md"), md, "utf-8");
  writeFileSync(join(runtime.legacyEvidenceDir, "latest.json"), json, "utf-8");
  writeFileSync(join(runtime.legacyEvidenceDir, "latest.md"), md, "utf-8");

  if (run.architectureImpact) {
    const impactJson = `${JSON.stringify(run.architectureImpact, null, 2)}\n`;
    const impactMd = `${renderArchitectureImpactMarkdown(run.architectureImpact).join("\n").trimEnd()}\n`;
    writeFileSync(join(runtime.evidenceDir, `${run.runId}-impact.json`), impactJson, "utf-8");
    writeFileSync(join(runtime.evidenceDir, `${run.runId}-impact.md`), impactMd, "utf-8");
    writeFileSync(join(runtime.evidenceDir, "latest-impact.json"), impactJson, "utf-8");
    writeFileSync(join(runtime.evidenceDir, "latest-impact.md"), impactMd, "utf-8");
    writeFileSync(join(runtime.legacyEvidenceDir, "latest-impact.json"), impactJson, "utf-8");
    writeFileSync(join(runtime.legacyEvidenceDir, "latest-impact.md"), impactMd, "utf-8");
  }
}

function writeCloseoutEvidence(
  paths: FridayOpenClawPhaseControllerPaths,
  manifest: FridayPhaseManifest,
  result: FridayPhaseCloseoutResult,
): void {
  ensureDirectory(paths.finalCloseoutRoot);
  const json = `${JSON.stringify(result, null, 2)}\n`;
  const markdown = [
    `# ${manifest.title} Closeout`,
    "",
    `- Status: ${result.status}`,
    `- Report Path: ${result.reportPath}`,
    "",
    "## Blockers",
    "",
    ...(result.blockers.length > 0 ? result.blockers.map((item) => `- ${item}`) : ["- None"]),
    "",
    "## Notes",
    "",
    ...(result.notes.length > 0 ? result.notes.map((item) => `- ${item}`) : ["- None"]),
    "",
    ...result.gates.flatMap((gate) => renderGateMarkdown(gate)),
  ].join("\n").trimEnd();
  writeFileSync(join(paths.finalCloseoutRoot, "latest.json"), json, "utf-8");
  writeFileSync(join(paths.finalCloseoutRoot, "latest.md"), `${markdown}\n`, "utf-8");
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

function deriveStabilizeBranchName(manifest: FridayPhaseManifest, phase: FridayPhaseDefinition): string {
  const suffix = phase.promotion?.stabilizeSuffix ?? "stabilize";
  return `${deriveBranchName(manifest, phase)}-${suffix}`;
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

function getResumablePhase(manifest: FridayPhaseManifest, state: FridayPhaseControllerState): FridayPhaseDefinition | null {
  for (const phase of manifest.phases) {
    const current = getPhaseState(state, phase);
    if (current.status === "done") {
      continue;
    }
    const depsDone = phase.dependsOn.every((phaseId) => state.phases[phaseId]?.status === "done");
    if (!depsDone) {
      continue;
    }
    if (current.status === "blocked" || current.status === "implementing" || current.status === "stabilizing" || current.status === "ready_for_pr") {
      return phase;
    }
  }
  return getReadyPhase(manifest, state);
}

function buildCommitMessage(phase: FridayPhaseDefinition, stabilize = false): string {
  if (stabilize) {
    return `fix: stabilize ${phase.id} ${phase.slug.replace(/-/g, " ")}`;
  }
  return `feat: bootstrap ${phase.id} ${phase.slug.replace(/-/g, " ")}`;
}

function buildPrTitle(phase: FridayPhaseDefinition, stabilize = false): string {
  return stabilize
    ? `[${phase.id}] Stabilize ${phase.title}`
    : `[${phase.id}] ${phase.title}`;
}

function buildPrBody(manifest: FridayPhaseManifest, phase: FridayPhaseDefinition, stabilize = false): string {
  const lines = [
    "## Summary",
    "",
    stabilize
      ? `Stabilization follow-up for ${phase.title}.`
      : phase.summary,
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

function resolveRequiredChecks(manifest: FridayPhaseManifest, phase: FridayPhaseDefinition): string[] {
  return phase.promotion?.requiredChecks ?? manifest.repo.requiredChecks;
}

function resolveMergeStrategy(manifest: FridayPhaseManifest, phase: FridayPhaseDefinition): FridayMergeStrategy {
  return phase.promotion?.mergeStrategy ?? manifest.repo.mergeStrategy;
}

function resolveMaxRepairAttempts(manifest: FridayPhaseManifest, phase: FridayPhaseDefinition): number {
  return phase.implementation.repairPolicy?.maxAttempts ?? manifest.repo.maxAutoRepairAttempts;
}

function normalizeWorkers(phase: FridayPhaseDefinition, taskpack?: FridayPhaseTaskpack): FridayPhaseWorkerSpec[] {
  if (taskpack?.implementationWorkers && taskpack.implementationWorkers.length > 0) {
    return taskpack.implementationWorkers.map((worker) => ({
      ...worker,
      mode: worker.mode ?? "implementation",
    }));
  }
  if (phase.implementation.workers && phase.implementation.workers.length > 0) {
    return phase.implementation.workers.map((worker) => ({
      ...worker,
      mode: worker.mode ?? "implementation",
    }));
  }
  if (phase.implementation.command) {
    return [{
      id: `${phase.id}-implementation`,
      title: `${phase.title} implementation`,
      runner: "command",
      mode: "implementation",
      steps: [phase.implementation.command],
      allowedPaths: phase.allowedPaths,
      successCriteria: phase.successCriteria,
    }];
  }
  return [];
}

function resolveRepairWorker(phase: FridayPhaseDefinition, taskpack?: FridayPhaseTaskpack): FridayPhaseWorkerSpec | undefined {
  return taskpack?.repairWorker ?? phase.implementation.repairPolicy?.worker;
}

function resolveGateCommands(
  phase: FridayPhaseDefinition,
  taskpack: FridayPhaseTaskpack | undefined,
  gateId: keyof FridayPhaseDefinition["gates"],
): FridayPhaseCommand[] {
  const taskpackCommands = taskpack?.gates?.[gateId];
  if (taskpackCommands && taskpackCommands.length > 0) {
    return taskpackCommands;
  }
  return phase.gates[gateId] ?? [];
}

function pathMatchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function classifyPublicContractChange(path: string): boolean {
  return path.startsWith("src/api/http/routes/")
    || path.startsWith("src/api/runtime/")
    || path === "docs/current-source-of-truth.md";
}

function buildArchitectureImpactReport(
  phase: FridayPhaseDefinition,
  taskpack: FridayPhaseTaskpack,
  changedPaths: string[],
): FridayArchitectureImpactReport {
  const outOfBoundsPaths = changedPaths.filter((path) => !taskpack.allowedPaths.some((allowed) => pathMatchesPrefix(path, allowed)));
  const matches = taskpack.forbiddenBoundaries
    .map((boundary) => {
      const matchedPaths = changedPaths.filter((path) => boundary.pathPrefixes.some((prefix) => pathMatchesPrefix(path, prefix)));
      if (matchedPaths.length === 0) {
        return null;
      }
      return {
        id: boundary.id,
        description: boundary.description,
        verdict: boundary.verdict ?? "blocked",
        matchedPaths,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  const contractNotes: string[] = [];
  let contractVerdict: FridayArchitectureImpactReport["contractDiff"]["verdict"] = "unchanged";

  if (outOfBoundsPaths.length > 0) {
    contractVerdict = "blocked";
    contractNotes.push("Tracked changes escaped the taskpack allowedPaths boundary.");
  } else if (changedPaths.some((path) => classifyPublicContractChange(path))) {
    contractVerdict = "additive";
    contractNotes.push("Tracked changes touch public route or contract-bearing surfaces.");
  }

  if (matches.some((match) => match.verdict === "blocked")) {
    contractVerdict = "blocked";
    contractNotes.push("One or more forbidden architecture boundaries were matched.");
  }

  let verdict: FridayArchitectureImpactVerdict = "no_impact";
  if (outOfBoundsPaths.length > 0 || matches.some((match) => match.verdict === "blocked")) {
    verdict = "blocked";
  } else if (changedPaths.some((path) => classifyPublicContractChange(path))) {
    verdict = "additive_public";
  } else if (changedPaths.length > 0) {
    verdict = "additive_internal";
  }

  const notes: string[] = [];
  if (changedPaths.length === 0) {
    notes.push(`No tracked changes detected for ${phase.id} at architecture review time.`);
  }
  if (taskpack.executionMode === "spec_only") {
    notes.push("Taskpack is spec_only; dry-run validation is allowed, but automatic merge promotion must stay blocked.");
  }

  return {
    phaseId: phase.id,
    verdict,
    summary: verdict === "blocked"
      ? "Architecture impact exceeded the allowed phase boundary."
      : verdict === "additive_public"
        ? "Only additive public-surface changes were detected."
        : verdict === "additive_internal"
          ? "Only additive internal changes were detected."
          : "No tracked architecture impact detected.",
    changedPaths,
    outOfBoundsPaths,
    contractDiff: {
      verdict: contractVerdict,
      notes: contractNotes,
    },
    matches,
    notes,
  };
}

function normalizeChangedPaths(changedPaths: string[]): string[] {
  return [...new Set(changedPaths.map((path) => path.trim()).filter((path) => path.length > 0))].sort();
}

function resolvePhaseClosureEvidence(phase: FridayPhaseDefinition, taskpack: FridayPhaseTaskpack): string[] {
  const configured = taskpack.closureEvidence?.length
    ? taskpack.closureEvidence
    : phase.closure?.requiredEvidence ?? [];
  return [...new Set(configured)];
}

function selectMergedPullRequestForPhase(
  manifest: FridayPhaseManifest,
  phase: FridayPhaseDefinition,
  pullRequests: FridayMergedPullRequestRecord[],
): FridayMergedPullRequestRecord | null {
  const exactBranch = deriveBranchName(manifest, phase);
  const branchPrefix = `${manifest.repo.branchPrefix}-${String(phase.number)}-`;
  const candidates = pullRequests
    .filter((pullRequest) => pullRequest.baseRefName === manifest.repo.mainBranch)
    .filter((pullRequest) => pullRequest.headRefName === exactBranch || pullRequest.headRefName.startsWith(branchPrefix))
    .sort((left, right) => {
      const exactScore = Number(right.headRefName === exactBranch) - Number(left.headRefName === exactBranch);
      if (exactScore !== 0) {
        return exactScore;
      }
      const mergedAtDiff = Date.parse(right.mergedAt ?? "") - Date.parse(left.mergedAt ?? "");
      if (!Number.isNaN(mergedAtDiff) && mergedAtDiff !== 0) {
        return mergedAtDiff;
      }
      return right.number - left.number;
    });
  return candidates[0] ?? null;
}

function shouldAllowRepair(
  manifest: FridayPhaseManifest,
  phase: FridayPhaseDefinition,
  taskpack: FridayPhaseTaskpack,
  run: FridayPhaseRunRecord,
  failureCode: FridayPromotionFailureCode,
): boolean {
  if (manifest.repo.failurePolicy === "pause-immediately") {
    return false;
  }
  const policy = phase.implementation.repairPolicy ?? { enabled: true };
  if (policy.enabled === false || !resolveRepairWorker(phase, taskpack)) {
    return false;
  }
  if (run.repairAttempts >= resolveMaxRepairAttempts(manifest, phase)) {
    return false;
  }
  if (policy.failureCodes && policy.failureCodes.length > 0 && !policy.failureCodes.includes(failureCode)) {
    return false;
  }
  return true;
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
    const result = runProcess("gh", ["pr", "view", branchName, "--json", "number,url,state,mergedAt"], repoRoot);
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

  function readPrCheckRollup(branchName: string, repoRoot: string) {
    const result = runProcess("gh", ["pr", "view", branchName, "--json", "statusCheckRollup"], repoRoot);
    if (result.status !== 0 || result.stdout.trim().length === 0) {
      return [] as Array<{ name?: string; status?: string; conclusion?: string; detailsUrl?: string }>;
    }
    const parsed = JSON.parse(result.stdout) as {
      statusCheckRollup?: Array<{ name?: string; status?: string; conclusion?: string; detailsUrl?: string }>;
    };
    return parsed.statusCheckRollup ?? [];
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
        } catch (err) {
      console.warn("[friday][openclaw-phase-controller] operation failed:", err instanceof Error ? err.message : String(err));
          remoteMainHead = undefined;
        }
        workingTreeClean = ensureOk("git", ["status", "--porcelain"], repoRoot).length === 0;
      } catch (err) {
      console.warn("[friday][openclaw-phase-controller] operation failed:", err instanceof Error ? err.message : String(err));
        gitAvailable = false;
      }

      try {
        ensureOk("gh", ["--version"], repoRoot);
        ghAuthenticated = runProcess("gh", ["auth", "status"], repoRoot).status === 0;
      } catch (err) {
      console.warn("[friday][openclaw-phase-controller] operation failed:", err instanceof Error ? err.message : String(err));
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

    listChangedPaths(repoRoot) {
      const result = runProcess("git", ["status", "--porcelain"], repoRoot);
      if (result.status !== 0) {
        throw new FridayDomainError(
          "OPENCLAW_ADOPTION_COMMAND_FAILED",
          `git status --porcelain failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`,
          { httpStatus: 500 },
        );
      }
      const raw = (result.stdout ?? "").replace(/\n+$/, "");
      if (raw.length === 0) {
        return [];
      }
      return raw
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length >= 4)
        .map((line) => {
          const payload = line.slice(3).trim();
          const renameMarker = " -> ";
          return payload.includes(renameMarker) ? payload.split(renameMarker).at(-1) ?? payload : payload;
        });
    },

    runCommand(step, options) {
      const startedAt = options.nowIso();
      const cwd = step.cwd ? join(options.repoRoot, step.cwd) : options.repoRoot;
      const result = spawnSync(step.command, step.args, {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...(step.env ?? {}) },
      });
      const finishedAt = options.nowIso();
      return {
        label: step.label,
        command: [step.command, ...step.args].join(" "),
        status: result.status === 0 ? "passed" : "failed",
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
        throw new FridayDomainError(
          "OPENCLAW_ADOPTION_PR_CREATE_FAILED",
          `Could not read PR for ${input.branchName}`,
          { httpStatus: 500 },
        );
      }
      return created;
    },

    waitForPullRequestChecks(input) {
      let latest: Array<{ name: string; status: "passed" | "failed" | "pending" | "missing"; url?: string }> =
        input.requiredChecks.map((required) => ({ name: required, status: "missing" as const }));
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const rollup = readPrCheckRollup(input.branchName, input.repoRoot);
        latest = input.requiredChecks.map((required) => {
          const match = rollup.find((item) => item.name === required);
          if (!match) {
            return { name: required, status: "missing" as const };
          }
          const normalizedStatus = (match.status ?? "").toUpperCase();
          const normalizedConclusion = (match.conclusion ?? "").toUpperCase();
          if (normalizedConclusion === "SUCCESS") {
            return { name: required, status: "passed" as const, url: match.detailsUrl };
          }
          if (normalizedStatus === "IN_PROGRESS" || normalizedStatus === "QUEUED" || normalizedStatus === "PENDING" || normalizedConclusion.length === 0) {
            return { name: required, status: "pending" as const, url: match.detailsUrl };
          }
          return { name: required, status: "failed" as const, url: match.detailsUrl };
        });

        if (latest.some((check) => check.status === "failed")) {
          return latest;
        }
        const allVisible = latest.every((check) => check.status !== "missing");
        const allPassed = latest.every((check) => check.status === "passed");
        if (allVisible && allPassed) {
          return latest;
        }
        pause(10_000);
      }
      return latest;
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
        pause(5_000);
      }
      throw new FridayDomainError(
        "OPENCLAW_ADOPTION_MERGE_TIMEOUT",
        `Timed out waiting for ${branchName} to merge`,
        { httpStatus: 500 },
      );
    },

    listMergedPullRequests(input) {
      const result = runProcess(
        "gh",
        ["pr", "list", "--state", "merged", "--base", input.baseBranch, "--limit", "100", "--json", "number,title,url,headRefName,baseRefName,mergedAt"],
        input.repoRoot,
      );
      if (result.status !== 0 || result.stdout.trim().length === 0) {
        return [];
      }
      const parsed = JSON.parse(result.stdout) as Array<{
        number: number;
        title: string;
        url: string;
        headRefName: string;
        baseRefName: string;
        mergedAt?: string | null;
      }>;
      return parsed
        .filter((pullRequest) => pullRequest.headRefName.startsWith(input.headPrefix))
        .map((pullRequest) => ({
          number: pullRequest.number,
          title: pullRequest.title,
          url: pullRequest.url,
          state: "MERGED",
          merged: true,
          headRefName: pullRequest.headRefName,
          baseRefName: pullRequest.baseRefName,
          mergedAt: pullRequest.mergedAt ?? undefined,
        }));
    },

    readPullRequestDetail(repoRoot, prNumber) {
      const raw = ensureOk(
        "gh",
        ["pr", "view", String(prNumber), "--json", "number,title,url,state,mergedAt,headRefName,baseRefName,mergeCommit,files"],
        repoRoot,
      );
      const parsed = JSON.parse(raw) as {
        number: number;
        title: string;
        url: string;
        state: string;
        mergedAt?: string | null;
        headRefName: string;
        baseRefName: string;
        mergeCommit?: { oid?: string | null } | null;
        files?: Array<{ path?: string | null }>;
      };
      return {
        number: parsed.number,
        title: parsed.title,
        url: parsed.url,
        state: parsed.state,
        merged: Boolean(parsed.mergedAt),
        headRefName: parsed.headRefName,
        baseRefName: parsed.baseRefName,
        mergedAt: parsed.mergedAt ?? undefined,
        mergeCommitSha: parsed.mergeCommit?.oid ?? undefined,
        changedPaths: normalizeChangedPaths((parsed.files ?? []).map((file) => file.path ?? "")),
      };
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
        pause(10_000);
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

  function reconcileMergedPhaseHistory(
    manifest: FridayPhaseManifest,
    state: FridayPhaseControllerState,
    input: { dryRun?: boolean } = {},
  ): {
    blockers: string[];
    notes: string[];
    reconciledPhaseIds: Set<string>;
  } {
    const blockers: string[] = [];
    const notes: string[] = [];
    const reconciledPhaseIds = new Set<string>();
    const mergedPullRequests = platform.listMergedPullRequests({
      repoRoot: paths.repoRoot,
      baseBranch: manifest.repo.mainBranch,
      headPrefix: `${manifest.repo.branchPrefix}-`,
    });

    for (const phase of manifest.phases) {
      const runtime = phaseRuntimePaths(paths, phase);
      const phaseState = state.phases[phase.id];
      if (phaseState?.status === "done" && existsSync(runtime.runPath)) {
        continue;
      }

      let taskpackBundle;
      try {
        taskpackBundle = loadTaskpackBundle(paths, phase);
      } catch (error) {
        blockers.push(`${phase.id} taskpack could not be loaded during reconciliation: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      const matchedPullRequest = selectMergedPullRequestForPhase(manifest, phase, mergedPullRequests);
      if (!matchedPullRequest) {
        continue;
      }

      let pullRequestDetail: FridayPullRequestDetail;
      try {
        pullRequestDetail = platform.readPullRequestDetail(paths.repoRoot, matchedPullRequest.number);
      } catch (error) {
        blockers.push(`${phase.id} pull request details could not be loaded during reconciliation: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      const changedPaths = normalizeChangedPaths(pullRequestDetail.changedPaths);
      const architectureImpact = buildArchitectureImpactReport(phase, taskpackBundle.taskpack, changedPaths);
      const mergedAt = pullRequestDetail.mergedAt ?? nowIso();
      const run: FridayPhaseRunRecord = {
        runId: `reconciled-${phase.id}-${(pullRequestDetail.mergeCommitSha ?? `pr-${String(pullRequestDetail.number)}`).slice(0, 12)}`,
        phaseId: phase.id,
        phaseNumber: phase.number,
        branchName: pullRequestDetail.headRefName,
        taskpackPath: taskpackBundle.path,
        taskpackRevision: taskpackBundle.revision,
        status: architectureImpact.verdict === "blocked" ? "blocked" : "done",
        dryRun: Boolean(input.dryRun),
        startedAt: mergedAt,
        updatedAt: mergedAt,
        attempt: state.runs.filter((item) => item.phaseId === phase.id).length + 1,
        commitSha: pullRequestDetail.mergeCommitSha,
        prNumber: pullRequestDetail.number,
        prUrl: pullRequestDetail.url,
        mergedSha: pullRequestDetail.mergeCommitSha,
        gates: [{
          gateId: "architecture_impact",
          status: architectureImpact.verdict === "blocked" ? "failed" : "passed",
          failureCode: architectureImpact.verdict === "blocked" ? "architecture_blocked" : undefined,
          results: [],
        }],
        workers: [],
        prChecks: [],
        blockers: architectureImpact.verdict === "blocked"
          ? ["Reconciled merged PR exceeded the committed phase boundary."]
          : [],
        notes: [
          `Reconciled from merged PR #${String(pullRequestDetail.number)} (${pullRequestDetail.url}).`,
          `Resolved head branch ${pullRequestDetail.headRefName}.`,
        ],
        repairAttempts: 0,
        failureCode: architectureImpact.verdict === "blocked" ? "architecture_blocked" : undefined,
        failurePolicy: manifest.repo.failurePolicy,
        closureEvidence: resolvePhaseClosureEvidence(phase, taskpackBundle.taskpack),
        impactVerdict: architectureImpact.verdict,
        architectureImpact,
      };

      updatePhaseState(state, phase, run);
      if (!input.dryRun) {
        writeRunAndState(phase, run, state);
      }
      reconciledPhaseIds.add(phase.id);
      notes.push(`Reconciled ${phase.id} from merged PR #${String(pullRequestDetail.number)}.`);
      if (architectureImpact.verdict === "blocked") {
        blockers.push(`${phase.id} merged PR violates the committed taskpack boundary.`);
      }
    }

    return { blockers, notes, reconciledPhaseIds };
  }

  function updatePhaseState(state: FridayPhaseControllerState, phase: FridayPhaseDefinition, run: FridayPhaseRunRecord): void {
    state.phases[phase.id] = {
      phaseId: phase.id,
      status: run.status,
      latestRunId: run.runId,
      branchName: run.stabilizeBranchName ?? run.branchName,
      prNumber: run.prNumber,
      prUrl: run.prUrl,
      mergedSha: run.mergedSha,
      updatedAt: run.updatedAt,
      completedAt: run.status === "done" ? run.updatedAt : state.phases[phase.id]?.completedAt,
      blockedReason: run.blockers[0],
      blockedCode: run.failureCode,
      repairAttempts: run.repairAttempts,
    };
    state.runs = [...state.runs.filter((item) => item.runId !== run.runId), run];
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
    for (const phase of manifest.phases) {
      const taskpackPath = resolveTaskpackPath(paths, phase);
      if (!existsSync(taskpackPath)) {
        blockers.push(`Taskpack not found for ${phase.id}: ${relative(paths.repoRoot, taskpackPath)}`);
        continue;
      }
      try {
        const bundle = loadTaskpackBundle(paths, phase);
        if (bundle.taskpack.phaseId !== phase.id) {
          blockers.push(`Taskpack phase mismatch for ${phase.id}: ${relative(paths.repoRoot, taskpackPath)}`);
        }
        if (bundle.taskpack.executionMode === "spec_only") {
          warnings.push(`${phase.id} taskpack is spec_only and cannot auto-promote yet.`);
        }
      } catch (error) {
        blockers.push(
          `Taskpack parse failed for ${phase.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
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
    const taskpackBundle = loadTaskpackBundle(paths, nextPhase);
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
    if (!input.dryRun && taskpackBundle.taskpack.executionMode !== "automated") {
      return {
        ok: false,
        dryRun: false,
        phaseId: nextPhase.id,
        branchName,
        status: "blocked",
        message: `Taskpack for ${nextPhase.id} is spec_only and cannot be auto-promoted yet.`,
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
        ? `Dry run: would prepare ${nextPhase.id} on ${branchName} using ${relative(paths.repoRoot, taskpackBundle.path) || taskpackBundle.path}.`
        : `Prepared ${nextPhase.id} on ${branchName}.`,
    };
  }

  function makeRunRecord(
    manifest: FridayPhaseManifest,
    phase: FridayPhaseDefinition,
    taskpackBundle: { path: string; revision: string; taskpack: FridayPhaseTaskpack },
    input: { dryRun?: boolean },
    state: FridayPhaseControllerState,
    stabilize = false,
  ): FridayPhaseRunRecord {
    const attempt = state.runs.filter((item) => item.phaseId === phase.id).length + 1;
    return {
      runId: runIdFactory(),
      phaseId: phase.id,
      phaseNumber: phase.number,
      branchName: deriveBranchName(manifest, phase),
      stabilizeBranchName: stabilize ? deriveStabilizeBranchName(manifest, phase) : undefined,
      taskpackPath: taskpackBundle.path,
      taskpackRevision: taskpackBundle.revision,
      status: stabilize ? "stabilizing" : "implementing",
      dryRun: Boolean(input.dryRun),
      startedAt: nowIso(),
      updatedAt: nowIso(),
      attempt,
      gates: [],
      workers: [],
      prChecks: [],
      blockers: [],
      notes: [],
      repairAttempts: 0,
      failurePolicy: manifest.repo.failurePolicy,
      closureEvidence: resolvePhaseClosureEvidence(phase, taskpackBundle.taskpack),
    };
  }

  function workerToGate(
    worker: FridayPhaseWorkerRunResult,
    gateId: FridayPromotionGateResult["gateId"],
    failureCode: FridayPromotionFailureCode,
  ): FridayPromotionGateResult {
    return {
      gateId,
      status: worker.status === "failed" ? "failed" : worker.status === "skipped" ? "skipped" : "passed",
      failureCode: worker.status === "failed" ? failureCode : undefined,
      results: worker.steps,
    };
  }

  function runWorker(worker: FridayPhaseWorkerSpec, mode: FridayPhaseWorkerRunResult["mode"]): FridayPhaseWorkerRunResult {
    const startedAt = nowIso();
    const steps = worker.steps.map((step) => platform.runCommand(step, { repoRoot: paths.repoRoot, nowIso }));
    const hasFailure = steps.some((result) => result.status === "failed" && !result.optional);
    return {
      workerId: worker.id,
      title: worker.title,
      mode,
      runner: worker.runner,
      status: hasFailure ? "failed" : "passed",
      startedAt,
      finishedAt: nowIso(),
      steps,
      notes: [],
    };
  }

  function runGate(
    gateId: FridayPromotionGateResult["gateId"],
    commands: FridayPhaseCommand[],
    failureCode: FridayPromotionFailureCode,
  ): FridayPromotionGateResult {
    const results = commands.map((step) => platform.runCommand(step, { repoRoot: paths.repoRoot, nowIso }));
    const failed = results.some((result) => result.status === "failed" && !result.optional);
    return {
      gateId,
      status: failed ? "failed" : "passed",
      failureCode: failed ? failureCode : undefined,
      results,
    };
  }

  function blockRun(
    state: FridayPhaseControllerState,
    phase: FridayPhaseDefinition,
    run: FridayPhaseRunRecord,
    failureCode: FridayPromotionFailureCode,
    blocker: string,
  ): FridayPhasePromotionResult {
    run.status = "blocked";
    run.failureCode = failureCode;
    if (!run.blockers.includes(blocker)) {
      run.blockers.push(blocker);
    }
    run.updatedAt = nowIso();
    updatePhaseState(state, phase, run);
    writeRunAndState(phase, run, state);
    return { ok: false, dryRun: run.dryRun, phaseId: phase.id, status: run.status, branchName: run.stabilizeBranchName ?? run.branchName, run };
  }

  function runRepairWorker(
    manifest: FridayPhaseManifest,
    phase: FridayPhaseDefinition,
    taskpack: FridayPhaseTaskpack,
    run: FridayPhaseRunRecord,
    state: FridayPhaseControllerState,
    failureCode: FridayPromotionFailureCode,
    note: string,
  ): boolean {
    if (!shouldAllowRepair(manifest, phase, taskpack, run, failureCode)) {
      return false;
    }
    const repairWorker = resolveRepairWorker(phase, taskpack);
    if (!repairWorker) {
      return false;
    }
    run.status = "repairing";
    run.repairAttempts += 1;
    run.notes.push(note);
    const workerResult = runWorker(repairWorker, repairWorker.mode ?? "repair");
    run.workers.push(workerResult);
    run.gates.push(workerToGate(workerResult, "repair", "repair_failed"));
    run.updatedAt = nowIso();
    updatePhaseState(state, phase, run);
    writeRunAndState(phase, run, state);
    if (workerResult.status === "failed") {
      run.failureCode = "repair_failed";
      run.blockers.push(`Repair worker ${repairWorker.id} failed.`);
      return false;
    }
    return true;
  }

  function runImplementationAndBranchGates(
    manifest: FridayPhaseManifest,
    phase: FridayPhaseDefinition,
    taskpack: FridayPhaseTaskpack,
    run: FridayPhaseRunRecord,
    state: FridayPhaseControllerState,
    stabilize = false,
  ): boolean {
    const workers = stabilize
      ? (resolveRepairWorker(phase, taskpack) ? [{ ...resolveRepairWorker(phase, taskpack)!, mode: "stabilize" as const }] : normalizeWorkers(phase, taskpack))
      : normalizeWorkers(phase, taskpack);

    let rerunWorkers = true;
    while (true) {
      if (rerunWorkers) {
        run.status = "spawning_workers";
        let restartWorkers = false;
        for (const worker of workers) {
          const result = runWorker(worker, worker.mode ?? (stabilize ? "stabilize" : "implementation"));
          run.workers.push(result);
          run.gates.push(workerToGate(result, "implementation", "implementation_failed"));
          if (result.status === "failed") {
            run.failureCode = "implementation_failed";
            const repaired = runRepairWorker(
              manifest,
              phase,
              taskpack,
              run,
              state,
              "implementation_failed",
              `Worker ${worker.id} failed; attempting targeted repair.`,
            );
            if (repaired) {
              restartWorkers = true;
              break;
            }
            run.blockers.push(`Worker ${worker.id} failed during automated implementation.`);
            return false;
          }
        }
        if (restartWorkers) {
          rerunWorkers = true;
          continue;
        }
        rerunWorkers = false;
      }

      const architectureReport = buildArchitectureImpactReport(phase, taskpack, platform.listChangedPaths(paths.repoRoot));
      run.architectureImpact = architectureReport;
      run.impactVerdict = architectureReport.verdict;
      const architectureGate: FridayPromotionGateResult = {
        gateId: "architecture_impact",
        status: architectureReport.verdict === "blocked" ? "failed" : "passed",
        failureCode: architectureReport.verdict === "blocked" ? "architecture_blocked" : undefined,
        results: [],
      };
      run.gates.push(architectureGate);
      if (architectureReport.verdict === "blocked") {
        run.failureCode = "architecture_blocked";
        run.blockedBoundary = architectureReport.matches.find((match) => match.verdict === "blocked")?.id
          ?? (architectureReport.outOfBoundsPaths.length > 0 ? "allowed_paths" : undefined);
        run.blockers.push("Architecture impact exceeded the taskpack boundary.");
        return false;
      }

      run.status = "verifying";
      const fastGate = runGate("fast_local", resolveGateCommands(phase, taskpack, "fastLocal"), "branch_gate_failed");
      run.gates.push(fastGate);
      if (fastGate.status === "failed") {
        run.failureCode = "branch_gate_failed";
        const repaired = runRepairWorker(
          manifest,
          phase,
          taskpack,
          run,
          state,
          "branch_gate_failed",
          "Fast local gate failed; attempting repair before re-running branch gates.",
        );
        if (repaired) {
          rerunWorkers = false;
          continue;
        }
        run.blockers.push("Fast local gate failed.");
        return false;
      }

      const prePrGate = runGate("pre_pr", resolveGateCommands(phase, taskpack, "prePr"), "branch_gate_failed");
      run.gates.push(prePrGate);
      if (prePrGate.status === "failed") {
        run.failureCode = "branch_gate_failed";
        const repaired = runRepairWorker(
          manifest,
          phase,
          taskpack,
          run,
          state,
          "branch_gate_failed",
          "Pre-PR gate failed; attempting repair before re-running branch gates.",
        );
        if (repaired) {
          rerunWorkers = false;
          continue;
        }
        run.blockers.push("Pre-PR gate failed.");
        return false;
      }

      return true;
    }
  }

  function maybePrepareNextPhase(manifest: FridayPhaseManifest, state: FridayPhaseControllerState, phase: FridayPhaseDefinition, run: FridayPhaseRunRecord): void {
    const nextPhase = getReadyPhase(manifest, state);
    if (!nextPhase || nextPhase.id === phase.id) {
      return;
    }
    const nextTaskpack = loadTaskpackBundle(paths, nextPhase);
    if (nextTaskpack.taskpack.executionMode !== "automated") {
      run.notes.push(`Next phase ${nextPhase.id} stays planned because ${relative(paths.repoRoot, nextTaskpack.path) || nextTaskpack.path} is spec_only.`);
      return;
    }
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

  function runPostMergeAndClosureGates(
    phase: FridayPhaseDefinition,
    taskpack: FridayPhaseTaskpack,
    run: FridayPhaseRunRecord,
  ): FridayPromotionFailureCode | null {
    const postMergeGate = runGate("post_merge_main", resolveGateCommands(phase, taskpack, "postMerge"), "closure_failed");
    run.gates.push(postMergeGate);
    if (postMergeGate.status === "failed") {
      return "closure_failed";
    }
    const finalClosureCommands = resolveGateCommands(phase, taskpack, "finalClosure");
    if (finalClosureCommands.length > 0) {
      const finalGate = runGate("final_closure", finalClosureCommands, "closure_failed");
      run.gates.push(finalGate);
      if (finalGate.status === "failed") {
        return "closure_failed";
      }
    }
    return null;
  }

  function executePhase(input: {
    phaseId: string;
    dryRun?: boolean;
    prepareNext?: boolean;
    stabilize?: boolean;
  }): FridayPhasePromotionResult {
    const manifest = loadManifest();
    const phase = findPhase(manifest, input.phaseId);
    const taskpackBundle = loadTaskpackBundle(paths, phase);
    const state = loadState();
    const run = makeRunRecord(manifest, phase, taskpackBundle, input, state, Boolean(input.stabilize));
    const activeBranch = run.stabilizeBranchName ?? run.branchName;
    run.notes.push(`Loaded taskpack ${relative(paths.repoRoot, taskpackBundle.path) || taskpackBundle.path} (${taskpackBundle.revision}).`);

    const dependenciesDone = phase.dependsOn.every((phaseId) => state.phases[phaseId]?.status === "done");
    if (!dependenciesDone) {
      return blockRun(state, phase, run, "implementation_failed", `Dependencies incomplete for ${phase.id}: ${phase.dependsOn.join(", ")}`);
    }
    if (!input.dryRun && taskpackBundle.taskpack.executionMode !== "automated") {
      run.notes.push(`Loaded ${relative(paths.repoRoot, taskpackBundle.path) || taskpackBundle.path}.`);
      return blockRun(
        state,
        phase,
        run,
        "implementation_failed",
        `Taskpack for ${phase.id} is spec_only and cannot auto-promote yet.`,
      );
    }

    const repo = platform.inspectRepo(paths.repoRoot, manifest.repo.mainBranch);
    if (!repo.workingTreeClean && repo.currentBranch !== activeBranch) {
      return blockRun(
        state,
        phase,
        run,
        "implementation_failed",
        `Working tree is dirty on ${repo.currentBranch || "(unknown)"}; expected ${activeBranch} for automatic execution.`,
      );
    }

    if (!input.dryRun) {
      run.status = "syncing_main";
      updatePhaseState(state, phase, run);
      writeRunAndState(phase, run, state);
      if (repo.workingTreeClean) {
        platform.syncMain(paths.repoRoot, manifest.repo.mainBranch);
      } else {
        run.notes.push(`Resuming with existing local changes on ${activeBranch}; skipped syncing ${manifest.repo.mainBranch}.`);
      }
      platform.checkoutPhaseBranch(paths.repoRoot, activeBranch, manifest.repo.mainBranch);
    }

    const branchReady = runImplementationAndBranchGates(
      manifest,
      phase,
      taskpackBundle.taskpack,
      run,
      state,
      Boolean(input.stabilize),
    );
    if (!branchReady) {
      return blockRun(
        state,
        phase,
        run,
        run.failureCode ?? "implementation_failed",
        run.blockers.at(-1) ?? "Implementation or branch gates failed.",
      );
    }

    if (input.dryRun) {
      run.status = "ready_for_pr";
      run.notes.push("Dry run completed before commit/push/PR steps.");
      run.updatedAt = nowIso();
      updatePhaseState(state, phase, run);
      writeRunAndState(phase, run, state);
      return { ok: true, dryRun: true, phaseId: phase.id, status: run.status, branchName: activeBranch, run };
    }

    run.status = "committing";
    if (platform.hasChanges(paths.repoRoot)) {
      run.commitSha = platform.commitAll(paths.repoRoot, buildCommitMessage(phase, Boolean(input.stabilize)));
      run.notes.push(`Committed phase changes on ${activeBranch}.`);
    } else {
      run.notes.push(`No new tracked changes detected on ${activeBranch}; proceeding with PR reuse/create path.`);
    }

    platform.pushBranch(paths.repoRoot, activeBranch);

    run.status = "opening_pr";
    const pr = platform.createOrReusePullRequest({
      repoRoot: paths.repoRoot,
      branchName: activeBranch,
      baseBranch: manifest.repo.mainBranch,
      title: buildPrTitle(phase, Boolean(input.stabilize)),
      body: buildPrBody(manifest, phase, Boolean(input.stabilize)),
    });
    run.prNumber = pr.number;
    run.prUrl = pr.url;
    run.status = "pr_open";

    const requiredChecks = resolveRequiredChecks(manifest, phase);
    while (true) {
      run.status = "waiting_required_checks";
      run.prChecks = platform.waitForPullRequestChecks({
        repoRoot: paths.repoRoot,
        branchName: activeBranch,
        requiredChecks,
      });
      const missingChecks = run.prChecks.filter((check) => check.status === "missing" || check.status === "pending");
      const failedChecks = run.prChecks.filter((check) => check.status === "failed");
      if (missingChecks.length === 0 && failedChecks.length === 0) {
        break;
      }

      const failureCode: FridayPromotionFailureCode = failedChecks.length > 0
        ? "required_checks_failed"
        : "required_checks_missing";
      run.failureCode = failureCode;
      const repaired = runRepairWorker(
        manifest,
        phase,
        taskpackBundle.taskpack,
        run,
        state,
        failureCode,
        `Required PR checks did not pass cleanly (${failureCode}); attempting repair.`,
      );
      if (!repaired) {
        return blockRun(
          state,
          phase,
          run,
          failureCode,
          `Required PR checks failed or are incomplete: ${run.prChecks.filter((item) => item.status !== "passed").map((item) => item.name).join(", ")}`,
        );
      }

      const branchReadyAfterRepair = runImplementationAndBranchGates(
        manifest,
        phase,
        taskpackBundle.taskpack,
        run,
        state,
        Boolean(input.stabilize),
      );
      if (!branchReadyAfterRepair) {
        return blockRun(state, phase, run, run.failureCode ?? "branch_gate_failed", run.blockers.at(-1) ?? "Repair rerun failed.");
      }
      if (platform.hasChanges(paths.repoRoot)) {
        run.status = "committing";
        run.commitSha = platform.commitAll(paths.repoRoot, buildCommitMessage(phase, Boolean(input.stabilize)));
        run.notes.push(`Committed repair changes on ${activeBranch}.`);
      }
      platform.pushBranch(paths.repoRoot, activeBranch);
    }

    run.status = "merging";
    try {
      platform.mergePullRequest({
        repoRoot: paths.repoRoot,
        prNumber: pr.number,
        branchName: activeBranch,
        strategy: resolveMergeStrategy(manifest, phase),
      });
      platform.waitForPullRequestMerge(paths.repoRoot, activeBranch);
    } catch (error) {
      run.notes.push(`Merge step failed on ${activeBranch}: ${error instanceof Error ? error.message : String(error)}`);
      if (!input.stabilize && shouldAllowRepair(manifest, phase, taskpackBundle.taskpack, run, "merge_failed")) {
        updatePhaseState(state, phase, run);
        writeRunAndState(phase, run, state);
        return stabilizePhase({
          phaseId: phase.id,
          dryRun: input.dryRun,
          prepareNext: input.prepareNext,
        });
      }
      return blockRun(state, phase, run, "merge_failed", "Pull request merge failed.");
    }

    run.status = "waiting_mainline";
    platform.syncMain(paths.repoRoot, manifest.repo.mainBranch);
    run.mergedSha = platform.inspectRepo(paths.repoRoot, manifest.repo.mainBranch).localMainHead;
    if (!run.mergedSha) {
      return blockRun(state, phase, run, "merge_failed", "Could not resolve merged main SHA after merge.");
    }

    run.mainline = platform.waitForMainChecks({
      repoRoot: paths.repoRoot,
      branch: manifest.repo.mainBranch,
      headSha: run.mergedSha,
      requiredChecks,
    });
    if (!run.mainline.ok) {
      if (!input.stabilize && shouldAllowRepair(manifest, phase, taskpackBundle.taskpack, run, "mainline_red")) {
        run.notes.push("Mainline health failed after merge; escalating to stabilize branch.");
        updatePhaseState(state, phase, run);
        writeRunAndState(phase, run, state);
        return stabilizePhase({
          phaseId: phase.id,
          dryRun: input.dryRun,
          prepareNext: input.prepareNext,
        });
      }
      run.blockers.push(...run.mainline.issues);
      return blockRun(state, phase, run, "mainline_red", run.mainline.issues[0] ?? "Mainline checks failed.");
    }

    run.status = "closing_phase";
    const closureFailure = runPostMergeAndClosureGates(phase, taskpackBundle.taskpack, run);
    if (closureFailure) {
      if (!input.stabilize && shouldAllowRepair(manifest, phase, taskpackBundle.taskpack, run, closureFailure)) {
        run.notes.push("Post-merge closure failed; escalating to stabilize branch.");
        updatePhaseState(state, phase, run);
        writeRunAndState(phase, run, state);
        return stabilizePhase({
          phaseId: phase.id,
          dryRun: input.dryRun,
          prepareNext: input.prepareNext,
        });
      }
      return blockRun(state, phase, run, closureFailure, "Post-merge verification or closure gate failed.");
    }

    run.status = "done";
    run.updatedAt = nowIso();
    run.notes.push(`Merged to ${manifest.repo.mainBranch} and verified required checks.`);
    updatePhaseState(state, phase, run);

    if (input.prepareNext !== false) {
      maybePrepareNextPhase(manifest, state, phase, run);
    }

    writeRunAndState(phase, run, state);
    return { ok: true, dryRun: false, phaseId: phase.id, status: run.status, branchName: activeBranch, run };
  }

  function promotePhase(input: { phaseId: string; dryRun?: boolean; prepareNext?: boolean }): FridayPhasePromotionResult {
    return executePhase({ ...input, stabilize: false });
  }

  function stabilizePhase(input: { phaseId: string; dryRun?: boolean; prepareNext?: boolean }): FridayPhasePromotionResult {
    return executePhase({ ...input, stabilize: true });
  }

  function resumePhase(input: { phaseId?: string; dryRun?: boolean; prepareNext?: boolean } = {}): FridayPhaseStartResult | FridayPhasePromotionResult {
    const manifest = loadManifest();
    const state = loadState();
    const phase = input.phaseId ? findPhase(manifest, input.phaseId) : getResumablePhase(manifest, state);
    if (!phase) {
      return {
        ok: false,
        dryRun: Boolean(input.dryRun),
        message: "No resumable phase found.",
      };
    }
    const current = getPhaseState(state, phase);
    if (current.blockedCode === "merge_failed" || current.blockedCode === "mainline_red" || current.blockedCode === "closure_failed") {
      return stabilizePhase({
        phaseId: phase.id,
        dryRun: input.dryRun,
        prepareNext: input.prepareNext,
      });
    }
    return promotePhase({
      phaseId: phase.id,
      dryRun: input.dryRun,
      prepareNext: input.prepareNext,
    });
  }

  function closeout(input: { dryRun?: boolean } = {}): FridayPhaseCloseoutResult {
    const manifest = loadManifest();
    const state = loadState();
    const blockers: string[] = [];
    const notes: string[] = [];
    const reconciliation = reconcileMergedPhaseHistory(manifest, state, input);
    blockers.push(...reconciliation.blockers);
    notes.push(...reconciliation.notes);

    for (const phase of manifest.phases) {
      const phaseState = state.phases[phase.id];
      if (phaseState?.status !== "done") {
        blockers.push(`${phase.id} is not complete`);
      }
      try {
        loadTaskpackBundle(paths, phase);
      } catch (error) {
        blockers.push(`${phase.id} taskpack could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
      }
      const runtime = phaseRuntimePaths(paths, phase);
      if (!existsSync(runtime.runPath) && !(input.dryRun && reconciliation.reconciledPhaseIds.has(phase.id))) {
        blockers.push(`${phase.id} is missing phase runtime evidence`);
      }
    }

    const lastPhase = manifest.phases.at(-1);
    const gates: FridayPromotionGateResult[] = [];
    if (lastPhase) {
      try {
        const taskpack = loadTaskpackBundle(paths, lastPhase).taskpack;
        const finalCommands = resolveGateCommands(lastPhase, taskpack, "finalClosure");
        if (finalCommands.length > 0 && blockers.length === 0) {
          if (input.dryRun) {
            gates.push({
              gateId: "final_closure",
              status: "skipped",
              results: [],
            });
            notes.push("Dry run: skipped final closure commands.");
          } else {
            gates.push(runGate("final_closure", finalCommands, "closure_failed"));
          }
        }
      } catch (error) {
        blockers.push(`Final phase taskpack could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const failedGate = gates.find((gate) => gate.status === "failed");
    if (failedGate) {
      blockers.push(`Final closure gate failed: ${failedGate.gateId}`);
    }

    const reportPath = join(paths.finalCloseoutRoot, "latest.json");
    const result: FridayPhaseCloseoutResult = {
      ok: blockers.length === 0,
      status: blockers.length === 0 ? "done" : "blocked",
      reportPath,
      blockers,
      notes,
      gates,
    };
    writeCloseoutEvidence(paths, manifest, result);
    return result;
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
    return promotePhase({
      phaseId: nextPhase.id,
      dryRun: input.dryRun,
      prepareNext: input.prepareNext,
    });
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
    resumePhase,
    stabilizePhase,
    closeout,
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
  return states
    .map((state) => {
      const extras = [
        state.prNumber ? `pr=#${String(state.prNumber)}` : undefined,
        state.blockedCode ? `blockedCode=${state.blockedCode}` : undefined,
        typeof state.repairAttempts === "number" ? `repairs=${String(state.repairAttempts)}` : undefined,
        state.updatedAt ? `updated=${state.updatedAt}` : undefined,
      ].filter(Boolean);
      return `${state.phaseId}: ${state.status} (${state.branchName ?? "unassigned"}${extras.length > 0 ? `; ${extras.join(", ")}` : ""})`;
    })
    .join("\n");
}
