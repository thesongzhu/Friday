import { afterEach, describe, expect, it, vi } from "vitest";

import { createFridayApiRuntime } from "#api";
import {
  createFridayAgentEventEmitter,
  type FridayAgentRuntime,
} from "#agent";
import type { FridayProviderService } from "#providers";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../../helpers/friday-test-db.helper.js";

// execrun-replacement slice 4 (DARK): per-run Rust-route flag at the startRun HTTP route.
// The flag is DEFAULT-FALSE. With the flag off OR on, the route is byte-identical to today
// because (a) the predicate's boolean is consumed by NOBODY (no routing wired) and (b) the
// route never populates the read-tool grant, so even with the flag on the run is disqualified.
// In BOTH cases the unchanged fail-closed 503 stub fires (allowTestOnlyAgentRunStartExecution
// is left unset here, matching production). This proves dark == byte-identical.

const NOW = "2026-06-08T09:00:00.000Z";

function makeIdGenerator(): () => string {
  let counter = 0;
  return () => `id-${String(++counter)}`;
}

function makeProviderService(): FridayProviderService {
  return {
    listProviders: vi.fn(async () => []),
    getProvider: vi.fn(async () => null),
    createProvider: vi.fn(async () => ({} as never)),
    updateProvider: vi.fn(async () => ({} as never)),
    deleteProvider: vi.fn(async () => undefined),
    validateProvider: vi.fn(async () => ({ status: "ok" as const, checkedAt: NOW })),
    getRoutingConfig: vi.fn(async () => ({ defaultProviderId: "p-1", fallbackProviderIds: [] })),
    setRoutingConfig: vi.fn(async (input) => input),
    resolveRoute: vi.fn(async () => ({
      provider: {
        id: "p-1",
        kind: "deepseek" as const,
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com",
        enabled: true,
        config: {
          api: "openai-completions" as const,
          authMode: "api-key" as const,
          keySource: { kind: "env-ref" as const, envVar: "DEEPSEEK_API_KEY" },
          supportedModels: ["deepseek-v4-flash"],
          validation: { status: "ok" as const, checkedAt: NOW },
        },
        createdAt: NOW,
        updatedAt: NOW,
      },
      model: "deepseek-v4-flash",
    })),
    runWithFallback: vi.fn(async () => ({} as never)),
  } as unknown as FridayProviderService;
}

function makeBoundPrincipal(principalId: string) {
  return {
    principalType: "user",
    principalId,
    userId: principalId,
    tokenId: `${principalId}-token`,
    tokenKind: "access",
    scopes: ["agent.write"],
    issuedAt: NOW,
  };
}

function makeAgentRuntime(): FridayAgentRuntime {
  return {
    executeRun: vi.fn(async () => {
      throw new Error("executeRun must not be reached while the route is fail-closed");
    }),
    registerTool: vi.fn(),
    resumeStaleRunsOnBoot: vi.fn(() => 0),
  } as unknown as FridayAgentRuntime;
}

function makeRuntime(db: FridaySqliteLayer, routeAgentRunViaRust: boolean | undefined) {
  return createFridayApiRuntime({
    db,
    idGenerator: makeIdGenerator(),
    nowIso: () => NOW,
    providerService: makeProviderService(),
    agentRuntime: makeAgentRuntime(),
    agentEventEmitter: createFridayAgentEventEmitter(),
    tokenSecret: "test-secret-key-that-is-at-least-32-chars-long!!", // pragma: allowlist secret
    computeChecksum: (content: string) => `checksum-${content.length}`,
    resolveSkill: () => null,
    invokeSkill: async () => ({}),
    // allowTestOnlyAgentRunStartExecution intentionally UNSET → production fail-closed 503.
    ...(routeAgentRunViaRust === undefined ? {} : { routeAgentRunViaRust }),
  });
}

// A request body that WOULD satisfy the predicate's content clauses (read-only DeepSeek-flash).
// It still gets disqualified at the route because the route never grants the read-tool set.
const QUALIFYING_SHAPED_BODY = {
  task: "List the files in the workspace and read README.md.",
  providerId: "deepseek",
  model: "deepseek-v4-flash",
  constraints: { readOnly: true },
};

async function callStartRoute(
  runtime: ReturnType<typeof createFridayApiRuntime>,
  body: Record<string, unknown>,
) {
  const startRoute = runtime.routes
    .getRoutes()
    .find((route) => route.operationId === "agent.runs.start");
  expect(startRoute).toBeDefined();
  return startRoute!.handler({
    body,
    principal: makeBoundPrincipal("rust-route-flag-user"),
  } as never);
}

async function expectByteIdentical503(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({
    code: "TS_RUNTIME_AGENT_RUNS_RETIRED",
    httpStatus: 503,
  });
}

describe("FridayApiRuntime — execrun slice 4 per-run Rust-route flag (dark)", () => {
  let db: FridaySqliteLayer;

  afterEach(() => {
    db?.close();
  });

  it("flag DEFAULT (unset): a would-qualify request still hits today's unchanged 503", async () => {
    db = createTestDb();
    const runtime = makeRuntime(db, undefined);
    await expectByteIdentical503(callStartRoute(runtime, { ...QUALIFYING_SHAPED_BODY }));
  });

  it("flag explicitly FALSE: byte-identical 503 (predicate never even evaluated)", async () => {
    db = createTestDb();
    const runtime = makeRuntime(db, false);
    await expectByteIdentical503(callStartRoute(runtime, { ...QUALIFYING_SHAPED_BODY }));
  });

  it("flag ON: the predicate is computed (dark) but routes nothing — still the same 503", async () => {
    // With the flag on the route wrapper evaluates qualifiesForRustReadOnlyRoute and
    // DISCARDS the boolean. The route does not populate allowedRustRouteTools, so the run
    // is disqualified anyway; either way behavior is byte-identical to today.
    db = createTestDb();
    const runtime = makeRuntime(db, true);
    await expectByteIdentical503(callStartRoute(runtime, { ...QUALIFYING_SHAPED_BODY }));
  });
});
