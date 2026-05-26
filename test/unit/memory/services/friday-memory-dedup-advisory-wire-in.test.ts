import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayMemoryService } from "#memory";
import type {
  FridayMemoryDedupAdvisoryEvent,
  FridayMemoryService,
} from "#memory";
import type { FridayProviderService } from "#providers";
import { FridayDomainError } from "#errors";

/**
 * B4 / FRI-AUD-006 advisory wire-in regression suite.
 *
 * Operator directive (2026-05-26): advisory-only, non-destructive.
 *   - Distinct memory stores normally with NO advisory.
 *   - Duplicate-like memory still stores successfully (never blocked).
 *   - Duplicate-like memory triggers an additional audit/advisory event
 *     via deps.dedupAdvisorySink.
 *   - No memory is deleted, overwritten, merged, or auto-merged.
 *   - Blast-radius: existing store/search/recall behavior unchanged.
 */

const NOW = "2026-02-17T10:00:00.000Z";

// Embedding vector helper — identical vectors produce identical cosine
// similarity which surfaces as a high FTS+semantic merged score.
function makeEmbedFetch(vector: readonly number[]): typeof fetch {
  return vi.fn(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: [{ embedding: [...vector], index: 0 }],
          model: "text-embedding-3-small",
        }),
        { status: 200 },
      ),
    ),
  ) as typeof fetch;
}

function createMockProviderService(): FridayProviderService {
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
    runWithFallback: vi.fn().mockImplementation(async (params) => {
      const route = {
        provider: {
          id: "prov-1",
          kind: "openai" as const,
          name: "OpenAI",
          baseUrl: "https://api.openai.com",
          enabled: true,
          config: {
            api: "openai-completions" as const,
            authMode: "api-key" as const,
            keySource: { kind: "none" as const },
            supportedModels: ["text-embedding-3-small"],
          },
          createdAt: NOW,
          updatedAt: NOW,
        },
        model: "text-embedding-3-small",
      };
      const result = await params.run(route, "sk-test-key"); // pragma: allowlist secret
      return {
        result,
        route,
        attempts: [],
        routingDecision: {
          strategy: "direct" as const,
          reason: "test",
          budget: { withinBudget: true, remainingUsd: 100, monthlyLimitUsd: 100, spentUsd: 0 },
        },
      };
    }),
    recordUsage: vi.fn(),
    getUsageSummary: vi.fn(),
    getBudgetStatus: vi.fn(),
  } as unknown as FridayProviderService;
}

describe("memoryService.store advisory-only dedup wire-in (B4 / FRI-AUD-006)", () => {
  let db: FridaySqliteLayer;
  let idGen: () => string;
  let service: FridayMemoryService;
  let advisorySink: ReturnType<typeof vi.fn<[FridayMemoryDedupAdvisoryEvent], void>>;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();
    globalThis.fetch = makeEmbedFetch([0.1, 0.2, 0.3]);
    advisorySink = vi.fn();
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    service = createFridayMemoryService({
      db,
      providerService: createMockProviderService(),
      idGenerator: idGen,
      nowIso: () => NOW,
      dedupAdvisorySink: advisorySink,
      // Lower threshold so the simple FTS-only test corpus produces a positive
      // for the same-text duplicate case below. The default 0.92 is calibrated
      // for the hybrid FTS+semantic merge produced by full embedding lanes.
      dedupThreshold: 0.5,
    });
  });

  afterEach(() => {
    db.close();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("Test 1: distinct memory stores normally and emits NO advisory", async () => {
    const item = await service.store("notes", "Coffee meeting at 3pm with Alice", { source: "user" });

    expect(item.id).toBeTruthy();
    expect(item.content).toBe("Coffee meeting at 3pm with Alice");
    expect(advisorySink).not.toHaveBeenCalled();
    expect(
      consoleInfoSpy.mock.calls.some((args) =>
        typeof args[0] === "string" && args[0].includes("dedup advisory: candidate"),
      ),
    ).toBe(false);
  });

  it("Test 2: duplicate-like memory still stores successfully (never blocked)", async () => {
    const firstItem = await service.store("notes", "User prefers dark mode UI everywhere", { source: "user" });
    const secondItem = await service.store("notes", "User prefers dark mode UI everywhere", { source: "user" });

    // BOTH items persisted. Different IDs. Neither rejected.
    expect(firstItem.id).toBeTruthy();
    expect(secondItem.id).toBeTruthy();
    expect(secondItem.id).not.toBe(firstItem.id);

    // Both rows are in the durable store (no overwrite, no merge).
    const listed = await service.list({ namespace: "notes" });
    const listedIds = listed.map((it) => it.id).sort();
    expect(listedIds).toEqual([firstItem.id, secondItem.id].sort());

    // Content preserved exactly on BOTH rows (no field clobber).
    const fetched1 = await service.get(firstItem.id);
    const fetched2 = await service.get(secondItem.id);
    expect(fetched1?.content).toBe("User prefers dark mode UI everywhere");
    expect(fetched2?.content).toBe("User prefers dark mode UI everywhere");
  });

  it("Test 3: duplicate-like memory triggers an advisory event with the expected shape", async () => {
    const firstItem = await service.store("notes", "User prefers dark mode UI everywhere", { source: "user" });
    advisorySink.mockClear();
    consoleInfoSpy.mockClear();
    const secondItem = await service.store("notes", "User prefers dark mode UI everywhere", { source: "user" });

    expect(advisorySink).toHaveBeenCalledTimes(1);
    const event = advisorySink.mock.calls[0]![0];
    expect(event.kind).toBe("memory.dedup.advisory");
    expect(event.candidateItemId).toBe(secondItem.id);
    expect(event.existingItemId).toBe(firstItem.id);
    expect(event.namespace).toBe("notes");
    expect(event.threshold).toBe(0.5);
    expect(event.bestScore).toBeGreaterThanOrEqual(0.5);
    expect(event.bestScore).toBeLessThanOrEqual(1.0);
    expect(event.timestamp).toBe(NOW);

    // console.info advisory line emitted too.
    expect(
      consoleInfoSpy.mock.calls.some((args) => {
        const msg = args[0];
        return (
          typeof msg === "string"
          && msg.includes("dedup advisory: candidate")
          && msg.includes(secondItem.id)
          && msg.includes(firstItem.id)
          && msg.includes("policy_pending")
        );
      }),
    ).toBe(true);
  });

  it("Test 4: no memory is deleted, overwritten, merged, or auto-merged", async () => {
    // Store three near-duplicate items, capture their IDs + content + metadata.
    const a = await service.store("notes", "Project Atlas kickoff is on March 1", {
      source: "user",
      tags: ["project", "atlas"],
      metadata: { calendarEvent: "atlas-kickoff" },
    });
    const b = await service.store("notes", "Project Atlas kickoff is on March 1", {
      source: "user",
      tags: ["project", "atlas", "duplicate-suspect"],
      metadata: { calendarEvent: "atlas-kickoff", reviewer: "claude" },
    });
    const c = await service.store("notes", "Project Atlas kickoff is on March 1", {
      source: "agent",
      tags: ["project", "atlas", "third"],
    });

    // All three rows persisted with their ORIGINAL IDs.
    const listed = await service.list({ namespace: "notes" });
    expect(listed.map((it) => it.id).sort()).toEqual([a.id, b.id, c.id].sort());

    // Each row preserved its OWN tags + metadata exactly — no merge into a single row.
    const fetchedA = await service.get(a.id);
    const fetchedB = await service.get(b.id);
    const fetchedC = await service.get(c.id);
    expect(fetchedA?.tags.sort()).toEqual(["atlas", "project"].sort());
    expect(fetchedB?.tags.sort()).toEqual(["atlas", "duplicate-suspect", "project"].sort());
    expect(fetchedC?.tags.sort()).toEqual(["atlas", "project", "third"].sort());
    expect(fetchedB?.metadata).toEqual({ calendarEvent: "atlas-kickoff", reviewer: "claude" });
    expect(fetchedC?.source).toBe("agent");

    // Content preserved on every row (no overwrite, no clobber).
    expect(fetchedA?.content).toBe("Project Atlas kickoff is on March 1");
    expect(fetchedB?.content).toBe("Project Atlas kickoff is on March 1");
    expect(fetchedC?.content).toBe("Project Atlas kickoff is on March 1");
  });

  it("Test 5: blast-radius — store/search/get/list/delete basic paths still work", async () => {
    // store
    const item1 = await service.store("blast", "alpha bravo charlie", { source: "user", tags: ["t1"] });
    const item2 = await service.store("blast", "delta echo foxtrot", { source: "user", tags: ["t2"] });

    // search by FTS hits something
    const hits = await service.search("alpha");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.item.id === item1.id)).toBe(true);

    // get returns the item
    const fetched = await service.get(item2.id);
    expect(fetched?.content).toBe("delta echo foxtrot");

    // list returns both
    const listed = await service.list({ namespace: "blast" });
    expect(listed).toHaveLength(2);

    // delete returns true and removes the row
    const deleted = await service.delete(item1.id);
    expect(deleted).toBe(true);
    const fetchedAfterDelete = await service.get(item1.id);
    expect(fetchedAfterDelete).toBeNull();

    // Empty query still errors as before (no behavior regression).
    await expect(service.search("")).rejects.toBeInstanceOf(FridayDomainError);
  });

  it("Test 6: sink that throws does not break the store path", async () => {
    advisorySink.mockImplementation(() => {
      throw new Error("sink-boom");
    });

    await service.store("notes", "Identical sentence one", { source: "user" });
    const item = await service.store("notes", "Identical sentence one", { source: "user" });

    // Store still succeeded despite sink throwing.
    expect(item.id).toBeTruthy();
    const listed = await service.list({ namespace: "notes" });
    expect(listed.length).toBe(2);
  });

  it("Test 7: defaults — when no dedupAdvisorySink is provided, store path still succeeds", async () => {
    const sinkless = createFridayMemoryService({
      db,
      providerService: createMockProviderService(),
      idGenerator: idGen,
      nowIso: () => NOW,
      // no dedupAdvisorySink, no dedupThreshold — defaults apply.
    });

    await sinkless.store("notes", "Solo entry no advisory wiring", { source: "user" });
    const second = await sinkless.store("notes", "Solo entry no advisory wiring", { source: "user" });

    expect(second.id).toBeTruthy();
    const listed = await sinkless.list({ namespace: "notes" });
    expect(listed.length).toBe(2);
    expect(advisorySink).not.toHaveBeenCalled();
  });
});
