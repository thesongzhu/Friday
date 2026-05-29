import { vi } from "vitest";
import type { FridayMemoryService } from "#memory";
import type {
  FridayMemoryGuardContext,
  FridayMemoryGuardPiiGuard,
  FridayMemoryGuardQuotaRepository,
  FridayMemoryGuardRateLimiter,
  FridayMemoryGuardOutputFilter,
  FridayMemoryGuardService,
} from "#memory";
import type { FridaySqliteLayer } from "#state";
import type { FridayMemoryItem, FridayMemorySearchResult } from "#memory";
import { createFridayMemoryGuardService } from "#memory";

const NOW = "2026-02-18T10:00:00.000Z";
const NOW_MS = new Date(NOW).getTime();

export function createMockMemoryItem(overrides?: Partial<FridayMemoryItem>): FridayMemoryItem {
  return {
    id: "item-1",
    namespace: "tenant.default.user.user1.test-ns",
    key: "key-1",
    content: "Hello world",
    source: "system",
    tags: [],
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function createMockSearchResult(overrides?: Partial<FridayMemorySearchResult>): FridayMemorySearchResult {
  return {
    item: createMockMemoryItem(),
    score: 0.9,
    ftsScore: 0.8,
    semanticScore: 1.0,
    matchedBy: ["fts"],
    snippet: "Hello world",
    ...overrides,
  };
}

export function createMockCoreService(): FridayMemoryService {
  return {
    store: vi.fn().mockResolvedValue(createMockMemoryItem()),
    search: vi.fn().mockResolvedValue([createMockSearchResult()]),
    get: vi.fn().mockResolvedValue(createMockMemoryItem()),
    list: vi.fn().mockResolvedValue([createMockMemoryItem()]),
    delete: vi.fn().mockResolvedValue(true),
    prune: vi.fn().mockResolvedValue({ deletedCount: 0, deletedIds: [], dryRun: false }),
  };
}

export function createMockRateLimiter(): FridayMemoryGuardRateLimiter {
  return {
    consume: vi.fn().mockReturnValue({
      allowed: true,
      action: "write",
      key: "ns:write:test",
      remaining: 99,
      resetAt: NOW,
      retryAfterMs: 0,
    }),
  };
}

export function createMockQuotaRepo(): FridayMemoryGuardQuotaRepository {
  return {
    getNamespaceUsage: vi.fn().mockReturnValue({
      namespace: "test",
      itemCount: 0,
      totalBytes: 0,
      expiredItemCount: 0,
      expiredBytes: 0,
    }),
    listNamespacesByPrefix: vi.fn().mockReturnValue([]),
    pruneExpiredOldest: vi.fn().mockReturnValue({ deletedCount: 0, deletedBytes: 0, deletedIds: [] }),
  };
}

export function createMockPiiGuard(): FridayMemoryGuardPiiGuard {
  return {
    scanAndTransform: vi.fn().mockReturnValue({
      matches: [],
      distinctTypes: [],
      transformedContent: "Hello world",
      tagsToAdd: [],
    }),
    // Default: passthrough (no PII found) — returns the value unchanged with no extra tags.
    redactDeep: vi.fn().mockImplementation((value: unknown) => ({ value, tagsToAdd: [] })),
  };
}

export function createMockOutputFilter(): FridayMemoryGuardOutputFilter {
  return {
    filterItem: vi.fn().mockImplementation((item: FridayMemoryItem) => item),
    filterSearchResults: vi.fn().mockImplementation((results: FridayMemorySearchResult[]) => results),
  };
}

export function createMockDb(): FridaySqliteLayer {
  return {
    dbPath: ":memory:",
    writer: {} as FridaySqliteLayer["writer"],
    reads: {
      size: 1,
      withReadConnection: vi.fn().mockImplementation((fn: (db: unknown) => unknown) => fn({})),
      close: vi.fn(),
    },
    withWriteTransaction: vi.fn().mockImplementation((fn: (db: unknown) => unknown) => fn({})),
    withReadConnection: vi.fn().mockImplementation((fn: (db: unknown) => unknown) => fn({})),
    checkpoint: vi.fn(),
    close: vi.fn(),
  };
}

export interface GuardTestSetup {
  guard: FridayMemoryGuardService;
  core: FridayMemoryService;
  rateLimiter: FridayMemoryGuardRateLimiter;
  quotaRepo: FridayMemoryGuardQuotaRepository;
  piiGuard: FridayMemoryGuardPiiGuard;
  outputFilter: FridayMemoryGuardOutputFilter;
  db: FridaySqliteLayer;
  context: FridayMemoryGuardContext;
}

export function createGuardTestSetup(contextOverrides?: Partial<FridayMemoryGuardContext>): GuardTestSetup {
  const core = createMockCoreService();
  const rateLimiter = createMockRateLimiter();
  const quotaRepo = createMockQuotaRepo();
  const piiGuard = createMockPiiGuard();
  const outputFilter = createMockOutputFilter();
  const db = createMockDb();

  const context: FridayMemoryGuardContext = {
    subject: {
      hubId: "default",
      userId: "user1",
      accessLevel: "tenant",
    },
    principalId: "principal-1",
    ...contextOverrides,
  };

  const guard = createFridayMemoryGuardService({
    core,
    db,
    nowIso: () => NOW,
    nowMs: () => NOW_MS,
    context,
    rateLimiter,
    quotaRepo,
    piiGuard,
    outputFilter,
  });

  return { guard, core, rateLimiter, quotaRepo, piiGuard, outputFilter, db, context };
}
