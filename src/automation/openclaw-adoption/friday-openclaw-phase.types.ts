export type FridayAutomationFailurePolicy = "limited-self-heal-then-pause" | "pause-immediately";

export type FridayPhaseStatus =
  | "planned"
  | "implementing"
  | "verifying"
  | "ready_for_pr"
  | "pr_open"
  | "waiting_ci"
  | "merged_waiting_main"
  | "stabilizing"
  | "blocked"
  | "done";

export type FridayMergeStrategy = "squash" | "merge" | "rebase";

export interface FridayPhaseCommand {
  label: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  optional?: boolean;
}

export interface FridayPhaseImplementation {
  mode: "manual" | "shell";
  command?: FridayPhaseCommand;
}

export interface FridayPhaseDefinition {
  id: string;
  number: number;
  slug: string;
  title: string;
  summary: string;
  dependsOn: string[];
  allowedPaths: string[];
  successCriteria: string[];
  implementation: FridayPhaseImplementation;
  gates: {
    fastLocal: FridayPhaseCommand[];
    prePr: FridayPhaseCommand[];
    postMerge: FridayPhaseCommand[];
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

export interface FridayPromotionGateResult {
  gateId: "fast_local" | "pre_pr" | "post_merge_main";
  status: "passed" | "failed" | "skipped";
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
}

export interface FridayPhaseRunRecord {
  runId: string;
  phaseId: string;
  phaseNumber: number;
  branchName: string;
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
  blockers: string[];
  notes: string[];
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

export interface FridayOpenClawPhaseControllerPaths {
  repoRoot: string;
  manifestPath: string;
  runtimeRoot: string;
  statePath: string;
  evidenceRoot: string;
}

export interface FridayPhaseAutomationPlatform {
  inspectRepo(repoRoot: string, mainBranch: string): FridayRepoInspection;
  syncMain(repoRoot: string, mainBranch: string): void;
  checkoutPhaseBranch(repoRoot: string, branchName: string, mainBranch: string): void;
  hasChanges(repoRoot: string): boolean;
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
