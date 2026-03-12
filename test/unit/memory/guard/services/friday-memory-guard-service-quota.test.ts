import { describe, it, expect, vi } from "vitest";
import { FridayDomainError } from "#errors";
import {
  FRIDAY_MEMORY_GUARD_ERROR_CODES,
  FRIDAY_MEMORY_GUARD_QUOTA_MAX_ITEMS_PER_NAMESPACE,
  FRIDAY_MEMORY_GUARD_QUOTA_MAX_BYTES_PER_NAMESPACE,
} from "#memory";
import { createGuardTestSetup } from "./_helpers/create-guard-service.helper.js";

describe("FridayMemoryGuardService — Quota", () => {
  it("allows store when under quota", async () => {
    const { guard, core, quotaRepo } = createGuardTestSetup();
    vi.mocked(quotaRepo.getNamespaceUsage).mockReturnValue({
      namespace: "test",
      itemCount: 100,
      totalBytes: 1000,
      expiredItemCount: 0,
      expiredBytes: 0,
    });

    await guard.store("test-ns", "content");
    expect(core.store).toHaveBeenCalled();
  });

  it("rejects store when item count quota exceeded", async () => {
    const { guard, quotaRepo } = createGuardTestSetup();
    vi.mocked(quotaRepo.getNamespaceUsage).mockReturnValue({
      namespace: "test",
      itemCount: FRIDAY_MEMORY_GUARD_QUOTA_MAX_ITEMS_PER_NAMESPACE,
      totalBytes: 1000,
      expiredItemCount: 0,
      expiredBytes: 0,
    });

    await expect(guard.store("test-ns", "content")).rejects.toThrow(FridayDomainError);
    try {
      await guard.store("test-ns", "content");
    } catch (e) {
      const err = e as FridayDomainError;
      expect(err.code).toBe(FRIDAY_MEMORY_GUARD_ERROR_CODES.QUOTA_ITEMS_EXCEEDED);
      expect(err.httpStatus).toBe(429);
    }
  });

  it("rejects store when byte quota exceeded", async () => {
    const { guard, quotaRepo } = createGuardTestSetup();
    vi.mocked(quotaRepo.getNamespaceUsage).mockReturnValue({
      namespace: "test",
      itemCount: 1,
      totalBytes: FRIDAY_MEMORY_GUARD_QUOTA_MAX_BYTES_PER_NAMESPACE,
      expiredItemCount: 0,
      expiredBytes: 0,
    });

    await expect(guard.store("test-ns", "content")).rejects.toThrow(FridayDomainError);
    try {
      await guard.store("test-ns", "content");
    } catch (e) {
      const err = e as FridayDomainError;
      expect(err.code).toBe(FRIDAY_MEMORY_GUARD_ERROR_CODES.QUOTA_BYTES_EXCEEDED);
    }
  });

  it("auto-prunes expired items when quota would be exceeded", async () => {
    const { guard, core, quotaRepo, db } = createGuardTestSetup();

    // First call: over quota with expired items
    let callCount = 0;
    vi.mocked(quotaRepo.getNamespaceUsage).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          namespace: "test",
          itemCount: FRIDAY_MEMORY_GUARD_QUOTA_MAX_ITEMS_PER_NAMESPACE,
          totalBytes: 1000,
          expiredItemCount: 100,
          expiredBytes: 500,
        };
      }
      // After prune
      return {
        namespace: "test",
        itemCount: FRIDAY_MEMORY_GUARD_QUOTA_MAX_ITEMS_PER_NAMESPACE - 100,
        totalBytes: 500,
        expiredItemCount: 0,
        expiredBytes: 0,
      };
    });

    vi.mocked(quotaRepo.pruneExpiredOldest).mockReturnValue({
      deletedCount: 100,
      deletedBytes: 500,
      deletedIds: Array.from({ length: 100 }, (_, i) => `expired-${i}`),
    });

    await guard.store("test-ns", "content");
    expect(quotaRepo.pruneExpiredOldest).toHaveBeenCalled();
    expect(core.store).toHaveBeenCalled();
  });

  it("still rejects if quota exceeded even after pruning", async () => {
    const { guard, quotaRepo } = createGuardTestSetup();

    // Even after prune, still over quota
    vi.mocked(quotaRepo.getNamespaceUsage).mockReturnValue({
      namespace: "test",
      itemCount: FRIDAY_MEMORY_GUARD_QUOTA_MAX_ITEMS_PER_NAMESPACE,
      totalBytes: 1000,
      expiredItemCount: 0,
      expiredBytes: 0,
    });

    await expect(guard.store("test-ns", "content")).rejects.toThrow(FridayDomainError);
  });

  it("does not attempt prune when no expired items exist", async () => {
    const { guard, quotaRepo } = createGuardTestSetup();
    vi.mocked(quotaRepo.getNamespaceUsage).mockReturnValue({
      namespace: "test",
      itemCount: FRIDAY_MEMORY_GUARD_QUOTA_MAX_ITEMS_PER_NAMESPACE,
      totalBytes: 1000,
      expiredItemCount: 0,
      expiredBytes: 0,
    });

    await expect(guard.store("test-ns", "content")).rejects.toThrow(FridayDomainError);
    expect(quotaRepo.pruneExpiredOldest).not.toHaveBeenCalled();
  });
});
