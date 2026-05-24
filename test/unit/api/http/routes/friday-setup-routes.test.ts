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
});
