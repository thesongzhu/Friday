import { describe, it, expect, vi } from "vitest";
import { createFridayUixRoutes } from "#api";
import type { FridayHttpContext } from "#api";
import type { FridayUixSurfaceService } from "../../../../src/uix/services/friday-uix-surface-service.js";

// ─── SEC-EVENT-REDACTION-001 round-14: the Advisor's exact leak. Learned facts are written verbatim
//     (they bypass the write-time guard) and are exposed via GET/PATCH /v1/uix/learned-facts. The
//     free-form `value` field went through the shared PII output filter, but the shared guard's
//     string-VALUE leg ran ONLY PII detectors — so a SECRET-shape nested string value
//     (`Authorization: Bearer sk-proj-…`) was returned VERBATIM in the route JSON. These tests drive
//     the REAL uix route handlers. RED on 815f98ad, GREEN once the value leg composes the canonical
//     secret detector. ───

const NOW = "2026-03-07T10:00:00.000Z";
const M = "[REDACTED_SECRET]";
// The Advisor's exact canary credential.
const CANARY = "sk-proj-advisorCanary0123456789ABCDEFG"; // pragma: allowlist secret
const CANARY_HEADER = `Authorization: Bearer ${CANARY}`; // pragma: allowlist secret
const SK = "sk-abcdefghijklmnopqrstuv0123456789"; // pragma: allowlist secret
const GH_PAT = "github_pat_11ABCDEF0aBcDeFgHiJkL_0123456789abcdefghij"; // pragma: allowlist secret
const FW_SK = "ｓｋ－abcdefghijklmnop0123456789abcd"; // full-width sk- → sk-… // pragma: allowlist secret

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

describe("FridayUixRoutes — learned-fact SECRET egress (round-14)", () => {
  it("uix.learnedfacts.list redacts the Advisor canary (nested Authorization: Bearer sk-proj-…), prefix preserved", async () => {
    const routes = createFridayUixRoutes({
      service,
      listLearnedFacts: vi.fn(() => [{
        key: "pref:auth",
        value: { creds: { header: CANARY_HEADER }, note: "ok" },
        confidence: 0.9,
        evidenceCount: 3,
        lastConfirmedAt: NOW,
      }]),
    });
    const route = routes.find((r) => r.operationId === "uix.learnedfacts.list")!;
    const res = (await route.handler(makeCtx())) as {
      items: Array<{ value: { creds: { header: string }; note: string } }>;
    };

    expect(res.items[0]!.value.creds.header).toBe(`Authorization: Bearer ${M}`);
    expect(res.items[0]!.value.note).toBe("ok");
    // The exact credential is ABSENT from the whole serialized response; the forensic scheme survives.
    expect(JSON.stringify(res)).not.toContain(CANARY);
    expect(JSON.stringify(res)).toContain("Authorization: Bearer");
  });

  it("uix.learnedfacts.list redacts raw + Unicode secret string values (sk- / github_pat_ / full-width sk-)", async () => {
    const routes = createFridayUixRoutes({
      service,
      listLearnedFacts: vi.fn(() => [{
        key: "pref:keys",
        value: { a: SK, b: `deploy used ${GH_PAT}`, c: FW_SK },
        confidence: 0.9,
        evidenceCount: 3,
        lastConfirmedAt: NOW,
      }]),
    });
    const route = routes.find((r) => r.operationId === "uix.learnedfacts.list")!;
    const res = (await route.handler(makeCtx())) as {
      items: Array<{ value: { a: string; b: string; c: string } }>;
    };
    const v = res.items[0]!.value;
    expect(v.a).toBe(M);
    expect(v.b).toBe(`deploy used ${M}`);
    expect(v.c).toBe(M); // full-width sk- de-obfuscated + redacted
    const json = JSON.stringify(res);
    expect(json).not.toContain(SK);
    expect(json).not.toContain(GH_PAT);
  });

  it("uix.learnedfacts.update redacts a secret in the updated value (PATCH egress)", async () => {
    const routes = createFridayUixRoutes({
      service,
      updateLearnedFact: vi.fn(() => ({
        key: "pref:auth",
        value: CANARY_HEADER,
        confidence: 0.9,
        evidenceCount: 3,
        lastConfirmedAt: NOW,
      })),
    });
    const route = routes.find((r) => r.operationId === "uix.learnedfacts.update")!;
    const res = (await route.handler(makeCtx({
      params: { factKey: encodeURIComponent("pref:auth") },
      body: { value: "redact me" },
    }))) as { value: unknown };

    expect(res.value).toBe(`Authorization: Bearer ${M}`);
    expect(JSON.stringify(res)).not.toContain(CANARY);
  });

  it("uix.learnedfacts.list leaves a benign value unchanged (negative control)", async () => {
    const routes = createFridayUixRoutes({
      service,
      listLearnedFacts: vi.fn(() => [{
        key: "pref:favorite_color",
        value: { color: "青", note: "café" },
        confidence: 0.7,
        evidenceCount: 1,
        lastConfirmedAt: NOW,
      }]),
    });
    const route = routes.find((r) => r.operationId === "uix.learnedfacts.list")!;
    const res = (await route.handler(makeCtx())) as { items: Array<{ value: unknown }> };
    expect(res.items[0]!.value).toEqual({ color: "青", note: "café" });
  });
});
