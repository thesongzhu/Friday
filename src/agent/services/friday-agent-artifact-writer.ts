// ─── Artifact writer: file-based sync, NO git operations ───

import * as fs from "node:fs";
import * as path from "node:path";

import type { FridayAgentArtifact, FridayAgentTestResult, FridayAgentToolCallRecord } from "../model/friday-agent.types.js";
import type { FridayAgentConversationContext } from "../runtime/friday-agent-runtime.types.js";

// ─── Types ───

export interface FridayAgentArtifactWriter {
  /**
   * Write run artifacts to `.friday/agent-runs/<runId>/`.
   * Idempotent — safe to call multiple times with same data.
   * Returns the artifact directory path and list of written artifacts.
   */
  writeRunArtifacts(params: FridayAgentArtifactWriterParams): FridayAgentArtifactWriterResult;
}

export interface FridayAgentArtifactWriterParams {
  runId: string;
  task: string;
  status: string;
  response: string;
  toolCalls: FridayAgentToolCallRecord[];
  testResults: FridayAgentTestResult[];
  artifacts: FridayAgentArtifact[];
  durationMs: number;
  usageInput: number;
  usageOutput: number;
  costUsd?: number;
  completedAt: string;
  conversationContext?: FridayAgentConversationContext;
}

export interface FridayAgentArtifactWriterResult {
  artifactDir: string;
  artifacts: FridayAgentArtifact[];
}

// ─── Factory ───

export function createFridayAgentArtifactWriter(
  workspaceRoot: string,
): FridayAgentArtifactWriter {
  return {
    writeRunArtifacts(params) {
      const runDir = path.join(workspaceRoot, ".friday", "agent-runs", params.runId);

      // Ensure directory exists
      fs.mkdirSync(runDir, { recursive: true });

      // 1. run.json — run metadata
      const runMeta = {
        runId: params.runId,
        task: params.task,
        status: params.status,
        durationMs: params.durationMs,
        usageInput: params.usageInput,
        usageOutput: params.usageOutput,
        costUsd: params.costUsd ?? null,
        completedAt: params.completedAt,
        contextSelection: params.conversationContext
          ? {
            turnKind: params.conversationContext.turnKind ?? null,
            ...(params.conversationContext.turnFrame
              ? { turnFrame: params.conversationContext.turnFrame }
              : {}),
            selectedBlocks: params.conversationContext.selectedBlocks ?? [],
            selectionReasons: params.conversationContext.selectionReasons ?? [],
            replyToMessageId: params.conversationContext.replyToMessageId ?? null,
          }
          : null,
      };
      fs.writeFileSync(
        path.join(runDir, "run.json"),
        JSON.stringify(runMeta, null, 2) + "\n",
        "utf-8",
      );

      // 2. tool-calls.json — tool call records
      fs.writeFileSync(
        path.join(runDir, "tool-calls.json"),
        JSON.stringify(params.toolCalls, null, 2) + "\n",
        "utf-8",
      );

      // 3. test-results.json — test results
      fs.writeFileSync(
        path.join(runDir, "test-results.json"),
        JSON.stringify(params.testResults, null, 2) + "\n",
        "utf-8",
      );

      // 4. response.md — final response text
      fs.writeFileSync(
        path.join(runDir, "response.md"),
        params.response + "\n",
        "utf-8",
      );

      // 5. artifacts.json — artifact list
      fs.writeFileSync(
        path.join(runDir, "artifacts.json"),
        JSON.stringify(params.artifacts, null, 2) + "\n",
        "utf-8",
      );

      // Build enriched artifacts list (include artifact dir reference)
      const enrichedArtifacts: FridayAgentArtifact[] = [
        ...params.artifacts,
        { type: "run_record", path: path.join(runDir, "run.json") },
      ];

      return {
        artifactDir: runDir,
        artifacts: enrichedArtifacts,
      };
    },
  };
}
