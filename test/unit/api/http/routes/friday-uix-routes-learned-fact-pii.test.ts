import { describe, it, expect, vi } from "vitest";
import { createFridayUixRoutes } from "#api";
import type { FridayHttpContext } from "#api";
import type { FridayUixSurfaceService } from "../../../../src/uix/services/friday-uix-surface-service.js";

// ─── Sibling learned-fact egress leak (uix): learned facts are written verbatim (they bypass
//     the write-time PII guard) and are exposed to users for transparency via GET/PATCH
//     /v1/uix/learned-facts. The free-form `value` field skipped PII redaction entirely, so a
//     full-width / CJK / ASCII card/email leaked verbatim. These tests exercise the REAL uix
//     route handlers and assert the returned JSON is redacted. ───

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

const service = {} as unknown as FridayUixSurfaceService;

describe("FridayUixRoutes — learned-fact PII egress", () => {
  it("uix.learnedfacts.list redacts a full-width card in the learned-fact value", async () => {
    const routes = createFridayUixRoutes({
      service,
      listLearnedFacts: vi.fn(() => [{
        key: "pref:card",
        value: `カード番号は${FULLWIDTH_CARD}です`,
        confidence: 0.9,
        evidenceCount: 3,
        lastConfirmedAt: NOW,
      }]),
    });
    const route = routes.find((r) => r.operationId === "uix.learnedfacts.list")!;
    const res = (await route.handler(makeCtx())) as { items: Array<{ value: unknown }> };

    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.value).toBe("カード番号は[CREDIT_CARD]です");
    expect(JSON.stringify(res)).not.toContain(FULLWIDTH_CARD);
  });

  it("uix.learnedfacts.list redacts PII nested inside a structured value", async () => {
    const routes = createFridayUixRoutes({
      service,
      listLearnedFacts: vi.fn(() => [{
        key: "pref:contact",
        value: { channels: [{ kind: "email", raw: "alice@example.com" }], note: "ok" },
        confidence: 0.8,
        evidenceCount: 1,
        lastConfirmedAt: NOW,
      }]),
    });
    const route = routes.find((r) => r.operationId === "uix.learnedfacts.list")!;
    const res = (await route.handler(makeCtx())) as {
      items: Array<{ value: { channels: Array<{ kind: string; raw: string }>; note: string } }>;
    };

    expect(res.items[0]!.value.channels[0]!.kind).toBe("email");
    expect(res.items[0]!.value.channels[0]!.raw).toBe("[EMAIL]");
    expect(res.items[0]!.value.note).toBe("ok");
    expect(JSON.stringify(res)).not.toContain("alice@example.com");
  });

  it("uix.learnedfacts.update redacts a full-width card in the updated value", async () => {
    const routes = createFridayUixRoutes({
      service,
      updateLearnedFact: vi.fn(() => ({
        key: "pref:card",
        value: `カード番号は${FULLWIDTH_CARD}です`,
        confidence: 0.9,
        evidenceCount: 3,
        lastConfirmedAt: NOW,
      })),
    });
    const route = routes.find((r) => r.operationId === "uix.learnedfacts.update")!;
    const res = (await route.handler(makeCtx({
      params: { factKey: encodeURIComponent("pref:card") },
      body: { value: "redact me" },
    }))) as { value: unknown };

    expect(res.value).toBe("カード番号は[CREDIT_CARD]です");
    expect(JSON.stringify(res)).not.toContain(FULLWIDTH_CARD);
  });

  it("uix.learnedfacts.list leaves a value with no PII unchanged (negative control)", async () => {
    const routes = createFridayUixRoutes({
      service,
      listLearnedFacts: vi.fn(() => [{
        key: "pref:favorite_color",
        value: "blue",
        confidence: 0.7,
        evidenceCount: 1,
        lastConfirmedAt: NOW,
      }]),
    });
    const route = routes.find((r) => r.operationId === "uix.learnedfacts.list")!;
    const res = (await route.handler(makeCtx())) as { items: Array<{ value: unknown }> };
    expect(res.items[0]!.value).toBe("blue");
  });
});
