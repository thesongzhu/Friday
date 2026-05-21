// ─── Artifact writer: file-based sync, NO git operations ───

import * as fs from "node:fs";
import * as path from "node:path";

import type { FridayAgentArtifact, FridayAgentTestResult, FridayAgentToolCallRecord } from "../model/friday-agent.types.js";
import type { FridayAgentConversationContext } from "../runtime/friday-agent-runtime.types.js";
import {
  buildFridayAgentReplayableEvidenceReceipt,
  renderFridayAgentEvidenceReceiptMarkdown,
} from "./friday-agent-evidence-receipt.js";

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
      const runRecordPath = path.join(runDir, "run.json");
      const toolCallsPath = path.join(runDir, "tool-calls.json");
      const testResultsPath = path.join(runDir, "test-results.json");
      const responsePath = path.join(runDir, "response.md");
      const artifactsPath = path.join(runDir, "artifacts.json");
      const evidenceReceiptPath = path.join(runDir, "evidence-receipt.json");
      const evidenceReceiptMarkdownPath = path.join(runDir, "evidence-receipt.md");

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
        runRecordPath,
        JSON.stringify(runMeta, null, 2) + "\n",
        "utf-8",
      );

      // 2. tool-calls.json — tool call records
      fs.writeFileSync(
        toolCallsPath,
        JSON.stringify(params.toolCalls, null, 2) + "\n",
        "utf-8",
      );

      // 3. test-results.json — test results
      fs.writeFileSync(
        testResultsPath,
        JSON.stringify(params.testResults, null, 2) + "\n",
        "utf-8",
      );

      // 4. response.md — final response text
      fs.writeFileSync(
        responsePath,
        params.response + "\n",
        "utf-8",
      );

      // Build enriched artifacts list with replay receipt pointers.
      const enrichedArtifacts: FridayAgentArtifact[] = [
        ...params.artifacts,
        { type: "run_record", path: runRecordPath },
        { type: "evidence_receipt", path: evidenceReceiptPath },
        { type: "evidence_receipt_markdown", path: evidenceReceiptMarkdownPath },
      ];
      const evidenceReceipt = buildFridayAgentReplayableEvidenceReceipt({
        runId: params.runId,
        task: params.task,
        status: params.status,
        issuedAt: params.completedAt,
        completedAt: params.completedAt,
        durationMs: params.durationMs,
        usageInput: params.usageInput,
        usageOutput: params.usageOutput,
        costUsd: params.costUsd ?? null,
        artifactDir: runDir,
        toolCalls: params.toolCalls,
        testResults: params.testResults,
        artifacts: enrichedArtifacts,
      });

      // 5. evidence-receipt.json and .md - user-visible replay receipt
      fs.writeFileSync(
        evidenceReceiptPath,
        JSON.stringify(evidenceReceipt, null, 2) + "\n",
        "utf-8",
      );
      fs.writeFileSync(
        evidenceReceiptMarkdownPath,
        renderFridayAgentEvidenceReceiptMarkdown(evidenceReceipt),
        "utf-8",
      );

      // 6. artifacts.json - enriched artifact list
      fs.writeFileSync(
        artifactsPath,
        JSON.stringify(enrichedArtifacts, null, 2) + "\n",
        "utf-8",
      );

      return {
        artifactDir: runDir,
        artifacts: enrichedArtifacts,
      };
    },
  };
}
