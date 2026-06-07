import { describe, it, expect, vi } from "vitest";

import { createFridayDeepLinkRoutes } from "../../../../../src/api/http/routes/friday-deeplink-routes.js";
import type { FridayDeepLinkRoutesDeps } from "../../../../../src/api/http/routes/friday-deeplink-routes.js";

// A valid, non-blocked deep-link payload (provider-template), so body parse +
// verdict pass and the guard is the next thing that fires.
const VALID_PAYLOAD = {
  version: 1,
  type: "provider-template",
  label: "Imported OpenAI",
  providerTemplate: {
    providerKind: "openai",
    apiKey: "sk-test", // pragma: allowlist secret -- fixture value
    model: "gpt-4o-mini",
  },
};

function makeCtx(body: unknown) {
  return {
    requestId: "req-1",
    receivedAt: "2026-05-13T00:00:00Z",
    params: {},
    query: {},
    body,
    headers: {},
    principal: { principalId: "user-1", principalType: "api" as const },
  } as never;
}

function findRoute(routes: ReturnType<typeof createFridayDeepLinkRoutes>, opId: string) {
  const r = routes.find((route) => route.operationId === opId);
  if (!r) throw new Error(`route ${opId} not found`);
  return r;
}

describe("createFridayDeepLinkRoutes — TS-runtime retirement (default/live fail-close)", () => {
  function makeRetiredDeps(): FridayDeepLinkRoutesDeps & { applyDeepLink: ReturnType<typeof vi.fn> } {
    return { applyDeepLink: vi.fn(async () => ({ applied: true, resourceType: "provider-template" } as never)) };
  }

  it("fail-closes deeplink.preview with 503 TS_RUNTIME_DEEPLINK_RETIRED (after body validation)", async () => {
    const route = findRoute(createFridayDeepLinkRoutes(makeRetiredDeps()), "deeplink.preview");
    await expect(route.handler(makeCtx({ payload: VALID_PAYLOAD }))).rejects.toMatchObject({
      code: "TS_RUNTIME_DEEPLINK_RETIRED",
      httpStatus: 503,
    });
  });

  it("still 400s a malformed preview body BEFORE the retirement guard", async () => {
    const route = findRoute(createFridayDeepLinkRoutes(makeRetiredDeps()), "deeplink.preview");
    await expect(route.handler(makeCtx({}))).rejects.toMatchObject({ code: "VALIDATION_FAILED", httpStatus: 400 });
  });

  it("fail-closes deeplink.apply with 503 and does NOT dispatch applyDeepLink", async () => {
    const deps = makeRetiredDeps();
    const route = findRoute(createFridayDeepLinkRoutes(deps), "deeplink.apply");
    await expect(route.handler(makeCtx({ confirmed: true, payload: VALID_PAYLOAD }))).rejects.toMatchObject({
      code: "TS_RUNTIME_DEEPLINK_RETIRED",
      httpStatus: 503,
    });
    expect(deps.applyDeepLink).not.toHaveBeenCalled();
  });

  it("still enforces confirmed (400) BEFORE the apply retirement guard", async () => {
    const deps = makeRetiredDeps();
    const route = findRoute(createFridayDeepLinkRoutes(deps), "deeplink.apply");
    await expect(route.handler(makeCtx({ confirmed: false, payload: VALID_PAYLOAD }))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      httpStatus: 400,
    });
    expect(deps.applyDeepLink).not.toHaveBeenCalled();
  });

  it("runs preview + apply when the test-oracle flag is set", async () => {
    const deps = { ...makeRetiredDeps(), allowTestOnlyDeepLinkExecution: true };
    const previewRoute = findRoute(createFridayDeepLinkRoutes(deps), "deeplink.preview");
    const previewRes = await previewRoute.handler(makeCtx({ payload: VALID_PAYLOAD })) as { preview: unknown };
    expect(previewRes.preview).toBeDefined();

    const applyRoute = findRoute(createFridayDeepLinkRoutes(deps), "deeplink.apply");
    await applyRoute.handler(makeCtx({ confirmed: true, payload: VALID_PAYLOAD }));
    expect(deps.applyDeepLink).toHaveBeenCalledTimes(1);
  });
});
