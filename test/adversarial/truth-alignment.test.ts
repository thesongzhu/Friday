import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createFridayAgentArtifactWriter,
  createFridayAgentEventEmitter,
  createFridayAgentFileTools,
  createFridayAgentRuntime,
} from "#agent";
import type { FridayAgentLlmClient, FridayAgentLlmStreamEvent } from "#agent";
import type { CreateFridayAgentRuntimeDeps } from "#agent";
import { createTestDb, createTestIdGenerator } from "../unit/satellites/_helpers/create-test-db.helper.js";
import {
  PROMOTED_BENCHMARK_STRONG_REGRESSION_CASE_IDS,
} from "../../scripts/benchmark/friday-openclaw-promoted-gap-cases.mjs";

const [DOING_CONTINUE_WITH_BLOCKER_CASE_ID] = PROMOTED_BENCHMARK_STRONG_REGRESSION_CASE_IDS;
const NOW = "2026-03-24T18:00:00.000Z";
const CANONICAL_APPROVAL_SECRET = "test-canonical-key"; // pragma: allowlist secret

type ToolApprovalResolver = NonNullable<CreateFridayAgentRuntimeDeps["toolApprovalResolver"]>;

interface TestApprovalDecision {
  readonly toolName: string;
  readonly path: string | null;
  readonly approved: boolean;
}

function createMockLlmClient(
  events: FridayAgentLlmStreamEvent[][],
): FridayAgentLlmClient {
  let callIndex = 0;
  return {
    async *stream() {
      const batch = events[callIndex] ?? [];
      callIndex += 1;
      for (const event of batch) {
        yield event;
      }
    },
  };
}

function createWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "friday-struct-truth-"));
}

function createCanonicalArtifactApprovalResolver(
  approvedArtifactPaths: readonly string[],
): { resolver: ToolApprovalResolver; decisions: TestApprovalDecision[] } {
  const approvedPaths = new Set(approvedArtifactPaths.map((filePath) => path.resolve(filePath)));
  const decisions: TestApprovalDecision[] = [];
  const resolver: ToolApprovalResolver = async (prompt) => {
    const filePath = typeof prompt.params.path === "string"
      ? path.resolve(prompt.params.path)
      : null;
    const approved = (
      (prompt.toolName === "write" || prompt.toolName === "edit")
      && filePath !== null
      && approvedPaths.has(filePath)
    );
    decisions.push({ toolName: prompt.toolName, path: filePath, approved });
    if (approved) {
      return { approved: true, decidedByPrincipalId: "test-artifact-approver" };
    }
    return {
      approved: false,
      reason: "Test resolver denies mutations outside approved proof artifacts.",
    };
  };
  return { resolver, decisions };
}

describe("Structural truth alignment adversarial coverage", () => {
  // STRUCT-BENCHMARK-GAP-doing-continue-with-blocker
  it(`STRUCT-ARTIFACT-TRUTH-001 STRUCT-BENCHMARK-GAP-${DOING_CONTINUE_WITH_BLOCKER_CASE_ID} retries until blocker evidence is written`, async () => {
    const workspaceRoot = createWorkspace();
    const db = createTestDb();
    try {
      const mainPath = path.join(workspaceRoot, "main.txt");
      const referencePath = path.join(workspaceRoot, "reference.txt");
      const resultPath = path.join(workspaceRoot, "result.md");
      fs.writeFileSync(mainPath, "Friday needs a cleaner benchmark harness.\n", "utf8");
      const { resolver: toolApprovalResolver, decisions } = createCanonicalArtifactApprovalResolver([
        resultPath,
      ]);

      const llmClient = createMockLlmClient([
        [
          { type: "tool_use", id: "read-main", name: "read", input: { path: mainPath } },
          { type: "message_end", stopReason: "tool_use", inputTokens: 12, outputTokens: 6 },
        ],
        [
          {
            type: "tool_use",
            id: "write-result",
            name: "write",
            input: { path: resultPath, content: "Friday needs a cleaner benchmark harness.\n" },
          },
          { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 6 },
        ],
        [
          { type: "text_delta", text: "I created result.md and recorded the blocker." },
          { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 5 },
        ],
        [
          {
            type: "tool_use",
            id: "edit-result",
            name: "edit",
            input: {
              path: resultPath,
              oldText: "Friday needs a cleaner benchmark harness.",
              newText: [
                "Friday needs a cleaner benchmark harness.",
                "",
                "## Blocker",
                `${referencePath} is missing, so I continued with ${mainPath}.`,
                "",
              ].join("\n"),
            },
          },
          { type: "message_end", stopReason: "tool_use", inputTokens: 11, outputTokens: 8 },
        ],
        [
          {
            type: "text_delta",
            text: `I created result.md using main.txt and added a blocker section noting that ${referencePath} is missing.`,
          },
          { type: "message_end", stopReason: "end_turn", inputTokens: 7, outputTokens: 6 },
        ],
      ]);

      const runtime = createFridayAgentRuntime({
        allowTestOnlyAgentRunExecution: true,
        db,
        llmClient,
        model: "test-model",
        providerId: "test-provider",
        systemPrompt: "You are a test agent.",
        tools: createFridayAgentFileTools({ workspaceRoot }),
        eventEmitter: createFridayAgentEventEmitter(),
        idGenerator: createTestIdGenerator(),
        nowIso: () => NOW,
        canonicalMutatingActionGate: true,
        canonicalApprovalSecret: CANONICAL_APPROVAL_SECRET,
        toolApprovalResolver,
        artifactWriter: createFridayAgentArtifactWriter(workspaceRoot),
        workdir: workspaceRoot,
      });

      const result = await runtime.executeRun({
        task: [
          `Work only inside this sandbox: ${workspaceRoot}`,
          `Create ${resultPath} using ${mainPath}.`,
          `If ${referencePath} is missing, continue with ${mainPath} and explicitly record the blocker in ${resultPath}.`,
        ].join("\n"),
      });

      const written = fs.readFileSync(resultPath, "utf8");
      expect(result.status).toBe("completed");
      expect(result.toolCallCount).toBe(3);
      expect(decisions.map((decision) => ({
        toolName: decision.toolName,
        path: decision.path,
        approved: decision.approved,
      }))).toEqual([
        { toolName: "write", path: path.resolve(resultPath), approved: true },
        { toolName: "edit", path: path.resolve(resultPath), approved: true },
      ]);
      expect(written).toContain("cleaner benchmark harness");
      expect(written).toContain("## Blocker");
      expect(written).toContain(referencePath);
      expect(result.response).toContain("blocker section");
      expect(result.response).toContain("missing");
    } finally {
      db.close();
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("STRUCT-ARTIFACT-TRUTH-002 corrects a completion claim when the required artifact lacks source-backed content", async () => {
    const workspaceRoot = createWorkspace();
    const db = createTestDb();
    try {
      const mainPath = path.join(workspaceRoot, "main.txt");
      const resultPath = path.join(workspaceRoot, "result.md");
      fs.writeFileSync(mainPath, "Friday needs a cleaner benchmark harness.\n", "utf8");
      const { resolver: toolApprovalResolver, decisions } = createCanonicalArtifactApprovalResolver([
        resultPath,
      ]);

      const llmClient = createMockLlmClient([
        [
          {
            type: "tool_use",
            id: "write-result",
            name: "write",
            input: { path: resultPath, content: "Done.\n" },
          },
          { type: "message_end", stopReason: "tool_use", inputTokens: 9, outputTokens: 6 },
        ],
        [
          { type: "text_delta", text: "I created result.md using main.txt." },
          { type: "message_end", stopReason: "end_turn", inputTokens: 7, outputTokens: 5 },
        ],
        [
          {
            type: "tool_use",
            id: "fix-result",
            name: "edit",
            input: {
              path: resultPath,
              oldText: "Done.",
              newText: "Friday needs a cleaner benchmark harness.\n",
            },
          },
          { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 7 },
        ],
        [
          { type: "text_delta", text: "I created result.md using main.txt." },
          { type: "message_end", stopReason: "end_turn", inputTokens: 6, outputTokens: 5 },
        ],
      ]);

      const runtime = createFridayAgentRuntime({
        allowTestOnlyAgentRunExecution: true,
        db,
        llmClient,
        model: "test-model",
        providerId: "test-provider",
        systemPrompt: "You are a test agent.",
        tools: createFridayAgentFileTools({ workspaceRoot }),
        eventEmitter: createFridayAgentEventEmitter(),
        idGenerator: createTestIdGenerator(),
        nowIso: () => NOW,
        canonicalMutatingActionGate: true,
        canonicalApprovalSecret: CANONICAL_APPROVAL_SECRET,
        toolApprovalResolver,
        artifactWriter: createFridayAgentArtifactWriter(workspaceRoot),
        workdir: workspaceRoot,
      });

      const result = await runtime.executeRun({
        task: [
          `Work only inside this sandbox: ${workspaceRoot}`,
          `Create ${resultPath} using ${mainPath}.`,
        ].join("\n"),
      });

      expect(result.status).toBe("completed");
      expect(decisions.map((decision) => ({
        toolName: decision.toolName,
        path: decision.path,
        approved: decision.approved,
      }))).toEqual([
        { toolName: "write", path: path.resolve(resultPath), approved: true },
        { toolName: "edit", path: path.resolve(resultPath), approved: true },
      ]);
      expect(fs.readFileSync(resultPath, "utf8")).toContain("cleaner benchmark harness");
      expect(result.response).toContain("created result.md");
    } finally {
      db.close();
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
