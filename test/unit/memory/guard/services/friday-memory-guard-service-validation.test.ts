import { describe, it, expect, vi } from "vitest";
import { FridayDomainError } from "#errors";
import {
  FRIDAY_MEMORY_GUARD_ERROR_CODES,
  FRIDAY_MEMORY_GUARD_MAX_TAG_COUNT,
  FRIDAY_MEMORY_GUARD_QUOTA_APPROACHING_RATIO,
  FRIDAY_MEMORY_GUARD_QUOTA_MAX_ITEMS_PER_NAMESPACE,
  FRIDAY_MEMORY_GUARD_QUOTA_MAX_BYTES_PER_NAMESPACE,
} from "#memory";
import { createGuardTestSetup, createMockMemoryItem, createMockSearchResult } from "./_helpers/create-guard-service.helper.js";

describe("FridayMemoryGuardService — CX Review Fixes", () => {
  // ─── Fix 1: Namespace bypass in prune / scopeNamespaceFilter ───

  describe("namespace type validation (scopeNamespaceFilter)", () => {
    it("rejects object-type namespace in list for tenants", async () => {
      const { guard } = createGuardTestSetup();
      // Pass an object as namespace — should throw NAMESPACE_INVALID
      await expect(
        guard.list({ namespace: {} as unknown as string }),
      ).rejects.toThrow(FridayDomainError);
      try {
        await guard.list({ namespace: {} as unknown as string });
      } catch (e) {
        expect((e as FridayDomainError).code).toBe(FRIDAY_MEMORY_GUARD_ERROR_CODES.NAMESPACE_INVALID);
      }
    });

    it("rejects number-type namespace in prune for tenants", async () => {
      const { guard } = createGuardTestSetup();
      await expect(
        guard.prune({ namespace: 42 as unknown as string }),
      ).rejects.toThrow(FridayDomainError);
      try {
        await guard.prune({ namespace: 42 as unknown as string });
      } catch (e) {
        expect((e as FridayDomainError).code).toBe(FRIDAY_MEMORY_GUARD_ERROR_CODES.NAMESPACE_INVALID);
      }
    });

    it("rejects boolean-type namespace in search for tenants", async () => {
      const { guard } = createGuardTestSetup();
      await expect(
        guard.search("hello", { namespace: true as unknown as string }),
      ).rejects.toThrow(FridayDomainError);
      try {
        await guard.search("hello", { namespace: true as unknown as string });
      } catch (e) {
        expect((e as FridayDomainError).code).toBe(FRIDAY_MEMORY_GUARD_ERROR_CODES.NAMESPACE_INVALID);
      }
    });

    it("rejects object-type namespace even for system access", async () => {
      const { guard } = createGuardTestSetup({
        subject: { hubId: "default", accessLevel: "system" },
        principalId: "service-1",
      });
      await expect(
        guard.prune({ namespace: {} as unknown as string }),
      ).rejects.toThrow(FridayDomainError);
      try {
        await guard.prune({ namespace: {} as unknown as string });
      } catch (e) {
        expect((e as FridayDomainError).code).toBe(FRIDAY_MEMORY_GUARD_ERROR_CODES.NAMESPACE_INVALID);
      }
    });
  });

  // ─── Fix 2: Namespace prefix descendants ───

  describe("namespace prefix descendants", () => {
    it("expands scope prefix to include descendants when listing", async () => {
      const { guard, core, quotaRepo, db } = createGuardTestSetup();
      const descendants = [
        "tenant.default.user.user1.notes",
        "tenant.default.user.user1.tasks",
        "tenant.default.user.user1.diary",
      ];
      vi.mocked(quotaRepo.listNamespacesByPrefix).mockReturnValue(descendants);

      await guard.list();

      // Should call core.list with the prefix itself + expanded descendants + "default"
      expect(core.list).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: ["tenant.default.user.user1", ...descendants, "default"],
        }),
      );
    });

    it("keeps scopePrefix and default namespace available when no descendants found", async () => {
      const { guard, core, quotaRepo } = createGuardTestSetup();
      vi.mocked(quotaRepo.listNamespacesByPrefix).mockReturnValue([]);

      await guard.list();

      expect(core.list).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: ["tenant.default.user.user1", "default"],
        }),
      );
    });

    it("expands descendants for search default scoping", async () => {
      const { guard, core, quotaRepo } = createGuardTestSetup();
      const descendants = [
        "tenant.default.user.user1.notes",
        "tenant.default.user.user1.tasks",
      ];
      vi.mocked(quotaRepo.listNamespacesByPrefix).mockReturnValue(descendants);

      await guard.search("hello");

      const callArgs = vi.mocked(core.search).mock.calls[0];
      expect(callArgs[1]).toEqual(
        expect.objectContaining({
          namespace: ["tenant.default.user.user1", ...descendants, "default"],
        }),
      );
    });

    it("search keeps channel-scoped session namespaces returned by expanded scope", async () => {
      const { guard, core, quotaRepo } = createGuardTestSetup();
      vi.mocked(quotaRepo.listNamespacesByPrefix).mockImplementation((_db, prefix) => {
        if (prefix === "tenant.default.user.user1") {
          return ["tenant.default.user.user1.notes"];
        }
        if (prefix === "tenant.default.channel") {
          return ["tenant.default.channel.webchat.user.memextract-123.shared"];
        }
        return [];
      });
      vi.mocked(core.search).mockResolvedValue([
        createMockSearchResult({
          item: createMockMemoryItem({
            namespace: "tenant.default.channel.webchat.user.memextract-123.shared",
            content: "User prefers rg over grep",
          }),
        }),
      ]);

      const results = await guard.search("rg grep");

      expect(results).toHaveLength(1);
      expect(results[0]?.item.namespace).toBe("tenant.default.channel.webchat.user.memextract-123.shared");
    });

    it("list still includes channel-scoped session namespaces when direct user descendants are empty", async () => {
      const { guard, core, quotaRepo } = createGuardTestSetup();
      vi.mocked(quotaRepo.listNamespacesByPrefix).mockImplementation((_db, prefix) => {
        if (prefix === "tenant.default.user.user1") {
          return [];
        }
        if (prefix === "tenant.default.channel") {
          return ["tenant.default.channel.webchat.user.user1.shared"];
        }
        return [];
      });

      await guard.list();

      expect(core.list).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: ["tenant.default.user.user1", "tenant.default.channel.webchat.user.user1.shared", "default"],
        }),
      );
    });

    it("expands descendants for prune default scoping", async () => {
      const { guard, core, quotaRepo } = createGuardTestSetup();
      const descendants = [
        "tenant.default.user.user1.archive",
      ];
      vi.mocked(quotaRepo.listNamespacesByPrefix).mockReturnValue(descendants);

      await guard.prune();

      expect(core.prune).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: ["tenant.default.user.user1", ...descendants, "default"],
        }),
      );
    });
  });

  describe("fully qualified namespace reuse", () => {
    it("does not double-prefix a fully qualified in-scope namespace on store", async () => {
      const { guard, core } = createGuardTestSetup({
        subject: {
          hubId: "default",
          userId: "user1",
          accessLevel: "tenant",
          channelKind: "discord",
        },
      });

      await guard.store(
        "tenant.default.channel.discord.user.user1.notes",
        "remember this",
      );

      expect(core.store).toHaveBeenCalledWith(
        "tenant.default.channel.discord.user.user1.notes",
        expect.any(String),
        expect.anything(),
      );
    });

    it("passes a fully qualified in-scope namespace through on search", async () => {
      const { guard, core } = createGuardTestSetup({
        subject: {
          hubId: "default",
          userId: "user1",
          accessLevel: "tenant",
          channelKind: "discord",
        },
      });

      await guard.search("hello", {
        namespace: "tenant.default.channel.discord.user.user1.notes",
      });

      expect(core.search).toHaveBeenCalledWith(
        "hello",
        expect.objectContaining({
          namespace: "tenant.default.channel.discord.user.user1.notes",
        }),
      );
    });

    it("accepts a fully qualified channel namespace for the same tenant/user even without channelKind on the context", async () => {
      const { guard, core } = createGuardTestSetup({
        subject: {
          hubId: "default",
          userId: "user1",
          accessLevel: "tenant",
        },
      });

      await guard.search("hello", {
        namespace: "tenant.default.channel.webchat.user.user1.shared",
      });

      expect(core.search).toHaveBeenCalledWith(
        "hello",
        expect.objectContaining({
          namespace: "tenant.default.channel.webchat.user.user1.shared",
        }),
      );
    });
  });

  // ─── Fix 2b (CX R2): scopeNamespaceFilter includes prefix itself ───

  describe("scopeNamespaceFilter includes prefix namespace (CX R2)", () => {
    it("includes scopePrefix itself in expanded descendants when not already present", async () => {
      const { guard, core, quotaRepo } = createGuardTestSetup();
      // Simulate descendants that don't include the bare prefix
      const descendants = [
        "tenant.default.user.user1.notes",
        "tenant.default.user.user1.tasks",
      ];
      vi.mocked(quotaRepo.listNamespacesByPrefix).mockReturnValue(descendants);

      await guard.list();

      expect(core.list).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: ["tenant.default.user.user1", ...descendants, "default"],
        }),
      );
    });

    it("does not duplicate prefix when already in descendants", async () => {
      const { guard, core, quotaRepo } = createGuardTestSetup();
      const descendants = [
        "tenant.default.user.user1",
        "tenant.default.user.user1.notes",
      ];
      vi.mocked(quotaRepo.listNamespacesByPrefix).mockReturnValue(descendants);

      await guard.list();

      expect(core.list).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: [...descendants, "default"],
        }),
      );
    });

    it("includes prefix in search scope expansion", async () => {
      const { guard, core, quotaRepo } = createGuardTestSetup();
      const descendants = [
        "tenant.default.user.user1.archive",
      ];
      vi.mocked(quotaRepo.listNamespacesByPrefix).mockReturnValue(descendants);

      await guard.search("hello");

      const callArgs = vi.mocked(core.search).mock.calls[0];
      expect(callArgs[1]).toEqual(
        expect.objectContaining({
          namespace: ["tenant.default.user.user1", "tenant.default.user.user1.archive", "default"],
        }),
      );
    });

    it("includes prefix in prune scope expansion", async () => {
      const { guard, core, quotaRepo } = createGuardTestSetup();
      const descendants = [
        "tenant.default.user.user1.old",
      ];
      vi.mocked(quotaRepo.listNamespacesByPrefix).mockReturnValue(descendants);

      await guard.prune();

      expect(core.prune).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: ["tenant.default.user.user1", "tenant.default.user.user1.old", "default"],
        }),
      );
    });
  });

  // ─── Fix 3: Reserved namespace check on requested value ───

  describe("reserved namespace on requested value", () => {
    it("rejects tenant store to system.anything", async () => {
      const { guard } = createGuardTestSetup();
      await expect(guard.store("system.anything", "data")).rejects.toThrow(FridayDomainError);
      try {
        await guard.store("system.anything", "data");
      } catch (e) {
        expect((e as FridayDomainError).code).toBe(FRIDAY_MEMORY_GUARD_ERROR_CODES.NAMESPACE_RESERVED);
      }
    });

    it("rejects tenant store to bare 'system' namespace", async () => {
      const { guard } = createGuardTestSetup();
      await expect(guard.store("system", "data")).rejects.toThrow(FridayDomainError);
      try {
        await guard.store("system", "data");
      } catch (e) {
        expect((e as FridayDomainError).code).toBe(FRIDAY_MEMORY_GUARD_ERROR_CODES.NAMESPACE_RESERVED);
      }
    });

    it("allows system access level to store in system.config", async () => {
      const { guard, core } = createGuardTestSetup({
        subject: { hubId: "default", accessLevel: "system" },
        principalId: "service-1",
      });
      await guard.store("system.config", "content");
      expect(core.store).toHaveBeenCalledWith(
        "system.config",
        expect.anything(),
        expect.anything(),
      );
    });
  });

  // ─── Fix 5: Approaching ratio triggers auto-prune ───

  describe("approaching ratio auto-prune", () => {
    it("triggers auto-prune when approaching item quota threshold", async () => {
      const { guard, core, quotaRepo } = createGuardTestSetup();
      const approachingCount = Math.floor(
        FRIDAY_MEMORY_GUARD_QUOTA_MAX_ITEMS_PER_NAMESPACE * FRIDAY_MEMORY_GUARD_QUOTA_APPROACHING_RATIO,
      );

      let callCount = 0;
      vi.mocked(quotaRepo.getNamespaceUsage).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return {
            namespace: "test",
            itemCount: approachingCount, // exactly at approaching threshold
            totalBytes: 1000,
            expiredItemCount: 50,
            expiredBytes: 500,
          };
        }
        // After prune
        return {
          namespace: "test",
          itemCount: approachingCount - 50,
          totalBytes: 500,
          expiredItemCount: 0,
          expiredBytes: 0,
        };
      });

      vi.mocked(quotaRepo.pruneExpiredOldest).mockReturnValue({
        deletedCount: 50,
        deletedBytes: 500,
        deletedIds: Array.from({ length: 50 }, (_, i) => `expired-${i}`),
      });

      await guard.store("test-ns", "content");
      expect(quotaRepo.pruneExpiredOldest).toHaveBeenCalled();
      expect(core.store).toHaveBeenCalled();
    });

    it("triggers auto-prune when approaching byte quota threshold", async () => {
      const { guard, quotaRepo } = createGuardTestSetup();
      const approachingBytes = Math.floor(
        FRIDAY_MEMORY_GUARD_QUOTA_MAX_BYTES_PER_NAMESPACE * FRIDAY_MEMORY_GUARD_QUOTA_APPROACHING_RATIO,
      );

      let callCount = 0;
      vi.mocked(quotaRepo.getNamespaceUsage).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return {
            namespace: "test",
            itemCount: 100,
            totalBytes: approachingBytes,
            expiredItemCount: 10,
            expiredBytes: 5000,
          };
        }
        return {
          namespace: "test",
          itemCount: 90,
          totalBytes: approachingBytes - 5000,
          expiredItemCount: 0,
          expiredBytes: 0,
        };
      });

      vi.mocked(quotaRepo.pruneExpiredOldest).mockReturnValue({
        deletedCount: 10,
        deletedBytes: 5000,
        deletedIds: [],
      });

      await guard.store("test-ns", "content");
      expect(quotaRepo.pruneExpiredOldest).toHaveBeenCalled();
    });

    it("does not trigger auto-prune when well below approaching threshold", async () => {
      const { guard, quotaRepo } = createGuardTestSetup();
      vi.mocked(quotaRepo.getNamespaceUsage).mockReturnValue({
        namespace: "test",
        itemCount: 100, // well below 90% threshold
        totalBytes: 1000,
        expiredItemCount: 10,
        expiredBytes: 100,
      });

      await guard.store("test-ns", "content");
      expect(quotaRepo.pruneExpiredOldest).not.toHaveBeenCalled();
    });
  });

  // ─── Fix 6: Error boundary ───

  describe("error boundary", () => {
    it("wraps unexpected core errors in MEMORY_GUARD_INTERNAL", async () => {
      const { guard, core } = createGuardTestSetup();
      vi.mocked(core.get).mockRejectedValue(new Error("DB connection lost"));

      await expect(guard.get("item-1")).rejects.toThrow(FridayDomainError);
      try {
        await guard.get("item-1");
      } catch (e) {
        const err = e as FridayDomainError;
        expect(err.code).toBe(FRIDAY_MEMORY_GUARD_ERROR_CODES.INTERNAL);
        expect(err.message).toBe("DB connection lost");
        expect(err.httpStatus).toBe(500);
      }
    });

    it("preserves FridayDomainError through the boundary", async () => {
      const { guard, core } = createGuardTestSetup();
      const domainError = new FridayDomainError(
        FRIDAY_MEMORY_GUARD_ERROR_CODES.QUOTA_ITEMS_EXCEEDED,
        "quota exceeded",
        { httpStatus: 429 },
      );
      vi.mocked(core.store).mockRejectedValue(domainError);

      await expect(guard.store("test-ns", "content")).rejects.toThrow(FridayDomainError);
      try {
        await guard.store("test-ns", "content");
      } catch (e) {
        const err = e as FridayDomainError;
        expect(err.code).toBe(FRIDAY_MEMORY_GUARD_ERROR_CODES.QUOTA_ITEMS_EXCEEDED);
        expect(err.httpStatus).toBe(429);
      }
    });

    it("wraps non-Error throws in MEMORY_GUARD_INTERNAL", async () => {
      const { guard, core } = createGuardTestSetup();
      vi.mocked(core.list).mockRejectedValue("string error");

      await expect(guard.list()).rejects.toThrow(FridayDomainError);
      try {
        await guard.list();
      } catch (e) {
        const err = e as FridayDomainError;
        expect(err.code).toBe(FRIDAY_MEMORY_GUARD_ERROR_CODES.INTERNAL);
        expect(err.message).toBe("unexpected guard error");
      }
    });

    it("wraps search core errors in MEMORY_GUARD_INTERNAL", async () => {
      const { guard, core } = createGuardTestSetup();
      vi.mocked(core.search).mockRejectedValue(new TypeError("Cannot read property"));

      await expect(guard.search("hello")).rejects.toThrow(FridayDomainError);
      try {
        await guard.search("hello");
      } catch (e) {
        const err = e as FridayDomainError;
        expect(err.code).toBe(FRIDAY_MEMORY_GUARD_ERROR_CODES.INTERNAL);
      }
    });

    it("wraps delete core errors in MEMORY_GUARD_INTERNAL", async () => {
      const { guard, core } = createGuardTestSetup();
      vi.mocked(core.get).mockResolvedValue(
        createMockMemoryItem({ namespace: "tenant.default.user.user1.notes" }),
      );
      vi.mocked(core.delete).mockRejectedValue(new Error("DB error"));

      await expect(guard.delete("item-1")).rejects.toThrow(FridayDomainError);
      try {
        await guard.delete("item-1");
      } catch (e) {
        const err = e as FridayDomainError;
        expect(err.code).toBe(FRIDAY_MEMORY_GUARD_ERROR_CODES.INTERNAL);
      }
    });

    it("wraps prune core errors in MEMORY_GUARD_INTERNAL", async () => {
      const { guard, core } = createGuardTestSetup();
      vi.mocked(core.prune).mockRejectedValue(new Error("prune failed"));

      await expect(guard.prune()).rejects.toThrow(FridayDomainError);
      try {
        await guard.prune();
      } catch (e) {
        const err = e as FridayDomainError;
        expect(err.code).toBe(FRIDAY_MEMORY_GUARD_ERROR_CODES.INTERNAL);
      }
    });
  });

  // ─── Fix 7: PII tags bypass tag validation ───

  describe("PII tags re-validation", () => {
    it("rejects when PII tags push total above max tag count", async () => {
      const { guard, piiGuard } = createGuardTestSetup();
      // Provide max-1 tags (31), and PII guard will add 2 tags → 33 total → exceeds 32
      const existingTags = Array.from(
        { length: FRIDAY_MEMORY_GUARD_MAX_TAG_COUNT - 1 },
        (_, i) => `tag${i}`,
      );

      vi.mocked(piiGuard.scanAndTransform).mockReturnValue({
        matches: [
          { type: "email", value: "a@b.com", start: 0, end: 7 },
          { type: "phone_us", value: "555-1234", start: 10, end: 18 },
        ],
        distinctTypes: ["email", "phone_us"],
        transformedContent: "a@b.com & 555-1234",
        tagsToAdd: ["pii.email", "pii.phone-us"],
      });

      await expect(
        guard.store("test-ns", "a@b.com & 555-1234", { tags: existingTags }),
      ).rejects.toThrow(FridayDomainError);
      try {
        await guard.store("test-ns", "a@b.com & 555-1234", { tags: existingTags });
      } catch (e) {
        expect((e as FridayDomainError).code).toBe(FRIDAY_MEMORY_GUARD_ERROR_CODES.TAGS_TOO_MANY);
      }
    });

    it("allows when PII tags keep total within max tag count", async () => {
      const { guard, core, piiGuard } = createGuardTestSetup();
      const existingTags = Array.from(
        { length: FRIDAY_MEMORY_GUARD_MAX_TAG_COUNT - 2 },
        (_, i) => `tag${i}`,
      );

      vi.mocked(piiGuard.scanAndTransform).mockReturnValue({
        matches: [{ type: "email", value: "a@b.com", start: 0, end: 7 }],
        distinctTypes: ["email"],
        transformedContent: "a@b.com",
        tagsToAdd: ["pii.email"],
      });

      await guard.store("test-ns", "a@b.com", { tags: existingTags });
      expect(core.store).toHaveBeenCalled();
    });
  });
});
