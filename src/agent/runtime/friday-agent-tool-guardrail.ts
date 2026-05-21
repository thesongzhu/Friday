import {
  FRIDAY_AGENT_TOOL_GUARDRAIL_SCHEMA_VERSION,
  type FridayAgentToolGuardrailRiskLevel,
  type FridayAgentToolPostGuardrailEvidence,
  type FridayAgentToolPreGuardrailEvidence,
} from "../model/friday-agent.types.js";
import { classifyShellRisk } from "./friday-agent-tool-risk.js";

const TOOL_GUARDRAIL_EVIDENCE_BOUNDARY = [
  "This guardrail receipt is local tool-execution audit evidence.",
  "It records deterministic pre/post checks and evidence pointers, not release proof.",
  "Release/default-on claims still require same-SHA Real Green Gate and applicable real proof.",
].join(" ");

function listInputKeys(input: Record<string, unknown>): string[] {
  return Object.keys(input)
    .filter((key) => key !== "canonicalApproval")
    .sort();
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function resolveGuardrailRisk(input: {
  toolName: string;
  toolInput: Record<string, unknown>;
  mutating: boolean;
  approvalRequiredReason?: string | null;
}): FridayAgentToolGuardrailRiskLevel {
  if (input.toolName === "exec" && typeof input.toolInput.command === "string") {
    const shellRisk = classifyShellRisk(input.toolInput.command).level;
    if (shellRisk === "blocked" || shellRisk === "destructive") return "critical";
    if (shellRisk === "guarded") return "medium";
  }
  if (input.approvalRequiredReason) return "high";
  if (input.mutating) return "medium";
  return "low";
}

export function buildFridayAgentToolPreGuardrailEvidence(input: {
  toolCallId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  mutating: boolean;
  readOnly: boolean;
  operationalMode?: "plan" | "execute" | "restricted";
  approvalRequiredReason?: string | null;
  decision: "allow" | "block" | "requires_approval";
  routeId: string;
  correlationId: string;
  checks?: string[];
}): FridayAgentToolPreGuardrailEvidence {
  const approvalRequired = Boolean(input.approvalRequiredReason);
  return {
    schemaVersion: FRIDAY_AGENT_TOOL_GUARDRAIL_SCHEMA_VERSION,
    phase: "pre",
    decision: input.decision,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    mutating: input.mutating,
    readOnly: input.readOnly,
    ...(input.operationalMode ? { operationalMode: input.operationalMode } : {}),
    approvalRequired,
    riskLevel: resolveGuardrailRisk(input),
    routeId: input.routeId,
    correlationId: input.correlationId,
    checks: unique([
      input.readOnly ? "readonly_constraint_checked" : "write_context_checked",
      input.mutating ? "mutation_classifier_mutating" : "mutation_classifier_readonly",
      approvalRequired ? "approval_gate_required" : "approval_gate_not_required",
      ...(input.checks ?? []),
    ]),
    inputKeys: listInputKeys(input.toolInput),
    evidenceBoundary: TOOL_GUARDRAIL_EVIDENCE_BOUNDARY,
  };
}

export function buildFridayAgentToolPostGuardrailEvidence(input: {
  toolCallId: string;
  toolName: string;
  durationMs: number;
  isError: boolean;
  routeId: string;
  correlationId: string;
  summary?: string;
  errorCode?: string;
  status?: "completed" | "failed" | "blocked";
}): FridayAgentToolPostGuardrailEvidence {
  return {
    schemaVersion: FRIDAY_AGENT_TOOL_GUARDRAIL_SCHEMA_VERSION,
    phase: "post",
    status: input.status ?? (input.isError ? "failed" : "completed"),
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    isError: input.isError,
    durationMs: input.durationMs,
    routeId: input.routeId,
    correlationId: input.correlationId,
    evidenceCaptured: true,
    outputPointerKind: "agent_tool_output_event",
    summaryAvailable: typeof input.summary === "string" && input.summary.length > 0,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    evidenceBoundary: TOOL_GUARDRAIL_EVIDENCE_BOUNDARY,
  };
}
