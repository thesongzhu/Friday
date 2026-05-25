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

describe("friday-memory-dedup (B3 truth-labeling)", () => {
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

  it("checkMemoryDuplicate emits a one-time advisory naming the proof_pending wiring", async () => {
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
    expect(advisoryMessage).toContain("NOT wired");
    expect(advisoryMessage).toContain("memoryService.store()");
    expect(advisoryMessage).toContain("policy_pending");
  });

  it("memoryService.store() does NOT call dedup (durable store path bypass)", async () => {
    // The current truth: memoryService.store() persists every well-formed
    // store request as a new row regardless of whether a near-duplicate
    // already exists. This test will START FAILING the moment a future
    // slice wires checkMemoryDuplicate into store() — that's intentional,
    // it forces explicit policy review before the wiring lands.
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

    // 3 distinct rows persisted with 3 distinct ids — proof that dedup
    // is NOT being applied at the store boundary.
    expect(first.id).toBe("dedup-test-1");
    expect(second.id).toBe("dedup-test-2");
    expect(third.id).toBe("dedup-test-3");
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);

    // The dedup advisory must NOT have fired — store() does not call into
    // the dedup helper at all.
    expect(consoleInfoSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("[friday][memory-dedup]"),
    );
  });
});
