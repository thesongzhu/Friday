import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createFridayMemoryRoutes } from "#api";
import type { FridayHttpContext, FridayRouteDefinition } from "#api";
import {
  createFridayMemoryFileSyncRepository,
  createFridayMemoryFileSyncService,
  createFridayMemoryGuardServiceFactory,
  createFridayMemoryService,
  memoryNamespaceExportPath,
} from "#memory";
import type { FridayMemoryDedupAdvisoryEvent, FridayMemoryItem, FridayMemorySearchResult } from "#memory";
import type { FridayProviderService } from "#providers";
import { createFridaySqliteLayer } from "#state";

const START = "2026-05-27T10:00:00.000Z";

function createProviderWithoutEmbeddings(): FridayProviderService {
  return {
    listProviders: vi.fn(),
    getProvider: vi.fn(),
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    validateProvider: vi.fn(),
    getRoutingConfig: vi.fn(),
    setRoutingConfig: vi.fn(),
    resolveRoute: vi.fn(),
    runWithFallback: vi.fn().mockRejectedValue(
      new Error("No enabled providers available for routing: memory-cognition-v1-proof"),
    ),
    recordUsage: vi.fn(),
    getUsageSummary: vi.fn(),
    getBudgetStatus: vi.fn(),
    setBudgetConfig: vi.fn(),
  } as unknown as FridayProviderService;
}

function makeCtx(
  overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {},
): FridayHttpContext<unknown, unknown, unknown> {
  return {
    requestId: "req-memory-cognition-v1",
    receivedAt: START,
    params: {},
    query: {},
    body: {},
    headers: {},
    principal: {
      principalType: "user",
      principalId: "user-1",
      userId: "user-1",
      role: "admin",
      scopes: ["hub.admin", "memory.read", "memory.write"],
      tokenId: "tok-1",
      tokenKind: "access",
      issuedAt: START,
    },
    ...overrides,
  };
}

function findRoute(
  routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[],
  operationId: string,
): FridayRouteDefinition<unknown, unknown, unknown, unknown> {
  const route = routes.find((candidate) => candidate.operationId === operationId);
  if (!route) throw new Error(`route not found: ${operationId}`);
  return route;
}

describe("Memory cognition v1 proof", () => {
  let tmpDir: string;
  let db: ReturnType<typeof createFridaySqliteLayer>;
  let nowIso: string;
  let idCounter: number;
  let dedupEvents: FridayMemoryDedupAdvisoryEvent[];
  let routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[];

  function boot(existingDbPath?: string): void {
    db = createFridaySqliteLayer({
      dbPath: existingDbPath ?? path.join(tmpDir, "friday-memory-proof.db"),
      readPoolSize: 1,
      pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
    });
    const memoryService = createFridayMemoryService({
      db,
      providerService: createProviderWithoutEmbeddings(),
      idGenerator: () => `mem-proof-${String(++idCounter).padStart(4, "0")}`,
      nowIso: () => nowIso,
      dedupAdvisorySink: (event) => dedupEvents.push(event),
      dedupThreshold: 0.5,
    });
    const memoryGuardFactory = createFridayMemoryGuardServiceFactory({
      core: memoryService,
      db,
      nowIso: () => nowIso,
      nowMs: () => Date.parse(nowIso),
    });
    routes = createFridayMemoryRoutes({ memoryGuardFactory });
  }

  async function store(body: Record<string, unknown>): Promise<FridayMemoryItem> {
    const result = await findRoute(routes, "memory.items.create").handler(makeCtx({ body })) as { item: FridayMemoryItem };
    return result.item;
  }

  async function search(body: Record<string, unknown>): Promise<FridayMemorySearchResult[]> {
    const result = await findRoute(routes, "memory.search").handler(makeCtx({ body })) as { items: FridayMemorySearchResult[] };
    return result.items;
  }

  async function get(id: string): Promise<FridayMemoryItem> {
    const result = await findRoute(routes, "memory.get").handler(makeCtx({ params: { id } })) as { item: FridayMemoryItem };
    return result.item;
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-memory-cognition-v1-"));
    nowIso = START;
    idCounter = 0;
    dedupEvents = [];
    boot();
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {
      // best effort test cleanup
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("proves guarded top-k recall, confidence/access/decay ranking, PII redaction, non-destructive sync, restart recovery, and advisory-only dedup", async () => {
    const pii = await store({
      namespace: "cognition",
      content: "Contact user@example.com for the concierge workflow",
      memoryType: "fact",
      confidence: 0.9,
    });
    expect(pii.content).toContain("[EMAIL]");
    expect(pii.content).not.toContain("user@example.com");
    expect(pii.tags).toContain("pii.email");

    await store({
      namespace: "cognition",
      content: "alpha topk shared lower-confidence candidate",
      memoryType: "procedure",
      confidence: 0.2,
    });
    const highConfidence = await store({
      namespace: "cognition",
      content: "alpha topk shared higher-confidence candidate",
      memoryType: "procedure",
      confidence: 0.95,
    });
    const topK = await search({
      namespace: "cognition",
      query: "alpha topk shared candidate",
      limit: 1,
      memoryType: "procedure",
      boostByConfidence: true,
    });
    expect(topK).toHaveLength(1);
    expect(topK[0]!.item.id).toBe(highConfidence.id);

    const used = await store({
      namespace: "cognition",
      content: "accessrank shared used candidate",
      memoryType: "fact",
      confidence: 0.5,
    });
    const fresh = await store({
      namespace: "cognition",
      content: "accessrank shared fresh candidate",
      memoryType: "fact",
      confidence: 0.5,
    });
    await search({ namespace: "cognition", query: "used", limit: 1 });
    await search({ namespace: "cognition", query: "used", limit: 1 });
    await search({ namespace: "cognition", query: "used", limit: 1 });
    const accessRanked = await search({
      namespace: "cognition",
      query: "accessrank shared candidate",
      limit: 2,
      boostByAccess: true,
    });
    expect(accessRanked.map((entry) => entry.item.id)).toContain(used.id);
    expect(accessRanked.map((entry) => entry.item.id)).toContain(fresh.id);
    expect(accessRanked[0]!.item.id).toBe(used.id);
    expect((await get(used.id)).accessCount).toBeGreaterThan((await get(fresh.id)).accessCount ?? 0);

    nowIso = "2025-01-01T00:00:00.000Z";
    const stale = await store({
      namespace: "cognition",
      content: "decayrank shared stale candidate",
      memoryType: "fact",
      confidence: 1,
    });
    nowIso = "2026-05-27T10:00:00.000Z";
    const recent = await store({
      namespace: "cognition",
      content: "decayrank shared recent candidate",
      memoryType: "fact",
      confidence: 0.6,
    });
    const decayed = await search({
      namespace: "cognition",
      query: "decayrank shared candidate",
      limit: 1,
      boostByConfidence: true,
      applyRetentionDecay: true,
      retentionHalfLifeDays: 30,
    });
    expect(decayed[0]!.item.id).toBe(recent.id);
    expect((await get(stale.id)).confidence).toBe(1);

    await store({
      namespace: "cognition",
      content: "dedup advisory only keeps both duplicate rows",
      key: "dedup-a",
      memoryType: "fact",
      confidence: 0.8,
    });
    await store({
      namespace: "cognition",
      content: "dedup advisory only keeps both duplicate rows",
      key: "dedup-b",
      memoryType: "fact",
      confidence: 0.8,
    });
    const duplicates = await search({
      namespace: "cognition",
      query: "dedup advisory duplicate",
      limit: 10,
    });
    expect(duplicates.filter((entry) => entry.item.content.includes("dedup advisory only")).length).toBeGreaterThanOrEqual(2);

    const syncRepo = createFridayMemoryFileSyncRepository({ db });
    const syncService = createFridayMemoryFileSyncService({
      repository: syncRepo,
      stateDir: tmpDir,
      enableWatcher: false,
      nowIso: () => nowIso,
    });
    const syncResult = await syncService.syncNow({ force: true });
    expect(syncResult.errors).toHaveLength(0);
    expect(syncResult.filesWritten).toBeGreaterThan(0);

    const exportPath = memoryNamespaceExportPath(tmpDir, pii.namespace);
    const exported = JSON.parse(await fs.readFile(exportPath, "utf8")) as {
      items: Array<Record<string, unknown>>;
    };
    exported.items = exported.items.filter((item) => item.id !== fresh.id);
    exported.items.push({
      id: "file-added-memory",
      key: "file-added-memory",
      value: "file added non destructive proof",
      contentText: "file added non destructive proof",
      source: "file-edit",
      tags: [],
      metadata: {},
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    await fs.writeFile(exportPath, JSON.stringify(exported, null, 2), "utf8");

    const reindexResult = await syncService.reindexNow("memory_namespace", pii.namespace);
    expect(reindexResult.errors).toHaveLength(0);
    expect(reindexResult.filesProcessed).toBe(1);
    expect(reindexResult.itemsDeleted).toBe(0);
    await expect(get(fresh.id)).resolves.toMatchObject({ id: fresh.id });
    expect(await search({
      namespace: "cognition",
      query: "file added non destructive proof",
      limit: 1,
    })).toHaveLength(1);

    const dbPath = db.dbPath;
    db.close();
    boot(dbPath);

    const afterRestart = await search({
      namespace: "cognition",
      query: "file added non destructive proof",
      limit: 1,
    });
    expect(afterRestart).toHaveLength(1);
    expect(afterRestart[0]!.item.content).toBe("file added non destructive proof");

    const piiAfterRestart = await search({
      namespace: "cognition",
      query: "concierge workflow",
      limit: 1,
    });
    expect(piiAfterRestart[0]!.item.content).toContain("[EMAIL]");
    expect(piiAfterRestart[0]!.item.content).not.toContain("user@example.com");
  });
});
