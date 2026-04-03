import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, createTestIdGenerator } from "../../../helpers/friday-test-db.helper.js";
import { createFridayEpisodeExtractor } from "../../../../src/memory/services/friday-episode-extractor.js";
import type { FridaySqliteLayer } from "#state";

describe("FridayEpisodeExtractor", () => {
  let db: FridaySqliteLayer;
  let idGen: () => string;
  const nowIso = () => "2026-03-29T00:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();
  });

  afterEach(() => {
    db.close();
  });

  function seedRun(
    runId: string,
    task: string,
    status: string,
    durationMs = 1000,
    responseText?: string,
  ) {
    db.withWriteTransaction((conn) => {
      conn
        .prepare(
          `INSERT INTO friday_agent_runs
             (id, session_key, task, status, response_text,
              duration_ms, usage_input, usage_output, created_at)
           VALUES (?, 'sess-1', ?, ?, ?, ?, 0, 0, datetime('now'))`,
        )
        .run(runId, task, status, responseText ?? null, durationMs);
    });
  }

  function seedToolEvents(
    runId: string,
    tools: Array<{ name: string; durationMs?: number; isError?: boolean }>,
  ) {
    db.withWriteTransaction((conn) => {
      let seq = 0;
      for (const tool of tools) {
        const callId = `call-${seq}`;
        const now = new Date().toISOString();
        conn
          .prepare(
            `INSERT INTO friday_agent_run_events
               (event_id, run_id, event_name, payload_json, seq, emitted_at, created_at)
             VALUES (?, ?, 'agent.run.tool_start', ?, ?, ?, ?)`,
          )
          .run(
            idGen(),
            runId,
            JSON.stringify({ toolCallId: callId, toolName: tool.name }),
            seq++,
            now,
            now,
          );

        conn
          .prepare(
            `INSERT INTO friday_agent_run_events
               (event_id, run_id, event_name, payload_json, seq, emitted_at, created_at)
             VALUES (?, ?, 'agent.run.tool_end', ?, ?, ?, ?)`,
          )
          .run(
            idGen(),
            runId,
            JSON.stringify({
              toolCallId: callId,
              toolName: tool.name,
              durationMs: tool.durationMs ?? 100,
              isError: tool.isError ?? false,
            }),
            seq++,
            now,
            now,
          );
      }
    });
  }

  it("extracts a minimal failure episode when run has no tool events", async () => {
    seedRun("run-empty", "do nothing", "failed", 1000, "ERROR: no tool was available");

    const extractor = createFridayEpisodeExtractor({ db, idGenerator: idGen, nowIso });
    const episode = await extractor.extractFromRun("run-empty", "user-1");

    expect(episode).not.toBeNull();
    expect(episode!.runId).toBe("run-empty");
    expect(episode!.steps).toEqual([]);
    expect(episode!.toolSequence).toEqual([]);
    expect(episode!.outcome).toBe("failure");
  });

  it("returns null when run ID does not exist at all", async () => {
    const extractor = createFridayEpisodeExtractor({ db, idGenerator: idGen, nowIso });
    const episode = await extractor.extractFromRun("nonexistent-run", "user-1");

    // No events and no run record → null (returns null on empty events)
    expect(episode).toBeNull();
  });

  it("skips trivial completed runs with no tool activity and a one-line response", async () => {
    seedRun("run-trivial", "say ok", "completed", 100, "OK");

    const extractor = createFridayEpisodeExtractor({ db, idGenerator: idGen, nowIso });
    const episode = await extractor.extractFromRun("run-trivial", "user-1");

    expect(episode).toBeNull();
    const rows = db.withReadConnection((conn) =>
      conn.prepare("SELECT * FROM friday_episodes WHERE run_id = ?").all("run-trivial"),
    );
    expect(rows).toHaveLength(0);
  });

  it("skips longer completed chat-only runs without tool activity", async () => {
    seedRun(
      "run-chat-only",
      "explain the deployment policy",
      "completed",
      400,
      "The deployment policy requires staging verification before production rollout.",
    );

    const extractor = createFridayEpisodeExtractor({ db, idGenerator: idGen, nowIso });
    const episode = await extractor.extractFromRun("run-chat-only", "user-1");

    expect(episode).toBeNull();
  });

  it("extracts a successful episode with correct steps", async () => {
    const runId = "run-success";
    seedRun(runId, "search the web for cats", "completed", 2000);
    seedToolEvents(runId, [
      { name: "web_search", durationMs: 500 },
      { name: "read", durationMs: 200 },
      { name: "write", durationMs: 300 },
    ]);

    const extractor = createFridayEpisodeExtractor({ db, idGenerator: idGen, nowIso });
    const episode = await extractor.extractFromRun(runId, "user-1");

    expect(episode).not.toBeNull();
    expect(episode!.runId).toBe(runId);
    expect(episode!.userId).toBe("user-1");
    expect(episode!.taskIntent).toBe("search the web for cats");
    expect(episode!.outcome).toBe("success");
    expect(episode!.durationMs).toBe(2000);
    expect(episode!.toolSequence).toEqual(["web_search", "read", "write"]);

    // Steps
    expect(episode!.steps).toHaveLength(3);
    expect(episode!.steps[0].action).toBe("web_search");
    expect(episode!.steps[0].category).toBe("read"); // web_search is in READ_TOOLS
    expect(episode!.steps[0].seq).toBe(0);

    expect(episode!.steps[1].action).toBe("read");
    expect(episode!.steps[1].category).toBe("read");

    expect(episode!.steps[2].action).toBe("write");
    expect(episode!.steps[2].category).toBe("write");
  });

  it("marks failed runs as failure outcome", async () => {
    const runId = "run-fail";
    seedRun(runId, "deploy server", "failed", 500);
    seedToolEvents(runId, [
      { name: "exec", durationMs: 400, isError: true },
    ]);

    const extractor = createFridayEpisodeExtractor({ db, idGenerator: idGen, nowIso });
    const episode = await extractor.extractFromRun(runId, "user-1");

    expect(episode).not.toBeNull();
    expect(episode!.outcome).toBe("failure");
    expect(episode!.steps[0].observation).toContain("error");
  });

  it("persists episode to friday_episodes table", async () => {
    const runId = "run-persist";
    seedRun(runId, "test persistence", "completed", 100);
    seedToolEvents(runId, [{ name: "read" }]);

    const extractor = createFridayEpisodeExtractor({ db, idGenerator: idGen, nowIso });
    await extractor.extractFromRun(runId, "user-1");

    const rows = db.withReadConnection((conn) =>
      conn.prepare("SELECT * FROM friday_episodes WHERE run_id = ?").all(runId),
    );
    expect(rows).toHaveLength(1);
  });

  it("classifies tool categories correctly", async () => {
    const runId = "run-categories";
    seedRun(runId, "various tools", "completed");
    seedToolEvents(runId, [
      { name: "glob" },      // read
      { name: "edit" },      // write
      { name: "browser" },   // navigate
      { name: "exec" },      // mutate
      { name: "system" },    // query
      { name: "custom_tool" }, // other
    ]);

    const extractor = createFridayEpisodeExtractor({ db, idGenerator: idGen, nowIso });
    const episode = await extractor.extractFromRun(runId, "user-1");

    expect(episode!.steps.map((s) => s.category)).toEqual([
      "read", "write", "navigate", "mutate", "query", "other",
    ]);
  });
});
