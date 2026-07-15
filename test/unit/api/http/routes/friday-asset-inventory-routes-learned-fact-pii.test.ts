import { describe, it, expect, vi } from "vitest";
import { createFridayAssetInventoryRoutes } from "#api";
import type { FridayHttpContext } from "#api";

// ─── Sibling learned-fact egress leak (asset-inventory): learned facts appear as "knowledge"
//     assets via GET /v1/assets/inventory with the verbatim value in `details.value`. That
//     value bypasses the write-time PII guard, so a full-width / CJK / ASCII card/email leaked
//     unredacted. These tests exercise the REAL route handler and assert the returned JSON. ───

const NOW = "2026-03-07T10:00:00.000Z";
// toFullwidth("4111111111111111") — Luhn-valid Visa test number in full-width digits.
const FULLWIDTH_CARD = "４１１１１１１１１１１１１１１１";

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

describe("FridayAssetInventoryRoutes — learned-fact PII egress", () => {
  it("redacts a full-width card in the learned-fact details.value", async () => {
    const route = findRoute({
      subjectInventory: emptyInventory,
      listLearnedFacts: vi.fn(() => [{
        key: "pref:card",
        value: `カード番号は${FULLWIDTH_CARD}です`,
        confidence: 0.9,
        evidenceCount: 3,
        lastConfirmedAt: NOW,
      }]),
    });
    const res = (await route.handler(makeCtx())) as {
      items: Array<{ kind: string; details: { value: unknown } }>;
    };

    const learned = res.items.find((i) => i.kind === "learned_fact")!;
    expect(learned.details.value).toBe("カード番号は[CREDIT_CARD]です");
    expect(JSON.stringify(res)).not.toContain(FULLWIDTH_CARD);
  });

  it("redacts PII nested inside a structured learned-fact value", async () => {
    const route = findRoute({
      subjectInventory: emptyInventory,
      listLearnedFacts: vi.fn(() => [{
        key: "pref:contact",
        value: { channels: [{ kind: "email", raw: "alice@example.com" }], note: "ok" },
        confidence: 0.8,
        evidenceCount: 1,
        lastConfirmedAt: NOW,
      }]),
    });
    const res = (await route.handler(makeCtx())) as {
      items: Array<{ kind: string; details: { value: { channels: Array<{ raw: string }>; note: string } } }>;
    };

    const learned = res.items.find((i) => i.kind === "learned_fact")!;
    expect(learned.details.value.channels[0]!.raw).toBe("[EMAIL]");
    expect(learned.details.value.note).toBe("ok");
    expect(JSON.stringify(res)).not.toContain("alice@example.com");
  });

  it("leaves a value with no PII unchanged (negative control)", async () => {
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
