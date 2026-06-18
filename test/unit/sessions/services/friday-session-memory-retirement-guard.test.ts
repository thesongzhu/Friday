import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import {
  createFridaySessionService,
  createFridaySessionMemoryExtractionService,
  createFridaySessionMemoryExtractionRepository,
  FRIDAY_SESSION_IDLE_TIMEOUT_MS,
} from "#sessions";
import type {
  FridaySessionService,
  FridaySessionMemoryExtractionService,
} from "#sessions";
import type { FridayMemoryService } from "#memory";
import type { FridayProviderService } from "#providers";

/**
 * TS Runtime Retirement (TS-R4/G3) — METHOD-level guards for the session
 * lifecycle sweep and the memory-extraction mutators.
 *
 * The route-level retirement (friday-session-routes) only guarded the HTTP
 * surface. Two default-on scheduler jobs reach these service methods directly,
 * bypassing the route guard:
 *   - `session-lifecycle-sweep` (120s) → sessionService.sweepLifecycle()
 *   - `session-memory-extraction` worker (60s) →
 *      extractionService.extractFromSession / extractSpecificMessages
 *   - lifecycle job also → extractionService.extractFromSession (enqueue)
 * Plus the agent memory-extract tool, an off-route caller of the extraction
 * mutators. These jobs are dormant only because there are zero idle sessions;
 * they fire and spend provider quota the instant a session idles.
 *
 * These tests prove the guard now lives on the METHOD: in default/live config
 * (test-oracle flags unset) the methods fail closed BEFORE any provider/LLM
 * call or DB write — no extraction job is enqueued, no memory item is stored,
 * no session is transitioned. The explicit test-oracle flag re-opens the legacy
 * path. Reads (getExtractionStatus, listSessions, getSession) stay live.
 */

const NOW = "2026-02-18T10:00:00.000Z";
const SESSION_KEY = "discord:default:user1";

function createBoobyTrappedProviderService(): FridayProviderService {
  return {
    listProviders: vi.fn().mockResolvedValue([]),
    getProvider: vi.fn().mockResolvedValue(null),
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    validateProvider: vi.fn(),
    getRoutingConfig: vi.fn(),
    setRoutingConfig: vi.fn(),
    resolveRoute: vi.fn(),
    // Any provider/LLM call while fail-closed is a leak — blow up loudly.
    runWithFallback: vi.fn(() => {
      throw new Error("runWithFallback must not run when extraction is fail-closed");
    }),
    recordUsage: vi.fn(),
    getUsageSummary: vi.fn(),
    getBudgetStatus: vi.fn(),
    setBudgetConfig: vi.fn(),
  } as unknown as FridayProviderService;
}

function createBoobyTrappedMemoryService(): FridayMemoryService {
  return {
    store: vi.fn(() => {
      throw new Error("memoryService.store must not run when extraction is fail-closed");
    }),
    search: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(true),
    prune: vi.fn().mockResolvedValue({ deletedCount: 0, deletedIds: [], dryRun: false }),
  } as unknown as FridayMemoryService;
}

async function expectSessionWriteRetired(operation: () => Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(FridayDomainError);
  const domainError = caught as FridayDomainError;
  expect(domainError.code).toBe("TS_RUNTIME_SESSION_RETIRED");
  expect(domainError.httpStatus).toBe(503);
  expect(domainError.details?.classification).toBe("fail_closed");
}

describe("Session lifecycle sweep TS-retirement method guard", () => {
  const allocatedDbs: FridaySqliteLayer[] = [];

  afterEach(() => {
    while (allocatedDbs.length > 0) {
      allocatedDbs.pop()!.close();
    }
    vi.restoreAllMocks();
  });

  function buildSessionService(
    nowIso: () => string,
    allowTestOnlySessionExecution?: boolean,
    existingDb?: FridaySqliteLayer,
  ): { db: FridaySqliteLayer; service: FridaySessionService } {
    const db = existingDb ?? createTestDb();
    if (!existingDb) {
      allocatedDbs.push(db);
    }
    const service = createFridaySessionService({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso,
      ...(allowTestOnlySessionExecution === undefined
        ? {}
        : { allowTestOnlySessionExecution }),
    });
    return { db, service };
  }

  async function seedIdleEligibleSession(service: FridaySessionService): Promise<void> {
    await service.createSession({ channel: "discord", chatId: "user1", userId: "user1" });
    await service.addMessage(SESSION_KEY, { role: "user", content: "Hello" });
  }

  it("fails closed by default: throws 503 fail_closed and transitions no session", async () => {
    // Seed an active session whose last activity is at the BASE clock, then run
    // the guarded sweep under a clock well past the idle timeout (default
    // fail-closed). A live sweep WOULD transition it active→idle; the guard
    // must prevent any such transition.
    const { db, service: baseService } = buildSessionService(() => NOW, true);
    await seedIdleEligibleSession(baseService);

    const futureIso = () =>
      new Date(Date.parse(NOW) + FRIDAY_SESSION_IDLE_TIMEOUT_MS + 60_000).toISOString();
    // Reuse the same db; default fail-closed (flag unset) on the sweep service.
    const { service: futureService } = buildSessionService(futureIso, undefined, db);

    const activeBefore = await futureService.listSessions({ status: "active" });
    expect(activeBefore.length).toBe(1);

    let caught: unknown;
    try {
      await futureService.sweepLifecycle();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FridayDomainError);
    const domainError = caught as FridayDomainError;
    expect(domainError.code).toBe("TS_RUNTIME_SESSION_RETIRED");
    expect(domainError.httpStatus).toBe(503);
    expect(domainError.details?.classification).toBe("fail_closed");

    // No session transitioned: the idle-eligible session is still active.
    const activeAfter = await futureService.listSessions({ status: "active" });
    expect(activeAfter.length).toBe(1);
    const idleAfter = await futureService.listSessions({ status: "idle" });
    expect(idleAfter.length).toBe(0);
  });

  it("fails closed with explicit allowTestOnlySessionExecution=false", async () => {
    const { service } = buildSessionService(() => NOW, false);
    await expect(service.sweepLifecycle()).rejects.toMatchObject({
      code: "TS_RUNTIME_SESSION_RETIRED",
    });
  });

  it("runs the legacy sweep when allowTestOnlySessionExecution=true", async () => {
    const { service } = buildSessionService(() => NOW, true);
    // No throw; returns a sweep result with the expected counter shape.
    const result = await service.sweepLifecycle();
    expect(result).toMatchObject({
      idledCount: expect.any(Number),
      archivedCount: expect.any(Number),
      prunedCount: expect.any(Number),
      hardDeletedCount: expect.any(Number),
    });
  });
});

describe("Session write mutators TS-retirement method guard (D1 session write legs)", () => {
  const allocatedDbs: FridaySqliteLayer[] = [];
  const ACTIVE_KEY = "discord:default:user1";

  afterEach(() => {
    while (allocatedDbs.length > 0) {
      allocatedDbs.pop()!.close();
    }
    vi.restoreAllMocks();
  });

  function buildSessionService(
    allowTestOnlySessionExecution?: boolean,
    existingDb?: FridaySqliteLayer,
  ): { db: FridaySqliteLayer; service: FridaySessionService } {
    const db = existingDb ?? createTestDb();
    if (!existingDb) {
      allocatedDbs.push(db);
    }
    const service = createFridaySessionService({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      ...(allowTestOnlySessionExecution === undefined
        ? {}
        : { allowTestOnlySessionExecution }),
    });
    return { db, service };
  }

  async function seedActiveSession(service: FridaySessionService): Promise<void> {
    await service.createSession({
      channel: "discord",
      chatId: "user1",
      userId: "user1",
      metadata: { seed: true },
    });
    await service.addMessage(ACTIVE_KEY, {
      role: "user",
      content: "seed message",
      idempotencyKey: "seed-message",
      metadata: { seed: true },
    });
  }

  it("does not run the boot-time legacy backfill unless the test-only write flag is true", () => {
    const db = createTestDb();
    allocatedDbs.push(db);
    const writeSpy = vi.spyOn(db, "withWriteTransaction");

    createFridaySessionService({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
    });

    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("keeps active getOrCreateSession as a read while failing closed missing-session creation", async () => {
    const { db, service: seedService } = buildSessionService(true);
    await seedActiveSession(seedService);

    const { service: guardedService } = buildSessionService(undefined, db);

    await expect(guardedService.getOrCreateSession(ACTIVE_KEY)).resolves.toMatchObject({
      key: ACTIVE_KEY,
      status: "active",
    });

    const missingKey = "discord:default:missing-user";
    await expectSessionWriteRetired(() => guardedService.getOrCreateSession(missingKey));
    await expect(guardedService.getSession(missingKey)).resolves.toBeNull();
  });

  it("fails closed common session write mutators before DB side effects", async () => {
    const { db, service: seedService } = buildSessionService(true);
    await seedActiveSession(seedService);
    const { service: guardedService } = buildSessionService(undefined, db);

    const beforeMessages = await guardedService.getMessages(ACTIVE_KEY);
    expect(beforeMessages.length).toBe(1);

    await expectSessionWriteRetired(() =>
      guardedService.createSession({ channel: "discord", chatId: "blocked-create" }),
    );
    await expect(guardedService.getSession("discord:default:blocked-create")).resolves.toBeNull();

    await expectSessionWriteRetired(() =>
      guardedService.addMessage(ACTIVE_KEY, { role: "user", content: "blocked append" }),
    );
    await expectSessionWriteRetired(() =>
      guardedService.updateMessageMetadataByIdempotency(ACTIVE_KEY, {
        idempotencyKey: "seed-message",
        metadataPatch: { blocked: true },
      }),
    );
    await expectSessionWriteRetired(() => guardedService.archiveSession(ACTIVE_KEY));
    await expectSessionWriteRetired(() => guardedService.pruneOldSessions(NOW));
    await expectSessionWriteRetired(() => guardedService.resetSession(ACTIVE_KEY));
    await expectSessionWriteRetired(() =>
      guardedService.setConversationFocus(ACTIVE_KEY, { updatedAt: NOW }),
    );
    await expectSessionWriteRetired(() =>
      guardedService.mergeMetadata(ACTIVE_KEY, { blocked: true }),
    );
    await expectSessionWriteRetired(() => guardedService.setSendPolicy(ACTIVE_KEY, "block"));
    await expectSessionWriteRetired(() =>
      guardedService.alignSessionContext(ACTIVE_KEY, { userId: "blocked-user" }),
    );

    const afterSession = await guardedService.getSession(ACTIVE_KEY);
    expect(afterSession).toMatchObject({
      status: "active",
      userId: "user1",
      metadata: { seed: true },
    });
    expect(afterSession?.sendPolicy).toBeUndefined();
    expect(await guardedService.evaluateSendPolicy(ACTIVE_KEY)).toBe("allow");
    expect(await guardedService.getConversationFocus(ACTIVE_KEY)).toBeNull();

    const afterMessages = await guardedService.getMessages(ACTIVE_KEY);
    expect(afterMessages).toHaveLength(beforeMessages.length);
    expect(afterMessages[0]?.metadata).toEqual({ seed: true });
  });

  it("fails closed fork merge before parent summary or fork archive writes", async () => {
    const { db, service: seedService } = buildSessionService(true);
    await seedActiveSession(seedService);
    const fork = await seedService.forkSession(ACTIVE_KEY, { taskId: "merge-retired" });
    const beforeParentMessages = await seedService.getMessages(ACTIVE_KEY);

    const { service: guardedService } = buildSessionService(undefined, db);
    await expectSessionWriteRetired(() =>
      guardedService.mergeForkSummary(ACTIVE_KEY, {
        forkSessionKey: fork.forkSession.key,
        summary: "blocked merge summary",
        archiveFork: true,
      }),
    );

    expect(await guardedService.getMessages(ACTIVE_KEY)).toHaveLength(beforeParentMessages.length);
    expect(await guardedService.getSession(fork.forkSession.key)).toMatchObject({
      status: "active",
    });
  });
});

describe("Session forkSession TS-retirement method guard (A3 HOLE 2)", () => {
  const allocatedDbs: FridaySqliteLayer[] = [];
  const PARENT_KEY = "discord:default:user1";

  afterEach(() => {
    while (allocatedDbs.length > 0) {
      allocatedDbs.pop()!.close();
    }
    vi.restoreAllMocks();
  });

  function buildSessionService(
    allowTestOnlySessionExecution?: boolean,
  ): { db: FridaySqliteLayer; service: FridaySessionService } {
    const db = createTestDb();
    allocatedDbs.push(db);
    const service = createFridaySessionService({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      ...(allowTestOnlySessionExecution === undefined
        ? {}
        : { allowTestOnlySessionExecution }),
    });
    return { db, service };
  }

  async function seedParent(service: FridaySessionService): Promise<void> {
    await service.createSession({ channel: "discord", chatId: "user1", userId: "user1" });
    await service.addMessage(PARENT_KEY, { role: "user", content: "parent message" });
  }

  it("fails closed by default: 503 fail_closed and creates NO fork session", async () => {
    // Seed the parent under an open service, then fork under a DEFAULT (flag
    // unset) service so the guard is the only thing that can stop the fork.
    const { db, service: seedService } = buildSessionService(true);
    await seedParent(seedService);

    const forkService = createFridaySessionService({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
    });

    const before = await forkService.listSessions({});
    const beforeCount = before.length;

    let caught: unknown;
    try {
      await forkService.forkSession(PARENT_KEY, { taskId: "fork-task" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FridayDomainError);
    const domainError = caught as FridayDomainError;
    expect(domainError.code).toBe("TS_RUNTIME_SESSION_RETIRED");
    expect(domainError.httpStatus).toBe(503);
    expect(domainError.details?.classification).toBe("fail_closed");

    // No fork was created: guard fired BEFORE the write transaction.
    const after = await forkService.listSessions({});
    expect(after.length).toBe(beforeCount);
  });

  it("fails closed with explicit allowTestOnlySessionExecution=false", async () => {
    const { service } = buildSessionService(false);
    await expect(service.forkSession(PARENT_KEY, { taskId: "fork-task" })).rejects.toMatchObject({
      code: "TS_RUNTIME_SESSION_RETIRED",
    });
  });

  it("creates the fork when allowTestOnlySessionExecution=true (legacy path)", async () => {
    const { service } = buildSessionService(true);
    await seedParent(service);
    const result = await service.forkSession(PARENT_KEY, { taskId: "fork-task" });
    expect(result.forkSession).toBeDefined();
    expect(result.forkSession.key).not.toBe(PARENT_KEY);
  });
});

describe("Session memory extraction TS-retirement method guard", () => {
  let db: FridaySqliteLayer;
  let sessionService: FridaySessionService;
  let providerService: FridayProviderService;
  let memoryService: FridayMemoryService;
  const extractionRepo = createFridaySessionMemoryExtractionRepository();

  beforeEach(async () => {
    db = createTestDb();
    const idGen = createTestIdGenerator();
    sessionService = createFridaySessionService({
      db,
      idGenerator: idGen,
      nowIso: () => NOW,
      allowTestOnlySessionExecution: true,
    });
    providerService = createBoobyTrappedProviderService();
    memoryService = createBoobyTrappedMemoryService();
    // Seed a session with pending messages so the inline path would have work.
    await sessionService.createSession({ channel: "discord", chatId: "user1", userId: "user1" });
    await sessionService.addMessage(SESSION_KEY, { role: "user", content: "remember dark mode" });
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  function buildExtractionService(
    allowTestOnlySessionMemoryExtractionExecution?: boolean,
  ): FridaySessionMemoryExtractionService {
    return createFridaySessionMemoryExtractionService({
      db,
      sessionService,
      memoryService,
      providerService,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      ...(allowTestOnlySessionMemoryExtractionExecution === undefined
        ? {}
        : { allowTestOnlySessionMemoryExtractionExecution }),
    });
  }

  function queuedJobCount(): number {
    return db.withReadConnection((d) =>
      extractionRepo.countBySessionAndStatus(d, SESSION_KEY, ["queued", "running"]),
    );
  }

  it("extractFromSession fails closed by default: 503, no provider call, no job enqueued, no memory store", async () => {
    const extractionService = buildExtractionService();

    let caught: unknown;
    try {
      await extractionService.extractFromSession(SESSION_KEY, { trigger: "auto", mode: "queue" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FridayDomainError);
    const domainError = caught as FridayDomainError;
    expect(domainError.code).toBe("TS_RUNTIME_SESSION_MEMORY_EXTRACTION_RETIRED");
    expect(domainError.httpStatus).toBe(503);
    expect(domainError.details?.classification).toBe("fail_closed");

    expect(providerService.runWithFallback).not.toHaveBeenCalled();
    expect(memoryService.store).not.toHaveBeenCalled();
    expect(queuedJobCount()).toBe(0);
  });

  it("extractFromSession inline mode fails closed before any provider/LLM call", async () => {
    const extractionService = buildExtractionService();
    await expect(
      extractionService.extractFromSession(SESSION_KEY, { trigger: "manual", mode: "inline" }),
    ).rejects.toMatchObject({ code: "TS_RUNTIME_SESSION_MEMORY_EXTRACTION_RETIRED" });
    expect(providerService.runWithFallback).not.toHaveBeenCalled();
    expect(memoryService.store).not.toHaveBeenCalled();
  });

  it("extractSpecificMessages fails closed by default before any side effect", async () => {
    const extractionService = buildExtractionService();
    await expect(
      extractionService.extractSpecificMessages(SESSION_KEY, ["msg-1"], { mode: "inline" }),
    ).rejects.toMatchObject({ code: "TS_RUNTIME_SESSION_MEMORY_EXTRACTION_RETIRED" });
    expect(providerService.runWithFallback).not.toHaveBeenCalled();
    expect(memoryService.store).not.toHaveBeenCalled();
    expect(queuedJobCount()).toBe(0);
  });

  it("retryFailedExtractions fails closed by default and queues no retry job", async () => {
    const extractionService = buildExtractionService();
    await expect(
      extractionService.retryFailedExtractions(SESSION_KEY),
    ).rejects.toMatchObject({ code: "TS_RUNTIME_SESSION_MEMORY_EXTRACTION_RETIRED" });
    expect(queuedJobCount()).toBe(0);
  });

  it("fails closed with explicit allowTestOnlySessionMemoryExtractionExecution=false", async () => {
    const extractionService = buildExtractionService(false);
    await expect(
      extractionService.extractFromSession(SESSION_KEY, { trigger: "auto", mode: "queue" }),
    ).rejects.toMatchObject({ code: "TS_RUNTIME_SESSION_MEMORY_EXTRACTION_RETIRED" });
  });

  it("enqueues a job when allowTestOnlySessionMemoryExtractionExecution=true (legacy path)", async () => {
    const extractionService = buildExtractionService(true);
    const result = await extractionService.extractFromSession(SESSION_KEY, {
      trigger: "auto",
      mode: "queue",
    });
    // Queue mode only writes a job row — no provider/LLM call, no memory store.
    expect(result.queued).toBe(true);
    expect(queuedJobCount()).toBe(1);
    expect(providerService.runWithFallback).not.toHaveBeenCalled();
    expect(memoryService.store).not.toHaveBeenCalled();
  });
});
