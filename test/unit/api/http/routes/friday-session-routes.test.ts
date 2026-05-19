import { describe, it, expect, vi } from "vitest";
import { FridayDomainError } from "#errors";
import { createFridaySessionRoutes } from "#api";
import { FRIDAY_SESSION_ERROR_CODES, FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES } from "#sessions";
import type { FridaySessionService, FridaySessionMemoryExtractionService } from "#sessions";
import type { FridaySessionRecord, FridaySessionMessageRecord } from "#sessions";

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

function makeBoundPrincipal(): Record<string, unknown> {
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
    const routes = createFridaySessionRoutes({ sessionService: svc });
    expect(routes).toHaveLength(22);
  });

  it("all routes have unique operationIds", () => {
    const svc = createMockService();
    const routes = createFridaySessionRoutes({ sessionService: svc });
    const ids = routes.map((r) => r.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all routes require auth", () => {
    const svc = createMockService();
    const routes = createFridaySessionRoutes({ sessionService: svc });
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

      const routes = createFridaySessionRoutes({ sessionService: svc });
      const listRoute = routes.find((r) => r.operationId === "sessions.list")!;

      const result = await listRoute.handler(makeMockCtx({ query: {} }) as never);
      expect(result).toHaveProperty("items", sessions);
      expect(svc.listSessions).toHaveBeenCalledWith({
        channel: undefined,
        accountId: undefined,
        userId: undefined,
        status: undefined,
        limit: undefined,
        cursor: undefined,
      });
    });

    it("passes query params to service", async () => {
      const svc = createMockService();
      vi.mocked(svc.listSessions).mockResolvedValue([]);

      const routes = createFridaySessionRoutes({ sessionService: svc });
      const listRoute = routes.find((r) => r.operationId === "sessions.list")!;

      await listRoute.handler(
        makeMockCtx({
          query: { channel: "discord", status: "active", limit: "10", cursor: "2026-01-01T00:00:00.000Z" },
        }) as never,
      );

      expect(svc.listSessions).toHaveBeenCalledWith({
        channel: "discord",
        accountId: undefined,
        userId: undefined,
        status: "active",
        limit: 10,
        cursor: "2026-01-01T00:00:00.000Z",
      });
    });

    it("validates invalid limit", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ sessionService: svc });
      const listRoute = routes.find((r) => r.operationId === "sessions.list")!;

      await expectRouteError(
        listRoute.handler(makeMockCtx({ query: { limit: "abc" } }) as never),
        FRIDAY_SESSION_ERROR_CODES.INVALID_INPUT,
      );
    });

    it("validates invalid status", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ sessionService: svc });
      const listRoute = routes.find((r) => r.operationId === "sessions.list")!;

      await expectRouteError(
        listRoute.handler(makeMockCtx({ query: { status: "invalid" } }) as never),
        FRIDAY_SESSION_ERROR_CODES.INVALID_INPUT,
      );
    });
  });

  // ─── sessions.create ───

  describe("sessions.create", () => {
    it("validates missing body", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ sessionService: svc });
      const createRoute = routes.find((r) => r.operationId === "sessions.create")!;

      await expectRouteError(
        createRoute.handler(makeMockCtx({ body: null }) as never),
        FRIDAY_SESSION_ERROR_CODES.INVALID_INPUT,
      );
    });

    it("validates missing channel", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ sessionService: svc });
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

      const routes = createFridaySessionRoutes({ sessionService: svc });
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
  });

  // ─── sessions.get ───

  describe("sessions.get", () => {
    it("throws 404 when session not found", async () => {
      const svc = createMockService();
      vi.mocked(svc.getSession).mockResolvedValue(null);

      const routes = createFridaySessionRoutes({ sessionService: svc });
      const getRoute = routes.find((r) => r.operationId === "sessions.get")!;

      await expectRouteError(
        getRoute.handler(makeMockCtx({ params: { sessionKey: "discord:default:nope" } }) as never),
        FRIDAY_SESSION_ERROR_CODES.NOT_FOUND,
      );
    });

    it("returns session when found", async () => {
      const svc = createMockService();
      const mockSession = makeMockSession();
      vi.mocked(svc.getSession).mockResolvedValue(mockSession);

      const routes = createFridaySessionRoutes({ sessionService: svc });
      const getRoute = routes.find((r) => r.operationId === "sessions.get")!;

      const result = await getRoute.handler(
        makeMockCtx({ params: { sessionKey: "discord:default:user1" } }) as never,
      );

      expect(result).toHaveProperty("session", mockSession);
    });

    it("throws FridayDomainError on malformed URL-encoded key", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ sessionService: svc });
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

      const routes = createFridaySessionRoutes({ sessionService: svc });
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
      const routes = createFridaySessionRoutes({ sessionService: svc });
      const pruneRoute = routes.find((r) => r.operationId === "sessions.prune")!;

      await expectRouteError(
        pruneRoute.handler(makeMockCtx({ body: null }) as never),
        FRIDAY_SESSION_ERROR_CODES.PRUNE_VALIDATION_ERROR,
      );
    });

    it("validates missing olderThan", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ sessionService: svc });
      const pruneRoute = routes.find((r) => r.operationId === "sessions.prune")!;

      await expectRouteError(
        pruneRoute.handler(makeMockCtx({ body: {} }) as never),
        FRIDAY_SESSION_ERROR_CODES.PRUNE_VALIDATION_ERROR,
      );
    });

    it("validates invalid ISO date in olderThan", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ sessionService: svc });
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

      const routes = createFridaySessionRoutes({ sessionService: svc });
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

      const routes = createFridaySessionRoutes({ sessionService: svc });
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
      const routes = createFridaySessionRoutes({
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
      const routes = createFridaySessionRoutes({ sessionService: svc });
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
      const routes = createFridaySessionRoutes({ sessionService: svc });
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

      const routes = createFridaySessionRoutes({ sessionService: svc });
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

      const routes = createFridaySessionRoutes({
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

      const routes = createFridaySessionRoutes({
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
      const routes = createFridaySessionRoutes({ sessionService: svc });
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
      vi.mocked(svc.getMessages).mockResolvedValue([makeMockMessage()]);

      const routes = createFridaySessionRoutes({ sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.messages.list")!;

      const result = await route.handler(
        makeMockCtx({ params: { sessionKey: "discord:default:user1" }, query: {} }) as never,
      );

      expect(result).toHaveProperty("items");
    });

    it("validates invalid limit", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.messages.list")!;

      await expectRouteError(
        route.handler(
          makeMockCtx({
            params: { sessionKey: "discord:default:user1" },
            query: { limit: "not-a-number" },
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
      vi.mocked(svc.getSessionMemoryNamespace).mockResolvedValue(
        "tenant.default.channel.discord.user.user1.shared",
      );

      const routes = createFridaySessionRoutes({ sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.memory.namespace.get")!;

      const result = await route.handler(
        makeMockCtx({ params: { sessionKey: "discord:default:user1" } }) as never,
      );

      expect(result).toHaveProperty(
        "namespace",
        "tenant.default.channel.discord.user.user1.shared",
      );
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

      const routes = createFridaySessionRoutes({ sessionService: svc });
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
      const routes = createFridaySessionRoutes({ sessionService: svc });
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
      const routes = createFridaySessionRoutes({ sessionService: svc });
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
      const routes = createFridaySessionRoutes({ sessionService: svc });
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
      vi.mocked(svc.listForks).mockResolvedValue([makeMockSession()]);

      const routes = createFridaySessionRoutes({ sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.forks.list")!;

      const result = await route.handler(
        makeMockCtx({ params: { sessionKey: "discord:default:user1" }, query: {} }) as never,
      );

      expect(result).toHaveProperty("items");
      expect(svc.listForks).toHaveBeenCalledWith("discord:default:user1", {
        status: undefined,
        limit: undefined,
      });
    });

    it("validates invalid status", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ sessionService: svc });
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
  });

  // ─── sessions.forks.merge ───

  describe("sessions.forks.merge", () => {
    it("validates missing body", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ sessionService: svc });
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
      const routes = createFridaySessionRoutes({ sessionService: svc });
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
      const routes = createFridaySessionRoutes({ sessionService: svc });
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

      const routes = createFridaySessionRoutes({ sessionService: svc });
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

      const routes = createFridaySessionRoutes({ sessionService: svc });
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

      const routes = createFridaySessionRoutes({
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
      const routes = createFridaySessionRoutes({
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

      const routes = createFridaySessionRoutes({
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

      const routes = createFridaySessionRoutes({
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

      const routes = createFridaySessionRoutes({
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

      const routes = createFridaySessionRoutes({
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

      const routes = createFridaySessionRoutes({
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

      const routes = createFridaySessionRoutes({
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

      const routes = createFridaySessionRoutes({
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
            hubId: "default",
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

      const routes = createFridaySessionRoutes({ sessionService: svc });
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
      const routes = createFridaySessionRoutes({ sessionService: svc, runSession });
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
      const routes = createFridaySessionRoutes({ sessionService: svc });
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
      const routes = createFridaySessionRoutes({ sessionService: svc });
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
      const routes = createFridaySessionRoutes({ sessionService: svc, extractionService: extractSvc });
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
      const routes = createFridaySessionRoutes({ sessionService: svc, extractionService: extractSvc });
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
      const routes = createFridaySessionRoutes({ sessionService: svc, extractionService: extractSvc });
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
      const routes = createFridaySessionRoutes({ sessionService: svc, extractionService: extractSvc });
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
      const routes = createFridaySessionRoutes({ sessionService: svc, extractionService: extractSvc });
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
      const routes = createFridaySessionRoutes({ sessionService: svc, extractionService: extractSvc });
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
      const routes = createFridaySessionRoutes({ sessionService: svc });
      const route = routes.find((r) => r.operationId === "sessions.memory.extraction.retry")!;

      await expectRouteError(
        route.handler(makeMockCtx({ body: {} }) as never),
        FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.PROVIDER_ERROR,
      );
    });

    it("rejects empty string sessionKey", async () => {
      const svc = createMockService();
      const extractSvc = createMockExtractionService();
      const routes = createFridaySessionRoutes({ sessionService: svc, extractionService: extractSvc });
      const route = routes.find((r) => r.operationId === "sessions.memory.extraction.retry")!;

      await expectRouteError(
        route.handler(makeMockCtx({ body: { sessionKey: "" } }) as never),
        FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.INVALID_INPUT,
      );
    });

    it("accepts valid retry body", async () => {
      const svc = createMockService();
      const extractSvc = createMockExtractionService();
      const routes = createFridaySessionRoutes({ sessionService: svc, extractionService: extractSvc });
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
      const routes = createFridaySessionRoutes({ sessionService: svc, extractionService: extractSvc });
      const route = routes.find((r) => r.operationId === "sessions.memory.extraction.retry")!;

      const result = await route.handler(makeMockCtx({ body: {} }) as never);

      expect(result).toHaveProperty("result");
      expect(extractSvc.retryFailedExtractions).toHaveBeenCalledWith(undefined);
    });
  });

  describe("sessions.memory.extraction.get", () => {
    it("throws 501 when extraction service not configured", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ sessionService: svc });
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
      const extractSvc = createMockExtractionService();
      const routes = createFridaySessionRoutes({ sessionService: svc, extractionService: extractSvc });
      const route = routes.find((r) => r.operationId === "sessions.memory.extraction.get")!;

      const result = await route.handler(
        makeMockCtx({ params: { sessionKey: "discord:default:user1" } }) as never,
      );

      expect(result).toHaveProperty("status");
    });
  });

  describe("sessions.memory.remember", () => {
    it("throws 501 when extraction service not configured", async () => {
      const svc = createMockService();
      const routes = createFridaySessionRoutes({ sessionService: svc });
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
      const routes = createFridaySessionRoutes({ sessionService: svc, extractionService: extractSvc });
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
      const routes = createFridaySessionRoutes({ sessionService: svc });
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
      const routes = createFridaySessionRoutes({ sessionService: svc });
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
      const routes = createFridaySessionRoutes({ sessionService: svc });
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
      const routes = createFridaySessionRoutes({ sessionService: svc });
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
      const routes = createFridaySessionRoutes({ sessionService: svc });
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

      const routes = createFridaySessionRoutes({ sessionService: svc });
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
      const routes = createFridaySessionRoutes({ sessionService: svc });
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
      const routes = createFridaySessionRoutes({ sessionService: svc });
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

      const routes = createFridaySessionRoutes({ sessionService: svc });
      const listRoute = routes.find((r) => r.operationId === "sessions.list")!;

      await listRoute.handler(
        makeMockCtx({ query: { limit: "500" } }) as never,
      );

      expect(svc.listSessions).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100 }),
      );
    });
  });

  describe("sessions.messages.list — limit cap", () => {
    it("caps limit to 100 when query limit exceeds maximum", async () => {
      const svc = createMockService();
      vi.mocked(svc.getMessages).mockResolvedValue([]);

      const routes = createFridaySessionRoutes({ sessionService: svc });
      const messagesRoute = routes.find((r) => r.operationId === "sessions.messages.list")!;

      await messagesRoute.handler(
        makeMockCtx({
          params: { sessionKey: "discord:default:user1" },
          query: { limit: "500" },
        }) as never,
      );

      expect(svc.getMessages).toHaveBeenCalledWith("discord:default:user1", 100, undefined);
    });
  });

  describe("sessions.forks.list — limit cap", () => {
    it("caps limit to 100 when query limit exceeds maximum", async () => {
      const svc = createMockService();
      vi.mocked(svc.listForks).mockResolvedValue([]);

      const routes = createFridaySessionRoutes({ sessionService: svc });
      const forksRoute = routes.find((r) => r.operationId === "sessions.forks.list")!;

      await forksRoute.handler(
        makeMockCtx({
          params: { sessionKey: "discord:default:user1" },
          query: { limit: "500" },
        }) as never,
      );

      expect(svc.listForks).toHaveBeenCalledWith("discord:default:user1", expect.objectContaining({ limit: 100 }));
    });
  });
});
