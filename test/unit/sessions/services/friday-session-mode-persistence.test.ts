import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridaySessionService } from "#sessions";
import type { FridaySessionService, FridaySessionConversationFocusState } from "#sessions";

describe("Session operationalMode persistence", () => {
  let db: FridaySqliteLayer;
  let service: FridaySessionService;
  const NOW = "2026-02-18T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    service = createFridaySessionService({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      // TS-R4/G3: this is a legacy in-process persistence suite. Default/live
      // callers leave this unset and fail-close before TS session writes.
      allowTestOnlySessionExecution: true,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("persists and restores operationalMode across read/write cycle", async () => {
    const session = await service.createSession({ channel: "test", chatId: "user1" });

    const focusState: FridaySessionConversationFocusState = {
      operationalMode: "plan",
      updatedAt: NOW,
    };

    await service.setConversationFocus(session.key, focusState);
    const restored = await service.getConversationFocus(session.key);

    expect(restored).not.toBeNull();
    expect(restored!.operationalMode).toBe("plan");
  });

  it("persists and restores preModeRestore", async () => {
    const session = await service.createSession({ channel: "test", chatId: "user1" });

    const focusState: FridaySessionConversationFocusState = {
      operationalMode: "restricted",
      preModeRestore: "execute",
      updatedAt: NOW,
    };

    await service.setConversationFocus(session.key, focusState);
    const restored = await service.getConversationFocus(session.key);

    expect(restored!.operationalMode).toBe("restricted");
    expect(restored!.preModeRestore).toBe("execute");
  });

  it("rejects invalid operationalMode values during deserialization", async () => {
    const session = await service.createSession({ channel: "test", chatId: "user1" });

    // Write a focus state with an invalid mode directly via metadata
    const focusState = {
      operationalMode: "invalid_mode",
      updatedAt: NOW,
    } as unknown as FridaySessionConversationFocusState;

    await service.setConversationFocus(session.key, focusState);
    const restored = await service.getConversationFocus(session.key);

    // Invalid mode should be stripped during deserialization
    expect(restored!.operationalMode).toBeUndefined();
  });

  it("preserves operationalMode alongside other focus state fields", async () => {
    const session = await service.createSession({ channel: "test", chatId: "user1" });

    const focusState: FridaySessionConversationFocusState = {
      operationalMode: "execute",
      currentTopicSummary: "Discussing deployment",
      lastRunId: "run-001",
      updatedAt: NOW,
    };

    await service.setConversationFocus(session.key, focusState);
    const restored = await service.getConversationFocus(session.key);

    expect(restored!.operationalMode).toBe("execute");
    expect(restored!.currentTopicSummary).toBe("Discussing deployment");
    expect(restored!.lastRunId).toBe("run-001");
  });

  it("returns null operationalMode when not set", async () => {
    const session = await service.createSession({ channel: "test", chatId: "user1" });

    const focusState: FridaySessionConversationFocusState = {
      currentTopicSummary: "General chat",
      updatedAt: NOW,
    };

    await service.setConversationFocus(session.key, focusState);
    const restored = await service.getConversationFocus(session.key);

    expect(restored!.operationalMode).toBeUndefined();
  });
});
