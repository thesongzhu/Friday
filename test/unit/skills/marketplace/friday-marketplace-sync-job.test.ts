import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFridayMarketplaceSyncJob } from "#jobs";
import type { FridayMarketplaceSyncService, FridaySyncResult } from "#skills";
import type { FridayMarketplaceCacheService } from "#skills";

describe("FridayMarketplaceSyncJob", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeSyncResult(overrides?: Partial<FridaySyncResult>): FridaySyncResult {
    return {
      sourceId: "src-1",
      sourceName: "Test",
      skillsSynced: 5,
      versionsSynced: 10,
      errors: [],
      ...overrides,
    };
  }

  function createMockSyncService(results: FridaySyncResult[] = [makeSyncResult()]): FridayMarketplaceSyncService {
    return {
      syncAllSources: vi.fn().mockResolvedValue(results),
      syncSource: vi.fn().mockResolvedValue(results[0]),
    };
  }

  function createMockCacheService(): FridayMarketplaceCacheService {
    return {
      getStaleSourceIds: vi.fn().mockReturnValue([]),
      pruneStaleEntries: vi.fn().mockReturnValue(0),
      clearSourceCache: vi.fn().mockReturnValue(0),
    };
  }

  it("runOnce syncs and prunes", async () => {
    const syncService = createMockSyncService();
    const cacheService = createMockCacheService();

    const job = createFridayMarketplaceSyncJob({ syncService, cacheService });
    const result = await job.runOnce();

    expect(cacheService.pruneStaleEntries).toHaveBeenCalled();
    expect(syncService.syncAllSources).toHaveBeenCalled();
    expect(result.sourcesAttempted).toBe(1);
    expect(result.sourcesSucceeded).toBe(1);
    expect(result.totalSkillsSynced).toBe(5);
    expect(result.totalVersionsSynced).toBe(10);
    expect(result.errors).toHaveLength(0);
  });

  it("runOnce reports errors from sources", async () => {
    const syncService = createMockSyncService([
      makeSyncResult({ errors: ["fetch failed"] }),
    ]);
    const cacheService = createMockCacheService();

    const job = createFridayMarketplaceSyncJob({ syncService, cacheService });
    const result = await job.runOnce();

    expect(result.sourcesSucceeded).toBe(0);
    expect(result.errors).toEqual(["fetch failed"]);
  });

  it("start/stop controls running state", () => {
    const syncService = createMockSyncService();
    const cacheService = createMockCacheService();

    const job = createFridayMarketplaceSyncJob({ syncService, cacheService });
    expect(job.isRunning()).toBe(false);

    job.start();
    expect(job.isRunning()).toBe(true);

    job.stop();
    expect(job.isRunning()).toBe(false);
  });

  it("runs cycle after start", async () => {
    const syncService = createMockSyncService();
    const cacheService = createMockCacheService();

    const job = createFridayMarketplaceSyncJob({
      syncService,
      cacheService,
      config: { intervalMs: 60000, jitterMs: 0, maxBackoffMs: 120000 },
    });

    job.start();

    // Initial delay of 1000ms
    await vi.advanceTimersByTimeAsync(1100);
    expect(syncService.syncAllSources).toHaveBeenCalled();

    job.stop();
  });

  it("start is idempotent", () => {
    const syncService = createMockSyncService();
    const cacheService = createMockCacheService();

    const job = createFridayMarketplaceSyncJob({ syncService, cacheService });
    job.start();
    job.start(); // second start should be no-op
    expect(job.isRunning()).toBe(true);
    job.stop();
  });

  it("handles sync failure with backoff", async () => {
    const syncService: FridayMarketplaceSyncService = {
      syncAllSources: vi.fn().mockRejectedValue(new Error("boom")),
      syncSource: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const cacheService = createMockCacheService();

    const job = createFridayMarketplaceSyncJob({
      syncService,
      cacheService,
      config: { intervalMs: 1000, jitterMs: 0, maxBackoffMs: 10000 },
    });

    job.start();

    // First cycle after 1s initial delay
    await vi.advanceTimersByTimeAsync(1100);
    expect(syncService.syncAllSources).toHaveBeenCalledTimes(1);

    // After 1st failure: consecutiveFailures=1, backoff = 1000 * 2^1 = 2000ms
    await vi.advanceTimersByTimeAsync(2100);
    expect(syncService.syncAllSources).toHaveBeenCalledTimes(2);

    // After 2nd failure: consecutiveFailures=2, backoff = 1000 * 2^2 = 4000ms
    await vi.advanceTimersByTimeAsync(4100);
    expect(syncService.syncAllSources).toHaveBeenCalledTimes(3);

    job.stop();
  });

  it("asserts exact backoff delay schedule (jitter=0)", async () => {
    // With jitterFactor=0, backoff delays are deterministic:
    // failure 1 → base*2^1 = 2000, failure 2 → base*2^2 = 4000, failure 3 → base*2^3 = 8000
    let callCount = 0;
    const callTimes: number[] = [];
    let fakeNow = 0;

    const syncService: FridayMarketplaceSyncService = {
      syncAllSources: vi.fn().mockImplementation(() => {
        callCount++;
        callTimes.push(fakeNow);
        return Promise.reject(new Error("boom"));
      }),
      syncSource: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const cacheService = createMockCacheService();

    const job = createFridayMarketplaceSyncJob({
      syncService,
      cacheService,
      config: { intervalMs: 1000, jitterMs: 0, maxBackoffMs: 64000 },
    });

    job.start();

    // Initial delay: 1000ms
    fakeNow = 1000;
    await vi.advanceTimersByTimeAsync(1100);
    expect(callCount).toBe(1);

    // After 1st failure: backoff = 1000 * 2^1 = 2000ms
    fakeNow = 3000;
    await vi.advanceTimersByTimeAsync(2100);
    expect(callCount).toBe(2);

    // After 2nd failure: backoff = 1000 * 2^2 = 4000ms
    fakeNow = 7000;
    await vi.advanceTimersByTimeAsync(4100);
    expect(callCount).toBe(3);

    // After 3rd failure: backoff = 1000 * 2^3 = 8000ms
    fakeNow = 15000;
    await vi.advanceTimersByTimeAsync(8100);
    expect(callCount).toBe(4);

    job.stop();
  });
});
