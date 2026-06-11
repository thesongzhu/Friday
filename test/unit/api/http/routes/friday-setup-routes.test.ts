import { describe, expect, it, vi } from "vitest";

import { createFridaySetupRoutes, type FridaySetupRoutesDeps } from "../../../../../src/api/http/routes/friday-setup-routes.js";

/**
 * B0 Slice A3 — setup bootstrap-boundary tests.
 *
 * The 11 mutating setup-wizard routes each invoke `assertSetupBootstrapBoundary`
 * before any side effect. The boundary requires:
 *   1. request originates from a loopback address
 *   2. `friday_setup_state.setup_completed_at IS NULL`
 *
 * This file proves, per route, that:
 *   - the route declares `auth: { public: true, allowUnauthenticatedMutation: true }`
 *   - a non-localhost request is rejected with SETUP_BOOTSTRAP_NOT_ALLOWED_NON_LOCALHOST (403) and no side effect
 *   - a request after setup completion is rejected with SETUP_ALREADY_COMPLETED (409) and no side effect
 *
 * It also adds one positive regression covering a legitimate first-boot localhost call
 * that should reach the handler's normal logic.
 */

const NOW = "2026-05-24T11:00:00.000Z";

interface DepsOptions {
  setupCompletedAt?: string | null;
  networkMode?: string;
}

interface DepsAndSpies {
  deps: FridaySetupRoutesDeps;
  writeTxn: ReturnType<typeof vi.fn>;
  listProviders: ReturnType<typeof vi.fn>;
  activateSavedChannels: ReturnType<typeof vi.fn>;
  onChannelsSaved: ReturnType<typeof vi.fn>;
  onSetupCompleted: ReturnType<typeof vi.fn>;
}

function makeDeps(opts: DepsOptions = {}): DepsAndSpies {
  const setupCompletedAt = opts.setupCompletedAt ?? null;
  const networkMode = opts.networkMode ?? "local";

  const setupStateRow = {
    id: "singleton",
    setup_completed_at: setupCompletedAt,
    completed_steps: "[]",
    skipped_steps: "[]",
    network_mode: networkMode,
    network_host: "127.0.0.1",
    network_port: 3141,
    channels_json: "[]",
    created_at: NOW,
    updated_at: NOW,
  };

  const writeTxn = vi.fn((cb: (db: unknown) => unknown) => {
    return cb({
      prepare: () => ({ run: () => undefined, get: () => undefined, all: () => [] }),
    });
  });
  const listProviders = vi.fn(async () => []);
  const activateSavedChannels = vi.fn(async () => ({ activatedKinds: [] }));
  const onChannelsSaved = vi.fn(async () => undefined);
  const onSetupCompleted = vi.fn(async () => undefined);

  const deps = {
    db: {
      withReadConnection: <T,>(fn: (db: unknown) => T): T =>
        fn({
          prepare: (sql: string) => ({
            get: () => {
              if (sql.includes("FROM friday_setup_state")) return setupStateRow;
              return undefined;
            },
            all: () => [],
            run: () => undefined,
          }),
        }),
      withWriteTransaction: writeTxn,
      close: vi.fn(),
    },
    providerService: {
      listProviders,
      getProvider: vi.fn(),
      saveProvider: vi.fn(),
      removeProvider: vi.fn(),
      detectProvider: vi.fn(),
      validateProviderCredentials: vi.fn(),
      verifyProviderConnectivity: vi.fn(),
      __routesTestStub: true,
    },
    skillRegistry: {
      list: () => [],
      get: vi.fn(),
    },
    nowIso: () => NOW,
    runningHost: "127.0.0.1",
    runningPort: 3141,
    getLiveChannelCount: () => 0,
    activateSavedChannels,
    onChannelsSaved,
    onSetupCompleted,
    // Test-oracle flag: detect handler tests exercise the live provider probe.
    // Production wiring leaves it unset (TS-runtime retirement).
    allowTestOnlyProviderDetectExecution: true,
  } as unknown as FridaySetupRoutesDeps;

  return { deps, writeTxn, listProviders, activateSavedChannels, onChannelsSaved, onSetupCompleted };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "req-a3-1",
    receivedAt: NOW,
    params: {},
    query: {},
    headers: {},
    body: {},
    principal: null,
    ip: "127.0.0.1",
    ...overrides,
  } as never;
}

function findMutatingRoute(
  routes: ReturnType<typeof createFridaySetupRoutes>,
  operationId: string,
) {
  const route = routes.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route not found: ${operationId}`);
  return route;
}

/**
 * The 11 mutating setup-wizard routes covered by Slice A3.
 *
 * Each entry uses a minimal `validBody` that gets past the route's own input
 * validation when the bootstrap boundary holds. The bodies are NOT exercised
 * here for behavior — only to confirm the boundary fires before any side effect.
 */
const A3_MUTATING_ROUTES: Array<{ id: string; body: Record<string, unknown> }> = [
  { id: "providers.detect", body: { kind: "ollama" } },
  { id: "setup.network.save", body: { mode: "local", port: 3141 } },
  { id: "setup.channels.feishu.registration.begin", body: {} },
  { id: "setup.channels.feishu.registration.poll", body: { registrationId: "reg-1" } },
  { id: "setup.channels.telegram.verification.begin", body: { botToken: "tok" } },
  { id: "setup.channels.telegram.verification.poll", body: { verificationId: "ver-1" } },
  { id: "setup.channels.discord.verification.begin", body: { token: "tok" } },
  { id: "setup.channels.discord.verification.complete", body: { verificationId: "ver-1", userId: "u" } },
  { id: "setup.channels.test", body: { kind: "discord", config: { token: "tok" } } },
  { id: "setup.channels.save", body: { controlConfirmed: true, channels: [] } },
  { id: "setup.complete", body: { completedSteps: ["welcome", "done"], skippedSteps: [] } },
];

describe("createFridaySetupRoutes — B0 Slice A3 bootstrap boundary", () => {
  it("exposes exactly 11 mutating setup routes with the carve-out flag", () => {
    const { deps } = makeDeps({ setupCompletedAt: null });
    const routes = createFridaySetupRoutes(deps);

    const flagged = routes.filter(
      (r) =>
        r.method !== "GET" &&
        typeof r.auth === "object" &&
        r.auth.public === true &&
        (r.auth as { allowUnauthenticatedMutation?: true }).allowUnauthenticatedMutation === true,
    );
    expect(flagged.length).toBe(11);

    const flaggedIds = new Set(flagged.map((r) => r.operationId));
    for (const { id } of A3_MUTATING_ROUTES) {
      expect(flaggedIds.has(id)).toBe(true);
    }
  });

  describe.each(A3_MUTATING_ROUTES)("$id", ({ id, body }) => {
    it("rejects non-localhost IP with SETUP_BOOTSTRAP_NOT_ALLOWED_NON_LOCALHOST 403 and no side effect", async () => {
      const { deps, writeTxn, activateSavedChannels, onChannelsSaved, onSetupCompleted, listProviders } = makeDeps({
        setupCompletedAt: null,
      });
      const route = findMutatingRoute(createFridaySetupRoutes(deps), id);

      await expect(
        route.handler(makeCtx({ ip: "10.0.0.5", body })),
      ).rejects.toMatchObject({
        code: "SETUP_BOOTSTRAP_NOT_ALLOWED_NON_LOCALHOST",
        httpStatus: 403,
      });

      expect(writeTxn).not.toHaveBeenCalled();
      expect(activateSavedChannels).not.toHaveBeenCalled();
      expect(onChannelsSaved).not.toHaveBeenCalled();
      expect(onSetupCompleted).not.toHaveBeenCalled();
      expect(listProviders).not.toHaveBeenCalled();
    });

    it("rejects requests after setup_completed_at is set with SETUP_ALREADY_COMPLETED 409 and no side effect", async () => {
      const { deps, writeTxn, activateSavedChannels, onChannelsSaved, onSetupCompleted, listProviders } = makeDeps({
        setupCompletedAt: "2026-05-24T10:00:00.000Z",
      });
      const route = findMutatingRoute(createFridaySetupRoutes(deps), id);

      await expect(
        route.handler(makeCtx({ ip: "127.0.0.1", body })),
      ).rejects.toMatchObject({
        code: "SETUP_ALREADY_COMPLETED",
        httpStatus: 409,
      });

      expect(writeTxn).not.toHaveBeenCalled();
      expect(activateSavedChannels).not.toHaveBeenCalled();
      expect(onChannelsSaved).not.toHaveBeenCalled();
      expect(onSetupCompleted).not.toHaveBeenCalled();
      expect(listProviders).not.toHaveBeenCalled();
    });
  });

  it("regression: legitimate first-boot localhost setup.network.save reaches handler and writes state", async () => {
    const { deps, writeTxn } = makeDeps({ setupCompletedAt: null });
    const route = findMutatingRoute(createFridaySetupRoutes(deps), "setup.network.save");

    const result = await route.handler(
      makeCtx({ ip: "127.0.0.1", body: { mode: "local", port: 3141 } }),
    );

    expect(result).toEqual(
      expect.objectContaining({
        host: "127.0.0.1",
        port: 3141,
        mode: "local",
      }),
    );
    // Boundary did not block; the write path executed.
    expect(writeTxn).toHaveBeenCalled();
  });

  it("regression: ::1 loopback is accepted (IPv6 first-boot)", async () => {
    const { deps, writeTxn } = makeDeps({ setupCompletedAt: null });
    const route = findMutatingRoute(createFridaySetupRoutes(deps), "setup.network.save");

    await route.handler(
      makeCtx({ ip: "::1", body: { mode: "local", port: 3141 } }),
    );
    expect(writeTxn).toHaveBeenCalled();
  });

  it("authenticated bypass: bound principal can re-run setup mutations post-setup from any IP", async () => {
    // The boundary is a fallback for UNauthenticated requests (synthetic public
    // principal). An authenticated bound principal already provides
    // authorization, so the assertion bypasses — this preserves the legitimate
    // post-setup reconfiguration flow (e.g. release-proof Discord roundtrip
    // scenario, admin swapping bot tokens after first boot).
    const { deps, writeTxn } = makeDeps({ setupCompletedAt: "2026-05-24T10:00:00.000Z" });
    const route = findMutatingRoute(createFridaySetupRoutes(deps), "setup.network.save");

    const result = await route.handler(
      makeCtx({
        ip: "10.0.0.5", // explicitly non-localhost — does not matter for authenticated principal
        body: { mode: "local", port: 3141 },
        principal: {
          principalId: "user-admin-001",
          principalType: "user",
          userId: "11111111-1111-1111-1111-111111111111",
          tenantId: "22222222-2222-2222-2222-222222222222",
          role: "admin",
          scopes: ["session.read", "session.write", "hub.admin"],
          tokenId: "33333333-3333-3333-3333-333333333333",
          tokenKind: "access",
          issuedAt: NOW,
        },
      }),
    );

    expect(result).toEqual(
      expect.objectContaining({ mode: "local", port: 3141 }),
    );
    expect(writeTxn).toHaveBeenCalled();
  });

  it("authenticated bypass: synthetic-public principalId is NOT treated as authenticated even with other fields populated", async () => {
    // Defense-in-depth: a partial fake principal whose principalId matches the
    // synthetic-public id must still hit the boundary, even if other auth
    // fields are spoofed.
    const { deps, writeTxn } = makeDeps({ setupCompletedAt: "2026-05-24T10:00:00.000Z" });
    const route = findMutatingRoute(createFridaySetupRoutes(deps), "setup.network.save");

    await expect(
      route.handler(
        makeCtx({
          ip: "127.0.0.1",
          body: { mode: "local", port: 3141 },
          principal: {
            principalId: "public:default",
            principalType: "user",
            userId: "fake",
            tenantId: "fake",
            role: "admin", // intentionally spoofed
            scopes: ["hub.admin"], // intentionally spoofed
            tokenId: "fake",
            tokenKind: "access",
            issuedAt: NOW,
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "SETUP_ALREADY_COMPLETED",
      httpStatus: 409,
    });
    expect(writeTxn).not.toHaveBeenCalled();
  });

  it("bypass: forged x-forwarded-for header on a non-loopback ctx.ip is still rejected", async () => {
    // The boundary reads ONLY ctx.ip — the server's trust-proxy policy is the
    // sole authority for populating ctx.ip from forwarded headers
    // (see src/api/http/friday-http-client-ip.ts:99-117 and the
    // FRIDAY_HTTP_TRUST_PROXY env var which defaults to "off"). If a future
    // change accidentally adds header-reading to the boundary, this test fails.
    const { deps, writeTxn } = makeDeps({ setupCompletedAt: null });
    const route = findMutatingRoute(createFridaySetupRoutes(deps), "setup.network.save");

    await expect(
      route.handler(
        makeCtx({
          ip: "10.0.0.5",
          headers: {
            "x-forwarded-for": "127.0.0.1, 10.0.0.5",
            "x-real-ip": "127.0.0.1",
            "forwarded": "for=127.0.0.1",
          },
          body: { mode: "local", port: 3141 },
        }),
      ),
    ).rejects.toMatchObject({
      code: "SETUP_BOOTSTRAP_NOT_ALLOWED_NON_LOCALHOST",
      httpStatus: 403,
    });
    expect(writeTxn).not.toHaveBeenCalled();
  });

  // ─── B1 Slice 1: QQ channel labeled unsupported ───
  //
  // GLOBAL_DECISIONS_LOCKED.md: "QQ is unsupported/proof_pending unless fixed
  // and proven." QQ inbound is currently silently dropped by the channel
  // registry's lifecycle/start arbitration. Until that root cause is fixed and
  // end-to-end inbound delivery is proved, setup must refuse to test or save
  // QQ channels. The schema still recognizes `kind: "qq"` for backward-compat,
  // but the user-facing boundary fails closed with CHANNEL_KIND_UNSUPPORTED.

  it("B1: setup.channels.test refuses kind='qq' with CHANNEL_KIND_UNSUPPORTED 409 (labeled unsupported)", async () => {
    const { deps, writeTxn } = makeDeps({ setupCompletedAt: null });
    const route = findMutatingRoute(createFridaySetupRoutes(deps), "setup.channels.test");

    await expect(
      route.handler(
        makeCtx({
          ip: "127.0.0.1",
          body: { kind: "qq", config: { appId: "test", appSecret: "test" } }, // pragma: allowlist secret
        }),
      ),
    ).rejects.toMatchObject({
      code: "CHANNEL_KIND_UNSUPPORTED",
      httpStatus: 409,
    });

    // Verifier-side proof: no credential validation, no test connection, no DB write.
    expect(writeTxn).not.toHaveBeenCalled();
  });

  it("B1: setup.channels.save refuses any channels[].kind='qq' with CHANNEL_KIND_UNSUPPORTED 409", async () => {
    const { deps, writeTxn, activateSavedChannels, onChannelsSaved } = makeDeps({ setupCompletedAt: null });
    const route = findMutatingRoute(createFridaySetupRoutes(deps), "setup.channels.save");

    await expect(
      route.handler(
        makeCtx({
          ip: "127.0.0.1",
          body: {
            controlConfirmed: true,
            channels: [
              { kind: "qq", enabled: true, config: { appId: "a", appSecret: "s" } }, // pragma: allowlist secret
            ],
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "CHANNEL_KIND_UNSUPPORTED",
      httpStatus: 409,
    });

    // Verifier-side proof: no channel persisted, no activation, no callback fired.
    expect(writeTxn).not.toHaveBeenCalled();
    expect(activateSavedChannels).not.toHaveBeenCalled();
    expect(onChannelsSaved).not.toHaveBeenCalled();
  });

  it("B1: setup.channels.save fails on QQ before checking other per-channel verification (no partial persistence)", async () => {
    // Defense-in-depth: when QQ appears in the channel batch, the unsupported
    // check fires per-iteration and the loop throws before any subsequent
    // channel's verification or any DB write begins. Position QQ FIRST in the
    // list so this test isolates the unsupported-check; A subsequent test
    // case proves the order-independence by re-running with QQ later (under
    // disabled flags on others so we don't fight per-channel verification).
    const { deps, writeTxn, activateSavedChannels, onChannelsSaved } = makeDeps({ setupCompletedAt: null });
    const route = findMutatingRoute(createFridaySetupRoutes(deps), "setup.channels.save");

    await expect(
      route.handler(
        makeCtx({
          ip: "127.0.0.1",
          body: {
            controlConfirmed: true,
            channels: [
              { kind: "qq", enabled: true, config: { appId: "a", appSecret: "s" } }, // pragma: allowlist secret
              { kind: "discord", enabled: false, config: {} },
              { kind: "telegram", enabled: false, config: {} },
            ],
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "CHANNEL_KIND_UNSUPPORTED",
      httpStatus: 409,
    });

    expect(writeTxn).not.toHaveBeenCalled();
    expect(activateSavedChannels).not.toHaveBeenCalled();
    expect(onChannelsSaved).not.toHaveBeenCalled();
  });

  it("B1: setup.channels.save still rejects QQ when QQ appears AFTER a supported disabled channel (order-independent)", async () => {
    // Supplementary case: when QQ is in a mid-list position, the unsupported
    // check still fires (validation loop iterates from index 0 forward and
    // throws on first unsupported entry).
    const { deps, writeTxn, activateSavedChannels, onChannelsSaved } = makeDeps({ setupCompletedAt: null });
    const route = findMutatingRoute(createFridaySetupRoutes(deps), "setup.channels.save");

    await expect(
      route.handler(
        makeCtx({
          ip: "127.0.0.1",
          body: {
            controlConfirmed: true,
            channels: [
              { kind: "discord", enabled: false, config: {} },
              { kind: "qq", enabled: true, config: { appId: "a", appSecret: "s" } }, // pragma: allowlist secret
            ],
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "CHANNEL_KIND_UNSUPPORTED",
      httpStatus: 409,
    });

    expect(writeTxn).not.toHaveBeenCalled();
    expect(activateSavedChannels).not.toHaveBeenCalled();
    expect(onChannelsSaved).not.toHaveBeenCalled();
  });

  // ─── B1 Slice 11: Slack HTTP mode labeled unsupported ───
  //
  // AUTO_DECISION_POLICY ("prefer truthful unsupported over pretending"):
  // Slack HTTP mode is an unwired stub — createSlackHttpEventService.start()
  // flips an internal flag without binding an HTTP server, and
  // verifySlackSignature has zero callers. A user configuring slack+http would
  // see no inbound messages at all. Truth-label this mode as unsupported until
  // the listener AND signature verifier (including timestamp freshness) are
  // wired together and proven end-to-end. Slack socket mode remains supported.

  it("B1: setup.channels.test refuses kind='slack' + mode='http' with CHANNEL_MODE_UNSUPPORTED 409", async () => {
    const { deps, writeTxn } = makeDeps({ setupCompletedAt: null });
    const route = findMutatingRoute(createFridaySetupRoutes(deps), "setup.channels.test");

    await expect(
      route.handler(
        makeCtx({
          ip: "127.0.0.1",
          body: {
            kind: "slack",
            config: {
              botToken: "xoxb-stub",
              mode: "http",
              signingSecret: "stub-secret", // pragma: allowlist secret
            },
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "CHANNEL_MODE_UNSUPPORTED",
      httpStatus: 409,
      details: { kind: "slack", mode: "http", status: "unsupported" },
    });

    // Verifier-side proof: no credential validation, no test connection, no DB write.
    expect(writeTxn).not.toHaveBeenCalled();
  });

  it("B1: setup.channels.test accepts kind='slack' + mode='socket' (regression: socket mode still works)", async () => {
    const { deps } = makeDeps({ setupCompletedAt: null });
    const route = findMutatingRoute(createFridaySetupRoutes(deps), "setup.channels.test");

    const result = await route.handler(
      makeCtx({
        ip: "127.0.0.1",
        body: {
          kind: "slack",
          config: { botToken: "xoxb-stub", mode: "socket", appToken: "xapp-stub" },
        },
      }),
    );

    expect(result).toMatchObject({ kind: "slack", validated: true });
  });

  it("B1: setup.channels.save refuses any channels[].kind='slack' + mode='http' with CHANNEL_MODE_UNSUPPORTED 409", async () => {
    const { deps, writeTxn, activateSavedChannels, onChannelsSaved } = makeDeps({ setupCompletedAt: null });
    const route = findMutatingRoute(createFridaySetupRoutes(deps), "setup.channels.save");

    await expect(
      route.handler(
        makeCtx({
          ip: "127.0.0.1",
          body: {
            controlConfirmed: true,
            channels: [
              {
                kind: "slack",
                enabled: true,
                config: {
                  botToken: "xoxb-stub",
                  mode: "http",
                  signingSecret: "stub-secret", // pragma: allowlist secret
                },
              },
            ],
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "CHANNEL_MODE_UNSUPPORTED",
      httpStatus: 409,
      details: { kind: "slack", mode: "http", status: "unsupported" },
    });

    // Verifier-side proof: no channel persisted, no activation, no callback fired.
    expect(writeTxn).not.toHaveBeenCalled();
    expect(activateSavedChannels).not.toHaveBeenCalled();
    expect(onChannelsSaved).not.toHaveBeenCalled();
  });

  it("B1: setup.channels.save order-independent: slack+http after disabled discord still gets CHANNEL_MODE_UNSUPPORTED", async () => {
    const { deps, writeTxn, activateSavedChannels, onChannelsSaved } = makeDeps({ setupCompletedAt: null });
    const route = findMutatingRoute(createFridaySetupRoutes(deps), "setup.channels.save");

    await expect(
      route.handler(
        makeCtx({
          ip: "127.0.0.1",
          body: {
            controlConfirmed: true,
            channels: [
              { kind: "discord", enabled: false, config: {} },
              {
                kind: "slack",
                enabled: true,
                config: {
                  botToken: "xoxb-stub",
                  mode: "http",
                  signingSecret: "stub-secret", // pragma: allowlist secret
                },
              },
            ],
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "CHANNEL_MODE_UNSUPPORTED",
      httpStatus: 409,
    });

    expect(writeTxn).not.toHaveBeenCalled();
    expect(activateSavedChannels).not.toHaveBeenCalled();
    expect(onChannelsSaved).not.toHaveBeenCalled();
  });
});

describe("createFridaySetupRoutes — providers.detect TS-runtime retirement", () => {
  // Enabled deps but WITHOUT the test-oracle flag = production/live wiring.
  function retiredRoutes() {
    const { deps } = makeDeps({ setupCompletedAt: null });
    return createFridaySetupRoutes({ ...deps, allowTestOnlyProviderDetectExecution: false } as FridaySetupRoutesDeps);
  }

  it("fail-closes providers.detect with 503 TS_RUNTIME_PROVIDERS_DETECT_RETIRED (before any provider fetch)", async () => {
    const route = findMutatingRoute(retiredRoutes(), "providers.detect");
    // Valid body + localhost (bootstrap boundary holds) -> reaches the guard, not a 400/boundary error.
    await expect(route.handler(makeCtx({ body: { kind: "ollama" }, ip: "127.0.0.1" }))).rejects.toMatchObject({
      code: "TS_RUNTIME_PROVIDERS_DETECT_RETIRED",
      httpStatus: 503,
    });
  });

  it("still 400s a malformed detect body BEFORE the retirement guard", async () => {
    const route = findMutatingRoute(retiredRoutes(), "providers.detect");
    // No apiKey/kind/baseUrl -> VALIDATION_ERROR 400 fires before the 503.
    await expect(route.handler(makeCtx({ body: {}, ip: "127.0.0.1" }))).rejects.toMatchObject({ httpStatus: 400 });
  });
});

describe("createFridaySetupRoutes — providers.detect DARK Rust cut-over (FRIDAY_ROUTE_PROVIDERS_VIA_RUST)", () => {
  // A scripted bridge stub standing in for the real Rust hub_providers_detect bin (no
  // spawn, no cargo, no CLI, no quota). It records the probe it was asked for.
  function makeDetectBridge() {
    const calls: Array<{ probe?: string }> = [];
    const detect = vi.fn(async (input?: { probe?: string }) => {
      calls.push({ probe: input?.probe });
      return {
        truthLabel: "rust_providers_detect" as const,
        proofOnly: true as const,
        detected: [{ provider: "codex", installed: true, authenticated: true, detail: "logged_in" }],
        readyProviders: ["codex"],
        anyAuthenticated: true,
        allAuthenticated: false,
      };
    });
    return { rustProvidersDetect: { detect }, calls, detect };
  }

  it("flag OFF (default) stays byte-identical: 503 TS_RUNTIME_PROVIDERS_DETECT_RETIRED even with the bridge wired", async () => {
    const { deps } = makeDeps({ setupCompletedAt: null });
    const bridge = makeDetectBridge();
    // Bridge present, flag absent (default OFF), legacy probe also retired.
    const routes = createFridaySetupRoutes({
      ...deps,
      allowTestOnlyProviderDetectExecution: false,
      rustProvidersDetect: bridge.rustProvidersDetect,
    } as unknown as FridaySetupRoutesDeps);
    const route = findMutatingRoute(routes, "providers.detect");

    await expect(route.handler(makeCtx({ body: { kind: "ollama" }, ip: "127.0.0.1" }))).rejects.toMatchObject({
      code: "TS_RUNTIME_PROVIDERS_DETECT_RETIRED",
      httpStatus: 503,
    });
    // Flag off ⇒ the bridge is NEVER consulted.
    expect(bridge.detect).not.toHaveBeenCalled();
  });

  it("flag ON bridges to the Rust providers-detect bin and returns its refs-only payload", async () => {
    const { deps } = makeDeps({ setupCompletedAt: null });
    const bridge = makeDetectBridge();
    const routes = createFridaySetupRoutes({
      ...deps,
      allowTestOnlyProviderDetectExecution: false,
      routeProvidersViaRust: true,
      rustProvidersDetect: bridge.rustProvidersDetect,
    } as unknown as FridaySetupRoutesDeps);
    const route = findMutatingRoute(routes, "providers.detect");

    const result = await route.handler(makeCtx({ body: {}, ip: "127.0.0.1" }));

    expect(result).toMatchObject({
      truthLabel: "rust_providers_detect",
      proofOnly: true,
      readyProviders: ["codex"],
    });
    // Default probe selection is `both` when the body omits it.
    expect(bridge.calls).toEqual([{ probe: "both" }]);
  });

  it("flag ON forwards an explicit probe selection", async () => {
    const { deps } = makeDeps({ setupCompletedAt: null });
    const bridge = makeDetectBridge();
    const routes = createFridaySetupRoutes({
      ...deps,
      routeProvidersViaRust: true,
      rustProvidersDetect: bridge.rustProvidersDetect,
    } as unknown as FridaySetupRoutesDeps);
    const route = findMutatingRoute(routes, "providers.detect");

    await route.handler(makeCtx({ body: { probe: "claude" }, ip: "127.0.0.1" }));

    expect(bridge.calls).toEqual([{ probe: "claude" }]);
  });

  it("flag ON still enforces the bootstrap boundary FIRST (non-localhost 403, bridge untouched)", async () => {
    const { deps } = makeDeps({ setupCompletedAt: null });
    const bridge = makeDetectBridge();
    const routes = createFridaySetupRoutes({
      ...deps,
      routeProvidersViaRust: true,
      rustProvidersDetect: bridge.rustProvidersDetect,
    } as unknown as FridaySetupRoutesDeps);
    const route = findMutatingRoute(routes, "providers.detect");

    await expect(route.handler(makeCtx({ body: {}, ip: "10.0.0.5" }))).rejects.toMatchObject({
      code: "SETUP_BOOTSTRAP_NOT_ALLOWED_NON_LOCALHOST",
      httpStatus: 403,
    });
    expect(bridge.detect).not.toHaveBeenCalled();
  });

  it("flag ON but bridge missing fails closed (503), never silently passing", async () => {
    const { deps } = makeDeps({ setupCompletedAt: null });
    const routes = createFridaySetupRoutes({
      ...deps,
      routeProvidersViaRust: true,
      // no rustProvidersDetect wired
    } as unknown as FridaySetupRoutesDeps);
    const route = findMutatingRoute(routes, "providers.detect");

    await expect(route.handler(makeCtx({ body: {}, ip: "127.0.0.1" }))).rejects.toMatchObject({
      code: "TS_RUNTIME_PROVIDERS_DETECT_RETIRED",
      httpStatus: 503,
    });
  });
});
