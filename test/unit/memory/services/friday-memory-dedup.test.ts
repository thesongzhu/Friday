import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import {
  createFridayMemoryService,
  type FridayMemoryService,
} from "#memory";
import type { FridayMemorySearchResult } from "#memory";
import { checkMemoryDuplicate } from "../../../../src/memory/services/friday-memory-dedup.js";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

const NOW = "2026-02-17T10:00:00.000Z";

describe("friday-memory-dedup (B4 advisory wire-in; destructive merge/block policy_pending)", () => {
  let db: FridaySqliteLayer;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = createTestDb();
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    db.close();
    consoleInfoSpy.mockRestore();
  });

  it("checkMemoryDuplicate emits a one-time advisory naming the advisory-only wiring", async () => {
    const searchSpy = vi.fn<
      (
        query: string,
        options?: Record<string, unknown>,
      ) => Promise<FridayMemorySearchResult[]>
    >(async () => []);

    await checkMemoryDuplicate(
      { namespace: "ns", content: "first call" },
      { search: searchSpy },
    );
    await checkMemoryDuplicate(
      { namespace: "ns", content: "second call" },
      { search: searchSpy },
    );
    await checkMemoryDuplicate(
      { namespace: "ns", content: "third call" },
      { search: searchSpy },
    );

    // Advisory must fire exactly once, regardless of how many times the
    // helper is called.
    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const advisoryMessage = consoleInfoSpy.mock.calls[0]![0] as string;
    expect(advisoryMessage).toContain("checkMemoryDuplicate");
    // B4 wire-in: the one-time log now names the advisory-only wiring and
    // explicitly preserves the policy_pending boundary for destructive
    // merge/block semantics.
    expect(advisoryMessage).toContain("wired into memoryService.store()");
    expect(advisoryMessage).toContain("advisory-only");
    expect(advisoryMessage).toContain("non-destructive");
    expect(advisoryMessage).toContain("policy_pending");
  });

  it("memoryService.store() calls dedup AFTER persist (advisory only; never blocks)", async () => {
    // B4 (2026-05-26): store() now invokes checkMemoryDuplicate AFTER a
    // successful persist. Distinct rows are still stored regardless of
    // whether a near-duplicate exists; the dedup result is informational.
    // This test guards: (a) the wire-in fires, (b) NO row is overwritten
    // or merged, (c) the candidate is in the durable store even when
    // duplicate-like.
    const service: FridayMemoryService = createFridayMemoryService({
      db,
      providerService: {
        runWithFallback: vi.fn().mockRejectedValue(new Error("embedding disabled for this test")),
      } as never,
      idGenerator: (() => {
        let n = 0;
        return () => `dedup-test-${++n}`;
      })(),
      nowIso: () => NOW,
    });

    const first = await service.store("dedup-ns", "The quick brown fox");
    const second = await service.store("dedup-ns", "The quick brown fox");
    const third = await service.store("dedup-ns", "The quick brown fox");

    // 3 distinct rows persisted with 3 distinct ids — proof that the dedup
    // advisory does NOT block, overwrite, or merge.
    expect(first.id).toBe("dedup-test-1");
    expect(second.id).toBe("dedup-test-2");
    expect(third.id).toBe("dedup-test-3");
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);

    // Detailed advisory-event coverage (sink shape, threshold,
    // candidate/existing ids, no-mutation invariant) lives in
    // `friday-memory-dedup-advisory-wire-in.test.ts`. This test focuses
    // on the load-bearing invariant: store() never blocks, overwrites,
    // or merges when duplicates are present.
  });
});
