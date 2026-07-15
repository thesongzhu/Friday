import { describe, it, expect, vi } from "vitest";
import type { FridayMemoryGuardContext } from "#memory";
import { createFridayMemoryGuardService, createFridayMemoryPiiGuard } from "#memory";
import {
  createMockCoreService,
  createMockRateLimiter,
  createMockQuotaRepo,
  createMockOutputFilter,
  createMockDb,
} from "./_helpers/create-guard-service.helper.js";

// ─── Advisor round 2 — production guard/store seam probe ─────────────────────────
//
// This reproduces the exact `guard.store` probe the Advisor ran. It wires the REAL PII guard
// (redact mode, the production default) into the REAL guard service and asserts what
// `core.store` actually receives. The finding: a deep-but-benign metadata object that
// serializes UNDER the 16 KiB metadata limit passed validation, but `redactDeep`'s fixed depth
// cap replaced the over-deep subtree with a "[REDACTED_DEPTH]" sentinel — so core.store
// persisted the sentinel instead of the user's canonical metadata (silent data loss,
// DATA-RETENTION-001). After the iterative full-scan rewrite, core.store must receive the
// ORIGINAL metadata, byte-identical.

const NOW = "2026-02-18T10:00:00.000Z";
const NOW_MS = new Date(NOW).getTime();

function makeRealPiiGuardService(mode: "redact" | "tag" | "block" = "redact") {
  const core = createMockCoreService();
  const context: FridayMemoryGuardContext = {
    subject: { hubId: "default", userId: "user1", accessLevel: "tenant" },
    principalId: "principal-1",
  };
  const guard = createFridayMemoryGuardService({
    core,
    db: createMockDb(),
    nowIso: () => NOW,
    nowMs: () => NOW_MS,
    context,
    rateLimiter: createMockRateLimiter(),
    quotaRepo: createMockQuotaRepo(),
    piiGuard: createFridayMemoryPiiGuard(mode), // REAL guard, not a mock
    outputFilter: createMockOutputFilter(),
  });
  return { guard, core };
}

// `depth` levels of {child: …} around a benign leaf. At depth 501 the serialized JSON is a few
// KB — comfortably under the 16 KiB metadata limit (validateMetadata passes) — yet the leaf
// sits past the old depth-500 cap, so the pre-fix walker corrupted it.
function deepBenignMetadata(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = {
    deep_value: "keepme-benign-canonical-marker",
    count: 42,
    ratio: 3.14,
    ok: true,
  };
  for (let i = 0; i < depth; i += 1) node = { child: node, level: i };
  return node;
}

describe("FridayMemoryGuardService — deep metadata store seam (Advisor round 2) [red-first]", () => {
  it("core.store receives the ORIGINAL benign deep metadata, not a [REDACTED_DEPTH] sentinel", async () => {
    const { guard, core } = makeRealPiiGuardService("redact");
    const metadata = deepBenignMetadata(501);

    // Sanity: this input is under the 16 KiB metadata byte-bound (so it passes validation and
    // the write actually reaches core.store — the seam where the loss occurred).
    expect(new TextEncoder().encode(JSON.stringify(metadata)).length).toBeLessThan(16 * 1024);

    await guard.store("test-ns", "benign content", { metadata });

    const callArgs = vi.mocked(core.store).mock.calls[0];
    const storedMeta = callArgs[2]?.metadata as Record<string, unknown> | undefined;

    // The probe: what core.store actually got.
    const storedJson = JSON.stringify(storedMeta);
    expect(storedJson).not.toContain("[REDACTED_DEPTH]"); // no sentinel corruption
    expect(storedJson).toContain("keepme-benign-canonical-marker"); // deep canonical value survived
    expect(storedJson).toBe(JSON.stringify(metadata)); // byte-identical: zero data loss
  });

  it("still redacts DEEP PII in metadata on the store path (leak stays closed)", async () => {
    const { guard, core } = makeRealPiiGuardService("redact");
    // Benign wrapper, deep PII leaf under sensitive keys + an email string.
    let node: Record<string, unknown> = { contact: "owner@example.com", phone: 5552345678, ssn: 123456789 };
    for (let i = 0; i < 600; i += 1) node = { child: node };
    const metadata = node;
    expect(new TextEncoder().encode(JSON.stringify(metadata)).length).toBeLessThan(16 * 1024);

    await guard.store("test-ns", "benign content", { metadata });

    const callArgs = vi.mocked(core.store).mock.calls[0];
    const storedJson = JSON.stringify(callArgs[2]?.metadata);
    expect(storedJson).not.toContain("owner@example.com"); // deep PII never persisted clear
    expect(storedJson).not.toContain("5552345678");
    expect(storedJson).not.toContain("123456789");
    expect(storedJson).not.toContain("[REDACTED_DEPTH]");
    expect(storedJson).toContain("[EMAIL]");
    expect(storedJson).toContain("[PHONE_US]");
    expect(storedJson).toContain("[SSN_US]");
    // PII surfaced as tags on the stored item.
    const storedTags = callArgs[2]?.tags as string[] | undefined;
    expect(storedTags).toEqual(expect.arrayContaining(["pii.email", "pii.phone_us", "pii.ssn_us"]));
  });
});
