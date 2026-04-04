import { afterEach, describe, expect, it } from "vitest";

import {
  createFridayAgentRunEventRepository,
  createFridayAgentRunRepository,
} from "#agent";
import { createFridayImmediateRunPersistence } from "#engine";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../helpers/friday-test-db.helper.js";

describe("FridayImmediateRunPersistence", () => {
  let db: FridaySqliteLayer;

  afterEach(() => {
    db?.close();
  });

  it("creates a durable run record and replayable terminal events once", () => {
    db = createTestDb();
    const repo = createFridayAgentRunRepository();
    const runEventRepository = createFridayAgentRunEventRepository();

    const persist = createFridayImmediateRunPersistence({
      db,
      repo,
      runEventRepository,
      idGenerator: (() => {
        let seq = 0;
        return () => `evt-${String(++seq)}`;
      })(),
      nowIso: () => "2026-04-03T21:10:00.000Z",
    });

    persist({
      runId: "run-immediate-001",
      task: "What can you do?",
      sessionKey: "chat:default:chat-immediate-001",
      responseText: "Current capabilities:\n- Skills\n- Workflows",
    });
    persist({
      runId: "run-immediate-001",
      task: "What can you do?",
      sessionKey: "chat:default:chat-immediate-001",
      responseText: "Current capabilities:\n- Skills\n- Workflows",
    });

    const run = db.withReadConnection((reader) => repo.getById(reader, "run-immediate-001"));
    const events = db.withReadConnection((reader) => runEventRepository.list(reader, "run-immediate-001"));

    expect(run?.status).toBe("completed");
    expect(run?.responseText).toContain("Current capabilities:");
    expect(events).toHaveLength(2);
    expect(events[0]?.eventName).toBe("agent.run.text_delta");
    expect(events[1]?.eventName).toBe("agent.run.completed");
  });
});
