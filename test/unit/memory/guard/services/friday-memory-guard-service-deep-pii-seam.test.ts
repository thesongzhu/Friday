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

// ─── Advisor round 3 — production guard/store seam probe: full-width pure-numeric KEY ─────
//
// The pure-numeric object-KEY exemption preserved the ASCII business key "4111111111111111" but
// its semantically-identical FULL-WIDTH form was folded by the PII matcher, matched as a card, and
// irreversibly renamed to "[CREDIT_CARD]" — so on the REAL store path core.store received a
// corrupted key (canonical-lookup identity broken). After making the exemption Unicode-decimal-
// aware, core.store must receive the ORIGINAL full-width key, byte-identical.
describe("FridayMemoryGuardService — full-width pure-numeric metadata KEY store seam (Advisor round 3) [red-first]", () => {
  const fullwidth = (s: string): string =>
    [...s]
      .map((ch) => {
        const c = ch.charCodeAt(0);
        return c >= 0x21 && c <= 0x7e ? String.fromCharCode(c + 0xfee0) : ch;
      })
      .join("");

  it("core.store receives the ORIGINAL full-width pure-numeric KEY (not renamed to [CREDIT_CARD])", async () => {
    const { guard, core } = makeRealPiiGuardService("redact");
    const fwKey = fullwidth("4111111111111111"); // full-width Luhn-valid Visa test number as a KEY
    const metadata: Record<string, unknown> = { [fwKey]: "canonical-marker" };

    await guard.store("test-ns", "benign content", { metadata });

    const callArgs = vi.mocked(core.store).mock.calls[0];
    const storedMeta = callArgs[2]?.metadata as Record<string, unknown> | undefined;
    expect(storedMeta).toBeDefined();
    expect(Object.keys(storedMeta as Record<string, unknown>)).toContain(fwKey); // key preserved
    expect(Object.keys(storedMeta as Record<string, unknown>)).not.toContain("[CREDIT_CARD]");
    expect((storedMeta as Record<string, unknown>)[fwKey]).toBe("canonical-marker");
    // No PII tag was fabricated from a benign business id.
    const storedTags = (callArgs[2]?.tags as string[] | undefined) ?? [];
    expect(storedTags).not.toContain("pii.credit_card");
  });
});
