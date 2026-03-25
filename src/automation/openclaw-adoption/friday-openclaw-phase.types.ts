export type FridayAutomationFailurePolicy = "limited-self-heal-then-pause" | "pause-immediately";

export type FridayPhaseStatus =
  | "planned"
  | "syncing_main"
  | "implementing"
  | "spawning_workers"
  | "repairing"
  | "verifying"
  | "ready_for_pr"
  | "committing"
  | "opening_pr"
  | "pr_open"
  | "waiting_required_checks"
  | "waiting_ci"
  | "merging"
  | "merged_waiting_main"
  | "waiting_mainline"
  | "stabilizing"
  | "closing_phase"
  | "blocked"
  | "done";

export type FridayMergeStrategy = "squash" | "merge" | "rebase";

export type FridayPhaseWorkerRunner = "command";

export type FridayPhaseWorkerMode = "implementation" | "repair" | "stabilize" | "closure";

export type FridayPromotionFailureCode =
  | "implementation_failed"
  | "architecture_blocked"
  | "repair_failed"
  | "branch_gate_failed"
  | "required_checks_missing"
  | "required_checks_failed"
  | "merge_failed"
  | "mainline_red"
  | "closure_failed";

export interface FridayPhaseCommand {
  label: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  optional?: boolean;
}

export interface FridayPhaseWorkerSpec {
  id: string;
  title: string;
  runner: FridayPhaseWorkerRunner;
  mode?: FridayPhaseWorkerMode;
  steps: FridayPhaseCommand[];
  allowedPaths?: string[];
  successCriteria?: string[];
  outputContract?: string[];
  continueOnFailure?: boolean;
}

export type FridayArchitectureImpactVerdict =
  | "no_impact"
  | "additive_internal"
  | "additive_public"
  | "blocked";

export type FridayContractDiffVerdict = "unchanged" | "additive" | "blocked";

export interface FridayArchitectureBoundaryRule {
  id: string;
  description: string;
  pathPrefixes: string[];
  verdict?: FridayArchitectureImpactVerdict;
}

export interface FridayArchitectureImpactMatch {
  id: string;
  description: string;
  verdict: FridayArchitectureImpactVerdict;
  matchedPaths: string[];
}

export interface FridayArchitectureImpactReport {
  phaseId: string;
  verdict: FridayArchitectureImpactVerdict;
  summary: string;
  changedPaths: string[];
  outOfBoundsPaths: string[];
  contractDiff: {
    verdict: FridayContractDiffVerdict;
    notes: string[];
  };
  matches: FridayArchitectureImpactMatch[];
  notes: string[];
}

export interface FridayPhaseRepairPolicy {
  enabled?: boolean;
  maxAttempts?: number;
  failureCodes?: FridayPromotionFailureCode[];
  worker?: FridayPhaseWorkerSpec;
  guardrails?: string[];
}

export interface FridayPhaseImplementation {
  mode: "manual" | "shell" | "hybrid";
  command?: FridayPhaseCommand;
  workers?: FridayPhaseWorkerSpec[];
  repairPolicy?: FridayPhaseRepairPolicy;
}

export interface FridayPhasePromotionPolicy {
  requiredChecks?: string[];
  mergeStrategy?: FridayMergeStrategy;
  mainlineHealthPolicy?: "required-checks-green";
  stabilizeSuffix?: string;
}

export interface FridayPhaseClosurePolicy {
  requiredEvidence: string[];
  notes?: string[];
}

export interface FridayPhaseDefinition {
  id: string;
  number: number;
  slug: string;
  title: string;
  summary: string;
  dependsOn: string[];
  allowedPaths: string[];
  taskpackPath?: string;
  successCriteria: string[];
  implementation: FridayPhaseImplementation;
  promotion?: FridayPhasePromotionPolicy;
  closure?: FridayPhaseClosurePolicy;
  gates: {
    fastLocal: FridayPhaseCommand[];
    prePr: FridayPhaseCommand[];
    postMerge: FridayPhaseCommand[];
    finalClosure?: FridayPhaseCommand[];
  };
}

export interface FridayPhaseManifest {
  schemaVersion: "1.0";
  programId: "openclaw-adoption";
  title: string;
  repo: {
    mainBranch: string;
    branchPrefix: string;
    mergeStrategy: FridayMergeStrategy;
    requiredChecks: string[];
    failurePolicy: FridayAutomationFailurePolicy;
    maxAutoRepairAttempts: number;
  };
  guardrails: string[];
  phases: FridayPhaseDefinition[];
}

export interface FridayPhaseTaskpack {
  schemaVersion: "1.0";
  phaseId: string;
  title: string;
  executionMode: "automated" | "spec_only";
  goal: string;
  allowedPaths: string[];
  implementationWorkers: FridayPhaseWorkerSpec[];
  repairWorker?: FridayPhaseWorkerSpec;
  successCriteria: string[];
  gates?: Partial<FridayPhaseDefinition["gates"]>;
  closureEvidence?: string[];
  forbiddenBoundaries: FridayArchitectureBoundaryRule[];
  notes?: string[];
}

export interface FridayPhaseCommandResult {
  label: string;
  command: string;
  status: "passed" | "failed" | "skipped";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
  optional: boolean;
}

export interface FridayPhaseWorkerRunResult {
  workerId: string;
  title: string;
  mode: FridayPhaseWorkerMode;
  runner: FridayPhaseWorkerRunner;
  status: "passed" | "failed" | "skipped";
  startedAt: string;
  finishedAt: string;
  steps: FridayPhaseCommandResult[];
  notes: string[];
}

export interface FridayPromotionGateResult {
  gateId: "implementation" | "architecture_impact" | "repair" | "fast_local" | "pre_pr" | "post_merge_main" | "final_closure";
  status: "passed" | "failed" | "skipped";
  failureCode?: FridayPromotionFailureCode;
  results: FridayPhaseCommandResult[];
}

export interface FridayPhaseSummaryState {
  phaseId: string;
  status: FridayPhaseStatus;
  latestRunId?: string;
  branchName?: string;
  prNumber?: number;
  prUrl?: string;
  mergedSha?: string;
  updatedAt?: string;
  completedAt?: string;
  blockedReason?: string;
  blockedCode?: FridayPromotionFailureCode;
  repairAttempts?: number;
}

export interface FridayPhaseRunRecord {
  runId: string;
  phaseId: string;
  phaseNumber: number;
  branchName: string;
  stabilizeBranchName?: string;
  taskpackPath?: string;
  taskpackRevision?: string;
  status: FridayPhaseStatus;
  dryRun: boolean;
  startedAt: string;
  updatedAt: string;
  attempt: number;
  commitSha?: string;
  prNumber?: number;
  prUrl?: string;
  mergedSha?: string;
  gates: FridayPromotionGateResult[];
  workers: FridayPhaseWorkerRunResult[];
  prChecks: Array<{
    name: string;
    status: "passed" | "failed" | "pending" | "missing";
    url?: string;
  }>;
  blockers: string[];
  blockedBoundary?: string;
  notes: string[];
  repairAttempts: number;
  failureCode?: FridayPromotionFailureCode;
  failurePolicy: FridayAutomationFailurePolicy;
  closureEvidence: string[];
  impactVerdict?: FridayArchitectureImpactVerdict;
  architectureImpact?: FridayArchitectureImpactReport;
  mainline?: FridayMainlineHealthVerdict;
}

export interface FridayPhaseControllerState {
  schemaVersion: "1.0";
  programId: "openclaw-adoption";
  phases: Record<string, FridayPhaseSummaryState>;
  runs: FridayPhaseRunRecord[];
  updatedAt: string;
}

export interface FridayPullRequestRecord {
  number: number;
  url: string;
  state: string;
  merged: boolean;
}

export interface FridayMainlineHealthVerdict {
  ok: boolean;
  branch: string;
  headSha?: string;
  workflowRunId?: number;
  workflowUrl?: string;
  workflowConclusion?: string;
  requiredChecks: Array<{
    name: string;
    status: "passed" | "failed" | "pending" | "missing";
    url?: string;
  }>;
  issues: string[];
}

export interface FridayRepoInspection {
  repoRoot: string;
  currentBranch: string;
  localMainHead?: string;
  remoteMainHead?: string;
  workingTreeClean: boolean;
  gitAvailable: boolean;
  ghAvailable: boolean;
  ghAuthenticated: boolean;
}

export interface FridayPhaseDoctorReport {
  ok: boolean;
  inspectedAt: string;
  manifestPath: string;
  repo: FridayRepoInspection;
  blockers: string[];
  warnings: string[];
}

export interface FridayPhaseStartResult {
  ok: boolean;
  dryRun: boolean;
  phaseId?: string;
  branchName?: string;
  status?: FridayPhaseStatus;
  message: string;
}

export interface FridayPhasePromotionResult {
  ok: boolean;
  dryRun: boolean;
  phaseId: string;
  status: FridayPhaseStatus;
  branchName: string;
  run: FridayPhaseRunRecord;
}

export interface FridayPhaseCloseoutResult {
  ok: boolean;
  status: "blocked" | "done";
  reportPath: string;
  blockers: string[];
  notes: string[];
  gates: FridayPromotionGateResult[];
}

export interface FridayOpenClawPhaseControllerPaths {
  repoRoot: string;
  manifestPath: string;
  runtimeRoot: string;
  statePath: string;
  programPath: string;
  evidenceRoot: string;
  finalCloseoutRoot: string;
  taskpackRoot: string;
}

export interface FridayPhaseAutomationPlatform {
  inspectRepo(repoRoot: string, mainBranch: string): FridayRepoInspection;
  syncMain(repoRoot: string, mainBranch: string): void;
  checkoutPhaseBranch(repoRoot: string, branchName: string, mainBranch: string): void;
  hasChanges(repoRoot: string): boolean;
  listChangedPaths(repoRoot: string): string[];
  runCommand(
    step: FridayPhaseCommand,
    options: { repoRoot: string; nowIso: () => string },
  ): FridayPhaseCommandResult;
  commitAll(repoRoot: string, message: string): string;
  pushBranch(repoRoot: string, branchName: string): void;
  createOrReusePullRequest(input: {
    repoRoot: string;
    branchName: string;
    baseBranch: string;
    title: string;
    body: string;
  }): FridayPullRequestRecord;
  waitForPullRequestChecks(input: {
    repoRoot: string;
    branchName: string;
    requiredChecks: string[];
  }): Array<{ name: string; status: "passed" | "failed" | "pending" | "missing"; url?: string }>;
  mergePullRequest(input: {
    repoRoot: string;
    prNumber: number;
    branchName: string;
    strategy: FridayMergeStrategy;
  }): void;
  waitForPullRequestMerge(repoRoot: string, branchName: string): FridayPullRequestRecord;
  waitForMainChecks(input: {
    repoRoot: string;
    branch: string;
    headSha: string;
    requiredChecks: string[];
  }): FridayMainlineHealthVerdict;
}
