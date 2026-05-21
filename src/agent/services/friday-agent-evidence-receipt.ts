import { join } from "node:path";

import type {
  FridayAgentArtifact,
  FridayAgentTestResult,
  FridayAgentToolCallRecord,
} from "../model/friday-agent.types.js";

export const FRIDAY_AGENT_EVIDENCE_RECEIPT_SCHEMA_VERSION = "friday.agent.evidence_receipt.v1";

export type FridayAgentEvidenceReceiptStatus =
  | "verified_receipt"
  | "blocked_or_failed"
  | "waiting_for_human"
  | "in_progress";

export interface FridayAgentEvidenceReceiptFile {
  label: string;
  kind:
    | "run_record"
    | "tool_calls"
    | "test_results"
    | "response"
    | "artifacts"
    | "evidence_receipt"
    | "audit_endpoint"
    | "artifact";
  path?: string;
  href?: string;
}

export interface FridayAgentEvidenceReceiptCounts {
  toolCalls: {
    total: number;
    succeeded: number;
    failed: number;
  };
  tests: {
    total: number;
    passed: number;
    failed: number;
  };
  artifacts: {
    total: number;
    byType: Record<string, number>;
  };
}

export interface FridayAgentReplayableEvidenceReceipt {
  schemaVersion: typeof FRIDAY_AGENT_EVIDENCE_RECEIPT_SCHEMA_VERSION;
  receiptKind: "agent_run_replayable_evidence";
  receiptStatus: FridayAgentEvidenceReceiptStatus;
  issuedAt: string;
  run: {
    runId: string;
    task: string;
    status: string;
    completedAt?: string;
    durationMs?: number;
    usageInput?: number;
    usageOutput?: number;
    costUsd?: number | null;
  };
  evidence: FridayAgentEvidenceReceiptCounts & {
    auditEventCount?: number;
    decisionTraceAvailable?: boolean;
    decisionTraceActionCount?: number;
  };
  replay: {
    auditEndpoint: string;
    artifactDir?: string;
    files: FridayAgentEvidenceReceiptFile[];
  };
  blockers: string[];
  limitations: string[];
  proofBoundary: string;
  userSummary: string;
}

export interface BuildFridayAgentReplayableEvidenceReceiptInput {
  runId: string;
  task: string;
  status: string;
  issuedAt?: string;
  completedAt?: string;
  durationMs?: number;
  usageInput?: number;
  usageOutput?: number;
  costUsd?: number | null;
  artifactDir?: string;
  toolCalls?: FridayAgentToolCallRecord[];
  testResults?: FridayAgentTestResult[];
  artifacts?: FridayAgentArtifact[];
  auditEventCount?: number;
  decisionTraceAvailable?: boolean;
  decisionTraceActionCount?: number;
}

const HUMAN_WAITING_STATUSES = new Set([
  "awaiting_clarification",
  "awaiting_plan_approval",
  "awaiting_tool_approval",
]);

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "failed_tests",
  "cancelled",
]);

const PROOF_BOUNDARY = [
  "This receipt is replay evidence for one local Friday agent run.",
  "It is not release proof; release/default-on claims still require same-SHA Real Green Gate,",
  "nonzero passing scenarios, empty blockers, and real runtime/provider/API/UI proof for the claimed surface.",
].join(" ");

function countToolCalls(toolCalls: FridayAgentToolCallRecord[] = []): FridayAgentEvidenceReceiptCounts["toolCalls"] {
  const failed = toolCalls.filter((call) => call.result.isError === true).length;
  return {
    total: toolCalls.length,
    succeeded: toolCalls.length - failed,
    failed,
  };
}

function countTestResults(testResults: FridayAgentTestResult[] = []): FridayAgentEvidenceReceiptCounts["tests"] {
  const failed = testResults.filter((result) => result.passed !== true).length;
  return {
    total: testResults.length,
    passed: testResults.length - failed,
    failed,
  };
}

function countArtifacts(artifacts: FridayAgentArtifact[] = []): FridayAgentEvidenceReceiptCounts["artifacts"] {
  const byType: Record<string, number> = {};
  for (const artifact of artifacts) {
    byType[artifact.type] = (byType[artifact.type] ?? 0) + 1;
  }
  return {
    total: artifacts.length,
    byType,
  };
}

function buildReplayFiles(input: BuildFridayAgentReplayableEvidenceReceiptInput): FridayAgentEvidenceReceiptFile[] {
  const auditEndpoint = `/v1/agent/runs/${encodeURIComponent(input.runId)}/audit`;
  const files: FridayAgentEvidenceReceiptFile[] = [
    { label: "Audit API", kind: "audit_endpoint", href: auditEndpoint },
  ];

  if (input.artifactDir) {
    files.push(
      { label: "Run record", kind: "run_record", path: join(input.artifactDir, "run.json") },
      { label: "Tool calls", kind: "tool_calls", path: join(input.artifactDir, "tool-calls.json") },
      { label: "Test results", kind: "test_results", path: join(input.artifactDir, "test-results.json") },
      { label: "Response", kind: "response", path: join(input.artifactDir, "response.md") },
      { label: "Artifact index", kind: "artifacts", path: join(input.artifactDir, "artifacts.json") },
      { label: "Evidence receipt", kind: "evidence_receipt", path: join(input.artifactDir, "evidence-receipt.json") },
    );
  }

  for (const artifact of input.artifacts ?? []) {
    if (!artifact.path || artifact.type === "run_record" || artifact.type === "evidence_receipt") {
      continue;
    }
    files.push({
      label: artifact.type,
      kind: "artifact",
      path: artifact.path,
    });
  }

  return files;
}

function classifyReceipt(input: BuildFridayAgentReplayableEvidenceReceiptInput): FridayAgentEvidenceReceiptStatus {
  if (HUMAN_WAITING_STATUSES.has(input.status)) {
    return "waiting_for_human";
  }
  if (input.status === "completed") {
    return input.artifactDir
      && countToolCalls(input.toolCalls).failed === 0
      && countTestResults(input.testResults).failed === 0
      ? "verified_receipt"
      : "blocked_or_failed";
  }
  if (TERMINAL_STATUSES.has(input.status)) {
    return "blocked_or_failed";
  }
  return "in_progress";
}

function buildBlockers(input: BuildFridayAgentReplayableEvidenceReceiptInput): string[] {
  const blockers: string[] = [];
  if (!input.artifactDir) {
    blockers.push("No artifact directory is attached to this run.");
  }
  if (input.status === "failed" || input.status === "failed_tests" || input.status === "cancelled") {
    blockers.push(`Run ended with status ${input.status}.`);
  }
  const failedTools = countToolCalls(input.toolCalls).failed;
  if (failedTools > 0) {
    blockers.push(`${String(failedTools)} tool call(s) reported an error.`);
  }
  const failedTests = countTestResults(input.testResults).failed;
  if (failedTests > 0) {
    blockers.push(`${String(failedTests)} test result(s) failed.`);
  }
  return blockers;
}

function buildLimitations(input: BuildFridayAgentReplayableEvidenceReceiptInput): string[] {
  const limitations = [
    "Receipt file paths are replay pointers, not proof that every external provider or release gate passed.",
    "Raw tool arguments and raw tool output are intentionally kept in tool-calls.json instead of repeated here.",
  ];
  if (input.decisionTraceAvailable !== true) {
    limitations.push("Decision trace was not available when this receipt was built.");
  }
  if (!TERMINAL_STATUSES.has(input.status)) {
    limitations.push("Run is not terminal, so this receipt cannot be treated as a completed outcome.");
  }
  return limitations;
}

function buildUserSummary(input: BuildFridayAgentReplayableEvidenceReceiptInput): string {
  const status = classifyReceipt(input);
  if (status === "verified_receipt") {
    return "Friday has a replayable receipt for this completed local run.";
  }
  if (status === "waiting_for_human") {
    return "Friday is waiting for a human decision; the receipt records the current replay pointers.";
  }
  if (status === "blocked_or_failed") {
    return "Friday did not complete this run successfully; the receipt records the failure evidence.";
  }
  return "Friday is still working; the receipt records the current replay pointers.";
}

export function buildFridayAgentReplayableEvidenceReceipt(
  input: BuildFridayAgentReplayableEvidenceReceiptInput,
): FridayAgentReplayableEvidenceReceipt {
  const issuedAt = input.issuedAt ?? input.completedAt ?? new Date().toISOString();
  return {
    schemaVersion: FRIDAY_AGENT_EVIDENCE_RECEIPT_SCHEMA_VERSION,
    receiptKind: "agent_run_replayable_evidence",
    receiptStatus: classifyReceipt(input),
    issuedAt,
    run: {
      runId: input.runId,
      task: input.task,
      status: input.status,
      ...(input.completedAt ? { completedAt: input.completedAt } : {}),
      ...(typeof input.durationMs === "number" ? { durationMs: input.durationMs } : {}),
      ...(typeof input.usageInput === "number" ? { usageInput: input.usageInput } : {}),
      ...(typeof input.usageOutput === "number" ? { usageOutput: input.usageOutput } : {}),
      ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
    },
    evidence: {
      toolCalls: countToolCalls(input.toolCalls),
      tests: countTestResults(input.testResults),
      artifacts: countArtifacts(input.artifacts),
      ...(typeof input.auditEventCount === "number" ? { auditEventCount: input.auditEventCount } : {}),
      ...(typeof input.decisionTraceAvailable === "boolean"
        ? { decisionTraceAvailable: input.decisionTraceAvailable }
        : {}),
      ...(typeof input.decisionTraceActionCount === "number"
        ? { decisionTraceActionCount: input.decisionTraceActionCount }
        : {}),
    },
    replay: {
      auditEndpoint: `/v1/agent/runs/${encodeURIComponent(input.runId)}/audit`,
      ...(input.artifactDir ? { artifactDir: input.artifactDir } : {}),
      files: buildReplayFiles(input),
    },
    blockers: buildBlockers(input),
    limitations: buildLimitations(input),
    proofBoundary: PROOF_BOUNDARY,
    userSummary: buildUserSummary(input),
  };
}

export function renderFridayAgentEvidenceReceiptMarkdown(
  receipt: FridayAgentReplayableEvidenceReceipt,
): string {
  const lines = [
    `# Friday Agent Evidence Receipt: ${receipt.run.runId}`,
    "",
    `Status: ${receipt.receiptStatus}`,
    `Run status: ${receipt.run.status}`,
    `Summary: ${receipt.userSummary}`,
    "",
    "Replay pointers:",
    ...receipt.replay.files.map((file) => `- ${file.label}: ${file.path ?? file.href ?? "unavailable"}`),
    "",
    "Evidence counts:",
    `- Tool calls: ${String(receipt.evidence.toolCalls.succeeded)} succeeded, ${String(receipt.evidence.toolCalls.failed)} failed, ${String(receipt.evidence.toolCalls.total)} total`,
    `- Tests: ${String(receipt.evidence.tests.passed)} passed, ${String(receipt.evidence.tests.failed)} failed, ${String(receipt.evidence.tests.total)} total`,
    `- Artifacts: ${String(receipt.evidence.artifacts.total)} total`,
    "",
    "Proof boundary:",
    receipt.proofBoundary,
  ];
  if (receipt.blockers.length > 0) {
    lines.push("", "Blockers:", ...receipt.blockers.map((blocker) => `- ${blocker}`));
  }
  if (receipt.limitations.length > 0) {
    lines.push("", "Limitations:", ...receipt.limitations.map((limitation) => `- ${limitation}`));
  }
  return `${lines.join("\n")}\n`;
}
