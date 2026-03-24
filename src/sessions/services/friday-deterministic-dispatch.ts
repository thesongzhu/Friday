/**
 * Deterministic Dispatch — Serves classified `sync_immediate` requests
 * without invoking the LLM agent.
 *
 * Each handler calls an existing snapshot getter or service method and
 * formats the result as a plain-text response string.
 *
 * @module sessions/services/friday-deterministic-dispatch
 */

import type { FridayAgentCapabilitiesSnapshot } from "../../agent/tools/friday-agent-capabilities-tool.js";
import type { FridayAgentTaskStatusSnapshot } from "../../agent/tools/friday-agent-task-status-tool.js";
import { formatFridayDaemonStatus } from "../../daemon/friday-daemon-runtime.js";
import type { FridayDaemonStatus } from "../../daemon/friday-daemon.types.js";
import type { FridayWorkflowApprovalService } from "../../workflows/services/friday-workflow-approval-service.types.js";
import type { FridayWorkflowExecutionService, FridayWorkflowRunEntity } from "#workflows";
import type { FridayExecutionClassification } from "./friday-execution-classifier.js";

// ─── Types ───

export interface FridayDeterministicDispatchResult {
  readonly handled: boolean;
  readonly response?: string;
}

export interface FridayDeterministicDispatchDeps {
  readonly capabilitySnapshotGetter?: (input: {
    readOnly: boolean;
  }) => Promise<FridayAgentCapabilitiesSnapshot> | FridayAgentCapabilitiesSnapshot;

  readonly taskStatusSnapshotGetter?: (input: {
    runId?: string;
    sessionKey?: string;
    readOnly: boolean;
  }) => Promise<FridayAgentTaskStatusSnapshot> | FridayAgentTaskStatusSnapshot;

  readonly getDaemonStatus?: () => FridayDaemonStatus;

  readonly listMcpServers?: () => ReadonlyArray<{ id: string; transport?: string }>;
  readonly approvalService?: FridayWorkflowApprovalService;
  readonly workflowExecutionService?: FridayWorkflowExecutionService;
}

export interface DispatchDeterministicInput {
  readonly classification: FridayExecutionClassification;
  readonly sessionKey?: string;
  readonly runId?: string;
  readonly actorId?: string;
}

// ─── Dispatch ───

export async function dispatchDeterministic(
  input: DispatchDeterministicInput,
  deps: FridayDeterministicDispatchDeps,
): Promise<FridayDeterministicDispatchResult> {
  const { handler } = input.classification;

  switch (handler) {
    case "capabilities":
      return handleCapabilities(deps);

    case "task_status":
      return handleTaskStatus(input, deps);

    case "daemon_status":
      return handleDaemonStatus(deps);

    case "mcp_list":
      return handleMcpList(deps);

    case "approval_decision":
      return handleApprovalDecision(input, deps);

    case "workflow_query":
      return handleWorkflowQuery(input, deps);

    default:
      return { handled: false };
  }
}

// ─── Handlers ───

async function handleCapabilities(
  deps: FridayDeterministicDispatchDeps,
): Promise<FridayDeterministicDispatchResult> {
  if (!deps.capabilitySnapshotGetter) {
    return { handled: false };
  }
  try {
    const snap = await deps.capabilitySnapshotGetter({ readOnly: false });
    const lines: string[] = ["Current capabilities:"];

    lines.push(`  Read-only mode: ${snap.readOnly ? "yes" : "no"}`);
    lines.push(`  Messaging: ${snap.messaging.enabled ? `enabled (${snap.messaging.kinds.join(", ")})` : "disabled"}`);
    lines.push(`  MCP: ${snap.mcp.enabled ? `enabled (${String(snap.mcp.serverCount)} server(s))` : "disabled"}`);
    lines.push(`  Provider: ${snap.provider.available ? `available (${String(snap.provider.configuredCount)} configured)` : "not available"}`);
    if (snap.browser.activeMode) {
      lines.push(`  Browser: ${snap.browser.activeMode}${snap.browser.targetBrowser ? ` (${snap.browser.targetBrowser})` : ""}`);
    }
    lines.push(`  System orchestration: ${snap.system.enabled ? "enabled" : "disabled"}`);
    lines.push(`  Desktop companion: ${snap.desktop.connected ? "connected" : "disconnected"}`);

    return { handled: true, response: lines.join("\n") };
  } catch {
    return { handled: false };
  }
}

async function handleTaskStatus(
  input: DispatchDeterministicInput,
  deps: FridayDeterministicDispatchDeps,
): Promise<FridayDeterministicDispatchResult> {
  if (!deps.taskStatusSnapshotGetter) {
    return { handled: false };
  }
  try {
    const snap = await deps.taskStatusSnapshotGetter({
      runId: input.runId,
      sessionKey: input.sessionKey,
      readOnly: false,
    });

    const lines: string[] = [];

    if (snap.terminalOutcome) {
      lines.push(`Task ${snap.terminalOutcome.status}${snap.terminalOutcome.summary ? `: ${snap.terminalOutcome.summary}` : ""}`);
      if (snap.terminalOutcome.responseText) {
        lines.push(snap.terminalOutcome.responseText);
      }
    } else if (snap.runStatus) {
      lines.push(`Task status: ${snap.runStatus}${snap.phase ? ` (${snap.phase})` : ""}`);
      if (snap.task) {
        lines.push(`Task: ${snap.task}`);
      }
      if (snap.latestTool) {
        lines.push(`Latest tool: ${snap.latestTool}`);
      }
      if (typeof snap.elapsedMs === "number") {
        lines.push(`Elapsed: ${String(Math.round(snap.elapsedMs / 1000))}s`);
      }
      if (snap.blockers.length > 0) {
        lines.push(`Blockers: ${snap.blockers.join(", ")}`);
      }
      if (snap.activeSubagents.length > 0) {
        lines.push(`Active subagents: ${String(snap.activeSubagents.length)}`);
      }
    } else {
      lines.push("No active task at this time.");
    }

    return { handled: true, response: lines.join("\n") };
  } catch {
    return { handled: false };
  }
}

function handleDaemonStatus(
  deps: FridayDeterministicDispatchDeps,
): FridayDeterministicDispatchResult {
  if (!deps.getDaemonStatus) {
    return { handled: false };
  }
  return { handled: true, response: formatFridayDaemonStatus(deps.getDaemonStatus()) };
}

function handleMcpList(
  deps: FridayDeterministicDispatchDeps,
): FridayDeterministicDispatchResult {
  if (!deps.listMcpServers) {
    return { handled: false };
  }

  const servers = deps.listMcpServers();
  if (servers.length === 0) {
    return { handled: true, response: "No MCP servers configured." };
  }

  const lines = [`${String(servers.length)} MCP server(s) configured:`];
  for (const server of servers) {
    lines.push(`  - ${server.id}${server.transport ? ` (${server.transport})` : ""}`);
  }
  return { handled: true, response: lines.join("\n") };
}

async function handleApprovalDecision(
  input: DispatchDeterministicInput,
  deps: FridayDeterministicDispatchDeps,
): Promise<FridayDeterministicDispatchResult> {
  const decision = input.classification.extractedParams?.decision;
  if (!decision || !deps.approvalService) {
    return { handled: false };
  }

  const actorId = input.actorId ?? "system";
  const explicitApprovalId = input.classification.extractedParams?.approvalId;

  if (explicitApprovalId) {
    return executeApprovalDecision({
      approvalId: explicitApprovalId,
      decision,
      actorId,
      approvalService: deps.approvalService,
    });
  }

  const pending = deps.approvalService.listPending({});
  if (pending.length === 0) {
    return { handled: true, response: "No pending approvals at this time." };
  }
  if (pending.length > 1) {
    const lines = [
      `Multiple pending approvals require clarification before ${decision}:`,
    ];
    for (const approval of pending) {
      lines.push(`  - ${approval.id} (run ${approval.runId}, node ${approval.nodeId})`);
    }
    return { handled: true, response: lines.join("\n") };
  }

  return executeApprovalDecision({
    approvalId: pending[0]!.id,
    decision,
    actorId,
    approvalService: deps.approvalService,
  });
}

async function executeApprovalDecision(input: {
  approvalId: string;
  decision: "approve" | "reject";
  actorId: string;
  approvalService: FridayWorkflowApprovalService;
}): Promise<FridayDeterministicDispatchResult> {
  try {
    const result = input.decision === "approve"
      ? await input.approvalService.approve({
          approvalId: input.approvalId,
          decidedByUserId: input.actorId,
          comment: undefined,
        })
      : await input.approvalService.reject({
          approvalId: input.approvalId,
          decidedByUserId: input.actorId,
          comment: undefined,
        });
    const action = input.decision === "approve" ? "Approved" : "Rejected";
    return {
      handled: true,
      response: `${action} approval ${result.approval.id} for workflow run ${result.approval.runId}. Resumed: ${result.resumed ? "yes" : "no"}.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      handled: true,
      response: `Unable to ${input.decision} approval ${input.approvalId}: ${message}`,
    };
  }
}

function handleWorkflowQuery(
  input: DispatchDeterministicInput,
  deps: FridayDeterministicDispatchDeps,
): FridayDeterministicDispatchResult {
  if (!deps.workflowExecutionService) {
    return { handled: false };
  }

  const explicitRunId = input.classification.extractedParams?.runId;
  if (explicitRunId) {
    const run = deps.workflowExecutionService.getRun(explicitRunId);
    if (!run) {
      return { handled: true, response: `Workflow run ${explicitRunId} not found.` };
    }
    return { handled: true, response: formatWorkflowRunDetail(run) };
  }

  const activeRuns = deps.workflowExecutionService.listActiveRuns(10);
  if (activeRuns.length === 0) {
    return { handled: true, response: "No active workflow runs." };
  }

  const lines = [`${String(activeRuns.length)} active workflow run(s):`];
  for (const run of activeRuns) {
    lines.push(`  - ${run.id} (${run.status}) workflow ${run.workflowId}`);
  }
  return { handled: true, response: lines.join("\n") };
}

function formatWorkflowRunDetail(run: FridayWorkflowRunEntity): string {
  const lines = [
    `Workflow run ${run.id}: ${run.status}`,
    `Workflow: ${run.workflowId}`,
    `Started: ${run.startedAt}`,
  ];
  if (run.finishedAt) {
    lines.push(`Finished: ${run.finishedAt}`);
  }
  if (run.failure) {
    lines.push(`Failure: ${run.failure.code} — ${run.failure.message}`);
  }
  return lines.join("\n");
}
