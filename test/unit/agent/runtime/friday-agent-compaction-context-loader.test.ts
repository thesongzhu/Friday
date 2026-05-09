import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridayCompactionContextLoader } from "../../../../src/agent/runtime/friday-agent-compaction-context-loader.js";
import { createFridayAgentContextReplayRepository } from "../../../../src/agent/persistence/friday-agent-context-replay-repository.js";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

const NOW = "2026-04-16T19:00:00.000Z";

describe("FridayCompactionContextLoader", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("returns only context replay blocks for the current session", async () => {
    const repo = createFridayAgentContextReplayRepository();
    db.withWriteTransaction((writer) => {
      repo.appendCompactionSummary(writer, {
        entryId: "replay-1",
        sessionKey: "session-a",
        runId: "run-1",
        summary: {
          summaryText: "User already validated Discord routing.",
          decisions: [],
          todos: ["Re-run self-healing after config patch."],
          openQuestions: [],
          toolFailures: [],
          fileOperations: [],
        },
        metadata: {
          evidenceTier: "audit_replay_evidence",
          trustLevel: "unconfirmed_summary",
          redactionApplied: true,
          redactionCount: 2,
        },
        compactedAt: NOW,
        createdAt: NOW,
      });
      repo.appendCompactionSummary(writer, {
        entryId: "replay-2",
        sessionKey: "session-b",
        runId: "run-2",
        summary: {
          summaryText: "This belongs to another session.",
          decisions: [],
          todos: [],
          openQuestions: [],
          toolFailures: [],
          fileOperations: [],
        },
        compactedAt: NOW,
        createdAt: NOW,
      });
    });
    const loader = createFridayCompactionContextLoader({ db, repository: repo });

    const result = await loader.loadContext({ sessionKey: "session-a" });

    expect(result.blockCount).toBe(1);
    expect(result.fragment).toContain("Discord routing");
    expect(result.fragment).toContain("self-healing");
    expect(result.fragment).not.toContain("another session");
    expect(result.fragment).toContain("[Unconfirmed Context Replay");
    expect(result.fragment).toContain("not user-confirmed memory");
    expect(result.sources).toEqual(["context_replay:replay-1"]);
    expect(result.evidenceTier).toBe("audit_replay_evidence");
    expect(result.trustLevel).toBe("unconfirmed_summary");
    expect(result.source).toBe("context_replay");
    expect(result.memoryBoundary).toBe("not_user_confirmed_memory");
    expect(result.redactionApplied).toBe(true);
    expect(result.redactionCount).toBe(2);
    expect(result.replayEntryIds).toEqual(["replay-1"]);
  });

  it("returns an empty fragment when sessionKey is missing", async () => {
    const loader = createFridayCompactionContextLoader({ db });

    const result = await loader.loadContext({});

    expect(result.fragment).toBe("");
    expect(result.blockCount).toBe(0);
  });
});
