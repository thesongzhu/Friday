import { describe, it, expect, vi } from "vitest";
import { FridayDomainError } from "#errors";
import { createFridaySessionRoutes } from "#api";
import { FRIDAY_SESSION_ERROR_CODES, FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES } from "#sessions";
import type { FridaySessionService, FridaySessionMemoryExtractionService } from "#sessions";
import type { FridaySessionRecord, FridaySessionMessageRecord } from "#sessions";
import { createFridayRustHubSessionLifecycleDispatchAdapter } from "../../../../../src/api/mission-spine/friday-rust-hub-session-lifecycle-dispatch-adapter.js";
import type { FridayRustHubAgentRunSealedClient } from "../../../../../src/api/mission-spine/friday-rust-hub-agent-run-ws-sealed-client.js";
import type { FridayRustHubRunAnswerReadbackService } from "../../../../../src/api/mission-spine/friday-rust-hub-run-answer-readback-service.js";

function makeMockSession(overrides: Partial<FridaySessionRecord> = {}): FridaySessionRecord {
  return {
    id: "sess-1",
    key: "discord:default:user1",
    channel: "discord",
    accountId: "default",
    chatId: "user1",
    chatKind: "dm",
    status: "active",
    metadata: {},
    contextInputTokens: 0,
    contextOutputTokens: 0,
    contextTotalTokens: 0,
    messageCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeMockMessage(overrides: Partial<FridaySessionMessageRecord> = {}): FridaySessionMessageRecord {
  return {
    id: "msg-1",
    sessionId: "sess-1",
    sessionKey: "discord:default:user1",
    sequence: 1,
    role: "user",
    content: "hello",
    contentText: "hello",
    tokenCount: 5,
    metadata: {},
    memoryExtractStatus: "pending",
    occurredAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeMockCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    params: {},
    query: {},
    body: null,
    headers: {},
    principal: null,
    requestId: "req-1",
    receivedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeBoundPrincipal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    principalType: "user",
    principalId: "user:bound-1",
    tenantId: "00000000-0000-0000-0000-000000000101",
    userId: "00000000-0000-0000-0000-000000000102",
    role: "admin",
    scopes: ["agent.run", "session.read", "session.write"],
    tokenId: "00000000-0000-0000-0000-000000000103",
    tokenKind: "access",
    issuedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function createMockService(): FridaySessionService {
  return {
    createSession: vi.fn(),
    listSessions: vi.fn(),
    getSession: vi.fn().mockResolvedValue(null),
    getOrCreateSession: vi.fn().mockResolvedValue(makeMockSession()),
    alignSessionContext: vi.fn(),
    addMessage: vi.fn(),
    updateMessageMetadataByIdempotency: vi.fn(),
    getMessages: vi.fn(),
    archiveSession: vi.fn(),
    pruneOldSessions: vi.fn(),
    sweepLifecycle: vi.fn(),
    getSessionMemoryNamespace: vi.fn(),
    forkSession: vi.fn(),
    listForks: vi.fn(),
    mergeForkSummary: vi.fn(),
    resetSession: vi.fn(),
    setSendPolicy: vi.fn(),
    evaluateSendPolicy: vi.fn().mockResolvedValue("allow"),
    getConversationFocus: vi.fn(),
    setConversationFocus: vi.fn(),
    mergeMetadata: vi.fn(),
  };
}

async function expectRouteError(fn: Promise<unknown>, code: string): Promise<void> {
  try {
    await fn;
    expect.fail("Expected FridayDomainError to be thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(FridayDomainError);
    expect((err as FridayDomainError).code).toBe(code);
  }
}

describe("FridaySessionRoutes", () => {
  it("creates 22 routes (10 core + compact + delete + export + reset + outbound + 3 fork + 4 extraction)", () => {
    const svc = createMockService();
    const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
    expect(routes).toHaveLength(22);
  });

  it("all routes have unique operationIds", () => {
    const svc = createMockService();
    const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
    const ids = routes.map((r) => r.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all routes require auth", () => {
    const svc = createMockService();
    const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
    for (const route of routes) {
      expect(route.auth).toEqual({ public: true });
    }
  });

  // ─── sessions.list ───

  describe("sessions.list", () => {
    it("returns items from service", async () => {
      const svc = createMockService();
      const sessions = [makeMockSession()];
      vi.mocked(svc.listSessions).mockResolvedValue(sessions);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const listRoute = routes.find((r) => r.operationId === "sessions.list")!;

      const result = await listRoute.handler(makeMockCtx({ query: {}, principal: makeBoundPrincipal() }) as never);
      expect(result).toHaveProperty("items", sessions);
      expect(svc.listSessions).toHaveBeenCalledWith({
        channel: undefined,
        accountId: "00000000-0000-0000-0000-000000000101",
        userId: "00000000-0000-0000-0000-000000000102",
        status: undefined,
        limit: undefined,
        cursor: undefined,
      });
    });

    it("passes query params to service", async () => {
      const svc = createMockService();
      vi.mocked(svc.listSessions).mockResolvedValue([]);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const listRoute = routes.find((r) => r.operationId === "sessions.list")!;

      await listRoute.handler(
        makeMockCtx({
          query: { channel: "discord", status: "active", limit: "10", cursor: "2026-01-01T00:00:00.000Z" },
          principal: makeBoundPrincipal(),
        }) as never,
      );

      expect(svc.listSessions).toHaveBeenCalledWith({
        channel: "discord",
        accountId: "00000000-0000-0000-0000-000000000101",
        userId: "00000000-0000-0000-0000-000000000102",
        status: "active",
        limit: 10,
        cursor: "2026-01-01T00:00:00.000Z",
      });
    });

    it("NEW-30 red: binds list scope to the authenticated principal instead of caller-supplied filters", async () => {
      const svc = createMockService();
      vi.mocked(svc.listSessions).mockResolvedValue([]);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const listRoute = routes.find((r) => r.operationId === "sessions.list")!;

      await listRoute.handler(
        makeMockCtx({
          query: {
            accountId: "tenant-victim",
            userId: "user-victim",
            channel: "discord",
          },
          principal: makeBoundPrincipal({
            tenantId: "tenant-attacker",
            userId: "user-attacker",
            scopes: ["session.read"],
            role: "viewer",
          }),
        }) as never,
      );

      expect(svc.listSessions).toHaveBeenCalledWith({
        channel: "discord",
        accountId: "tenant-attacker",
        userId: "user-attacker",
        status: undefined,
        limit: undefined,
        cursor: undefined,
      });
    });

    it("validates invalid limit", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const listRoute = routes.find((r) => r.operationId === "sessions.list")!;

      await expectRouteError(
        listRoute.handler(makeMockCtx({ query: { limit: "abc" }, principal: makeBoundPrincipal() }) as never),
        FRIDAY_SESSION_ERROR_CODES.INVALID_INPUT,
      );
    });

    it("validates invalid status", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const listRoute = routes.find((r) => r.operationId === "sessions.list")!;

      await expectRouteError(
        listRoute.handler(makeMockCtx({ query: { status: "invalid" }, principal: makeBoundPrincipal() }) as never),
        FRIDAY_SESSION_ERROR_CODES.INVALID_INPUT,
      );
    });
  });

  // ─── sessions.create ───

  describe("sessions.create", () => {
    it("validates missing body", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const createRoute = routes.find((r) => r.operationId === "sessions.create")!;

      await expectRouteError(
        createRoute.handler(makeMockCtx({ body: null }) as never),
        FRIDAY_SESSION_ERROR_CODES.INVALID_INPUT,
      );
    });

    it("validates missing channel", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const createRoute = routes.find((r) => r.operationId === "sessions.create")!;

      await expectRouteError(
        createRoute.handler(makeMockCtx({ body: { chatId: "x" } }) as never),
        FRIDAY_SESSION_ERROR_CODES.INVALID_INPUT,
      );
    });

    it("calls createSession with full input on valid body", async () => {
      const svc = createMockService();
      const mockSession = makeMockSession();
      vi.mocked(svc.createSession).mockResolvedValue(mockSession);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const createRoute = routes.find((r) => r.operationId === "sessions.create")!;

      const result = await createRoute.handler(
        makeMockCtx({
          body: { channel: "discord", chatId: "user1", accountId: "acme", chatKind: "dm", metadata: { x: 1 } },
        }) as never,
      );

      expect(svc.createSession).toHaveBeenCalledWith({
        channel: "discord",
        chatId: "user1",
        userId: undefined,
        accountId: "acme",
        chatKind: "dm",
        metadata: { x: 1 },
      });
      expect(result).toHaveProperty("session");
    });

    it("aligns a newly created default session to the authenticated principal tenant", async () => {
      const svc = createMockService();
      const createdSession = makeMockSession({
        key: "discord:default:user1",
        accountId: "default",
        userId: undefined,
      });
      const alignedSession = makeMockSession({
        key: createdSession.key,
        accountId: "tenant-acme",
        userId: "user-1",
      });
      vi.mocked(svc.createSession).mockResolvedValue(createdSession);
      vi.mocked(svc.getSession)
        .mockResolvedValueOnce(createdSession)
        .mockResolvedValueOnce(alignedSession);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const createRoute = routes.find((r) => r.operationId === "sessions.create")!;

      const result = await createRoute.handler(
        makeMockCtx({
          body: { channel: "discord", chatId: "user1", chatKind: "dm" },
          principal: {
            principalType: "user",
            principalId: "principal-1",
            tenantId: "tenant-acme",
            userId: "user-1",
            role: "owner",
            scopes: ["session.write"],
            tokenId: "token-1",
            tokenKind: "access",
            issuedAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2026-01-01T01:00:00.000Z",
          },
        }) as never,
      );

      expect(svc.alignSessionContext).toHaveBeenCalledWith(createdSession.key, {
        accountId: "tenant-acme",
        userId: "user-1",
      });
      expect(result.session).toEqual(alignedSession);
    });
  });

  // ─── sessions.get ───

  describe("sessions.get", () => {
    it("throws 404 when session not found", async () => {
      const svc = createMockService();
      vi.mocked(svc.getSession).mockResolvedValue(null);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const getRoute = routes.find((r) => r.operationId === "sessions.get")!;

      await expectRouteError(
        getRoute.handler(makeMockCtx({ params: { sessionKey: "discord:default:nope" }, principal: makeBoundPrincipal() }) as never),
        FRIDAY_SESSION_ERROR_CODES.NOT_FOUND,
      );
    });

    it("returns session when found", async () => {
      const svc = createMockService();
      const mockSession = makeMockSession({
        accountId: "00000000-0000-0000-0000-000000000101",
        userId: "00000000-0000-0000-0000-000000000102",
      });
      vi.mocked(svc.getSession).mockResolvedValue(mockSession);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const getRoute = routes.find((r) => r.operationId === "sessions.get")!;

      const result = await getRoute.handler(
        makeMockCtx({ params: { sessionKey: "discord:default:user1" }, principal: makeBoundPrincipal() }) as never,
      );

      expect(result).toHaveProperty("session", mockSession);
    });

    it("NEW-30 red: rejects get for a session owned by a different principal", async () => {
      const svc = createMockService();
      vi.mocked(svc.getSession).mockResolvedValue(makeMockSession({
        accountId: "tenant-victim",
        userId: "user-victim",
      }));

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const getRoute = routes.find((r) => r.operationId === "sessions.get")!;

      await expectRouteError(
        getRoute.handler(
          makeMockCtx({
            params: { sessionKey: "discord:default:victim" },
            principal: makeBoundPrincipal({
              tenantId: "tenant-attacker",
              userId: "user-attacker",
              scopes: ["session.read"],
              role: "viewer",
            }),
          }) as never,
        ),
        "SESSION_OWNER_MISMATCH",
      );
    });

    it("throws FridayDomainError on malformed URL-encoded key", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const getRoute = routes.find((r) => r.operationId === "sessions.get")!;

      await expectRouteError(
        getRoute.handler(makeMockCtx({ params: { sessionKey: "%E0%A4%A" } }) as never),
        FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
      );
    });
  });

  // ─── sessions.archive ───

  describe("sessions.archive", () => {
    it("archives session", async () => {
      const svc = createMockService();
      const archived = makeMockSession({ status: "archived" });
      vi.mocked(svc.archiveSession).mockResolvedValue(archived);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const archiveRoute = routes.find((r) => r.operationId === "sessions.archive")!;

      const result = await archiveRoute.handler(
        makeMockCtx({ params: { sessionKey: "discord:default:user1" } }) as never,
      );

      expect(result).toHaveProperty("session");
    });
  });

  // ─── sessions.prune ───

  describe("sessions.prune", () => {
    it("validates missing body", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const pruneRoute = routes.find((r) => r.operationId === "sessions.prune")!;

      await expectRouteError(
        pruneRoute.handler(makeMockCtx({ body: null }) as never),
        FRIDAY_SESSION_ERROR_CODES.PRUNE_VALIDATION_ERROR,
      );
    });

    it("validates missing olderThan", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const pruneRoute = routes.find((r) => r.operationId === "sessions.prune")!;

      await expectRouteError(
        pruneRoute.handler(makeMockCtx({ body: {} }) as never),
        FRIDAY_SESSION_ERROR_CODES.PRUNE_VALIDATION_ERROR,
      );
    });

    it("validates invalid ISO date in olderThan", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const pruneRoute = routes.find((r) => r.operationId === "sessions.prune")!;

      await expectRouteError(
        pruneRoute.handler(makeMockCtx({ body: { olderThan: "not-a-date" } }) as never),
        FRIDAY_SESSION_ERROR_CODES.PRUNE_VALIDATION_ERROR,
      );
    });

    it("calls pruneOldSessions on valid body", async () => {
      const svc = createMockService();
      vi.mocked(svc.pruneOldSessions).mockResolvedValue({
        archivedToPrunedCount: 0,
        hardDeletedCount: 0,
        sessionKeys: [],
      });

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const pruneRoute = routes.find((r) => r.operationId === "sessions.prune")!;

      await pruneRoute.handler(
        makeMockCtx({ body: { olderThan: "2026-01-01T00:00:00.000Z" } }) as never,
      );

      expect(svc.pruneOldSessions).toHaveBeenCalledWith("2026-01-01T00:00:00.000Z");
    });
  });

  // ─── sessions.sweep ───

  describe("sessions.sweep", () => {
    it("calls sweepLifecycle and returns result", async () => {
      const svc = createMockService();
      vi.mocked(svc.sweepLifecycle).mockResolvedValue({
        idledCount: 1,
        archivedCount: 2,
        prunedCount: 0,
        hardDeletedCount: 0,
      });

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const sweepRoute = routes.find((r) => r.operationId === "sessions.sweep")!;

      const result = await sweepRoute.handler(makeMockCtx() as never);
      expect(result).toHaveProperty("result");
      expect(svc.sweepLifecycle).toHaveBeenCalled();
    });
  });

  describe("sessions.compact", () => {
    it("persists a compacted focus summary and metadata", async () => {
      const svc = createMockService();
      vi.mocked(svc.getMessages).mockResolvedValue([
        makeMockMessage({ id: "msg-1", sequence: 1, role: "user", contentText: "first task" }),
        makeMockMessage({ id: "msg-2", sequence: 2, role: "assistant", contentText: "first answer" }),
        makeMockMessage({ id: "msg-3", sequence: 3, role: "user", contentText: "recent follow-up" }),
      ]);
      vi.mocked(svc.getConversationFocus).mockResolvedValue(null);
      vi.mocked(svc.setConversationFocus).mockResolvedValue(makeMockSession());
      vi.mocked(svc.mergeMetadata).mockResolvedValue(makeMockSession());
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true,
        sessionService: svc,
        nowIso: () => "2026-01-01T00:00:05.000Z",
      });
      const route = routes.find((r) => r.operationId === "sessions.compact")!;

      const result = await route.handler(makeMockCtx({
        params: { sessionKey: encodeURIComponent("discord:default:user1") },
        body: { keepRecent: 1 },
      }) as never);

      expect(result).toMatchObject({
        compaction: {
          sessionKey: "discord:default:user1",
          compactedMessageCount: 2,
          keptRecentMessageCount: 1,
          summary: expect.stringContaining("first task"),
          sequenceStart: 1,
          sequenceEnd: 2,
        },
      });
      expect(svc.setConversationFocus).toHaveBeenCalledWith(
        "discord:default:user1",
        expect.objectContaining({
          currentTopicSummary: expect.stringContaining("first answer"),
          currentTopicStartSequence: 3,
          updatedAt: "2026-01-01T00:00:05.000Z",
        }),
      );
      expect(svc.mergeMetadata).toHaveBeenCalledWith(
        "discord:default:user1",
        expect.objectContaining({
          lastCompaction: expect.objectContaining({
            compactedMessageCount: 2,
            keptRecentMessageCount: 1,
          }),
        }),
      );
    });
  });

  // ─── sessions.messages.create ───

  describe("sessions.messages.create", () => {
    it("validates missing message body", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.messages.create")!;

      await expectRouteError(
        route.handler(
          makeMockCtx({ params: { sessionKey: "discord:default:user1" }, body: null }) as never,
        ),
        FRIDAY_SESSION_ERROR_CODES.MESSAGE_VALIDATION_ERROR,
      );
    });

    it("validates missing role", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.messages.create")!;

      await expectRouteError(
        route.handler(
          makeMockCtx({
            params: { sessionKey: "discord:default:user1" },
            body: { content: "hello" },
          }) as never,
        ),
        FRIDAY_SESSION_ERROR_CODES.MESSAGE_VALIDATION_ERROR,
      );
    });

    it("creates message on valid body", async () => {
      const svc = createMockService();
      const mockMsg = makeMockMessage();
      vi.mocked(svc.alignSessionContext).mockResolvedValue(makeMockSession({
        accountId: "admin-001",
        userId: "admin-001",
        memoryNamespace: "tenant.admin-001.channel.discord.user.admin-001.shared",
      }));
      vi.mocked(svc.addMessage).mockResolvedValue(mockMsg);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.messages.create")!;

      const result = await route.handler(
        makeMockCtx({
          params: { sessionKey: "discord:default:user1" },
          body: { role: "user", content: "hello" },
          principal: {
            principalType: "user",
            principalId: "admin-001",
            tenantId: "admin-001",
            userId: "admin-001",
            scopes: ["session.write"],
            tokenId: "tok-1",
            tokenKind: "access",
            issuedAt: "2026-01-01T00:00:00.000Z",
          },
        }) as never,
      );

      expect(result).toHaveProperty("message");
      expect(svc.alignSessionContext).toHaveBeenCalledWith("discord:default:user1", {
        accountId: "admin-001",
        userId: "admin-001",
      });
    });
  });

  // ─── sessions.outbound.send ───

  describe("sessions.outbound.send", () => {
    it("sends through the channel registry and stores a session message", async () => {
      const svc = createMockService();
      const session = makeMockSession({ channel: "discord", chatId: "discord-channel-1" });
      const storedMessage = makeMockMessage({
        role: "assistant",
        content: "live marker",
        contentText: "live marker",
        metadata: {
          source: "channel_outbound",
          channelMessageId: "discord-msg-1",
        },
      });
      vi.mocked(svc.getSession).mockResolvedValue(session);
      vi.mocked(svc.addMessage).mockResolvedValue(storedMessage);
      const channelRegistry = {
        send: vi.fn().mockResolvedValue({ messageId: "discord-msg-1" }),
      };

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true,
        sessionService: svc,
        channelRegistry: channelRegistry as never,
        nowIso: () => "2026-01-01T00:00:00.000Z",
      });
      const route = routes.find((r) => r.operationId === "sessions.outbound.send")!;

      const result = await route.handler(
        makeMockCtx({
          params: { sessionKey: "discord:default:user1" },
          body: {
            text: " live marker ",
            metadata: { uiSurface: "channels" },
          },
        }) as never,
      );

      expect(channelRegistry.send).toHaveBeenCalledWith("discord", {
        chatId: "discord-channel-1",
        text: "live marker",
        images: undefined,
        replyTo: undefined,
        chatType: "direct",
      });
      expect(svc.addMessage).toHaveBeenCalledWith("discord:default:user1", expect.objectContaining({
        role: "assistant",
        content: "live marker",
        contentText: "live marker",
        idempotencyKey: "channel-outbound:discord:discord-msg-1",
        metadata: expect.objectContaining({
          uiSurface: "channels",
          source: "channel_outbound",
          deliveryStatus: "sent",
          channelKind: "discord",
          channelChatId: "discord-channel-1",
          channelMessageId: "discord-msg-1",
        }),
      }));
      expect(result).toEqual({
        delivery: {
          channel: "discord",
          chatId: "discord-channel-1",
          messageId: "discord-msg-1",
        },
        message: storedMessage,
      });
    });

    it("rejects outbound when the session send policy blocks it", async () => {
      const svc = createMockService();
      vi.mocked(svc.getSession).mockResolvedValue(makeMockSession());
      vi.mocked(svc.evaluateSendPolicy).mockResolvedValue("block");
      const channelRegistry = { send: vi.fn() };

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true,
        sessionService: svc,
        channelRegistry: channelRegistry as never,
      });
      const route = routes.find((r) => r.operationId === "sessions.outbound.send")!;

      await expectRouteError(
        route.handler(
          makeMockCtx({
            params: { sessionKey: "discord:default:user1" },
            body: { text: "blocked marker" },
          }) as never,
        ),
        "CHANNEL_OUTBOUND_BLOCKED",
      );
      expect(channelRegistry.send).not.toHaveBeenCalled();
      expect(svc.addMessage).not.toHaveBeenCalled();
    });

    it("requires a configured channel registry", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.outbound.send")!;

      await expectRouteError(
        route.handler(
          makeMockCtx({
            params: { sessionKey: "discord:default:user1" },
            body: { text: "marker" },
          }) as never,
        ),
        "CHANNEL_OUTBOUND_UNAVAILABLE",
      );
    });
  });

  // ─── sessions.messages.list ───

  describe("sessions.messages.list", () => {
    it("returns messages", async () => {
      const svc = createMockService();
      vi.mocked(svc.getSession).mockResolvedValue(makeMockSession({
        accountId: "00000000-0000-0000-0000-000000000101",
        userId: "00000000-0000-0000-0000-000000000102",
      }));
      vi.mocked(svc.getMessages).mockResolvedValue([makeMockMessage()]);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.messages.list")!;

      const result = await route.handler(
        makeMockCtx({ params: { sessionKey: "discord:default:user1" }, query: {}, principal: makeBoundPrincipal() }) as never,
      );

      expect(result).toHaveProperty("items");
    });

    it("NEW-30 red: rejects messages list for a session owned by a different principal", async () => {
      const svc = createMockService();
      vi.mocked(svc.getSession).mockResolvedValue(makeMockSession({
        accountId: "tenant-victim",
        userId: "user-victim",
      }));
      vi.mocked(svc.getMessages).mockResolvedValue([makeMockMessage({
        content: "victim transcript",
        contentText: "victim transcript",
      })]);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.messages.list")!;

      await expectRouteError(
        route.handler(
          makeMockCtx({
            params: { sessionKey: "discord:default:victim" },
            query: {},
            principal: makeBoundPrincipal({
              tenantId: "tenant-attacker",
              userId: "user-attacker",
              scopes: ["session.read"],
              role: "viewer",
            }),
          }) as never,
        ),
        "SESSION_OWNER_MISMATCH",
      );
      expect(svc.getMessages).not.toHaveBeenCalled();
    });

    it("NEW-30 no-degrade: admin may read legacy channel mirrors without reopening viewer cross-owner reads", async () => {
      const svc = createMockService();
      vi.mocked(svc.getSession).mockResolvedValue(makeMockSession({
        key: "channel:discord:team-chat",
        channel: "discord",
        accountId: "default",
        chatId: "team-chat",
      }));
      vi.mocked(svc.getMessages).mockResolvedValue([makeMockMessage({
        sessionKey: "channel:discord:team-chat",
        role: "user",
        contentText: "legacy channel mirror",
      })]);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.messages.list")!;

      const adminResult = await route.handler(
        makeMockCtx({
          params: { sessionKey: "channel:discord:team-chat" },
          query: {},
          principal: makeBoundPrincipal({ role: "admin" }),
        }) as never,
      );

      expect(adminResult.items).toHaveLength(1);

      vi.mocked(svc.getMessages).mockClear();
      await expectRouteError(
        route.handler(
          makeMockCtx({
            params: { sessionKey: "channel:discord:team-chat" },
            query: {},
            principal: makeBoundPrincipal({
              tenantId: "tenant-attacker",
              userId: "user-attacker",
              scopes: ["session.read"],
              role: "viewer",
            }),
          }) as never,
        ),
        "SESSION_OWNER_MISMATCH",
      );
      expect(svc.getMessages).not.toHaveBeenCalled();
    });

    it("NEW-30 red: rejects export for a session owned by a different principal", async () => {
      const svc = createMockService();
      vi.mocked(svc.getSession).mockResolvedValue(makeMockSession({
        accountId: "tenant-victim",
        userId: "user-victim",
      }));
      vi.mocked(svc.getMessages).mockResolvedValue([makeMockMessage({
        content: "victim export",
        contentText: "victim export",
      })]);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.export")!;

      await expectRouteError(
        route.handler(
          makeMockCtx({
            params: { sessionKey: "discord:default:victim" },
            query: { format: "json" },
            principal: makeBoundPrincipal({
              tenantId: "tenant-attacker",
              userId: "user-attacker",
              scopes: ["session.read"],
              role: "viewer",
            }),
          }) as never,
        ),
        "SESSION_OWNER_MISMATCH",
      );
      expect(svc.getMessages).not.toHaveBeenCalled();
    });

    it("NEW-30 no-degrade: keeps absent-session message reads available for chat bootstrap", async () => {
      const svc = createMockService();
      vi.mocked(svc.getSession).mockResolvedValue(null);
      vi.mocked(svc.getMessages).mockResolvedValue([]);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.messages.list")!;

      const result = await route.handler(
        makeMockCtx({
          params: { sessionKey: "chat:default:chat-bootstrap" },
          query: { limit: "200" },
          principal: makeBoundPrincipal(),
        }) as never,
      );

      expect(result).toEqual({ items: [] });
      expect(svc.getSession).toHaveBeenCalledWith("chat:default:chat-bootstrap");
      expect(svc.getMessages).toHaveBeenCalledWith("chat:default:chat-bootstrap", 100, undefined);
    });

    it("NEW-30 no-degrade: keeps absent-session export reads available as an empty transcript", async () => {
      const svc = createMockService();
      vi.mocked(svc.getSession).mockResolvedValue(null);
      vi.mocked(svc.getMessages).mockResolvedValue([]);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.export")!;

      const result = await route.handler(
        makeMockCtx({
          params: { sessionKey: "chat:default:chat-bootstrap" },
          query: { format: "json" },
          principal: makeBoundPrincipal(),
        }) as never,
      );

      expect(JSON.parse(result.content)).toEqual({
        sessionKey: "chat:default:chat-bootstrap",
        messages: [],
      });
      expect(svc.getSession).toHaveBeenCalledWith("chat:default:chat-bootstrap");
      expect(svc.getMessages).toHaveBeenCalledWith("chat:default:chat-bootstrap", 100);
    });

    it("validates invalid limit", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.messages.list")!;

      await expectRouteError(
        route.handler(
          makeMockCtx({
            params: { sessionKey: "discord:default:user1" },
            query: { limit: "not-a-number" },
            principal: makeBoundPrincipal(),
          }) as never,
        ),
        FRIDAY_SESSION_ERROR_CODES.INVALID_INPUT,
      );
    });
  });

  // ─── sessions.memory.namespace.get ───

  describe("sessions.memory.namespace.get", () => {
    it("returns namespace", async () => {
      const svc = createMockService();
      vi.mocked(svc.getSession).mockResolvedValue(makeMockSession({
        accountId: "00000000-0000-0000-0000-000000000101",
        userId: "00000000-0000-0000-0000-000000000102",
      }));
      vi.mocked(svc.getSessionMemoryNamespace).mockResolvedValue(
        "tenant.default.channel.discord.user.user1.shared",
      );

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.memory.namespace.get")!;

      const result = await route.handler(
        makeMockCtx({
          params: { sessionKey: "discord:default:user1" },
          principal: makeBoundPrincipal(),
        }) as never,
      );

      expect(result).toHaveProperty(
        "namespace",
        "tenant.default.channel.discord.user.user1.shared",
      );
    });

    it("NEW-30 red: rejects namespace reads for a session owned by a different principal", async () => {
      const svc = createMockService();
      vi.mocked(svc.getSession).mockResolvedValue(makeMockSession({
        accountId: "tenant-victim",
        userId: "user-victim",
      }));
      vi.mocked(svc.getSessionMemoryNamespace).mockResolvedValue(
        "tenant.victim.channel.discord.user.user-victim.shared",
      );

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.memory.namespace.get")!;

      await expectRouteError(
        route.handler(
          makeMockCtx({
            params: { sessionKey: "discord:tenant-victim:user-victim" },
            principal: makeBoundPrincipal({
              tenantId: "tenant-attacker",
              userId: "user-attacker",
              scopes: ["session.read"],
              role: "viewer",
            }),
          }) as never,
        ),
        "SESSION_OWNER_MISMATCH",
      );
      expect(svc.getSessionMemoryNamespace).not.toHaveBeenCalled();
    });
  });

  // ─── sessions.forks.create ───

  describe("sessions.forks.create", () => {
    it("calls forkSession with defaults on empty body", async () => {
      const svc = createMockService();
      vi.mocked(svc.forkSession).mockResolvedValue({
        forkSession: makeMockSession({ key: "subagent:discord:default:user1:task-1" }),
        inheritedMessageCount: 20,
        forkedFromMessageId: "msg-100",
      });

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.forks.create")!;

      const result = await route.handler(
        makeMockCtx({
          params: { sessionKey: "discord:default:user1" },
          body: { useLastUserMessage: true },
          principal: makeBoundPrincipal(),
        }) as never,
      );

      expect(result).toHaveProperty("result");
      expect(svc.forkSession).toHaveBeenCalledWith("discord:default:user1", {
        taskId: undefined,
        inheritMessageCount: undefined,
        forkFromMessageId: undefined,
        metadata: undefined,
      });
    });

    it("rejects invalid inheritMessageCount", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.forks.create")!;

      await expectRouteError(
        route.handler(
          makeMockCtx({
            params: { sessionKey: "discord:default:user1" },
            body: { inheritMessageCount: -1 },
          }) as never,
        ),
        FRIDAY_SESSION_ERROR_CODES.INVALID_INPUT,
      );
    });

    it("rejects empty taskId string", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.forks.create")!;

      await expectRouteError(
        route.handler(
          makeMockCtx({
            params: { sessionKey: "discord:default:user1" },
            body: { taskId: "" },
          }) as never,
        ),
        FRIDAY_SESSION_ERROR_CODES.INVALID_INPUT,
      );
    });

    it("rejects empty forkFromMessageId string", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.forks.create")!;

      await expectRouteError(
        route.handler(
          makeMockCtx({
            params: { sessionKey: "discord:default:user1" },
            body: { forkFromMessageId: "" },
          }) as never,
        ),
        FRIDAY_SESSION_ERROR_CODES.INVALID_INPUT,
      );
    });
  });

  // ─── sessions.forks.list ───

  describe("sessions.forks.list", () => {
    it("returns fork list", async () => {
      const svc = createMockService();
      vi.mocked(svc.getSession).mockResolvedValue(makeMockSession({
        accountId: "00000000-0000-0000-0000-000000000101",
        userId: "00000000-0000-0000-0000-000000000102",
      }));
      vi.mocked(svc.listForks).mockResolvedValue([makeMockSession()]);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.forks.list")!;

      const result = await route.handler(
        makeMockCtx({
          params: { sessionKey: "discord:default:user1" },
          query: {},
          principal: makeBoundPrincipal(),
        }) as never,
      );

      expect(result).toHaveProperty("items");
      expect(svc.listForks).toHaveBeenCalledWith("discord:default:user1", {
        status: undefined,
        limit: undefined,
      });
    });

    it("validates invalid status", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.forks.list")!;

      await expectRouteError(
        route.handler(
          makeMockCtx({
            params: { sessionKey: "discord:default:user1" },
            query: { status: "invalid" },
          }) as never,
        ),
        FRIDAY_SESSION_ERROR_CODES.INVALID_INPUT,
      );
    });

    it("NEW-30 red: rejects fork list reads for a session owned by a different principal", async () => {
      const svc = createMockService();
      vi.mocked(svc.getSession).mockResolvedValue(makeMockSession({
        accountId: "tenant-victim",
        userId: "user-victim",
      }));
      vi.mocked(svc.listForks).mockResolvedValue([makeMockSession({
        key: "subagent:discord:tenant-victim:user-victim:child",
      })]);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.forks.list")!;

      await expectRouteError(
        route.handler(
          makeMockCtx({
            params: { sessionKey: "discord:tenant-victim:user-victim" },
            query: {},
            principal: makeBoundPrincipal({
              tenantId: "tenant-attacker",
              userId: "user-attacker",
              scopes: ["session.read"],
              role: "viewer",
            }),
          }) as never,
        ),
        "SESSION_OWNER_MISMATCH",
      );
      expect(svc.listForks).not.toHaveBeenCalled();
    });
  });

  // ─── sessions.forks.merge ───

  describe("sessions.forks.merge", () => {
    it("validates missing body", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.forks.merge")!;

      await expectRouteError(
        route.handler(
          makeMockCtx({ params: { sessionKey: "discord:default:user1" }, body: null }) as never,
        ),
        FRIDAY_SESSION_ERROR_CODES.FORK_MERGE_VALIDATION_ERROR,
      );
    });

    it("validates missing summary", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.forks.merge")!;

      await expectRouteError(
        route.handler(
          makeMockCtx({
            params: { sessionKey: "discord:default:user1" },
            body: { forkSessionKey: "subagent:discord:default:user1:task-1" },
          }) as never,
        ),
        FRIDAY_SESSION_ERROR_CODES.FORK_MERGE_VALIDATION_ERROR,
      );
    });

    it("validates missing forkSessionKey", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.forks.merge")!;

      await expectRouteError(
        route.handler(
          makeMockCtx({
            params: { sessionKey: "discord:default:user1" },
            body: { summary: "done" },
          }) as never,
        ),
        FRIDAY_SESSION_ERROR_CODES.FORK_MERGE_VALIDATION_ERROR,
      );
    });

    it("calls mergeForkSummary on valid body", async () => {
      const svc = createMockService();
      vi.mocked(svc.mergeForkSummary).mockResolvedValue({
        parentMessage: makeMockMessage(),
        forkSession: makeMockSession({ status: "archived" }),
      });

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.forks.merge")!;

      const result = await route.handler(
        makeMockCtx({
          params: { sessionKey: "discord:default:user1" },
          body: {
            forkSessionKey: "subagent:discord:default:user1:task-1",
            summary: "Task completed successfully",
          },
        }) as never,
      );

      expect(result).toHaveProperty("result");
      expect(svc.mergeForkSummary).toHaveBeenCalledWith("discord:default:user1", {
        forkSessionKey: "subagent:discord:default:user1:task-1",
        summary: "Task completed successfully",
        archiveFork: undefined,
        idempotencyKey: undefined,
        metadata: undefined,
      });
    });
  });

  // ─── sessions.run (legacy compatibility) ───

  describe("sessions.run", () => {
    it("returns 501 when runSession is not configured", async () => {
      const svc = createMockService();
      vi.mocked(svc.getMessages).mockResolvedValue([makeMockMessage()]);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.run")!;

      await expectRouteError(
        route.handler(
          makeMockCtx({
            params: { sessionKey: "discord:default:user1" },
            body: {},
          }) as never,
        ),
        FRIDAY_SESSION_ERROR_CODES.INVALID_INPUT,
      );
    });

    it("uses latest user message as task when explicitly requested", async () => {
      const svc = createMockService();
      const runSession = vi.fn().mockResolvedValue({
        runId: "run-1",
        status: "completed",
        response: "FRIDAY_E2E_OK",
        toolCallCount: 0,
        durationMs: 100,
        usageInput: 10,
        usageOutput: 5,
      });

      const userMessage = makeMockMessage({
        role: "user",
        contentText: "Reply exactly FRIDAY_E2E_OK",
      });
      const assistantMessage = makeMockMessage({
        id: "msg-2",
        role: "assistant",
        contentText: "FRIDAY_E2E_OK",
      });

      vi.mocked(svc.getMessages)
        .mockResolvedValueOnce([userMessage])
        .mockResolvedValueOnce([userMessage, assistantMessage]);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true,
        sessionService: svc,
        runSession,
      });
      const route = routes.find((r) => r.operationId === "sessions.run")!;

      const result = await route.handler(
        makeMockCtx({
          params: { sessionKey: "discord:default:user1" },
          body: { useLastUserMessage: true },
          principal: makeBoundPrincipal(),
        }) as never,
      );

      expect(runSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionKey: "discord:default:user1",
        task: "Reply exactly FRIDAY_E2E_OK",
        providerId: undefined,
        model: undefined,
        timeoutMs: undefined,
        persistTaskMessage: false,
        taskAlreadyInHistory: true,
      }));
      expect(result).toEqual({
        run: {
          runId: "run-1",
          status: "completed",
          response: "FRIDAY_E2E_OK",
          toolCallCount: 0,
          durationMs: 100,
          usageInput: 10,
          usageOutput: 5,
        },
        messages: [
          { role: "user", content: "Reply exactly FRIDAY_E2E_OK" },
          { role: "assistant", content: "FRIDAY_E2E_OK" },
        ],
      });
    });

    it("rejects omitted task unless latest-message reuse is explicit", async () => {
      const svc = createMockService();
      const runSession = vi.fn();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true,
        sessionService: svc,
        runSession,
      });
      const route = routes.find((r) => r.operationId === "sessions.run")!;

      await expect(
        route.handler(
          makeMockCtx({
            params: { sessionKey: "discord:default:user1" },
            body: {},
          }) as never,
        ),
      ).rejects.toThrow("task is required for public session runs");
      expect(svc.getMessages).not.toHaveBeenCalled();
      expect(runSession).not.toHaveBeenCalled();
    });

    it("marks persistTaskMessage=true when task is provided in request body", async () => {
      const svc = createMockService();
      const runSession = vi.fn().mockResolvedValue({
        runId: "run-2",
        status: "completed",
        response: "ok",
        toolCallCount: 0,
        durationMs: 50,
        usageInput: 1,
        usageOutput: 1,
      });

      vi.mocked(svc.getMessages).mockResolvedValue([
        makeMockMessage({ role: "user", contentText: "hello" }),
      ]);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true,
        sessionService: svc,
        runSession,
      });
      const route = routes.find((r) => r.operationId === "sessions.run")!;

      await route.handler(
        makeMockCtx({
          params: { sessionKey: "discord:default:user1" },
          body: { task: "do this now" },
        }) as never,
      );

      expect(runSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionKey: "discord:default:user1",
        task: "do this now",
        providerId: undefined,
        model: undefined,
        replyToMessageId: undefined,
        timeoutMs: undefined,
        persistTaskMessage: true,
        taskAlreadyInHistory: false,
      }));
    });

    it("isolates unauthenticated public session runs from server-workspace tools", async () => {
      const svc = createMockService();
      const runSession = vi.fn().mockResolvedValue({
        runId: "run-public-session",
        status: "completed",
        response: "ok",
        toolCallCount: 0,
        durationMs: 50,
        usageInput: 1,
        usageOutput: 1,
      });

      vi.mocked(svc.getMessages).mockResolvedValue([
        makeMockMessage({ role: "user", contentText: "hello" }),
      ]);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true,
        sessionService: svc,
        runSession,
      });
      const route = routes.find((r) => r.operationId === "sessions.run")!;

      const result = await route.handler(
        makeMockCtx({
          params: { sessionKey: "discord:default:user1" },
          body: {
            task: "Read AGENTS.md from the server workspace",
            providerId: "openai",
            model: "gpt-4o",
          },
          principal: null,
        }) as never,
      );

      expect(runSession).toHaveBeenCalledWith(expect.objectContaining({
        constraints: {
          readOnly: true,
          operationalMode: "restricted",
          dataSensitivity: "public",
        },
        disabledToolNames: [
          "read",
          "write",
          "edit",
          "exec",
          "pdf_parse",
          "image_analysis",
          "memory_search",
          "memory_query",
          "memory_get",
          "memory_store",
          "memory_extract",
          "feedback",
        ],
      }));
      const input = vi.mocked(runSession).mock.calls.at(-1)?.[0];
      expect(input?.principalId).toBeUndefined();
      expect(input?.scopes).toBeUndefined();
      expect(input?.tenantContext).toBeUndefined();
      expect(svc.getOrCreateSession).not.toHaveBeenCalled();
      expect(svc.getMessages).not.toHaveBeenCalled();
      expect(result).toEqual({
        run: {
          runId: "run-public-session",
          status: "completed",
          response: "ok",
          toolCallCount: 0,
          durationMs: 50,
          usageInput: 1,
          usageOutput: 1,
        },
        messages: [
          { role: "user", content: "Read AGENTS.md from the server workspace" },
          { role: "assistant", content: "ok" },
        ],
      });
    });

    it("rejects public latest-message reuse without reading private session history", async () => {
      const svc = createMockService();
      const runSession = vi.fn();

      vi.mocked(svc.getMessages).mockResolvedValue([
        makeMockMessage({ role: "user", contentText: "PRIVATE_CONTEXT_SHOULD_NOT_REPLAY" }),
      ]);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true,
        sessionService: svc,
        runSession,
      });
      const route = routes.find((r) => r.operationId === "sessions.run")!;

      await expect(
        route.handler(
          makeMockCtx({
            params: { sessionKey: "discord:default:user1" },
            body: { useLastUserMessage: true },
            principal: null,
          }) as never,
        ),
      ).rejects.toThrow("task is required for public session runs");
      expect(svc.getMessages).not.toHaveBeenCalled();
      expect(runSession).not.toHaveBeenCalled();
    });

    it("treats synthetic public session runs as public without tenant/provider context", async () => {
      const svc = createMockService();
      const runSession = vi.fn().mockResolvedValue({
        runId: "run-synthetic-public-session",
        status: "completed",
        response: "ok",
        toolCallCount: 0,
        durationMs: 50,
        usageInput: 1,
        usageOutput: 1,
      });

      vi.mocked(svc.getMessages).mockResolvedValue([
        makeMockMessage({ role: "user", contentText: "hello" }),
      ]);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true,
        sessionService: svc,
        runSession,
      });
      const route = routes.find((r) => r.operationId === "sessions.run")!;

      await route.handler(
        makeMockCtx({
          params: { sessionKey: "discord:default:user1" },
          body: { task: "Inspect repository files" },
          principal: {
            principalType: "user",
            principalId: "public:default",
            userId: "00000000-0000-0000-0000-000000000001",
            role: "admin",
            scopes: ["agent.run"],
            tokenId: "00000000-0000-0000-0000-000000000002",
            tokenKind: "access",
            issuedAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2026-01-01T01:00:00.000Z",
          },
        }) as never,
      );

      const input = vi.mocked(runSession).mock.calls.at(-1)?.[0];
      expect(input).toEqual(expect.objectContaining({
        constraints: {
          readOnly: true,
          operationalMode: "restricted",
          dataSensitivity: "public",
        },
        disabledToolNames: [
          "read",
          "write",
          "edit",
          "exec",
          "pdf_parse",
          "image_analysis",
          "memory_search",
          "memory_query",
          "memory_get",
          "memory_store",
          "memory_extract",
          "feedback",
        ],
      }));
      expect(input?.principalId).toBeUndefined();
      expect(input?.scopes).toBeUndefined();
      expect(input?.tenantContext).toBeUndefined();
    });

    it("forwards replyToMessageId to runSession", async () => {
      const svc = createMockService();
      const runSession = vi.fn().mockResolvedValue({
        runId: "run-2",
        status: "completed",
        response: "ok",
        toolCallCount: 0,
        durationMs: 50,
        usageInput: 1,
        usageOutput: 1,
      });

      vi.mocked(svc.getMessages).mockResolvedValue([
        makeMockMessage({ role: "user", contentText: "hello" }),
      ]);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true,
        sessionService: svc,
        runSession,
      });
      const route = routes.find((r) => r.operationId === "sessions.run")!;

      await route.handler(
        makeMockCtx({
          params: { sessionKey: "discord:default:user1" },
          body: { task: "do this now", replyToMessageId: "msg-42" },
        }) as never,
      );

      expect(runSession).toHaveBeenCalledWith(
        expect.objectContaining({
          replyToMessageId: "msg-42",
        }),
      );
    });

    it("forwards principal context to runSession", async () => {
      const svc = createMockService();
      const runSession = vi.fn().mockResolvedValue({
        runId: "run-1",
        status: "completed",
        response: "ok",
        toolCallCount: 0,
        durationMs: 50,
        usageInput: 1,
        usageOutput: 1,
      });

      vi.mocked(svc.getMessages)
        .mockResolvedValueOnce([makeMockMessage({ role: "user", contentText: "hello" })])
        .mockResolvedValueOnce([makeMockMessage({ role: "user", contentText: "hello" })]);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true,
        sessionService: svc,
        runSession,
      });
      const route = routes.find((r) => r.operationId === "sessions.run")!;

      await route.handler(
        makeMockCtx({
          params: { sessionKey: "discord:default:user1" },
          body: { useLastUserMessage: true },
          principal: {
            principalType: "user",
            principalId: "principal-1",
            userId: "user-1",
            role: "owner",
            scopes: ["agent.run"],
            tokenId: "token-1",
            tokenKind: "access",
            issuedAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2026-01-01T01:00:00.000Z",
          },
        }) as never,
      );

      expect(runSession).toHaveBeenCalledWith(
        expect.objectContaining({
          principalId: "principal-1",
          scopes: ["agent.run"],
        }),
      );
    });

    it("derives tenantContext from authenticated principal for session runs", async () => {
      const svc = createMockService();
      const runSession = vi.fn().mockResolvedValue({
        runId: "run-1",
        status: "completed",
        response: "ok",
        toolCallCount: 0,
        durationMs: 50,
        usageInput: 1,
        usageOutput: 1,
      });

      vi.mocked(svc.getMessages)
        .mockResolvedValueOnce([makeMockMessage({ role: "user", contentText: "hello" })])
        .mockResolvedValueOnce([makeMockMessage({ role: "user", contentText: "hello" })]);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true,
        sessionService: svc,
        runSession,
      });
      const route = routes.find((r) => r.operationId === "sessions.run")!;

      await route.handler(
        makeMockCtx({
          params: { sessionKey: "discord:default:user1" },
          body: { useLastUserMessage: true },
          principal: {
            principalType: "user",
            principalId: "principal-1",
            tenantId: "tenant-acme",
            userId: "user-1",
            role: "owner",
            scopes: ["agent.run"],
            tokenId: "token-1",
            tokenKind: "access",
            issuedAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2026-01-01T01:00:00.000Z",
          },
        }) as never,
      );

      expect(runSession).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantContext: {
            hubId: "tenant-acme",
            userId: "user-1",
          },
        }),
      );
    });

    it("does not overwrite an explicit session user/account with authenticated principal context", async () => {
      const svc = createMockService();
      const existingSession = makeMockSession({
        key: "web:tenant-custom:user-custom",
        channel: "web",
        accountId: "tenant-custom",
        chatId: "seed-chat",
        userId: "user-custom",
      });
      vi.mocked(svc.getOrCreateSession).mockResolvedValue(existingSession);
      vi.mocked(svc.getSession).mockResolvedValue(existingSession);
      vi.mocked(svc.addMessage).mockResolvedValue(makeMockMessage({
        sessionKey: existingSession.key,
        content: "hello",
        contentText: "hello",
      }));

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.messages.create")!;

      await route.handler(
        makeMockCtx({
          params: { sessionKey: existingSession.key },
          body: { role: "user", content: "hello" },
          principal: {
            principalType: "user",
            principalId: "principal-1",
            tenantId: "tenant-admin",
            userId: "admin-001",
            role: "owner",
            scopes: ["session.write"],
            tokenId: "token-1",
            tokenKind: "access",
            issuedAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2026-01-01T01:00:00.000Z",
          },
        }) as never,
      );

      expect(svc.alignSessionContext).not.toHaveBeenCalled();
      expect(svc.addMessage).toHaveBeenCalledWith(existingSession.key, {
        role: "user",
        content: "hello",
      });
    });

    it("validates timeoutMs in run body", async () => {
      const svc = createMockService();
      const runSession = vi.fn();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc, runSession });
      const route = routes.find((r) => r.operationId === "sessions.run")!;

      await expectRouteError(
        route.handler(
          makeMockCtx({
            params: { sessionKey: "discord:default:user1" },
            body: { timeoutMs: 0 },
          }) as never,
        ),
        FRIDAY_SESSION_ERROR_CODES.INVALID_INPUT,
      );
    });
  });

  // ─── Route paths and methods ───

  describe("route configuration", () => {
    it("has correct paths and methods", () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const routeMap = routes.map((r) => ({ id: r.operationId, method: r.method, path: r.path }));

      expect(routeMap).toContainEqual({ id: "sessions.list", method: "GET", path: "/v1/sessions" });
      expect(routeMap).toContainEqual({ id: "sessions.create", method: "POST", path: "/v1/sessions" });
      expect(routeMap).toContainEqual({ id: "sessions.get", method: "GET", path: "/v1/sessions/:sessionKey" });
      expect(routeMap).toContainEqual({ id: "sessions.archive", method: "POST", path: "/v1/sessions/:sessionKey/archive" });
      expect(routeMap).toContainEqual({ id: "sessions.prune", method: "POST", path: "/v1/sessions/prune" });
      expect(routeMap).toContainEqual({ id: "sessions.sweep", method: "POST", path: "/v1/sessions/sweep" });
      expect(routeMap).toContainEqual({ id: "sessions.messages.list", method: "GET", path: "/v1/sessions/:sessionKey/messages" });
      expect(routeMap).toContainEqual({ id: "sessions.export", method: "GET", path: "/v1/sessions/:sessionKey/export" });
      expect(routeMap).toContainEqual({ id: "sessions.messages.create", method: "POST", path: "/v1/sessions/:sessionKey/messages" });
      expect(routeMap).toContainEqual({ id: "sessions.outbound.send", method: "POST", path: "/v1/sessions/:sessionKey/outbound" });
      expect(routeMap).toContainEqual({ id: "sessions.run", method: "POST", path: "/v1/sessions/:sessionKey/run" });
      expect(routeMap).toContainEqual({ id: "sessions.memory.namespace.get", method: "GET", path: "/v1/sessions/:sessionKey/memory-namespace" });
      expect(routeMap).toContainEqual({ id: "sessions.forks.create", method: "POST", path: "/v1/sessions/:sessionKey/fork" });
      expect(routeMap).toContainEqual({ id: "sessions.forks.list", method: "GET", path: "/v1/sessions/:sessionKey/forks" });
      expect(routeMap).toContainEqual({ id: "sessions.forks.merge", method: "POST", path: "/v1/sessions/:sessionKey/merge" });
    });
  });

  // ─── Extraction route validation (Issue #3) ───

  function createMockExtractionService(): FridaySessionMemoryExtractionService {
    return {
      extractFromSession: vi.fn().mockResolvedValue({
        sessionKey: "discord:default:user1",
        trigger: "manual",
        mode: "inline",
        queued: false,
        processedMessageCount: 0,
        extractedMessageCount: 0,
        skippedMessageCount: 0,
        failedMessageCount: 0,
        memoryItemsCreated: 0,
      }),
      extractSpecificMessages: vi.fn().mockResolvedValue({
        sessionKey: "discord:default:user1",
        trigger: "manual",
        mode: "inline",
        queued: false,
        processedMessageCount: 0,
        extractedMessageCount: 0,
        skippedMessageCount: 0,
        failedMessageCount: 0,
        memoryItemsCreated: 0,
      }),
      getExtractionStatus: vi.fn().mockResolvedValue({
        sessionKey: "discord:default:user1",
        pendingMessages: 0,
        extractedMessages: 0,
        skippedMessages: 0,
        failedMessages: 0,
        queuedJobs: 0,
        runningJobs: 0,
      }),
      retryFailedExtractions: vi.fn().mockResolvedValue({
        sessionsQueued: [],
        resetMessageCount: 0,
      }),
    };
  }

  describe("sessions.memory.extract", () => {
    it("throws 501 when extraction service not configured", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.memory.extract")!;

      await expectRouteError(
        route.handler(
          makeMockCtx({ params: { sessionKey: "discord:default:user1" }, body: {} }) as never,
        ),
        FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.PROVIDER_ERROR,
      );
    });

    it("rejects invalid trigger value", async () => {
      const svc = createMockService();
      const extractSvc = createMockExtractionService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc, extractionService: extractSvc });
      const route = routes.find((r) => r.operationId === "sessions.memory.extract")!;

      await expectRouteError(
        route.handler(
          makeMockCtx({
            params: { sessionKey: "discord:default:user1" },
            body: { trigger: "invalid_trigger" },
          }) as never,
        ),
        FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.INVALID_INPUT,
      );
    });

    it("rejects invalid mode value", async () => {
      const svc = createMockService();
      const extractSvc = createMockExtractionService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc, extractionService: extractSvc });
      const route = routes.find((r) => r.operationId === "sessions.memory.extract")!;

      await expectRouteError(
        route.handler(
          makeMockCtx({
            params: { sessionKey: "discord:default:user1" },
            body: { mode: "streaming" },
          }) as never,
        ),
        FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.INVALID_INPUT,
      );
    });

    it("rejects non-integer batchSize", async () => {
      const svc = createMockService();
      const extractSvc = createMockExtractionService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc, extractionService: extractSvc });
      const route = routes.find((r) => r.operationId === "sessions.memory.extract")!;

      await expectRouteError(
        route.handler(
          makeMockCtx({
            params: { sessionKey: "discord:default:user1" },
            body: { batchSize: -1 },
          }) as never,
        ),
        FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.INVALID_INPUT,
      );
    });

    it("rejects non-integer maxBatches", async () => {
      const svc = createMockService();
      const extractSvc = createMockExtractionService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc, extractionService: extractSvc });
      const route = routes.find((r) => r.operationId === "sessions.memory.extract")!;

      await expectRouteError(
        route.handler(
          makeMockCtx({
            params: { sessionKey: "discord:default:user1" },
            body: { maxBatches: 0 },
          }) as never,
        ),
        FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.INVALID_INPUT,
      );
    });

    it("accepts valid extract body and calls service", async () => {
      const svc = createMockService();
      const extractSvc = createMockExtractionService();
      vi.mocked(svc.alignSessionContext).mockResolvedValue(makeMockSession({
        accountId: "admin-001",
        userId: "admin-001",
        memoryNamespace: "tenant.admin-001.channel.discord.user.admin-001.shared",
      }));
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc, extractionService: extractSvc });
      const route = routes.find((r) => r.operationId === "sessions.memory.extract")!;

      const result = await route.handler(
        makeMockCtx({
          params: { sessionKey: "discord:default:user1" },
          body: { trigger: "manual", mode: "inline", batchSize: 10, maxBatches: 2 },
          principal: {
            principalType: "user",
            principalId: "admin-001",
            tenantId: "admin-001",
            userId: "admin-001",
            scopes: ["session.write"],
            tokenId: "tok-1",
            tokenKind: "access",
            issuedAt: "2026-01-01T00:00:00.000Z",
          },
        }) as never,
      );

      expect(result).toHaveProperty("result");
      expect(svc.alignSessionContext).toHaveBeenCalledWith("discord:default:user1", {
        accountId: "admin-001",
        userId: "admin-001",
      });
      expect(extractSvc.extractFromSession).toHaveBeenCalledWith(
        "discord:default:user1",
        { trigger: "manual", mode: "inline", batchSize: 10, maxBatches: 2 },
      );
    });

    it("accepts empty body (all defaults)", async () => {
      const svc = createMockService();
      const extractSvc = createMockExtractionService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc, extractionService: extractSvc });
      const route = routes.find((r) => r.operationId === "sessions.memory.extract")!;

      const result = await route.handler(
        makeMockCtx({
          params: { sessionKey: "discord:default:user1" },
          body: {},
        }) as never,
      );

      expect(result).toHaveProperty("result");
    });
  });

  describe("sessions.memory.extraction.retry", () => {
    it("throws 501 when extraction service not configured", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.memory.extraction.retry")!;

      await expectRouteError(
        route.handler(makeMockCtx({ body: {} }) as never),
        FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.PROVIDER_ERROR,
      );
    });

    it("rejects empty string sessionKey", async () => {
      const svc = createMockService();
      const extractSvc = createMockExtractionService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc, extractionService: extractSvc });
      const route = routes.find((r) => r.operationId === "sessions.memory.extraction.retry")!;

      await expectRouteError(
        route.handler(makeMockCtx({ body: { sessionKey: "" } }) as never),
        FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.INVALID_INPUT,
      );
    });

    it("accepts valid retry body", async () => {
      const svc = createMockService();
      const extractSvc = createMockExtractionService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc, extractionService: extractSvc });
      const route = routes.find((r) => r.operationId === "sessions.memory.extraction.retry")!;

      const result = await route.handler(
        makeMockCtx({ body: { sessionKey: "discord:default:user1" } }) as never,
      );

      expect(result).toHaveProperty("result");
      expect(extractSvc.retryFailedExtractions).toHaveBeenCalledWith("discord:default:user1");
    });

    it("accepts empty body (retry all)", async () => {
      const svc = createMockService();
      const extractSvc = createMockExtractionService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc, extractionService: extractSvc });
      const route = routes.find((r) => r.operationId === "sessions.memory.extraction.retry")!;

      const result = await route.handler(makeMockCtx({ body: {} }) as never);

      expect(result).toHaveProperty("result");
      expect(extractSvc.retryFailedExtractions).toHaveBeenCalledWith(undefined);
    });
  });

  describe("sessions.memory.extraction.get", () => {
    it("throws 501 when extraction service not configured", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.memory.extraction.get")!;

      await expectRouteError(
        route.handler(
          makeMockCtx({ params: { sessionKey: "discord:default:user1" } }) as never,
        ),
        FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.PROVIDER_ERROR,
      );
    });

    it("returns status when extraction service is configured", async () => {
      const svc = createMockService();
      vi.mocked(svc.getSession).mockResolvedValue(makeMockSession({
        accountId: "00000000-0000-0000-0000-000000000101",
        userId: "00000000-0000-0000-0000-000000000102",
      }));
      const extractSvc = createMockExtractionService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc, extractionService: extractSvc });
      const route = routes.find((r) => r.operationId === "sessions.memory.extraction.get")!;

      const result = await route.handler(
        makeMockCtx({
          params: { sessionKey: "discord:default:user1" },
          principal: makeBoundPrincipal(),
        }) as never,
      );

      expect(result).toHaveProperty("status");
    });

    it("NEW-30 red: rejects extraction status reads for a session owned by a different principal", async () => {
      const svc = createMockService();
      vi.mocked(svc.getSession).mockResolvedValue(makeMockSession({
        accountId: "tenant-victim",
        userId: "user-victim",
      }));
      const extractSvc = createMockExtractionService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc, extractionService: extractSvc });
      const route = routes.find((r) => r.operationId === "sessions.memory.extraction.get")!;

      await expectRouteError(
        route.handler(
          makeMockCtx({
            params: { sessionKey: "discord:tenant-victim:user-victim" },
            principal: makeBoundPrincipal({
              tenantId: "tenant-attacker",
              userId: "user-attacker",
              scopes: ["session.read"],
              role: "viewer",
            }),
          }) as never,
        ),
        "SESSION_OWNER_MISMATCH",
      );
      expect(extractSvc.getExtractionStatus).not.toHaveBeenCalled();
    });
  });

  describe("sessions.memory.remember", () => {
    it("throws 501 when extraction service not configured", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.memory.remember")!;

      await expectRouteError(
        route.handler(
          makeMockCtx({
            params: { sessionKey: "discord:default:user1" },
            body: { messageIds: ["msg-1"] },
          }) as never,
        ),
        FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.PROVIDER_ERROR,
      );
    });

    it("aligns session context before remembering messages for an authenticated user", async () => {
      const svc = createMockService();
      vi.mocked(svc.alignSessionContext).mockResolvedValue(makeMockSession({
        accountId: "admin-001",
        userId: "admin-001",
      }));
      const extractSvc = createMockExtractionService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc, extractionService: extractSvc });
      const route = routes.find((r) => r.operationId === "sessions.memory.remember")!;

      await route.handler(
        makeMockCtx({
          params: { sessionKey: "discord:default:user1" },
          body: { messageIds: ["msg-1"] },
          principal: {
            principalType: "user",
            principalId: "admin-001",
            tenantId: "admin-001",
            userId: "admin-001",
            scopes: ["session.write"],
            tokenId: "tok-1",
            tokenKind: "access",
            issuedAt: "2026-01-01T00:00:00.000Z",
          },
        }) as never,
      );

      expect(svc.alignSessionContext).toHaveBeenCalledWith("discord:default:user1", {
        accountId: "admin-001",
        userId: "admin-001",
      });
    });
  });

  // ─── VULN-1: Metadata prototype pollution sanitization ───

  describe("sessions.create — metadata sanitization", () => {
    it("rejects __proto__ key in metadata with VALIDATION_ERROR (400)", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const createRoute = routes.find((r) => r.operationId === "sessions.create")!;

      // Use JSON.parse to create an actual own-property __proto__ key (like HTTP body parsing does)
      const metadata = JSON.parse('{"__proto__": {"polluted": true}}');

      await expectRouteError(
        createRoute.handler(
          makeMockCtx({
            body: { channel: "test", chatId: "test", metadata },
          }) as never,
        ),
        "VALIDATION_ERROR",
      );
    });

    it("rejects constructor key in metadata with VALIDATION_ERROR (400)", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const createRoute = routes.find((r) => r.operationId === "sessions.create")!;

      await expectRouteError(
        createRoute.handler(
          makeMockCtx({
            body: { channel: "test", chatId: "test", metadata: { constructor: { prototype: { x: 1 } } } },
          }) as never,
        ),
        "VALIDATION_ERROR",
      );
    });

    it("rejects prototype key in metadata with VALIDATION_ERROR (400)", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const createRoute = routes.find((r) => r.operationId === "sessions.create")!;

      await expectRouteError(
        createRoute.handler(
          makeMockCtx({
            body: { channel: "test", chatId: "test", metadata: { prototype: { bad: true } } },
          }) as never,
        ),
        "VALIDATION_ERROR",
      );
    });

    it("rejects deeply nested forbidden keys in metadata", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const createRoute = routes.find((r) => r.operationId === "sessions.create")!;

      // Use JSON.parse for nested __proto__ key
      const nestedMetadata = JSON.parse('{"a": {"b": {"__proto__": {"polluted": true}}}}');

      await expectRouteError(
        createRoute.handler(
          makeMockCtx({
            body: { channel: "test", chatId: "test", metadata: nestedMetadata },
          }) as never,
        ),
        "VALIDATION_ERROR",
      );
    });

    it("rejects non-object metadata (e.g. array)", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const createRoute = routes.find((r) => r.operationId === "sessions.create")!;

      await expectRouteError(
        createRoute.handler(
          makeMockCtx({
            body: { channel: "test", chatId: "test", metadata: [1, 2, 3] },
          }) as never,
        ),
        "VALIDATION_ERROR",
      );
    });

    it("passes valid nested metadata through to service (null-prototype)", async () => {
      const svc = createMockService();
      vi.mocked(svc.createSession).mockResolvedValue(makeMockSession());

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const createRoute = routes.find((r) => r.operationId === "sessions.create")!;

      await createRoute.handler(
        makeMockCtx({
          body: { channel: "test", chatId: "test", metadata: { safe: { nested: true }, count: 42 } },
        }) as never,
      );

      const calledWith = vi.mocked(svc.createSession).mock.calls[0][0];
      expect(calledWith.metadata).toEqual({ safe: { nested: true }, count: 42 });
      // Verify null-prototype (no inherited properties)
      expect(Object.getPrototypeOf(calledWith.metadata)).toBeNull();
    });
  });

  describe("sessions.forks.create — metadata sanitization", () => {
    it("rejects __proto__ key in fork metadata", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.forks.create")!;

      const metadata = JSON.parse('{"__proto__": {"polluted": true}}');

      await expectRouteError(
        route.handler(
          makeMockCtx({
            params: { sessionKey: "discord:default:user1" },
            body: { metadata },
          }) as never,
        ),
        "VALIDATION_ERROR",
      );
    });
  });

  describe("sessions.forks.merge — metadata sanitization", () => {
    it("rejects __proto__ key in merge metadata", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.forks.merge")!;

      const metadata = JSON.parse('{"__proto__": {"polluted": true}}');

      await expectRouteError(
        route.handler(
          makeMockCtx({
            params: { sessionKey: "discord:default:user1" },
            body: {
              forkSessionKey: "subagent:discord:default:user1:task-1",
              summary: "done",
              metadata,
            },
          }) as never,
        ),
        "VALIDATION_ERROR",
      );
    });
  });

  // ─── FRI-SEC-010: Limit capping ───

  describe("sessions.list — limit cap", () => {
    it("caps limit to 100 when query limit exceeds maximum", async () => {
      const svc = createMockService();
      vi.mocked(svc.listSessions).mockResolvedValue([]);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const listRoute = routes.find((r) => r.operationId === "sessions.list")!;

      await listRoute.handler(
        makeMockCtx({ query: { limit: "500" }, principal: makeBoundPrincipal() }) as never,
      );

      expect(svc.listSessions).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100 }),
      );
    });
  });

  describe("sessions.messages.list — limit cap", () => {
    it("caps limit to 100 when query limit exceeds maximum", async () => {
      const svc = createMockService();
      vi.mocked(svc.getSession).mockResolvedValue(makeMockSession({
        accountId: "00000000-0000-0000-0000-000000000101",
        userId: "00000000-0000-0000-0000-000000000102",
      }));
      vi.mocked(svc.getMessages).mockResolvedValue([]);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const messagesRoute = routes.find((r) => r.operationId === "sessions.messages.list")!;

      await messagesRoute.handler(
        makeMockCtx({
          params: { sessionKey: "discord:default:user1" },
          query: { limit: "500" },
          principal: makeBoundPrincipal(),
        }) as never,
      );

      expect(svc.getMessages).toHaveBeenCalledWith("discord:default:user1", 100, undefined);
    });
  });

  describe("sessions.forks.list — limit cap", () => {
    it("caps limit to 100 when query limit exceeds maximum", async () => {
      const svc = createMockService();
      vi.mocked(svc.getSession).mockResolvedValue(makeMockSession({
        accountId: "00000000-0000-0000-0000-000000000101",
        userId: "00000000-0000-0000-0000-000000000102",
      }));
      vi.mocked(svc.listForks).mockResolvedValue([]);

      const routes = createFridaySessionRoutes({ allowTestOnlySessionExecution: true, allowTestOnlySessionRunExecution: true, allowTestOnlySessionMemoryExtractionExecution: true, sessionService: svc });
      const forksRoute = routes.find((r) => r.operationId === "sessions.forks.list")!;

      await forksRoute.handler(
        makeMockCtx({
          params: { sessionKey: "discord:default:user1" },
          query: { limit: "500" },
          principal: makeBoundPrincipal(),
        }) as never,
      );

      expect(svc.listForks).toHaveBeenCalledWith("discord:default:user1", expect.objectContaining({ limit: 100 }));
    });
  });
});

describe("TS runtime retirement — session mutations fail-close by default", () => {
  function makeRetiredExtractionService(): FridaySessionMemoryExtractionService {
    return {
      extractFromSession: vi.fn(),
      extractSpecificMessages: vi.fn(),
      getExtractionStatus: vi.fn(),
      retryFailedExtractions: vi.fn(),
    };
  }

  function buildRetiredRoutes() {
    const sessionService = createMockService();
    const extractionService = makeRetiredExtractionService();
    const channelRegistry = { send: vi.fn().mockResolvedValue({ messageId: "discord-msg-1" }) };
    const runSession = vi.fn();
    const routes = createFridaySessionRoutes({
      sessionService,
      extractionService,
      channelRegistry: channelRegistry as never,
      runSession,
      allowTestOnlySessionExecution: false,
      allowTestOnlySessionRunExecution: false,
      allowTestOnlySessionMemoryExtractionExecution: false,
    });
    return { routes, sessionService, extractionService, channelRegistry, runSession };
  }

  async function expectFailClosed(fn: Promise<unknown>, code: string): Promise<void> {
    try {
      await fn;
      expect.fail("Expected FridayDomainError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FridayDomainError);
      expect((err as FridayDomainError).code).toBe(code);
      expect((err as FridayDomainError).httpStatus).toBe(503);
    }
  }

  it("(a) fail-closes sessions.create with TS_RUNTIME_SESSION_RETIRED before calling the service", async () => {
    const { routes, sessionService } = buildRetiredRoutes();
    const route = routes.find((r) => r.operationId === "sessions.create")!;

    await expectFailClosed(
      route.handler(
        makeMockCtx({
          body: { channel: "discord", chatId: "user1" },
          principal: makeBoundPrincipal(),
        }) as never,
      ),
      "TS_RUNTIME_SESSION_RETIRED",
    );
    expect(sessionService.createSession).not.toHaveBeenCalled();
  });

  it("(b) fail-closes sessions.run with TS_RUNTIME_SESSION_RUN_RETIRED before invoking runSession", async () => {
    const { routes, runSession } = buildRetiredRoutes();
    const route = routes.find((r) => r.operationId === "sessions.run")!;

    await expectFailClosed(
      route.handler(
        makeMockCtx({
          params: { sessionKey: "discord:default:user1" },
          body: { task: "do something" },
          principal: makeBoundPrincipal(),
        }) as never,
      ),
      "TS_RUNTIME_SESSION_RUN_RETIRED",
    );
    expect(runSession).not.toHaveBeenCalled();
  });

  it("(c) fail-closes sessions.memory.extract with TS_RUNTIME_SESSION_MEMORY_EXTRACTION_RETIRED before extracting", async () => {
    const { routes, extractionService, sessionService } = buildRetiredRoutes();
    const route = routes.find((r) => r.operationId === "sessions.memory.extract")!;

    await expectFailClosed(
      route.handler(
        makeMockCtx({
          params: { sessionKey: "discord:default:user1" },
          body: {},
          principal: makeBoundPrincipal(),
        }) as never,
      ),
      "TS_RUNTIME_SESSION_MEMORY_EXTRACTION_RETIRED",
    );
    expect(extractionService.extractFromSession).not.toHaveBeenCalled();
    expect(sessionService.alignSessionContext).not.toHaveBeenCalled();
  });

  it.each([
    {
      operationId: "sessions.delete",
      ctx: makeMockCtx({
        params: { sessionKey: "discord:default:user1" },
        principal: makeBoundPrincipal(),
      }),
      assertNoCall: ({ sessionService }: ReturnType<typeof buildRetiredRoutes>) => {
        expect(sessionService.archiveSession).not.toHaveBeenCalled();
      },
    },
    {
      operationId: "sessions.archive",
      ctx: makeMockCtx({
        params: { sessionKey: "discord:default:user1" },
        principal: makeBoundPrincipal(),
      }),
      assertNoCall: ({ sessionService }: ReturnType<typeof buildRetiredRoutes>) => {
        expect(sessionService.archiveSession).not.toHaveBeenCalled();
      },
    },
    {
      operationId: "sessions.reset",
      ctx: makeMockCtx({
        params: { sessionKey: "discord:default:user1" },
        principal: makeBoundPrincipal(),
      }),
      assertNoCall: ({ sessionService }: ReturnType<typeof buildRetiredRoutes>) => {
        expect(sessionService.resetSession).not.toHaveBeenCalled();
      },
    },
    {
      operationId: "sessions.prune",
      ctx: makeMockCtx({
        body: { olderThan: "2026-01-01T00:00:00.000Z" },
        principal: makeBoundPrincipal(),
      }),
      assertNoCall: ({ sessionService }: ReturnType<typeof buildRetiredRoutes>) => {
        expect(sessionService.pruneOldSessions).not.toHaveBeenCalled();
      },
    },
    {
      operationId: "sessions.sweep",
      ctx: makeMockCtx({ principal: makeBoundPrincipal() }),
      assertNoCall: ({ sessionService }: ReturnType<typeof buildRetiredRoutes>) => {
        expect(sessionService.sweepLifecycle).not.toHaveBeenCalled();
      },
    },
    {
      operationId: "sessions.compact",
      ctx: makeMockCtx({
        params: { sessionKey: "discord:default:user1" },
        body: { summary: "compacted" },
        principal: makeBoundPrincipal(),
      }),
      assertNoCall: ({ sessionService }: ReturnType<typeof buildRetiredRoutes>) => {
        expect(sessionService.getMessages).not.toHaveBeenCalled();
        expect(sessionService.setConversationFocus).not.toHaveBeenCalled();
        expect(sessionService.mergeMetadata).not.toHaveBeenCalled();
      },
    },
    {
      operationId: "sessions.messages.create",
      ctx: makeMockCtx({
        params: { sessionKey: "discord:default:user1" },
        body: { role: "user", content: "hello" },
        principal: makeBoundPrincipal(),
      }),
      assertNoCall: ({ sessionService }: ReturnType<typeof buildRetiredRoutes>) => {
        expect(sessionService.getOrCreateSession).not.toHaveBeenCalled();
        expect(sessionService.addMessage).not.toHaveBeenCalled();
      },
    },
    {
      operationId: "sessions.forks.create",
      ctx: makeMockCtx({
        params: { sessionKey: "discord:default:user1" },
        body: {},
        principal: makeBoundPrincipal(),
      }),
      assertNoCall: ({ sessionService }: ReturnType<typeof buildRetiredRoutes>) => {
        expect(sessionService.forkSession).not.toHaveBeenCalled();
      },
    },
    {
      operationId: "sessions.forks.merge",
      ctx: makeMockCtx({
        params: { sessionKey: "discord:default:user1" },
        body: { forkSessionKey: "subagent:discord:default:user1:task-1", summary: "done" },
        principal: makeBoundPrincipal(),
      }),
      assertNoCall: ({ sessionService }: ReturnType<typeof buildRetiredRoutes>) => {
        expect(sessionService.mergeForkSummary).not.toHaveBeenCalled();
      },
    },
  ])(
    "fail-closes $operationId with TS_RUNTIME_SESSION_RETIRED before TypeScript session mutation",
    async ({ operationId, ctx, assertNoCall }) => {
      const retired = buildRetiredRoutes();
      const route = retired.routes.find((r) => r.operationId === operationId)!;

      await expectFailClosed(
        route.handler(ctx as never),
        "TS_RUNTIME_SESSION_RETIRED",
      );
      assertNoCall(retired);
    },
  );

  it.each([
    {
      operationId: "sessions.memory.remember",
      ctx: makeMockCtx({
        params: { sessionKey: "discord:default:user1" },
        body: { messageIds: ["msg-1"] },
        principal: makeBoundPrincipal(),
      }),
      assertNoCall: ({ extractionService, sessionService }: ReturnType<typeof buildRetiredRoutes>) => {
        expect(extractionService.extractSpecificMessages).not.toHaveBeenCalled();
        expect(sessionService.alignSessionContext).not.toHaveBeenCalled();
      },
    },
    {
      operationId: "sessions.memory.extraction.retry",
      ctx: makeMockCtx({
        body: { sessionKey: "discord:default:user1" },
        principal: makeBoundPrincipal(),
      }),
      assertNoCall: ({ extractionService }: ReturnType<typeof buildRetiredRoutes>) => {
        expect(extractionService.retryFailedExtractions).not.toHaveBeenCalled();
      },
    },
  ])(
    "fail-closes $operationId with TS_RUNTIME_SESSION_MEMORY_EXTRACTION_RETIRED before extraction mutation",
    async ({ operationId, ctx, assertNoCall }) => {
      const retired = buildRetiredRoutes();
      const route = retired.routes.find((r) => r.operationId === operationId)!;

      await expectFailClosed(
        route.handler(ctx as never),
        "TS_RUNTIME_SESSION_MEMORY_EXTRACTION_RETIRED",
      );
      assertNoCall(retired);
    },
  );

  it("(d) still rejects a malformed sessions.memory.extract body with the validation error (hoist proof, not 503)", async () => {
    const { routes, extractionService } = buildRetiredRoutes();
    const route = routes.find((r) => r.operationId === "sessions.memory.extract")!;

    try {
      await route.handler(
        makeMockCtx({
          params: { sessionKey: "discord:default:user1" },
          body: { trigger: "invalid_trigger" },
          principal: makeBoundPrincipal(),
        }) as never,
      );
      expect.fail("Expected FridayDomainError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FridayDomainError);
      expect((err as FridayDomainError).code).toBe(
        FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.INVALID_INPUT,
      );
      expect((err as FridayDomainError).code).not.toBe(
        "TS_RUNTIME_SESSION_MEMORY_EXTRACTION_RETIRED",
      );
    }
    expect(extractionService.extractFromSession).not.toHaveBeenCalled();
  });

  it("(e) keeps sessions.outbound.send functional (operator_external_adapter, no fail-close)", async () => {
    const { routes, sessionService, channelRegistry } = buildRetiredRoutes();
    vi.mocked(sessionService.getSession).mockResolvedValue(
      makeMockSession({ channel: "discord", chatId: "discord-channel-1" }),
    );
    vi.mocked(sessionService.addMessage).mockResolvedValue(
      makeMockMessage({ role: "assistant", content: "marker", contentText: "marker" }),
    );
    const route = routes.find((r) => r.operationId === "sessions.outbound.send")!;

    const result = await route.handler(
      makeMockCtx({
        params: { sessionKey: "discord:default:user1" },
        body: { text: "marker" },
        principal: makeBoundPrincipal(),
      }) as never,
    );

    expect(channelRegistry.send).toHaveBeenCalledWith(
      "discord",
      expect.objectContaining({ chatId: "discord-channel-1", text: "marker" }),
    );
    expect(result).toHaveProperty("delivery");
  });
});

describe("Rust session lifecycle bridge", () => {
  it("routes create/message/namespace through the Rust-owned bridge when enabled", async () => {
    const sessionService = createMockService();
    const rustSessionLifecycleBridge = {
      createSession: vi.fn().mockResolvedValue({
        session: makeMockSession({
          key: "closure:default:closure-chat",
          channel: "closure",
          accountId: "00000000-0000-0000-0000-000000000101",
          userId: "00000000-0000-0000-0000-000000000102",
          chatId: "closure-chat",
        }),
      }),
      appendMessage: vi.fn().mockResolvedValue({
        message: makeMockMessage({
          sessionKey: "closure:default:closure-chat",
          role: "user",
          content: "Remember that my favorite color is teal.",
          contentText: "Remember that my favorite color is teal.",
        }),
      }),
      getMemoryNamespace: vi.fn().mockResolvedValue({
        namespace:
          "tenant.00000000-0000-0000-0000-000000000101.channel.closure.user.00000000-0000-0000-0000-000000000102.shared",
      }),
    };

    const routes = createFridaySessionRoutes({
      sessionService,
      routeSessionsViaRust: true,
      rustSessionLifecycleBridge,
      allowTestOnlySessionExecution: false,
    });

    const create = routes.find((r) => r.operationId === "sessions.create")!;
    const createResult = await create.handler(
      makeMockCtx({
        body: {
          channel: "closure",
          chatId: "closure-chat",
          metadata: { source: "new79-reviewer-refute" },
        },
        principal: makeBoundPrincipal(),
      }) as never,
    );
    expect((createResult as { session: { key: string } }).session.key).toBe(
      "closure:default:closure-chat",
    );
    expect(rustSessionLifecycleBridge.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { source: "new79-reviewer-refute" },
        principal: expect.objectContaining({ principalId: "user:bound-1" }),
      }),
    );
    expect(sessionService.createSession).not.toHaveBeenCalled();

    const message = routes.find((r) => r.operationId === "sessions.messages.create")!;
    await message.handler(
      makeMockCtx({
        params: { sessionKey: "closure:default:closure-chat" },
        body: {
          role: "user",
          content: { text: "Remember that my favorite color is teal." },
          contentText: "Remember that my favorite color is teal.",
          toolCalls: [{ name: "memory.remember", arguments: { color: "teal" } }],
          tokenCount: 8,
          idempotencyKey: "idem-new79",
          parentMessageId: "msg-parent",
          metadata: { reviewer: "linnaeus" },
          timestamp: "2026-07-07T10:10:00.000Z",
        },
        principal: makeBoundPrincipal(),
      }) as never,
    );
    expect(rustSessionLifecycleBridge.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "closure:default:closure-chat",
        role: "user",
        content: { text: "Remember that my favorite color is teal." },
        contentText: "Remember that my favorite color is teal.",
        toolCalls: [{ name: "memory.remember", arguments: { color: "teal" } }],
        tokenCount: 8,
        idempotencyKey: "idem-new79",
        parentMessageId: "msg-parent",
        metadata: { reviewer: "linnaeus" },
        timestamp: "2026-07-07T10:10:00.000Z",
        principal: expect.objectContaining({ principalId: "user:bound-1" }),
      }),
    );
    expect(sessionService.addMessage).not.toHaveBeenCalled();

    const namespace = routes.find((r) => r.operationId === "sessions.memory.namespace.get")!;
    const namespaceResult = await namespace.handler(
      makeMockCtx({
        params: { sessionKey: "closure:default:closure-chat" },
        principal: makeBoundPrincipal(),
      }) as never,
    );
    expect(namespaceResult).toEqual({
      namespace:
        "tenant.00000000-0000-0000-0000-000000000101.channel.closure.user.00000000-0000-0000-0000-000000000102.shared",
    });
    expect(sessionService.getSessionMemoryNamespace).not.toHaveBeenCalled();
  });

  it("rejects Rust bridge writes without a bound session.write principal", async () => {
    const sessionService = createMockService();
    const rustSessionLifecycleBridge = {
      createSession: vi.fn(),
      appendMessage: vi.fn(),
      getMemoryNamespace: vi.fn(),
    };

    const routes = createFridaySessionRoutes({
      sessionService,
      routeSessionsViaRust: true,
      rustSessionLifecycleBridge,
      allowTestOnlySessionExecution: false,
    });

    const create = routes.find((r) => r.operationId === "sessions.create")!;
    await expectRouteError(
      create.handler(
        makeMockCtx({
          body: { channel: "closure", chatId: "closure-chat" },
          principal: null,
        }) as never,
      ),
      "OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED",
    );
    expect(rustSessionLifecycleBridge.createSession).not.toHaveBeenCalled();

    const message = routes.find((r) => r.operationId === "sessions.messages.create")!;
    await expectRouteError(
      message.handler(
        makeMockCtx({
          params: { sessionKey: "closure:default:closure-chat" },
          body: { role: "user", content: "hello" },
          principal: makeBoundPrincipal({ scopes: ["session.read"], role: "viewer" }),
        }) as never,
      ),
      "OWNER_SESSION_CHANNEL_AUTHORITY_REQUIRED",
    );
    expect(rustSessionLifecycleBridge.appendMessage).not.toHaveBeenCalled();
  });
});

// (CORE-RUNNABLE-001 / CORE-A CR-3) The REAL production session bridge adapter — NOT a mock — driven
// over a TEST TRANSPORT (a fake low-level sealed client + a fake owner-gated readback, exactly the
// seams the agent-run + mission-spine adapters use in their tests). Proves the session run Rust route
// is reachable-and-real when routeSessionsViaRust is on, and byte-identical fail-closed when off.
describe("Rust session run route (REAL adapter over a test transport)", () => {
  function makeRealBridgeWithTestTransport(
    overrides: Partial<Parameters<typeof createFridayRustHubSessionLifecycleDispatchAdapter>[0]> = {},
  ) {
    const dispatchRun = vi.fn().mockResolvedValue({
      truthLabel: "rust_wired",
      runId: "rust-session-run-1",
      status: "finished",
      answerSha256: "sha-answer",
      answerLen: 32,
      turns: 1,
      executedTools: 2,
      promptTokens: 11,
      completionTokens: 4,
    });
    const readAnswer = vi.fn().mockResolvedValue({
      truthLabel: "rust_wired_dev",
      proofOnly: true,
      outcome: "delivered",
      runId: "rust-session-run-1",
      status: "finished",
      answer: "hello from the rust session loop",
      answerSha256: "sha-answer",
      answerLen: 32,
    });
    // (CR-3) The fake low-level sealed client ALSO answers the session create/append round-trips —
    // the SAME `createSession` / `appendSessionMessage` methods the Rust arms serve. These echo a
    // refs-only receipt (id + seq + timestamps) WITHOUT a socket, exactly like the Rust store's
    // refs-only reply, so the REAL adapter's create/append mapping is exercised end-to-end.
    const createSession = vi.fn().mockResolvedValue({
      truthLabel: "rust_wired",
      sessionId: "discord:default:user1",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });
    const appendSessionMessage = vi.fn().mockResolvedValue({
      truthLabel: "rust_wired",
      messageId: "discord:default:user1:m0",
      seq: 0,
      createdAt: 1_700_000_000_500,
      updatedAt: 1_700_000_000_500,
    });
    const bridge = createFridayRustHubSessionLifecycleDispatchAdapter({
      port: 0,
      // A fixture 32-byte secret; the fake createClient ignores it (no socket). NEVER a real key.
      secretResolver: () => new Uint8Array(32),
      idGenerator: () => "rust-session-run-1",
      hubDbPath: "/tmp/friday-rust-session-test.db",
      // Test transport: a fake low-level sealed client. The REAL service adapter wraps it.
      createClient: () =>
        ({
          dispatchRun,
          createSession,
          appendSessionMessage,
        } as unknown as FridayRustHubAgentRunSealedClient),
      // Test transport: a fake owner-gated readback returning a delivered body.
      readback: { readAnswer } as unknown as FridayRustHubRunAnswerReadbackService,
      ...overrides,
    });
    return { bridge, dispatchRun, readAnswer, createSession, appendSessionMessage };
  }

  it("dispatches sessions.run to the Rust-backed bridge (not 503) when routeSessionsViaRust is on", async () => {
    const { bridge, dispatchRun, readAnswer } = makeRealBridgeWithTestTransport();
    const routes = createFridaySessionRoutes({
      sessionService: createMockService(),
      // Must be present so the route does not 501; NOT called (the Rust branch returns first).
      runSession: vi.fn(),
      routeSessionsViaRust: true,
      rustSessionLifecycleBridge: bridge,
      // The legacy TS run oracle is OFF — proving the Rust path (not the TS oracle) served the run.
      allowTestOnlySessionRunExecution: false,
    });

    const run = routes.find((r) => r.operationId === "sessions.run")!;
    const result = (await run.handler(
      makeMockCtx({
        params: { sessionKey: "discord:default:user1" },
        body: { task: "summarize my day" },
        principal: makeBoundPrincipal(),
      }) as never,
    )) as {
      run: {
        runId: string;
        status: string;
        response: string;
        toolCallCount: number;
        usageInput: number;
        usageOutput: number;
      };
      messages: Array<{ role: string; content: string }>;
    };

    expect(result.run.status).toBe("completed");
    expect(result.run.response).toBe("hello from the rust session loop");
    expect(result.run.toolCallCount).toBe(2);
    expect(result.run.usageInput).toBe(11);
    expect(result.run.usageOutput).toBe(4);
    expect(result.messages).toEqual([
      { role: "user", content: "summarize my day" },
      { role: "assistant", content: "hello from the rust session loop" },
    ]);
    // Proves the REAL adapter drove the sealed transport + owner-gated readback (not a mock bridge).
    expect(dispatchRun).toHaveBeenCalledTimes(1);
    expect(dispatchRun.mock.calls[0][0]).toMatchObject({
      task: "summarize my day",
      sessionKey: "discord:default:user1",
      forwardedPrincipal: "user:bound-1",
      constraints: { readOnly: true },
    });
    expect(readAnswer).toHaveBeenCalledTimes(1);
    expect(readAnswer.mock.calls[0][0]).toMatchObject({
      runId: "rust-session-run-1",
      callerPrincipal: "user:bound-1",
    });
  });

  it("still fails closed with TS_RUNTIME_SESSION_RUN_RETIRED when routeSessionsViaRust is OFF (unchanged default)", async () => {
    const { bridge, dispatchRun } = makeRealBridgeWithTestTransport();
    const routes = createFridaySessionRoutes({
      sessionService: createMockService(),
      runSession: vi.fn(),
      // Flag OFF (omitted) + TS oracle off ⇒ today's fail-closed 503, bridge never consulted.
      rustSessionLifecycleBridge: bridge,
      allowTestOnlySessionRunExecution: false,
    });

    const run = routes.find((r) => r.operationId === "sessions.run")!;
    await expectRouteError(
      run.handler(
        makeMockCtx({
          params: { sessionKey: "discord:default:user1" },
          body: { task: "summarize my day" },
          principal: makeBoundPrincipal(),
        }) as never,
      ),
      "TS_RUNTIME_SESSION_RUN_RETIRED",
    );
    expect(dispatchRun).not.toHaveBeenCalled();
  });

  it("rejects a Rust session run without a bound session.write principal", async () => {
    const { bridge, dispatchRun } = makeRealBridgeWithTestTransport();
    const routes = createFridaySessionRoutes({
      sessionService: createMockService(),
      runSession: vi.fn(),
      routeSessionsViaRust: true,
      rustSessionLifecycleBridge: bridge,
      allowTestOnlySessionRunExecution: false,
    });

    const run = routes.find((r) => r.operationId === "sessions.run")!;
    await expectRouteError(
      run.handler(
        makeMockCtx({
          params: { sessionKey: "discord:default:user1" },
          body: { task: "summarize my day" },
          principal: makeBoundPrincipal({ scopes: ["session.read"], role: "viewer" }),
        }) as never,
      ),
      "OWNER_SESSION_CHANNEL_AUTHORITY_REQUIRED",
    );
    expect(dispatchRun).not.toHaveBeenCalled();
  });

  it("dispatches the FULL create → append → run public seam to the Rust bridge (not 503) when routeSessionsViaRust is on", async () => {
    const { bridge, createSession, appendSessionMessage, dispatchRun } =
      makeRealBridgeWithTestTransport();
    const routes = createFridaySessionRoutes({
      sessionService: createMockService(),
      runSession: vi.fn(),
      routeSessionsViaRust: true,
      rustSessionLifecycleBridge: bridge,
      // Every legacy TS oracle OFF — proving the Rust path (not the TS oracle) served the seam.
      allowTestOnlySessionExecution: false,
      allowTestOnlySessionRunExecution: false,
    });

    // POST /v1/sessions → bridge.createSession → SessionCreateRequest → refs-only session.
    const create = routes.find((r) => r.operationId === "sessions.create")!;
    const created = (await create.handler(
      makeMockCtx({
        body: { channel: "discord", chatId: "user1", metadata: { source: "cr3" } },
        principal: makeBoundPrincipal(),
      }) as never,
    )) as { session: { key: string; channel: string; status: string; messageCount: number } };
    expect(created.session.key).toBe("discord:default:user1");
    expect(created.session.channel).toBe("discord");
    expect(created.session.status).toBe("active");
    expect(created.session.messageCount).toBe(0);
    // The REAL adapter drove the sealed transport: the derived canonical key rode the wire, and the
    // forwarded owner is the AUTHENTICATED principal (never a client-asserted owner).
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0][0]).toMatchObject({
      sessionId: "discord:default:user1",
      userId: "user:bound-1",
      metadataJson: JSON.stringify({ source: "cr3" }),
    });

    // POST /v1/sessions/:key/messages → bridge.appendMessage → SessionMessageAppendRequest → refs.
    const message = routes.find((r) => r.operationId === "sessions.messages.create")!;
    const appended = (await message.handler(
      makeMockCtx({
        params: { sessionKey: "discord:default:user1" },
        body: { role: "user", content: "summarize my day", idempotencyKey: "idem-cr3" },
        principal: makeBoundPrincipal(),
      }) as never,
    )) as { message: { id: string; sequence: number; role: string; contentText: string } };
    expect(appended.message.id).toBe("discord:default:user1:m0");
    expect(appended.message.sequence).toBe(0);
    expect(appended.message.role).toBe("user");
    expect(appended.message.contentText).toBe("summarize my day");
    expect(appendSessionMessage).toHaveBeenCalledTimes(1);
    expect(appendSessionMessage.mock.calls[0][0]).toMatchObject({
      sessionId: "discord:default:user1",
      role: "user",
      content: "summarize my day",
      refs: "idem-cr3",
    });

    // POST /v1/sessions/:key/run → bridge.runSession → dispatchRun (already proven) → answer.
    const run = routes.find((r) => r.operationId === "sessions.run")!;
    const ran = (await run.handler(
      makeMockCtx({
        params: { sessionKey: "discord:default:user1" },
        body: { task: "summarize my day" },
        principal: makeBoundPrincipal(),
      }) as never,
    )) as { run: { status: string; response: string } };
    expect(ran.run.status).toBe("completed");
    expect(ran.run.response).toBe("hello from the rust session loop");
    expect(dispatchRun).toHaveBeenCalledTimes(1);
  });

  it("getMemoryNamespace remains an HONEST 503 (deferred Rust owner-gated read; never a faked namespace)", async () => {
    const { bridge } = makeRealBridgeWithTestTransport();
    await expectRouteError(
      bridge.getMemoryNamespace({
        sessionKey: "discord:default:user1",
        principal: makeBoundPrincipal() as never,
      }),
      "RUST_SESSION_LIFECYCLE_PROTOCOL_UNAVAILABLE",
    );
  });

  it("create/append fail closed when the sealed-WS client secret cannot be resolved (no socket, no fake row)", async () => {
    const { bridge, createSession, appendSessionMessage } = makeRealBridgeWithTestTransport({
      secretResolver: () => null,
    });
    await expectRouteError(
      bridge.createSession({
        channel: "discord",
        chatId: "user1",
        principal: makeBoundPrincipal() as never,
      }),
      "RUST_SESSION_LIFECYCLE_DISPATCH_UNAVAILABLE",
    );
    await expectRouteError(
      bridge.appendMessage({
        sessionKey: "discord:default:user1",
        role: "user",
        content: "hi",
        principal: makeBoundPrincipal() as never,
      }),
      "RUST_SESSION_LIFECYCLE_DISPATCH_UNAVAILABLE",
    );
    // Fail-closed BEFORE any socket: the underlying client round-trips were never constructed/called.
    expect(createSession).not.toHaveBeenCalled();
    expect(appendSessionMessage).not.toHaveBeenCalled();
  });

  it("a foreign-owner append surfaces the Rust owner-gate refusal as a fail-closed 503 (never a silent success)", async () => {
    // The Rust arm refuses a non-owner append with an `Error` → the sealed client fails closed (503).
    // Model that with a fake client whose `appendSessionMessage` rejects with the domain 503.
    const denial = new FridayDomainError(
      "MISSION_SPINE_RUST_AGENT_RUN_SEALED_WS_CLIENT_UNAVAILABLE",
      "owner-gate refusal (Error inbound)",
      { httpStatus: 503 },
    );
    const appendSessionMessage = vi.fn().mockRejectedValue(denial);
    const bridge = createFridayRustHubSessionLifecycleDispatchAdapter({
      port: 0,
      secretResolver: () => new Uint8Array(32),
      idGenerator: () => "run-x",
      hubDbPath: "/tmp/friday-rust-session-test.db",
      createClient: () =>
        ({ appendSessionMessage } as unknown as FridayRustHubAgentRunSealedClient),
    });
    await expect(
      bridge.appendMessage({
        sessionKey: "discord:default:someone-elses",
        role: "user",
        content: "sneaky",
        principal: makeBoundPrincipal() as never,
      }),
    ).rejects.toMatchObject({ httpStatus: 503 });
    expect(appendSessionMessage).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the sealed-WS client secret cannot be resolved (no socket, no fake body)", async () => {
    const { bridge, dispatchRun, readAnswer } = makeRealBridgeWithTestTransport({
      secretResolver: () => null,
    });
    await expectRouteError(
      bridge.runSession!({
        sessionKey: "discord:default:user1",
        task: "summarize my day",
        principalId: "user:bound-1",
      }),
      "RUST_SESSION_LIFECYCLE_DISPATCH_UNAVAILABLE",
    );
    expect(dispatchRun).not.toHaveBeenCalled();
    expect(readAnswer).not.toHaveBeenCalled();
  });
});
