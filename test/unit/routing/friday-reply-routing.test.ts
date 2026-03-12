import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DEFAULT_REPLY_ROUTING_CONFIG,
  type FridayReplyRouteContext,
} from "../../../src/routing/friday-reply-routing.types.js";
import {
  createFridayReplyRouteRepository,
  type FridayReplyRouteRepository,
} from "../../../src/routing/friday-reply-route-repository.js";
import {
  createFridayReplyQueueRepository,
  type FridayReplyQueueRepository,
} from "../../../src/routing/friday-reply-queue-repository.js";
import {
  createFridayReplyRoutingService,
  type FridayReplyRoutingServiceDeps,
} from "../../../src/routing/friday-reply-routing-service.js";
import {
  createFridayReplyQueueJob,
  type FridayReplyQueueJobDeps,
} from "../../../src/routing/friday-reply-queue-job.js";
import type { FridayQueuedReply } from "../../../src/routing/friday-reply-routing.types.js";

// ─── Route Repository ───

describe("FridayReplyRouteRepository", () => {
  let repo: FridayReplyRouteRepository;

  beforeEach(() => {
    repo = createFridayReplyRouteRepository();
  });

  it("stores and retrieves route context", () => {
    const ctx: FridayReplyRouteContext = {
      sessionKey: "channel:discord:chat-1",
      channelKind: "discord",
      channelId: "ch-1",
      chatId: "chat-1",
      senderId: "user-1",
      capturedAt: "2026-02-25T12:00:00Z",
    };
    repo.set(ctx);
    expect(repo.get("channel:discord:chat-1")).toEqual(ctx);
  });

  it("returns null for unknown session key", () => {
    expect(repo.get("unknown")).toBeNull();
  });

  it("overwrites context on second set", () => {
    repo.set({ sessionKey: "s1", channelKind: "discord", channelId: "c1", chatId: "chat-1", senderId: "u1", capturedAt: "2026-02-25T10:00:00Z" });
    repo.set({ sessionKey: "s1", channelKind: "slack", channelId: "c2", chatId: "chat-2", senderId: "u2", capturedAt: "2026-02-25T11:00:00Z" });
    expect(repo.get("s1")!.channelKind).toBe("slack");
  });

  it("removes a route context", () => {
    repo.set({ sessionKey: "s1", channelKind: "discord", channelId: "c1", chatId: "chat-1", senderId: "u1", capturedAt: "2026-02-25T10:00:00Z" });
    expect(repo.remove("s1")).toBe(true);
    expect(repo.get("s1")).toBeNull();
    expect(repo.remove("s1")).toBe(false);
  });

  it("lists all contexts", () => {
    repo.set({ sessionKey: "s1", channelKind: "discord", channelId: "c1", chatId: "chat-1", senderId: "u1", capturedAt: "2026-02-25T10:00:00Z" });
    repo.set({ sessionKey: "s2", channelKind: "slack", channelId: "c2", chatId: "chat-2", senderId: "u2", capturedAt: "2026-02-25T11:00:00Z" });
    expect(repo.listAll()).toHaveLength(2);
  });

  it("reports size", () => {
    expect(repo.size()).toBe(0);
    repo.set({ sessionKey: "s1", channelKind: "discord", channelId: "c1", chatId: "chat-1", senderId: "u1", capturedAt: "2026-02-25T10:00:00Z" });
    expect(repo.size()).toBe(1);
  });

  it("prunes entries older than cutoff", () => {
    repo.set({ sessionKey: "old", channelKind: "discord", channelId: "c1", chatId: "chat-1", senderId: "u1", capturedAt: "2026-02-20T10:00:00Z" });
    repo.set({ sessionKey: "new", channelKind: "slack", channelId: "c2", chatId: "chat-2", senderId: "u2", capturedAt: "2026-02-25T10:00:00Z" });
    const pruned = repo.pruneOlderThan("2026-02-24T00:00:00Z");
    expect(pruned).toBe(1);
    expect(repo.size()).toBe(1);
    expect(repo.get("new")).not.toBeNull();
  });
});

// ─── Queue Repository ───

describe("FridayReplyQueueRepository", () => {
  let repo: FridayReplyQueueRepository;

  function makeQueued(overrides: Partial<FridayQueuedReply> = {}): FridayQueuedReply {
    return {
      id: "q-001",
      sessionKey: "s1",
      channelKind: "discord",
      channelId: "c1",
      chatId: "chat-1",
      text: "Hello",
      status: "queued",
      attempts: 0,
      maxAttempts: 5,
      createdAt: "2026-02-25T12:00:00Z",
      nextRetryAt: "2026-02-25T12:00:00Z",
      ...overrides,
    };
  }

  beforeEach(() => {
    repo = createFridayReplyQueueRepository();
  });

  it("enqueues and retrieves entries", () => {
    repo.enqueue(makeQueued());
    expect(repo.get("q-001")).not.toBeNull();
    expect(repo.size()).toBe(1);
  });

  it("returns null for unknown id", () => {
    expect(repo.get("unknown")).toBeNull();
  });

  it("leases ready entries", () => {
    repo.enqueue(makeQueued({ id: "q-1", nextRetryAt: "2026-02-25T12:00:00Z" }));
    repo.enqueue(makeQueued({ id: "q-2", nextRetryAt: "2026-02-25T13:00:00Z" })); // future

    const ready = repo.leaseReady("2026-02-25T12:30:00Z", 10);
    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe("q-1");
  });

  it("respects lease limit", () => {
    for (let i = 0; i < 5; i++) {
      repo.enqueue(makeQueued({ id: `q-${i}`, nextRetryAt: "2026-02-25T12:00:00Z" }));
    }
    const ready = repo.leaseReady("2026-02-25T13:00:00Z", 3);
    expect(ready).toHaveLength(3);
  });

  it("marks delivered", () => {
    repo.enqueue(makeQueued());
    expect(repo.markDelivered("q-001")).toBe(true);
    expect(repo.get("q-001")!.status).toBe("delivered");
  });

  it("marks failed with incremented attempts", () => {
    repo.enqueue(makeQueued());
    expect(repo.markFailed("q-001", "timeout", "2026-02-25T12:05:00Z")).toBe(true);
    const entry = repo.get("q-001")!;
    expect(entry.attempts).toBe(1);
    expect(entry.lastError).toBe("timeout");
    expect(entry.status).toBe("queued");
  });

  it("marks dead letter", () => {
    repo.enqueue(makeQueued());
    expect(repo.markDeadLetter("q-001", "max retries")).toBe(true);
    expect(repo.get("q-001")!.status).toBe("dead_letter");
  });

  it("returns false for updates to non-existent entries", () => {
    expect(repo.markDelivered("nope")).toBe(false);
    expect(repo.markFailed("nope", "err", "2026-02-25T12:00:00Z")).toBe(false);
    expect(repo.markDeadLetter("nope", "err")).toBe(false);
  });

  it("removes expired entries", () => {
    repo.enqueue(makeQueued({ id: "old", createdAt: "2026-02-20T00:00:00Z" }));
    repo.enqueue(makeQueued({ id: "new", createdAt: "2026-02-25T12:00:00Z" }));
    const removed = repo.removeExpired("2026-02-24T00:00:00Z");
    expect(removed).toBe(1);
    expect(repo.size()).toBe(1);
  });

  it("does not remove delivered entries even if old", () => {
    repo.enqueue(makeQueued({ id: "old", createdAt: "2026-02-20T00:00:00Z" }));
    repo.markDelivered("old");
    const removed = repo.removeExpired("2026-02-24T00:00:00Z");
    expect(removed).toBe(0);
  });

  it("counts entries by status", () => {
    repo.enqueue(makeQueued({ id: "q-1" }));
    repo.enqueue(makeQueued({ id: "q-2" }));
    repo.enqueue(makeQueued({ id: "q-3" }));
    repo.markDelivered("q-1");
    repo.markDeadLetter("q-2", "err");
    expect(repo.countByStatus("queued")).toBe(1);
    expect(repo.countByStatus("delivered")).toBe(1);
    expect(repo.countByStatus("dead_letter")).toBe(1);
  });
});

// ─── Routing Service ───

describe("FridayReplyRoutingService", () => {
  function makeServiceDeps(overrides: Partial<FridayReplyRoutingServiceDeps> = {}): FridayReplyRoutingServiceDeps {
    return {
      routeRepo: createFridayReplyRouteRepository(),
      queueRepo: createFridayReplyQueueRepository(),
      nowIso: () => "2026-02-25T12:00:00Z",
      generateId: vi.fn().mockReturnValue("gen-001"),
      deliver: vi.fn().mockResolvedValue({ ok: true, messageId: "msg-001", deliveredAt: "2026-02-25T12:00:01Z" }),
      getSendPolicy: vi.fn().mockReturnValue("allow"),
      ...overrides,
    };
  }

  describe("captureRoute", () => {
    it("stores route context with timestamp", () => {
      const deps = makeServiceDeps();
      const service = createFridayReplyRoutingService(deps);

      service.captureRoute({
        sessionKey: "s1",
        channelKind: "discord",
        channelId: "c1",
        chatId: "chat-1",
        senderId: "u1",
      });

      const ctx = deps.routeRepo.get("s1");
      expect(ctx).not.toBeNull();
      expect(ctx!.capturedAt).toBe("2026-02-25T12:00:00Z");
    });
  });

  describe("resolveDestination", () => {
    it("returns explicit override first", () => {
      const deps = makeServiceDeps();
      const service = createFridayReplyRoutingService(deps);

      service.captureRoute({ sessionKey: "s1", channelKind: "discord", channelId: "c1", chatId: "chat-1", senderId: "u1" });

      const dest = service.resolveDestination("s1", { channelKind: "slack", channelId: "c2", chatId: "chat-2" });
      expect(dest!.source).toBe("explicit");
      expect(dest!.channelKind).toBe("slack");
    });

    it("returns session route when no override", () => {
      const deps = makeServiceDeps();
      const service = createFridayReplyRoutingService(deps);

      service.captureRoute({ sessionKey: "s1", channelKind: "discord", channelId: "c1", chatId: "chat-1", senderId: "u1" });

      const dest = service.resolveDestination("s1");
      expect(dest!.source).toBe("session_route");
      expect(dest!.channelKind).toBe("discord");
    });

    it("returns fallback when no route context exists", () => {
      const deps = makeServiceDeps({
        fallbackDestination: { channelKind: "webchat", channelId: "default", chatId: "main" },
      });
      const service = createFridayReplyRoutingService(deps);

      const dest = service.resolveDestination("unknown-session");
      expect(dest!.source).toBe("fallback");
      expect(dest!.channelKind).toBe("webchat");
    });

    it("returns null when no route and no fallback", () => {
      const deps = makeServiceDeps();
      const service = createFridayReplyRoutingService(deps);

      const dest = service.resolveDestination("unknown-session");
      expect(dest).toBeNull();
    });
  });

  describe("sendReply", () => {
    it("delivers directly when policy is allow", async () => {
      const deps = makeServiceDeps();
      const service = createFridayReplyRoutingService(deps);

      service.captureRoute({ sessionKey: "s1", channelKind: "discord", channelId: "c1", chatId: "chat-1", senderId: "u1" });

      const result = await service.sendReply({ sessionKey: "s1", text: "Hello" });
      expect(result.ok).toBe(true);
      expect(deps.deliver).toHaveBeenCalledWith(expect.objectContaining({
        channelKind: "discord",
        text: "Hello",
      }));
    });

    it("blocks when policy is block", async () => {
      const deps = makeServiceDeps({ getSendPolicy: vi.fn().mockReturnValue("block") });
      const service = createFridayReplyRoutingService(deps);

      service.captureRoute({ sessionKey: "s1", channelKind: "discord", channelId: "c1", chatId: "chat-1", senderId: "u1" });

      const result = await service.sendReply({ sessionKey: "s1", text: "Hello" });
      expect(result.ok).toBe(false);
      expect("blocked" in result && result.blocked).toBe(true);
      expect(deps.deliver).not.toHaveBeenCalled();
    });

    it("queues when policy is queue", async () => {
      const deps = makeServiceDeps({ getSendPolicy: vi.fn().mockReturnValue("queue") });
      const service = createFridayReplyRoutingService(deps);

      service.captureRoute({ sessionKey: "s1", channelKind: "discord", channelId: "c1", chatId: "chat-1", senderId: "u1" });

      const result = await service.sendReply({ sessionKey: "s1", text: "Hello" });
      expect(result.ok).toBe(false);
      expect("queued" in result && result.queued).toBe(true);
      expect(deps.deliver).not.toHaveBeenCalled();
      expect(deps.queueRepo.size()).toBe(1);
    });

    it("queues retryable delivery failures", async () => {
      const deps = makeServiceDeps({
        deliver: vi.fn().mockResolvedValue({ ok: false, error: "timeout", retryable: true }),
      });
      const service = createFridayReplyRoutingService(deps);

      service.captureRoute({ sessionKey: "s1", channelKind: "discord", channelId: "c1", chatId: "chat-1", senderId: "u1" });

      const result = await service.sendReply({ sessionKey: "s1", text: "Hello" });
      expect(result.ok).toBe(false);
      expect("queued" in result && result.queued).toBe(true);
      expect(deps.queueRepo.size()).toBe(1);
    });

    it("returns non-retryable delivery failures directly", async () => {
      const deps = makeServiceDeps({
        deliver: vi.fn().mockResolvedValue({ ok: false, error: "channel deleted", retryable: false }),
      });
      const service = createFridayReplyRoutingService(deps);

      service.captureRoute({ sessionKey: "s1", channelKind: "discord", channelId: "c1", chatId: "chat-1", senderId: "u1" });

      const result = await service.sendReply({ sessionKey: "s1", text: "Hello" });
      expect(result.ok).toBe(false);
      expect(deps.queueRepo.size()).toBe(0);
    });

    it("returns error when no route found", async () => {
      const deps = makeServiceDeps();
      const service = createFridayReplyRoutingService(deps);

      const result = await service.sendReply({ sessionKey: "unknown", text: "Hello" });
      expect(result.ok).toBe(false);
    });

    it("uses default send policy when none returned", async () => {
      const deps = makeServiceDeps({ getSendPolicy: vi.fn().mockReturnValue(null) });
      const service = createFridayReplyRoutingService(deps);

      service.captureRoute({ sessionKey: "s1", channelKind: "discord", channelId: "c1", chatId: "chat-1", senderId: "u1" });

      const result = await service.sendReply({ sessionKey: "s1", text: "Hello" });
      // Default is "allow"
      expect(result.ok).toBe(true);
    });

    it("uses explicit override destination", async () => {
      const deps = makeServiceDeps();
      const service = createFridayReplyRoutingService(deps);

      service.captureRoute({ sessionKey: "s1", channelKind: "discord", channelId: "c1", chatId: "chat-1", senderId: "u1" });

      await service.sendReply({
        sessionKey: "s1",
        text: "Hello",
        explicitOverride: { channelKind: "slack", channelId: "c2", chatId: "chat-2" },
      });

      expect(deps.deliver).toHaveBeenCalledWith(expect.objectContaining({ channelKind: "slack" }));
    });
  });

  describe("getRouteContext", () => {
    it("returns stored route context", () => {
      const deps = makeServiceDeps();
      const service = createFridayReplyRoutingService(deps);

      service.captureRoute({ sessionKey: "s1", channelKind: "discord", channelId: "c1", chatId: "chat-1", senderId: "u1" });

      const ctx = service.getRouteContext("s1");
      expect(ctx).not.toBeNull();
      expect(ctx!.channelKind).toBe("discord");
    });
  });
});

// ─── Queue Drain Job ───

describe("FridayReplyQueueJob", () => {
  function makeJobDeps(overrides: Partial<FridayReplyQueueJobDeps> = {}): FridayReplyQueueJobDeps {
    return {
      queueRepo: createFridayReplyQueueRepository(),
      config: { ...DEFAULT_REPLY_ROUTING_CONFIG, drainIntervalMs: 100, drainJitterMs: 0, drainBatchSize: 10 },
      nowIso: () => "2026-02-25T12:00:00Z",
      deliver: vi.fn().mockResolvedValue({ ok: true, messageId: "msg-001", deliveredAt: "2026-02-25T12:00:01Z" }),
      ...overrides,
    };
  }

  function makeQueued(repo: FridayReplyQueueRepository, overrides: Partial<FridayQueuedReply> = {}): FridayQueuedReply {
    const entry: FridayQueuedReply = {
      id: "q-001",
      sessionKey: "s1",
      channelKind: "discord",
      channelId: "c1",
      chatId: "chat-1",
      text: "Hello",
      status: "queued",
      attempts: 0,
      maxAttempts: 5,
      createdAt: "2026-02-25T12:00:00Z",
      nextRetryAt: "2026-02-25T12:00:00Z",
      ...overrides,
    };
    repo.enqueue(entry);
    return entry;
  }

  describe("runOnce", () => {
    it("returns zero counts on empty queue", async () => {
      const deps = makeJobDeps();
      const job = createFridayReplyQueueJob(deps);
      const result = await job.runOnce();

      expect(result.attempted).toBe(0);
      expect(result.delivered).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.deadLettered).toBe(0);
    });

    it("delivers ready entries", async () => {
      const deps = makeJobDeps();
      makeQueued(deps.queueRepo);
      const job = createFridayReplyQueueJob(deps);
      const result = await job.runOnce();

      expect(result.attempted).toBe(1);
      expect(result.delivered).toBe(1);
      expect(deps.deliver).toHaveBeenCalledWith(expect.objectContaining({ text: "Hello" }));
    });

    it("marks failed entries for retry", async () => {
      const deps = makeJobDeps({
        deliver: vi.fn().mockResolvedValue({ ok: false, error: "timeout", retryable: true }),
      });
      makeQueued(deps.queueRepo);
      const job = createFridayReplyQueueJob(deps);
      const result = await job.runOnce();

      expect(result.attempted).toBe(1);
      expect(result.failed).toBe(1);
      const entry = deps.queueRepo.get("q-001");
      expect(entry!.attempts).toBe(1);
      expect(entry!.lastError).toBe("timeout");
    });

    it("dead-letters entries at max attempts", async () => {
      const deps = makeJobDeps({
        deliver: vi.fn().mockResolvedValue({ ok: false, error: "permanent", retryable: false }),
      });
      makeQueued(deps.queueRepo, { attempts: 4, maxAttempts: 5 });
      const job = createFridayReplyQueueJob(deps);
      const result = await job.runOnce();

      expect(result.deadLettered).toBe(1);
      expect(deps.queueRepo.get("q-001")!.status).toBe("dead_letter");
    });

    it("handles delivery exceptions gracefully", async () => {
      const deps = makeJobDeps({
        deliver: vi.fn().mockRejectedValue(new Error("network error")),
      });
      makeQueued(deps.queueRepo);
      const job = createFridayReplyQueueJob(deps);
      const result = await job.runOnce();

      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("network error");
    });

    it("dead-letters exception at max attempts", async () => {
      const deps = makeJobDeps({
        deliver: vi.fn().mockRejectedValue(new Error("fatal")),
      });
      makeQueued(deps.queueRepo, { attempts: 4, maxAttempts: 5 });
      const job = createFridayReplyQueueJob(deps);
      const result = await job.runOnce();

      expect(result.deadLettered).toBe(1);
    });

    it("expires old entries", async () => {
      const deps = makeJobDeps();
      // nextRetryAt in the future so it's not leased in Phase 1
      makeQueued(deps.queueRepo, { id: "old", createdAt: "2026-02-20T00:00:00Z", nextRetryAt: "2099-01-01T00:00:00Z" });
      const job = createFridayReplyQueueJob(deps);
      const result = await job.runOnce();

      expect(result.expired).toBe(1);
    });

    it("processes multiple entries in a batch", async () => {
      const deps = makeJobDeps();
      for (let i = 0; i < 3; i++) {
        makeQueued(deps.queueRepo, { id: `q-${i}` });
      }
      const job = createFridayReplyQueueJob(deps);
      const result = await job.runOnce();

      expect(result.attempted).toBe(3);
      expect(result.delivered).toBe(3);
    });
  });

  describe("lifecycle", () => {
    it("starts and stops without errors", () => {
      const deps = makeJobDeps();
      const job = createFridayReplyQueueJob(deps);

      expect(job.isRunning()).toBe(false);
      job.start();
      expect(job.isRunning()).toBe(true);
      job.stop();
      expect(job.isRunning()).toBe(false);
    });

    it("start is idempotent", () => {
      const deps = makeJobDeps();
      const job = createFridayReplyQueueJob(deps);

      job.start();
      job.start();
      expect(job.isRunning()).toBe(true);
      job.stop();
    });

    it("stop is idempotent", () => {
      const deps = makeJobDeps();
      const job = createFridayReplyQueueJob(deps);

      job.stop();
      expect(job.isRunning()).toBe(false);
    });

    it("uses default config when none provided", async () => {
      const deps = makeJobDeps();
      delete (deps as any).config;
      const job = createFridayReplyQueueJob(deps);
      const result = await job.runOnce();
      expect(result.attempted).toBe(0);
    });
  });
});
