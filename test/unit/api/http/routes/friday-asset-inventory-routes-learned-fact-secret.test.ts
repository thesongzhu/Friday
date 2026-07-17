import { describe, it, expect, vi } from "vitest";
import { createFridayAssetInventoryRoutes } from "#api";
import type { FridayHttpContext } from "#api";

// ─── SEC-EVENT-REDACTION-001 round-14: the sibling asset-inventory egress. Learned facts appear as
//     "knowledge" assets via GET /v1/assets/inventory with the verbatim value in `details.value`.
//     A SECRET-shape nested string value bypassed redaction (the shared guard's value leg was
//     PII-only) and egressed verbatim. Drives the REAL route handler. RED on 815f98ad, GREEN once
//     the value leg composes the canonical secret detector. ───

const NOW = "2026-03-07T10:00:00.000Z";
const M = "[REDACTED_SECRET]";
const CANARY = "sk-proj-advisorCanary0123456789ABCDEFG"; // pragma: allowlist secret
const CANARY_HEADER = `Authorization: Bearer ${CANARY}`; // pragma: allowlist secret
const ZW_SK = "sk-​abcdefghijklmnop0123456789"; // U+200B after sk- // pragma: allowlist secret

function makeCtx(
  overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {},
): FridayHttpContext<unknown, unknown, unknown> {
  return {
    requestId: "req-1",
    receivedAt: NOW,
    params: {},
    query: {},
    body: {},
    headers: {},
    principal: { userId: "user-1" } as never,
    ...overrides,
  };
}

const emptyInventory = { list: () => [] };

function findRoute(deps: Parameters<typeof createFridayAssetInventoryRoutes>[0]) {
  return createFridayAssetInventoryRoutes(deps)
    .find((r) => r.operationId === "assets.inventory.list")!;
}

describe("FridayAssetInventoryRoutes — learned-fact SECRET egress (round-14)", () => {
  it("redacts the Advisor canary + a zero-width-obfuscated sk- in details.value, prefix preserved", async () => {
    const route = findRoute({
      subjectInventory: emptyInventory,
      listLearnedFacts: vi.fn(() => [{
        key: "pref:auth",
        value: { header: CANARY_HEADER, zw: ZW_SK, note: "keep" },
        confidence: 0.9,
        evidenceCount: 3,
        lastConfirmedAt: NOW,
      }]),
    });
    const res = (await route.handler(makeCtx())) as {
      items: Array<{ kind: string; details: { value: { header: string; zw: string; note: string } } }>;
    };

    const learned = res.items.find((i) => i.kind === "learned_fact")!;
    expect(learned.details.value.header).toBe(`Authorization: Bearer ${M}`);
    expect(learned.details.value.zw).toBe(M); // zero-width de-obfuscated + redacted
    expect(learned.details.value.note).toBe("keep");
    expect(JSON.stringify(res)).not.toContain(CANARY);
    expect(JSON.stringify(res)).toContain("Authorization: Bearer");
  });

  it("leaves a value with no secret/PII unchanged (negative control)", async () => {
    const route = findRoute({
      subjectInventory: emptyInventory,
      listLearnedFacts: vi.fn(() => [{
        key: "pref:favorite_color",
        value: "blue",
        confidence: 0.7,
        evidenceCount: 1,
        lastConfirmedAt: NOW,
      }]),
    });
    const res = (await route.handler(makeCtx())) as {
      items: Array<{ kind: string; details: { value: unknown } }>;
    };
    const learned = res.items.find((i) => i.kind === "learned_fact")!;
    expect(learned.details.value).toBe("blue");
  });
});
