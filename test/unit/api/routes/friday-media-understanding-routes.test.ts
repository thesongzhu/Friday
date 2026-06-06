import { describe, it, expect, vi } from "vitest";
import {
  createFridayMediaUnderstandingRoutes,
  type FridayMediaUnderstandingRoutesDeps,
} from "../../../../src/api/http/routes/friday-media-understanding-routes.js";
import type {
  FridayMediaUnderstandingProvider,
  FridayMediaUnderstandingResult,
  FridayMediaUnderstandingService,
} from "../../../../src/media-understanding/friday-media-understanding.types.js";
import { FridayDomainError } from "../../../../src/errors/friday-domain-error.js";

// ─── Helpers ───

function makeStubService(overrides?: Partial<FridayMediaUnderstandingService>): FridayMediaUnderstandingService {
  const result: FridayMediaUnderstandingResult = {
    enrichments: [],
    decisions: [],
    totalProcessingMs: 0,
  };
  return {
    processAttachments: vi.fn().mockResolvedValue(result),
    ...overrides,
  };
}

function makeStubProvider(): FridayMediaUnderstandingProvider {
  return {
    providerId: "stub-provider",
    supportedMediaTypes: ["image"],
    process: vi.fn().mockResolvedValue({
      description: "stub",
      confidence: 0,
      provider: "stub-provider",
      processingMs: 1,
    }),
  };
}

function makeDeps(overrides: Partial<FridayMediaUnderstandingRoutesDeps> = {}): FridayMediaUnderstandingRoutesDeps {
  return {
    service: makeStubService(),
    doctorProvider: makeStubProvider(),
    disabledReason: null,
    nowIso: () => "2026-05-13T00:00:00Z",
    // Test-oracle flag: the enabled-path tests below exercise the live provider
    // pipeline. Production wiring leaves this unset (TS-runtime retirement).
    allowTestOnlyMediaUnderstandingExecution: true,
    ...overrides,
  };
}

function makeDisabledDeps(reason: string): FridayMediaUnderstandingRoutesDeps {
  return {
    service: null,
    doctorProvider: null,
    disabledReason: reason,
    nowIso: () => "2026-05-13T00:00:00Z",
  };
}

function makeCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    params: {},
    query: {},
    body: null,
    headers: {},
    principal: { principalId: "user-001" },
    ...overrides,
  };
}

function findRoute(
  routes: ReturnType<typeof createFridayMediaUnderstandingRoutes>,
  operationId: string,
) {
  const route = routes.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route not found: ${operationId}`);
  return route;
}

// ─── Registration contract ───

describe("createFridayMediaUnderstandingRoutes — registration", () => {
  it("always registers exactly 2 routes (doctor + analyze)", () => {
    const routesEnabled = createFridayMediaUnderstandingRoutes(makeDeps());
    expect(routesEnabled).toHaveLength(2);

    const routesDisabled = createFridayMediaUnderstandingRoutes(
      makeDisabledDeps("FRIDAY_MEDIA_UNDERSTANDING_ENABLED is not set to true"),
    );
    expect(routesDisabled).toHaveLength(2);
  });

  it("registers media.understanding.doctor as POST /v1/media-understanding/doctor with public auth", () => {
    const routes = createFridayMediaUnderstandingRoutes(makeDeps());
    const doctor = findRoute(routes, "media.understanding.doctor");
    expect(doctor.method).toBe("POST");
    expect(doctor.path).toBe("/v1/media-understanding/doctor");
    expect(doctor.auth).toEqual({ public: true });
  });

  it("registers media.understanding.analyze as POST /v1/media-understanding/analyze with public auth", () => {
    const routes = createFridayMediaUnderstandingRoutes(makeDeps());
    const analyze = findRoute(routes, "media.understanding.analyze");
    expect(analyze.method).toBe("POST");
    expect(analyze.path).toBe("/v1/media-understanding/analyze");
    expect(analyze.auth).toEqual({ public: true });
  });
});

// ─── Disabled behavior ───

describe("createFridayMediaUnderstandingRoutes — disabled state", () => {
  it("doctor returns 503 MEDIA_UNDERSTANDING_DISABLED with disabledReason from deps", async () => {
    const deps = makeDisabledDeps("FRIDAY_MEDIA_UNDERSTANDING_ENABLED is not set to true");
    const routes = createFridayMediaUnderstandingRoutes(deps);
    const doctor = findRoute(routes, "media.understanding.doctor");

    let thrown: unknown = null;
    try {
      await doctor.handler(makeCtx() as never);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FridayDomainError);
    const e = thrown as FridayDomainError;
    expect(e.code).toBe("MEDIA_UNDERSTANDING_DISABLED");
    expect(e.httpStatus).toBe(503);
    expect(e.message).toBe("FRIDAY_MEDIA_UNDERSTANDING_ENABLED is not set to true");
  });

  it("analyze returns 503 MEDIA_UNDERSTANDING_DISABLED with disabledReason from deps", async () => {
    const deps = makeDisabledDeps("media understanding credential resolution failed: SECRET_ENV_VAR_MISSING");
    const routes = createFridayMediaUnderstandingRoutes(deps);
    const analyze = findRoute(routes, "media.understanding.analyze");

    let thrown: unknown = null;
    try {
      await analyze.handler(makeCtx({
        body: { attachments: [{ mimeType: "image/png", sizeBytes: 1, sourceUrl: "https://x" }] },
      }) as never);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FridayDomainError);
    const e = thrown as FridayDomainError;
    expect(e.code).toBe("MEDIA_UNDERSTANDING_DISABLED");
    expect(e.httpStatus).toBe(503);
    expect(e.message).toContain("SECRET_ENV_VAR_MISSING");
  });

  it("doctor returns 503 with default message when disabledReason is null", async () => {
    const routes = createFridayMediaUnderstandingRoutes({
      service: null,
      doctorProvider: null,
      disabledReason: null,
      nowIso: () => "2026-05-13T00:00:00Z",
    });
    const doctor = findRoute(routes, "media.understanding.doctor");
    let thrown: unknown = null;
    try {
      await doctor.handler(makeCtx() as never);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FridayDomainError);
    const e = thrown as FridayDomainError;
    expect(e.code).toBe("MEDIA_UNDERSTANDING_DISABLED");
    expect(e.httpStatus).toBe(503);
    expect(e.message).toMatch(/Media understanding is disabled/);
    expect(e.message).toMatch(/FRIDAY_MEDIA_UNDERSTANDING_ENABLED=true/);
  });
});

// ─── Enabled doctor behavior ───

describe("createFridayMediaUnderstandingRoutes — doctor enabled", () => {
  it("returns { report } shape on success", async () => {
    const deps = makeDeps();
    const routes = createFridayMediaUnderstandingRoutes(deps);
    const doctor = findRoute(routes, "media.understanding.doctor");
    const response = await doctor.handler(makeCtx() as never) as { report: { providerId: string; status: string } };
    expect(response).toHaveProperty("report");
    expect(response.report.providerId).toBe("stub-provider");
    expect(response.report.status).toBe("ok");
    expect(deps.doctorProvider!.process).toHaveBeenCalledTimes(1);
  });

  it("accepts an empty request body", async () => {
    const deps = makeDeps();
    const routes = createFridayMediaUnderstandingRoutes(deps);
    const doctor = findRoute(routes, "media.understanding.doctor");
    await expect(doctor.handler(makeCtx({ body: {} }) as never)).resolves.toBeDefined();
  });

  it("rejects invalid request body shape with VALIDATION_ERROR 400", async () => {
    const deps = makeDeps();
    const routes = createFridayMediaUnderstandingRoutes(deps);
    const doctor = findRoute(routes, "media.understanding.doctor");
    let thrown: unknown = null;
    try {
      await doctor.handler(makeCtx({ body: { testImageBase64: 123 } }) as never);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FridayDomainError);
    const e = thrown as FridayDomainError;
    expect(e.code).toBe("VALIDATION_ERROR");
    expect(e.httpStatus).toBe(400);
  });
});

// ─── Enabled analyze behavior ───

describe("createFridayMediaUnderstandingRoutes — analyze enabled", () => {
  it("returns { result } shape on success and calls service.processAttachments", async () => {
    const deps = makeDeps();
    const routes = createFridayMediaUnderstandingRoutes(deps);
    const analyze = findRoute(routes, "media.understanding.analyze");
    const response = await analyze.handler(makeCtx({
      body: {
        attachments: [
          { id: "a1", mimeType: "image/png", sizeBytes: 100, sourceUrl: "https://example.com/img.png" },
        ],
      },
    }) as never) as { result: unknown };
    expect(response).toHaveProperty("result");
    expect(deps.service!.processAttachments).toHaveBeenCalledTimes(1);
    const calledWith = (deps.service!.processAttachments as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledWith).toHaveLength(1);
    expect(calledWith[0]).toMatchObject({
      id: "a1",
      mimeType: "image/png",
      sizeBytes: 100,
      sourceUrl: "https://example.com/img.png",
      mediaType: "image",
    });
  });

  it("auto-generates attachment ids when not provided", async () => {
    const deps = makeDeps();
    const routes = createFridayMediaUnderstandingRoutes(deps);
    const analyze = findRoute(routes, "media.understanding.analyze");
    await analyze.handler(makeCtx({
      body: {
        attachments: [
          { mimeType: "image/jpeg", sizeBytes: 50, sourceUrl: "https://x/1.jpg" },
          { mimeType: "image/jpeg", sizeBytes: 60, sourceUrl: "https://x/2.jpg" },
        ],
      },
    }) as never);
    const calledWith = (deps.service!.processAttachments as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledWith[0].id).toBe("att-0");
    expect(calledWith[1].id).toBe("att-1");
  });

  it("rejects empty attachments array with VALIDATION_ERROR 400", async () => {
    const deps = makeDeps();
    const routes = createFridayMediaUnderstandingRoutes(deps);
    const analyze = findRoute(routes, "media.understanding.analyze");
    let thrown: unknown = null;
    try {
      await analyze.handler(makeCtx({ body: { attachments: [] } }) as never);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FridayDomainError);
    const e = thrown as FridayDomainError;
    expect(e.code).toBe("VALIDATION_ERROR");
    expect(e.httpStatus).toBe(400);
  });

  it("rejects missing mimeType with VALIDATION_ERROR 400", async () => {
    const deps = makeDeps();
    const routes = createFridayMediaUnderstandingRoutes(deps);
    const analyze = findRoute(routes, "media.understanding.analyze");
    let thrown: unknown = null;
    try {
      await analyze.handler(makeCtx({
        body: { attachments: [{ sizeBytes: 1, sourceUrl: "https://x" }] },
      }) as never);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FridayDomainError);
    const e = thrown as FridayDomainError;
    expect(e.code).toBe("VALIDATION_ERROR");
    expect(e.httpStatus).toBe(400);
  });

  it("rejects data: scheme sourceUrl with VALIDATION_ERROR 400 (no inline content bypass)", async () => {
    const deps = makeDeps();
    const routes = createFridayMediaUnderstandingRoutes(deps);
    const analyze = findRoute(routes, "media.understanding.analyze");
    let thrown: unknown = null;
    try {
      await analyze.handler(makeCtx({
        body: {
          attachments: [
            {
              mimeType: "image/png",
              sizeBytes: 1,
              sourceUrl: "data:image/png;base64,iVBORw0KGgo=",
            },
          ],
        },
      }) as never);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FridayDomainError);
    const e = thrown as FridayDomainError;
    expect(e.code).toBe("VALIDATION_ERROR");
    expect(e.httpStatus).toBe(400);
    expect(e.message).toMatch(/sourceUrl must use the http:\/\/ or https:\/\/ scheme/);
    expect(deps.service!.processAttachments).not.toHaveBeenCalled();
  });

  it("rejects non-http(s) schemes (file:, ftp:, etc.) with VALIDATION_ERROR 400", async () => {
    const deps = makeDeps();
    const routes = createFridayMediaUnderstandingRoutes(deps);
    const analyze = findRoute(routes, "media.understanding.analyze");
    for (const sourceUrl of [
      "file:///etc/passwd",
      "ftp://example.com/x.png",
      "javascript:alert(1)",
      "about:blank",
    ]) {
      let thrown: unknown = null;
      try {
        await analyze.handler(makeCtx({
          body: {
            attachments: [
              { mimeType: "image/png", sizeBytes: 1, sourceUrl },
            ],
          },
        }) as never);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(FridayDomainError);
      const e = thrown as FridayDomainError;
      expect(e.code).toBe("VALIDATION_ERROR");
      expect(e.httpStatus).toBe(400);
    }
    expect(deps.service!.processAttachments).not.toHaveBeenCalled();
  });

  it("accepts http:// sourceUrl as well as https://", async () => {
    const deps = makeDeps();
    const routes = createFridayMediaUnderstandingRoutes(deps);
    const analyze = findRoute(routes, "media.understanding.analyze");
    await analyze.handler(makeCtx({
      body: {
        attachments: [
          { mimeType: "image/png", sizeBytes: 1, sourceUrl: "http://example.com/img.png" },
          { mimeType: "image/png", sizeBytes: 1, sourceUrl: "HTTPS://Example.com/img.png" },
        ],
      },
    }) as never);
    expect(deps.service!.processAttachments).toHaveBeenCalledTimes(1);
    const calledWith = (deps.service!.processAttachments as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledWith).toHaveLength(2);
  });

  it("rejects non-object request body with VALIDATION_ERROR 400", async () => {
    const deps = makeDeps();
    const routes = createFridayMediaUnderstandingRoutes(deps);
    const analyze = findRoute(routes, "media.understanding.analyze");
    let thrown: unknown = null;
    try {
      await analyze.handler(makeCtx({ body: null }) as never);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FridayDomainError);
    const e = thrown as FridayDomainError;
    expect(e.code).toBe("VALIDATION_ERROR");
    expect(e.httpStatus).toBe(400);
  });

  it("detects audio mediaType from mimeType prefix", async () => {
    const deps = makeDeps();
    const routes = createFridayMediaUnderstandingRoutes(deps);
    const analyze = findRoute(routes, "media.understanding.analyze");
    await analyze.handler(makeCtx({
      body: {
        attachments: [
          { mimeType: "audio/mpeg", sizeBytes: 1000, sourceUrl: "https://x/audio.mp3" },
        ],
      },
    }) as never);
    const calledWith = (deps.service!.processAttachments as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledWith[0].mediaType).toBe("audio");
  });
});

// ─── TS-runtime retirement (default/live fail-close) ───

describe("createFridayMediaUnderstandingRoutes — TS-runtime retirement", () => {
  // ENABLED deps but WITHOUT the test-oracle flag = production/live wiring.
  function makeRetiredDeps(): FridayMediaUnderstandingRoutesDeps {
    return {
      service: makeStubService(),
      doctorProvider: makeStubProvider(),
      disabledReason: null,
      nowIso: () => "2026-05-13T00:00:00Z",
    };
  }

  it("fail-closes doctor with 503 TS_RUNTIME_MEDIA_UNDERSTANDING_RETIRED and does not probe", async () => {
    const deps = makeRetiredDeps();
    const routes = createFridayMediaUnderstandingRoutes(deps);
    const doctor = findRoute(routes, "media.understanding.doctor");
    let thrown: unknown = null;
    try {
      await doctor.handler(makeCtx({ body: {} }) as never);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FridayDomainError);
    const e = thrown as FridayDomainError;
    expect(e.code).toBe("TS_RUNTIME_MEDIA_UNDERSTANDING_RETIRED");
    expect(e.httpStatus).toBe(503);
    expect(deps.doctorProvider!.process).not.toHaveBeenCalled();
  });

  it("fail-closes analyze with 503 and does not call processAttachments", async () => {
    const deps = makeRetiredDeps();
    const routes = createFridayMediaUnderstandingRoutes(deps);
    const analyze = findRoute(routes, "media.understanding.analyze");
    let thrown: unknown = null;
    try {
      await analyze.handler(makeCtx({
        body: { attachments: [{ mimeType: "image/png", sizeBytes: 1, sourceUrl: "https://x/img.png" }] },
      }) as never);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FridayDomainError);
    const e = thrown as FridayDomainError;
    expect(e.code).toBe("TS_RUNTIME_MEDIA_UNDERSTANDING_RETIRED");
    expect(e.httpStatus).toBe(503);
    expect(deps.service!.processAttachments).not.toHaveBeenCalled();
  });

  it("still validates the analyze body (400) BEFORE the retirement guard", async () => {
    const deps = makeRetiredDeps();
    const routes = createFridayMediaUnderstandingRoutes(deps);
    const analyze = findRoute(routes, "media.understanding.analyze");
    let thrown: unknown = null;
    try {
      // non-http(s) scheme -> VALIDATION_ERROR 400 before the 503 guard
      await analyze.handler(makeCtx({
        body: { attachments: [{ mimeType: "image/png", sizeBytes: 1, sourceUrl: "file:///etc/passwd" }] },
      }) as never);
    } catch (err) {
      thrown = err;
    }
    const e = thrown as FridayDomainError;
    expect(e.code).toBe("VALIDATION_ERROR");
    expect(e.httpStatus).toBe(400);
    expect(deps.service!.processAttachments).not.toHaveBeenCalled();
  });

  it("still surfaces MEDIA_UNDERSTANDING_DISABLED (not the retirement 503) when disabled", async () => {
    // Disabled (service/provider null) WITHOUT the flag: the availability check
    // throws before the retirement guard.
    const routes = createFridayMediaUnderstandingRoutes(makeDisabledDeps("FRIDAY_MEDIA_UNDERSTANDING_ENABLED is not set to true"));
    const analyze = findRoute(routes, "media.understanding.analyze");
    let thrown: unknown = null;
    try {
      await analyze.handler(makeCtx({
        body: { attachments: [{ mimeType: "image/png", sizeBytes: 1, sourceUrl: "https://x/img.png" }] },
      }) as never);
    } catch (err) {
      thrown = err;
    }
    const e = thrown as FridayDomainError;
    expect(e.code).toBe("MEDIA_UNDERSTANDING_DISABLED");
    expect(e.httpStatus).toBe(503);
  });
});
