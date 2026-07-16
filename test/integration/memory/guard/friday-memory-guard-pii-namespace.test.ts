import { describe, it, expect, vi } from "vitest";
import { FridayDomainError } from "#errors";
import { createFridayMemoryPiiGuard, FRIDAY_MEMORY_GUARD_ERROR_CODES } from "#memory";
import {
  createGuardTestSetup,
  createMockMemoryItem,
  createMockSearchResult,
} from "../../../unit/memory/guard/services/_helpers/create-guard-service.helper.js";

describe("FridayMemoryGuard — PII + Namespace + Rate Limit (Integration)", () => {
  // ─── PII detection in redact mode (default) ───

  describe("PII detection (redact mode - default)", () => {
    it("does not block store when PII can be redacted by default", async () => {
      const { guard, piiGuard } = createGuardTestSetup();
      vi.mocked(piiGuard.scanAndTransform).mockReturnValue({
        matches: [{ type: "email", value: "user@test.com", start: 0, end: 13 }],
        distinctTypes: ["email"],
        transformedContent: "[EMAIL]",
        tagsToAdd: ["pii.email"],
      });

      await expect(guard.store("test-ns", "user@test.com")).resolves.toBeDefined();
    });

    it("redacts store content and adds PII tags by default", async () => {
      const { guard, core, piiGuard } = createGuardTestSetup();
      vi.mocked(piiGuard.scanAndTransform).mockReturnValue({
        matches: [{ type: "email", value: "user@test.com", start: 0, end: 13 }],
        distinctTypes: ["email"],
        transformedContent: "[EMAIL] is the address",
        tagsToAdd: ["pii.email"],
      });

      await guard.store("test-ns", "user@test.com is the address");
      expect(core.store).toHaveBeenCalledWith(
        expect.anything(),
        "[EMAIL] is the address",
        expect.objectContaining({ tags: ["pii.email"] }),
      );
    });

    it("passes clean content unchanged when no PII detected", async () => {
      const { guard, core, piiGuard } = createGuardTestSetup();
      vi.mocked(piiGuard.scanAndTransform).mockReturnValue({
        matches: [],
        distinctTypes: [],
        transformedContent: "safe content",
        tagsToAdd: [],
      });

      await guard.store("test-ns", "safe content");
      expect(core.store).toHaveBeenCalledWith(
        expect.anything(),
        "safe content",
        expect.anything(),
      );
    });

    it("preserves Luhn-valid project/proof identifiers while still redacting actual cards", async () => {
      const { guard, core, piiGuard } = createGuardTestSetup();
      const realPiiGuard = createFridayMemoryPiiGuard("redact");
      vi.mocked(piiGuard.scanAndTransform).mockImplementation((content) =>
        realPiiGuard.scanAndTransform(content),
      );

      const proofContent =
        "For this proof run, the user's project codename is BARB-1779879819520. marker=phase22d-rgg-1779879819520.";
      await guard.store("test-ns", proofContent);
      expect(core.store).toHaveBeenLastCalledWith(
        expect.anything(),
        proofContent,
        expect.objectContaining({ tags: undefined }),
      );

      await guard.store("test-ns", "Card: 4111111111111111");
      expect(core.store).toHaveBeenLastCalledWith(
        expect.anything(),
        "Card: [CREDIT_CARD]",
        expect.objectContaining({ tags: ["pii.credit_card"] }),
      );
    });
  });

  // ─── Namespace isolation ───

  describe("namespace isolation", () => {
    it("prefixes namespace for tenant-level access", async () => {
      const { guard, core } = createGuardTestSetup();
      await guard.store("my-notes", "content");
      expect(core.store).toHaveBeenCalledWith(
        "tenant.default.user.user1.my-notes",
        expect.anything(),
        expect.anything(),
      );
    });

    it("denies tenant access to system.* namespace", async () => {
      const { guard } = createGuardTestSetup();
      await expect(guard.store("system.config", "evil")).rejects.toThrow(FridayDomainError);
      try {
        await guard.store("system.config", "evil");
      } catch (e) {
        expect((e as FridayDomainError).code).toBe(
          FRIDAY_MEMORY_GUARD_ERROR_CODES.NAMESPACE_RESERVED,
        );
      }
    });

    it("prevents cross-namespace access on get", async () => {
      const { guard, core } = createGuardTestSetup();
      // Item belongs to a different user's namespace
      vi.mocked(core.get).mockResolvedValue(
        createMockMemoryItem({ namespace: "tenant.default.user.other-user.notes" }),
      );

      await expect(guard.get("item-1")).rejects.toThrow(FridayDomainError);
      try {
        await guard.get("item-1");
      } catch (e) {
        expect((e as FridayDomainError).code).toBe(
          FRIDAY_MEMORY_GUARD_ERROR_CODES.ITEM_ACCESS_DENIED,
        );
      }
    });

    it("prevents cross-namespace access on search", async () => {
      const { guard, core } = createGuardTestSetup();
      // Search returns an item from another tenant's namespace
      vi.mocked(core.search).mockResolvedValue([
        createMockSearchResult({
          item: createMockMemoryItem({ namespace: "tenant.other.user.x.notes" }),
        }),
      ]);

      const results = await guard.search("test query", { namespace: "notes" });
      // Should be filtered out by output filter or scope check
      expect(results).toHaveLength(0);
    });

    it("allows system access level to use system.* namespace", async () => {
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

  // ─── Rate limiting enforcement ───

  describe("rate limiting", () => {
    it("allows store when rate limit is not exceeded", async () => {
      const { guard, core } = createGuardTestSetup();
      await guard.store("test-ns", "content");
      expect(core.store).toHaveBeenCalled();
    });

    it("rejects store when namespace write rate is exceeded", async () => {
      const { guard, rateLimiter } = createGuardTestSetup();
      vi.mocked(rateLimiter.consume).mockReturnValue({
        allowed: false,
        action: "write",
        key: "ns:write:tenant.default.user.user1.test-ns",
        remaining: 0,
        resetAt: "2026-02-18T10:01:00.000Z",
        retryAfterMs: 60_000,
      });

      try {
        await guard.store("test-ns", "content");
        expect.fail("Expected FridayDomainError");
      } catch (e) {
        const err = e as FridayDomainError;
        expect(err.code).toBe(FRIDAY_MEMORY_GUARD_ERROR_CODES.RATE_LIMIT_NAMESPACE_WRITE);
        expect(err.httpStatus).toBe(429);
        expect(err.retryable).toBe(true);
      }
    });

    it("rejects search when search rate is exceeded", async () => {
      const { guard, rateLimiter } = createGuardTestSetup();
      vi.mocked(rateLimiter.consume).mockReturnValue({
        allowed: false,
        action: "search",
        key: "ns:search:tenant.default.user.user1.test-ns",
        remaining: 0,
        resetAt: "2026-02-18T10:01:00.000Z",
        retryAfterMs: 30_000,
      });

      try {
        await guard.search("test query", { namespace: "test-ns" });
        expect.fail("Expected FridayDomainError");
      } catch (e) {
        const err = e as FridayDomainError;
        expect([
          FRIDAY_MEMORY_GUARD_ERROR_CODES.RATE_LIMIT_NAMESPACE_SEARCH,
          FRIDAY_MEMORY_GUARD_ERROR_CODES.RATE_LIMIT_GLOBAL_SEARCH,
        ]).toContain(err.code);
        expect(err.httpStatus).toBe(429);
      }
    });
  });

  // ─── Typed-value PII: preserved at rest + redacted on authoritative read-back (R62) ───
  //
  // Exercises the REAL guard write path (guard.store → write-time redactDeep → core.store) with
  // an authoritative echoing core (store persists exactly what it is handed; get returns it).
  // Proves (a) ambiguous numeric ids are preserved AT REST (no irreversible masking) and
  // (b) registry-keyed numeric PII is redacted before persistence and never returned in
  // cleartext on read-back. Metadata is JSON (numbers, not bigint) — the store path is JSON-
  // validated. Key-driven redaction is context-aware: shape/Luhn is never consulted.
  describe("typed-value PII at rest + authoritative read-back (R62)", () => {
    it("preserves ambiguous numeric ids at rest and redacts registry-keyed numeric PII", async () => {
      const { guard, core, piiGuard } = createGuardTestSetup();
      const realGuard = createFridayMemoryPiiGuard("redact");
      vi.mocked(piiGuard.scanAndTransform).mockImplementation((c) => realGuard.scanAndTransform(c));
      vi.mocked(piiGuard.redactDeep).mockImplementation((v) => realGuard.redactDeep(v));

      // Authoritative store: persist exactly what the guard hands to core, echo it back on get.
      let persisted: ReturnType<typeof createMockMemoryItem> | undefined;
      vi.mocked(core.store).mockImplementation(async (namespace, content, meta) => {
        persisted = createMockMemoryItem({
          namespace,
          content,
          metadata: (meta?.metadata ?? {}) as Record<string, unknown>,
          tags: meta?.tags ?? [],
        });
        return persisted;
      });
      vi.mocked(core.get).mockImplementation(async () => persisted!);

      const stored = await guard.store("test-ns", "profile", {
        metadata: {
          order_id: 123456789, // ambiguous business id → preserved
          epoch_ms: 1_700_000_000_000, // epoch timestamp → preserved
          txn: 4111111111111111, // Luhn-valid under a NON-sensitive key → preserved
          sim_card: 2, // sensitive-SOUNDING key but value not card-shaped → preserved (value gate)
          ssn: 123456789, // registry key + SSN-shaped value → redacted
          phone: 5552345678, // registry key + phone-shaped value → redacted
          card: 4111111111111111, // registry key + Luhn card value → redacted
        },
      });

      // (a) authoritative AT-REST state = exactly what was handed to core.store for persistence.
      const atRest = vi.mocked(core.store).mock.calls.at(-1)![2]!.metadata as Record<string, unknown>;
      expect(atRest.order_id).toBe(123456789);
      expect(atRest.epoch_ms).toBe(1_700_000_000_000);
      expect(atRest.txn).toBe(4111111111111111);
      expect(atRest.sim_card).toBe(2); // benign business field survives at rest
      expect(atRest.ssn).toBe("[SSN_US]");
      expect(atRest.phone).toBe("[PHONE_US]");
      expect(atRest.card).toBe("[CREDIT_CARD]");

      // (b) authoritative READ-BACK returns the same preserved ids and no cleartext PII.
      const readBack = await guard.get(stored.id);
      const meta = readBack.metadata as Record<string, unknown>;
      expect(meta.order_id).toBe(123456789);
      expect(meta.ssn).toBe("[SSN_US]");
      expect(meta.phone).toBe("[PHONE_US]");
      expect(JSON.stringify(meta)).not.toContain("5552345678"); // phone value not leaked
    });
  });
});
