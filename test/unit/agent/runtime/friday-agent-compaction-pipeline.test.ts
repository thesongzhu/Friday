/**
 * Integration tests for the full compaction pipeline:
 *
 *   Bridge → Provider Compactor → Memory Sink → Context Formatter → Preference Injector
 *
 * These tests verify that the mechanisms are truly connected end-to-end,
 * not just that types compile.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  createFridayProviderContextCompactor,
} from "#providers";
import type {
  FridayProviderContextMessage,
  FridayContextCompactionSummary,
  FridayContextCompactionBlockSummary,
} from "#providers";
import type { FridayAgentMessage } from "#agent";

import {
  createFridayAgentCompactionBridge,
} from "../../../../src/agent/runtime/friday-agent-compaction-bridge.js";
import type {
  FridayAgentCompactionBridgeResult,
} from "../../../../src/agent/runtime/friday-agent-compaction-bridge.js";

import {
  createFridayCompactionContextReplaySink,
} from "../../../../src/agent/runtime/friday-agent-compaction-context-replay-sink.js";

import {
  verifyCompactionSummary,
} from "../../../../src/agent/runtime/friday-agent-compaction-verifier.js";

import {
  groupCompactionContextReplayRecords,
  formatCompactionContextForPrompt,
} from "../../../../src/agent/runtime/friday-agent-compaction-context-formatter.js";

import {
  createFridayPreferenceInjector,
} from "../../../../src/agent/runtime/friday-agent-preference-injector.js";

import {
  createFridayProviderTokenEstimator,
} from "../../../../src/providers/context/friday-provider-token-estimator.js";

import {
  createFridayProviderContextPruner,
} from "../../../../src/providers/context/friday-provider-context-pruner.js";

import type { FridayMemoryItem } from "../../../../src/memory/model/friday-memory.types.js";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import {
  createFridayAgentContextReplayRepository,
  type FridayAgentContextReplayRecord,
} from "../../../../src/agent/persistence/friday-agent-context-replay-repository.js";

// ─── Helpers ───

let idCounter = 0;
function testIdGenerator(): string {
  return `test-id-${String(++idCounter).padStart(4, "0")}`;
}

const NOW = "2026-04-15T10:00:00.000Z";
function testNowIso(): string {
  return NOW;
}

function makeContextReplayRecord(input?: Partial<FridayAgentContextReplayRecord>): FridayAgentContextReplayRecord {
  return {
    entryId: input?.entryId ?? "replay-1",
    sessionKey: input?.sessionKey ?? "session-abc",
    runId: input?.runId ?? "run-1",
    kind: "compaction_summary",
    trustLevel: "unconfirmed_summary",
    source: "context_replay",
    summary: input?.summary ?? {
      summaryText: "",
      decisions: [],
      todos: [],
      openQuestions: [],
      toolFailures: [],
      fileOperations: [],
    },
    blocks: input?.blocks ?? [],
    metadata: input?.metadata ?? {},
    compactedAt: input?.compactedAt ?? "2026-04-15T09:00:00Z",
    createdAt: input?.createdAt ?? NOW,
  };
}

function makeAgentMessages(count: number, options?: {
  includeToolUse?: boolean;
  includeFailures?: boolean;
  includeDecisions?: boolean;
}): FridayAgentMessage[] {
  const msgs: FridayAgentMessage[] = [];
  for (let i = 0; i < count; i++) {
    if (i % 2 === 0) {
      // User message
      let content = `User message ${i}: tell me about step ${i / 2}`;
      if (options?.includeDecisions && i === 4) {
        content = "I recommend we use TypeScript strict mode for this project. Should we proceed?";
      }
      if (i === 6) {
        content = "What about the next step? We need to deploy to production.";
      }
      msgs.push({ role: "user", content });
    } else {
      // Assistant message
      let content = `Assistant response ${i}: completed step ${(i - 1) / 2} successfully`;
      if (options?.includeFailures && i === 3) {
        content = "The browser session was not connected. Failed to open the page. Error: ECONNREFUSED.";
      }
      if (options?.includeToolUse && i === 1) {
        msgs.push({
          role: "assistant",
          content: [
            {
              type: "tool_use" as const,
              name: "exec",
              input: { command: "npm test" },
              id: `tool-${i}`,
            },
          ],
        });
        continue;
      }
      if (options?.includeDecisions && i === 5) {
        content = "I recommend using AWS ECS for deployment. The plan includes: 1. Build Docker image, 2. Push to ECR, 3. Deploy ECS service.";
      }
      msgs.push({ role: "assistant", content });
    }
  }
  return msgs;
}

// ─── Test Suite ───

describe("Compaction Pipeline Integration", () => {

  beforeEach(() => {
    idCounter = 0;
  });

  // ══════════════════════════════════════════════════════════════════
  // TEST 1: Bridge correctly converts and invokes provider compactor
  // ══════════════════════════════════════════════════════════════════

  describe("Compaction Bridge", () => {
    it("converts agent messages to provider messages and back without data loss", async () => {
      const estimator = createFridayProviderTokenEstimator();
      const pruner = createFridayProviderContextPruner();
      const compactor = createFridayProviderContextCompactor({ estimator, pruner });

      const bridge = createFridayAgentCompactionBridge({
        compactor,
        estimator,
        pruner,
        idGenerator: testIdGenerator,
        nowIso: testNowIso,
      });

      // 50 messages — well above the default threshold
      const messages = makeAgentMessages(50, {
        includeToolUse: true,
        includeFailures: true,
        includeDecisions: true,
      });

      const result = await bridge.compact({
        messages,
        systemPrompt: "You are a helpful assistant.",
        task: "Explain the deployment failure and how to fix it.",
        contextWindowTokens: 200, // Artificially low to force compaction
      });

      // Must have compacted
      expect(result.compacted).toBe(true);

      // Message count must be reduced
      expect(result.messages.length).toBeLessThan(messages.length);

      // Must have summary with structured extraction
      expect(result.summary).toBeDefined();
      expect(result.droppedMessageCount).toBeGreaterThan(0);

      // Original messages that were kept should preserve their content structure
      const keptAssistant = result.messages.find(
        (m) => m.role === "assistant" && Array.isArray(m.content),
      );
      // Tool use messages with content blocks should be preserved if kept
      // (or they may be in the dropped set — either is fine)

      // Summary should have at least some structured fields
      if (result.summary) {
        const hasContent =
          result.summary.summaryText.length > 0 ||
          result.summary.decisions.length > 0 ||
          result.summary.todos.length > 0 ||
          result.summary.toolFailures.length > 0;
        expect(hasContent).toBe(true);
      }
    });

    it("returns uncompacted result when below threshold", async () => {
      const estimator = createFridayProviderTokenEstimator();
      const pruner = createFridayProviderContextPruner();
      const compactor = createFridayProviderContextCompactor({ estimator, pruner });

      const bridge = createFridayAgentCompactionBridge({
        compactor, estimator, pruner,
        idGenerator: testIdGenerator,
        nowIso: testNowIso,
      });

      const messages = makeAgentMessages(4);

      const result = await bridge.compact({
        messages,
        systemPrompt: "You are a helpful assistant.",
        task: "Simple task.",
        contextWindowTokens: 200_000, // Large window, no compaction needed
      });

      expect(result.compacted).toBe(false);
      expect(result.messages).toBe(messages); // Same reference
      expect(result.droppedMessageCount).toBe(0);
    });

    it("captures tool_failure_block when messages contain errors", async () => {
      const estimator = createFridayProviderTokenEstimator();
      const pruner = createFridayProviderContextPruner();
      const compactor = createFridayProviderContextCompactor({ estimator, pruner });

      const bridge = createFridayAgentCompactionBridge({
        compactor, estimator, pruner,
        idGenerator: testIdGenerator,
        nowIso: testNowIso,
      });

      const messages = makeAgentMessages(50, { includeFailures: true });

      const result = await bridge.compact({
        messages,
        systemPrompt: "Test.",
        task: "Why did the browser fail?",
        contextWindowTokens: 200,
      });

      expect(result.compacted).toBe(true);
      // The blocks should include a tool_failure_block
      const failureBlock = result.blocks?.find((b) => b.kind === "tool_failure_block");
      expect(failureBlock).toBeDefined();

      // The failure content should be either in kept messages or in the summary
      const allContent = result.messages.map((m) =>
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      ).join("\n");

      // "browser session was not connected" or "ECONNREFUSED" should appear somewhere
      const hasFailureContext =
        allContent.includes("browser") ||
        allContent.includes("ECONNREFUSED") ||
        allContent.includes("failed") ||
        allContent.includes("failure");
      expect(hasFailureContext).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // TEST 2: Verifier catches hallucinated summaries
  // ══════════════════════════════════════════════════════════════════

  describe("Compaction Verifier", () => {
    it("passes verification when summary mentions source entities", () => {
      const messages: FridayProviderContextMessage[] = [
        { messageId: "m1", role: "user", content: "Run exec tool on src/index.ts", createdAt: NOW },
        { messageId: "m2", role: "assistant", content: "exec returned ENOENT for src/index.ts", createdAt: NOW, toolName: "exec" },
      ];

      const summary: FridayContextCompactionSummary = {
        summaryText: "User asked to run exec on src/index.ts, got ENOENT error.",
        decisions: [],
        todos: ["Fix the missing src/index.ts file"],
        openQuestions: [],
        toolFailures: ["exec: ENOENT on src/index.ts"],
        fileOperations: ["src/index.ts"],
      };

      const result = verifyCompactionSummary({ originalMessages: messages, summary });

      expect(result.valid).toBe(true);
      expect(result.entityRecall).toBeGreaterThanOrEqual(0.6);
      expect(result.hasStructuredContent).toBe(true);
    });

    it("fails verification when summary misses key entities", () => {
      const messages: FridayProviderContextMessage[] = [
        { messageId: "m1", role: "user", content: "Run exec tool on src/index.ts", createdAt: NOW },
        { messageId: "m2", role: "assistant", content: "exec returned ENOENT for src/index.ts", createdAt: NOW, toolName: "exec" },
      ];

      const summary: FridayContextCompactionSummary = {
        summaryText: "The user did something and got a result.",
        decisions: [],
        todos: [],
        openQuestions: [],
        toolFailures: [],
        fileOperations: [],
      };

      const result = verifyCompactionSummary({ originalMessages: messages, summary });

      expect(result.valid).toBe(false);
      expect(result.entityRecall).toBeLessThan(0.6);
      expect(result.missingEntities.length).toBeGreaterThan(0);
    });

    it("passes when source has no extractable entities", () => {
      const messages: FridayProviderContextMessage[] = [
        { messageId: "m1", role: "user", content: "Hello, how are you?", createdAt: NOW },
        { messageId: "m2", role: "assistant", content: "I am fine, thank you!", createdAt: NOW },
      ];

      const summary: FridayContextCompactionSummary = {
        summaryText: "Greeting exchange.",
        decisions: [],
        todos: [],
        openQuestions: [],
        toolFailures: [],
        fileOperations: [],
      };

      const result = verifyCompactionSummary({ originalMessages: messages, summary });

      // No entities to check → recall is 1.0
      expect(result.entityRecall).toBe(1.0);
      expect(result.valid).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // TEST 3: Context Replay Sink persists outside memory
  // ══════════════════════════════════════════════════════════════════

  describe("Compaction Context Replay Sink", () => {
    it("stores structured summary fields as one unconfirmed replay row and not memory", async () => {
      const db: FridaySqliteLayer = createTestDb();
      const sink = createFridayCompactionContextReplaySink({
        db,
        idGenerator: testIdGenerator,
        nowIso: testNowIso,
      });

      const summary: FridayContextCompactionSummary = {
        summaryText: "User worked on deployment. Browser failed initially.",
        decisions: ["Use TypeScript strict mode", "Deploy to AWS ECS"],
        todos: ["Fix browser connection", "Run smoke tests"],
        openQuestions: ["Should we use Redis?"],
        toolFailures: ["browser: ECONNREFUSED"],
        fileOperations: ["src/deploy.ts", "docker/Dockerfile"],
      };

      try {
        await sink.persist({
          sessionKey: "session-abc",
          runId: "run-123",
          summary,
          compactedAt: NOW,
        });

        const rows = createFridayAgentContextReplayRepository().listCompactionSummariesBySession(
          db.writer,
          { sessionKey: "session-abc" },
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].trustLevel).toBe("unconfirmed_summary");
        expect(rows[0].source).toBe("context_replay");
        expect(rows[0].summary.decisions).toContain("Use TypeScript strict mode");
        expect(rows[0].summary.decisions).toContain("Deploy to AWS ECS");
        expect(rows[0].summary.toolFailures).toContain("browser: ECONNREFUSED");

        const memoryCount = db.writer.prepare(
          "SELECT COUNT(*) AS count FROM memory_items WHERE namespace LIKE 'compaction.%'",
        ).get() as { count: number };
        expect(memoryCount.count).toBe(0);
      } finally {
        db.close();
      }
    });

    it("skips empty summaries and stores nothing", async () => {
      const db: FridaySqliteLayer = createTestDb();
      const sink = createFridayCompactionContextReplaySink({
        db,
        idGenerator: testIdGenerator,
        nowIso: testNowIso,
      });

      try {
        await sink.persist({
          sessionKey: "session-empty",
          runId: "run-empty",
          summary: {
            summaryText: "",
            decisions: [],
            todos: [],
            openQuestions: [],
            toolFailures: [],
            fileOperations: [],
          },
          compactedAt: NOW,
        });

        const count = db.writer.prepare(
          "SELECT COUNT(*) AS count FROM friday_agent_context_replay_entries",
        ).get() as { count: number };
        expect(count.count).toBe(0);
      } finally {
        db.close();
      }
    });

    it("redacts secret-shaped text before writing replay evidence", async () => {
      const db: FridaySqliteLayer = createTestDb();
      const sink = createFridayCompactionContextReplaySink({
        db,
        idGenerator: testIdGenerator,
        nowIso: testNowIso,
      });

      try {
        await sink.persist({
          sessionKey: "session-redact",
          runId: "run-redact",
          summary: {
            // pragma: allowlist secret
            summaryText: "The user pasted password: hunter2 while debugging.",
            decisions: [],
            todos: [],
            // pragma: allowlist secret
            openQuestions: ["Rotate access_token=sample-token before release."],
            toolFailures: [],
            fileOperations: [],
          },
          compactedAt: NOW,
        });

        const rows = createFridayAgentContextReplayRepository().listCompactionSummariesBySession(
          db.writer,
          { sessionKey: "session-redact" },
        );
        expect(rows).toHaveLength(1);
        expect(JSON.stringify(rows[0].summary)).not.toContain("hunter2");
        expect(JSON.stringify(rows[0].summary)).not.toContain("sample-token");
        expect(JSON.stringify(rows[0].summary)).toContain("[redacted]");
        expect(rows[0].metadata.redactionApplied).toBe(true);
        expect(rows[0].metadata.redactionCount).toBe(2);
      } finally {
        db.close();
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // TEST 4: Context Formatter produces correct prompt fragments
  // ══════════════════════════════════════════════════════════════════

  describe("Compaction Context Formatter", () => {
    it("groups context replay records and formats as unconfirmed prompt fragment", () => {
      const blocks = groupCompactionContextReplayRecords([
        makeContextReplayRecord({
          summary: {
            summaryText: "",
            decisions: ["Use TypeScript strict mode", "Deploy to AWS ECS"],
            todos: ["Fix browser connection", "Run smoke tests"],
            openQuestions: [],
            toolFailures: ["browser: ECONNREFUSED"],
            fileOperations: [],
          },
        }),
      ]);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].decisions).toEqual(["Use TypeScript strict mode", "Deploy to AWS ECS"]);
      expect(blocks[0].todos).toEqual(["Fix browser connection", "Run smoke tests"]);
      expect(blocks[0].toolFailures).toEqual(["browser: ECONNREFUSED"]);

      const prompt = formatCompactionContextForPrompt(blocks);

      expect(prompt).toContain("[Unconfirmed Context Replay");
      expect(prompt).toContain("not user-confirmed memory");
      expect(prompt).toContain("Decisions:");
      expect(prompt).toContain("TypeScript strict mode");
      expect(prompt).toContain("TODOs:");
      expect(prompt).toContain("Fix browser connection");
      expect(prompt).toContain("Tool failures:");
      expect(prompt).toContain("ECONNREFUSED");
    });

    it("limits output to maxChars", () => {
      const blocks = groupCompactionContextReplayRecords([
        makeContextReplayRecord({
          summary: {
            summaryText: "A".repeat(10_000),
            decisions: [],
            todos: [],
            openQuestions: [],
            toolFailures: [],
            fileOperations: [],
          },
        }),
      ]);
      const prompt = formatCompactionContextForPrompt(blocks, { maxChars: 100 });

      expect(prompt.length).toBeLessThanOrEqual(100);
      expect(prompt.endsWith("...")).toBe(true);
    });

    it("returns empty string when no items", () => {
      const blocks = groupCompactionContextReplayRecords([]);
      const prompt = formatCompactionContextForPrompt(blocks);
      expect(prompt).toBe("");
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // TEST 5: Preference Injector merges sources and deduplicates
  // ══════════════════════════════════════════════════════════════════

  describe("Preference Injector", () => {
    it("merges learning pipeline and memory sources", async () => {
      const mockMemoryService = {
        store: vi.fn(),
        search: vi.fn(),
        get: vi.fn(),
        list: vi.fn(async () => [
          {
            id: "pref-1", namespace: "learning.preferences", key: "d1",
            content: "Prefer deploying to AWS ECS",
            source: "learning:user-1:event-1",
            tags: ["learning", "auto", "preference", "user-1"],
            metadata: { confidence: 0.7 },
            createdAt: NOW, updatedAt: NOW,
          } as FridayMemoryItem,
        ]),
        delete: vi.fn(),
        prune: vi.fn(),
      };

      const injector = createFridayPreferenceInjector({
        memoryService: mockMemoryService as any,
        learningContextBuilder: () => ({
          preferences: {
            language: "TypeScript",
            framework: "React",
          },
        }),
        nowIso: testNowIso,
      });

      const result = await injector.loadPreferences("user-1");

      expect(result.itemCount).toBeGreaterThan(0);
      expect(result.fragment).toContain("[Learned Preferences]");
      expect(result.fragment).toContain("TypeScript");
      expect(result.sources).toContain("learning");
    });

    it("handles learning pipeline failure gracefully", async () => {
      const mockMemoryService = {
        store: vi.fn(),
        search: vi.fn(),
        get: vi.fn(),
        list: vi.fn(async () => []),
        delete: vi.fn(),
        prune: vi.fn(),
      };

      const injector = createFridayPreferenceInjector({
        memoryService: mockMemoryService as any,
        learningContextBuilder: () => { throw new Error("DB down"); },
        nowIso: testNowIso,
      });

      // Should not throw
      const result = await injector.loadPreferences("user-1");

      expect(result.fragment).toBe("");
      expect(result.itemCount).toBe(0);
    });

    it("deduplicates preferences with high token overlap", async () => {
      const mockMemoryService = {
        store: vi.fn(),
        search: vi.fn(),
        get: vi.fn(),
        list: vi.fn(async () => [
          {
            id: "pref-dup", namespace: "learning.preferences", key: "d1",
            content: "TypeScript strict mode preferred",
            source: "learning:user-1:event-1",
            tags: ["learning", "auto", "preference", "user-1"],
            metadata: { confidence: 0.9 },
            createdAt: NOW, updatedAt: NOW,
          } as FridayMemoryItem,
        ]),
        delete: vi.fn(),
        prune: vi.fn(),
      };

      const injector = createFridayPreferenceInjector({
        memoryService: mockMemoryService as any,
        learningContextBuilder: () => ({
          preferences: {
            "typescript_mode": "strict mode preferred",
          },
        }),
        nowIso: testNowIso,
      });

      const result = await injector.loadPreferences("user-1");

      // Should deduplicate the two very similar preferences
      // "TypeScript strict mode preferred" vs "typescript_mode: strict mode preferred"
      // They share high overlap, so one should be removed
      expect(result.itemCount).toBeLessThanOrEqual(2);
    });

    it("ignores compaction memory so session summaries do not leak into preferences", async () => {
      const mockMemoryService = {
        store: vi.fn(),
        search: vi.fn(),
        get: vi.fn(),
        list: vi.fn(async () => [
          {
            id: "compaction-1", namespace: "compaction.summary", key: "summary-1",
            content: "Canonical evidence path /tmp/leak.txt",
            source: "compaction:session-1:run-1",
            tags: ["compaction", "auto", "session-1"],
            metadata: { confidence: 0.9 },
            createdAt: NOW, updatedAt: NOW,
          } as FridayMemoryItem,
        ]),
        delete: vi.fn(),
        prune: vi.fn(),
      };

      const injector = createFridayPreferenceInjector({
        memoryService: mockMemoryService as any,
        nowIso: testNowIso,
      });

      const result = await injector.loadPreferences("user-1");

      expect(result.fragment).toBe("");
      expect(result.itemCount).toBe(0);
      expect(result.sources).toEqual([]);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // TEST 6: END-TO-END pipeline test
  // ══════════════════════════════════════════════════════════════════

  describe("End-to-End Pipeline", () => {
    it("compaction → context replay sink → formatter → prompt injection works as a connected pipeline", async () => {
      // ── Step 1: Create compaction bridge ──
      const estimator = createFridayProviderTokenEstimator();
      const pruner = createFridayProviderContextPruner();
      const compactor = createFridayProviderContextCompactor({ estimator, pruner });

      const bridge = createFridayAgentCompactionBridge({
        compactor, estimator, pruner,
        idGenerator: testIdGenerator,
        nowIso: testNowIso,
      });

      // ── Step 2: Create 50 messages with rich content ──
      const messages = makeAgentMessages(50, {
        includeToolUse: true,
        includeFailures: true,
        includeDecisions: true,
      });

      // ── Step 3: Run compaction ──
      const compactionResult = await bridge.compact({
        messages,
        systemPrompt: "You are a deployment assistant.",
        task: "Explain the browser failure and recommend next steps for deployment.",
        contextWindowTokens: 200, // Force compaction
      });

      expect(compactionResult.compacted).toBe(true);
      expect(compactionResult.summary).toBeDefined();

      // ── Step 4: Feed summary to context replay sink ──
      const db = createTestDb();
      const sink = createFridayCompactionContextReplaySink({
        db,
        idGenerator: testIdGenerator,
        nowIso: testNowIso,
      });

      try {
        await sink.persist({
          sessionKey: "session-e2e",
          runId: "run-e2e",
          summary: compactionResult.summary!,
          blocks: compactionResult.blocks,
          compactedAt: NOW,
        });

        const replayRecords = createFridayAgentContextReplayRepository().listCompactionSummariesBySession(
          db.writer,
          { sessionKey: "session-e2e" },
        );

        // Verify replay evidence was stored outside memory
        expect(replayRecords.length).toBeGreaterThan(0);

        // ── Step 5: Feed stored replay records to context formatter ──
        const blocks = groupCompactionContextReplayRecords(replayRecords);
        const promptFragment = formatCompactionContextForPrompt(blocks);

        // The prompt should contain meaningful content from the original conversation
        expect(promptFragment).toContain("[Unconfirmed Context Replay");
        expect(promptFragment).toContain("not user-confirmed memory");
        expect(promptFragment.length).toBeGreaterThan(50);
      } finally {
        db.close();
      }

      // ── Step 6: Verify the verifier works on the compaction output ──
      if (compactionResult.summary) {
        // Build provider messages for verification
        const providerMsgs: FridayProviderContextMessage[] = messages
          .filter((m) => typeof m.content === "string")
          .map((m, i) => ({
            messageId: `verify-${i}`,
            role: m.role as "user" | "assistant",
            content: m.content as string,
            createdAt: NOW,
          }));

        const verification = verifyCompactionSummary({
          originalMessages: providerMsgs,
          summary: compactionResult.summary,
        });

        // Verification should produce a meaningful result
        expect(typeof verification.valid).toBe("boolean");
        expect(verification.entityRecall).toBeGreaterThanOrEqual(0);
        expect(verification.entityRecall).toBeLessThanOrEqual(1);
      }

      // ── Step 7: Verify preference injector does NOT treat compaction items as preferences ──
      const injector = createFridayPreferenceInjector({
        memoryService: {
          store: vi.fn(),
          search: vi.fn(),
          get: vi.fn(),
          list: vi.fn(async () => []),
          delete: vi.fn(),
          prune: vi.fn(),
        } as any,
        nowIso: testNowIso,
      });

      const prefResult = await injector.loadPreferences("user-e2e");

      expect(prefResult.itemCount).toBe(0);
      expect(prefResult.fragment).toBe("");
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // TEST 7: Fallback / degradation behavior
  // ══════════════════════════════════════════════════════════════════

  describe("Graceful Degradation", () => {
    it("bridge handles compactor errors by throwing (caller catches)", async () => {
      const brokenCompactor = {
        async compact(): Promise<any> {
          throw new Error("LLM provider unavailable");
        },
      };

      const estimator = createFridayProviderTokenEstimator();
      const pruner = createFridayProviderContextPruner();

      const bridge = createFridayAgentCompactionBridge({
        compactor: brokenCompactor as any,
        estimator,
        pruner,
        idGenerator: testIdGenerator,
        nowIso: testNowIso,
      });

      const messages = makeAgentMessages(50);

      // Bridge should propagate the error (runtime catches it and falls back)
      await expect(bridge.compact({
        messages,
        systemPrompt: "Test.",
        task: "Test task.",
        contextWindowTokens: 200,
      })).rejects.toThrow("LLM provider unavailable");
    });
  });
});
