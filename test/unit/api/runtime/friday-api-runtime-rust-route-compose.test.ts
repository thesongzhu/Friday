import { afterEach, describe, expect, it, vi } from "vitest";

import { createFridayApiRuntime } from "#api";
import {
  createFridayAgentEventEmitter,
  type FridayAgentRuntime,
} from "#agent";
import type { FridayProviderService } from "#providers";
import type { FridaySqliteLayer } from "#state";
import { createFridayRustHubRunContinuityProjectorService } from "../../../../src/api/mission-spine/friday-rust-hub-run-continuity-projector-service.js";
import type {
  FridayRustHubAgentRunSealedClientService,
  FridayRustHubAgentRunSealedClientServiceRequest,
} from "../../../../src/api/mission-spine/friday-rust-hub-agent-run-sealed-client-service.js";
import type {
  FridayRustHubRunAnswerReadbackInput,
  FridayRustHubRunAnswerReadbackReceipt,
  FridayRustHubRunAnswerReadbackService,
} from "../../../../src/api/mission-spine/friday-rust-hub-run-answer-readback-service.js";
import { createTestDb } from "../../../helpers/friday-test-db.helper.js";

// execrun-replacement S-F-compose (DARK): the composition wires the dark substrate
// (WS client S-D → owner-gated readback slice-3 → continuity projector slice-2) into the
// ONE startRun route, behind the DEFAULT-OFF `routeAgentRunViaRust` flag. MOCK-PROVEN: a
// scripted-stub WS client + a `delivered` readback + the REAL projector against a test db.
// No real Rust bin, no provider, no spend, no network egress.

const NOW = "2026-06-08T09:00:00.000Z";

// The owner-gated answer body the slice-3 readback releases to the matching owner.
const OWNER_BODY = "README.md lists: src/, test/, package.json.";
const ANSWER_SHA256 = "a".repeat(64); // pragma: allowlist secret
const RUN_ID = "fixed-run-id";

function makeIdGenerator(runId: string): () => string {
  return () => runId;
}

/**
 * A generator that returns each id in `ids` in turn, then throws once exhausted. Used to
 * PROVE the cross-request idempotency replay path NEVER mints the second runId — if the
 * compose-path replay regressed and minted a fresh runId for request #2, this generator
 * would hand out R2 (and the test's row/WS assertions would catch the double-run).
 */
function makeSequenceIdGenerator(...ids: string[]): () => string {
  let i = 0;
  return () => {
    if (i >= ids.length) {
      throw new Error("idGenerator exhausted — a second runId was minted unexpectedly");
    }
    return ids[i++];
  };
}

const RUN_ID_2 = "fixed-run-id-2";

function makeProviderService(
  overrides: { getProvider?: (providerId: string) => Promise<unknown> } = {},
): FridayProviderService {
  return {
    listProviders: vi.fn(async () => []),
    getProvider: overrides.getProvider ?? vi.fn(async () => null),
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
      throw new Error("executeRun must not be reached on the Rust-route compose path");
    }),
    registerTool: vi.fn(),
    resumeStaleRunsOnBoot: vi.fn(() => 0),
  } as unknown as FridayAgentRuntime;
}

/** A scripted-stub sealed WS client that records every dispatch (refs-only result). */
function makeStubWsClient() {
  const calls: FridayRustHubAgentRunSealedClientServiceRequest[] = [];
  const service: FridayRustHubAgentRunSealedClientService = {
    dispatchRun: vi.fn(async (request: FridayRustHubAgentRunSealedClientServiceRequest) => {
      calls.push(request);
      return {
        truthLabel: "rust_wired" as const,
        runId: request.runId,
        status: "finished",
        answerSha256: ANSWER_SHA256,
        answerLen: OWNER_BODY.length,
      };
    }),
  };
  return { service, calls };
}

/** A stub readback that returns the owner-gated body to the matching owner principal. */
function makeStubReadback(owner: string) {
  const calls: FridayRustHubRunAnswerReadbackInput[] = [];
  const service: FridayRustHubRunAnswerReadbackService = {
    readAnswer: vi.fn(
      async (input: FridayRustHubRunAnswerReadbackInput): Promise<FridayRustHubRunAnswerReadbackReceipt> => {
        calls.push(input);
        if (input.callerPrincipal === owner) {
          return {
            truthLabel: "rust_wired_dev",
            proofOnly: true,
            outcome: "delivered",
            runId: input.runId,
            status: "finished",
            answer: OWNER_BODY,
            answerSha256: ANSWER_SHA256,
            answerLen: OWNER_BODY.length,
          };
        }
        return {
          truthLabel: "rust_wired_dev",
          proofOnly: true,
          outcome: "denied",
          runId: input.runId,
          denyReason: "principal_mismatch",
        };
      },
    ),
  };
  return { service, calls };
}

interface ComposeDeps {
  routeAgentRunViaRust?: boolean;
  wsClient?: FridayRustHubAgentRunSealedClientService;
  readback?: FridayRustHubRunAnswerReadbackService;
  clientSecretResolver?: () => Uint8Array | null;
  hubDbPath?: string;
  idGenerator?: () => string;
  providerService?: FridayProviderService;
}

function makeRuntime(db: FridaySqliteLayer, opts: ComposeDeps) {
  return createFridayApiRuntime({
    db,
    idGenerator: opts.idGenerator ?? makeIdGenerator(RUN_ID),
    nowIso: () => NOW,
    providerService: opts.providerService ?? makeProviderService(),
    agentRuntime: makeAgentRuntime(),
    agentEventEmitter: createFridayAgentEventEmitter(),
    tokenSecret: "test-secret-key-that-is-at-least-32-chars-long!!", // pragma: allowlist secret
    computeChecksum: (content: string) => `checksum-${content.length}`,
    resolveSkill: () => null,
    invokeSkill: async () => ({}),
    // allowTestOnlyAgentRunStartExecution intentionally UNSET → production fail-closed 503
    // on the disqualified / flag-off path (matches production + slice-4).
    ...(opts.routeAgentRunViaRust === undefined ? {} : { routeAgentRunViaRust: opts.routeAgentRunViaRust }),
    ...(opts.wsClient ? { rustAgentRunWsClient: opts.wsClient } : {}),
    ...(opts.readback ? { rustAgentRunAnswerReadback: opts.readback } : {}),
    // The REAL projector is used so the no-double-count contract is exercised against a db.
    rustAgentRunContinuityProjector: createFridayRustHubRunContinuityProjectorService(),
    // SecureStore X25519-secret resolver: fixture 32-byte secret by default (a valid X25519
    // scalar); tests override to prove fail-closed.
    rustAgentRunWsClientSecretResolver:
      opts.clientSecretResolver ?? (() => new Uint8Array(32).fill(7)),
    rustAgentRunHubDbPath: opts.hubDbPath ?? "/tmp/friday-test-hub.db",
  });
}

// A request body that fully SATISFIES the predicate (read-only DeepSeek-flash + the
// explicit 4-tool grant + no session + no plan-review).
const QUALIFYING_BODY = {
  task: "List the files in the workspace and read README.md.",
  providerId: "deepseek",
  model: "deepseek-v4-flash",
  constraints: { readOnly: true },
  allowedRustRouteTools: ["read_file", "list_dir", "stat_file", "search"],
};

// Same content clauses but NO read-tool grant → disqualified (clause-4 fails).
const DISQUALIFYING_BODY = {
  task: "List the files in the workspace and read README.md.",
  providerId: "deepseek",
  model: "deepseek-v4-flash",
  constraints: { readOnly: true },
};

const OWNER_PRINCIPAL = "rust-route-compose-owner";

async function callStartRoute(
  runtime: ReturnType<typeof createFridayApiRuntime>,
  body: Record<string, unknown>,
  opts: { headers?: Record<string, string>; principalId?: string } = {},
) {
  const startRoute = runtime.routes
    .getRoutes()
    .find((route) => route.operationId === "agent.runs.start");
  expect(startRoute).toBeDefined();
  return startRoute!.handler({
    body,
    principal: makeBoundPrincipal(opts.principalId ?? OWNER_PRINCIPAL),
    ...(opts.headers ? { headers: opts.headers } : {}),
    receivedAt: NOW,
  } as never);
}

function countRows(db: FridaySqliteLayer, table: string, runId: string): number {
  if (table === "friday_agent_runs") {
    return db.withReadConnection((d) =>
      (d.prepare("SELECT COUNT(*) AS c FROM friday_agent_runs WHERE id = ?").get(runId) as { c: number }).c,
    );
  }
  // llm_usage_records keyed on the deterministic per-run id.
  return db.withReadConnection((d) =>
    (d
      .prepare("SELECT COUNT(*) AS c FROM llm_usage_records WHERE id = ?")
      .get(`rust-continuity-usage:${runId}`) as { c: number }).c,
  );
}

describe("FridayApiRuntime — execrun S-F-compose (DARK) Rust-route composition", () => {
  let db: FridaySqliteLayer;

  afterEach(() => {
    db?.close();
  });

  it("(a) flag ON + qualifying run → WS→readback→projector path; ONE continuity row; body to owner", async () => {
    db = createTestDb();
    const ws = makeStubWsClient();
    const readback = makeStubReadback(OWNER_PRINCIPAL);
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      wsClient: ws.service,
      readback: readback.service,
    });

    const result = (await callStartRoute(runtime, { ...QUALIFYING_BODY })) as {
      runId: string;
      response: string;
      finalResponse?: string;
      status: string;
    };

    // The full path was invoked.
    expect(ws.calls).toHaveLength(1);
    expect(ws.calls[0].runId).toBe(RUN_ID);
    expect(ws.calls[0].forwardedPrincipal).toBe(OWNER_PRINCIPAL);
    // The sealed client receives the resolved 32-byte X25519 SECRET (NOT a pre-built authProof).
    expect(ws.calls[0].clientSecret.length).toBe(32);
    expect(readback.calls).toHaveLength(1);
    expect(readback.calls[0].callerPrincipal).toBe(OWNER_PRINCIPAL);

    // The owner-gated body was returned to the authenticated owner.
    expect(result.runId).toBe(RUN_ID);
    expect(result.response).toBe(OWNER_BODY);
    expect(result.finalResponse).toBe(OWNER_BODY);
    expect(result.status).toBe("completed");

    // Exactly ONE TS continuity agent_run + usage row.
    expect(countRows(db, "friday_agent_runs", RUN_ID)).toBe(1);
    expect(countRows(db, "llm_usage_records", RUN_ID)).toBe(1);
  });

  it("(b) flag OFF (default) → byte-identical 503; the WS path is NEVER touched", async () => {
    db = createTestDb();
    const ws = makeStubWsClient();
    const readback = makeStubReadback(OWNER_PRINCIPAL);
    const runtime = makeRuntime(db, {
      // routeAgentRunViaRust omitted → default false.
      wsClient: ws.service,
      readback: readback.service,
    });

    await expect(callStartRoute(runtime, { ...QUALIFYING_BODY })).rejects.toMatchObject({
      code: "TS_RUNTIME_AGENT_RUNS_RETIRED",
      httpStatus: 503,
    });
    expect(ws.calls).toHaveLength(0);
    expect(readback.calls).toHaveLength(0);
    expect(countRows(db, "friday_agent_runs", RUN_ID)).toBe(0);
  });

  it("(c) flag ON but DISQUALIFIED (no read-tool grant) → byte-identical 503; WS never touched", async () => {
    db = createTestDb();
    const ws = makeStubWsClient();
    const readback = makeStubReadback(OWNER_PRINCIPAL);
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      wsClient: ws.service,
      readback: readback.service,
    });

    await expect(callStartRoute(runtime, { ...DISQUALIFYING_BODY })).rejects.toMatchObject({
      code: "TS_RUNTIME_AGENT_RUNS_RETIRED",
      httpStatus: 503,
    });
    expect(ws.calls).toHaveLength(0);
    expect(readback.calls).toHaveLength(0);
  });

  it("(d) flag ON + qualifying but MISSING SecureStore key → fail closed (503); NO WS call", async () => {
    db = createTestDb();
    const ws = makeStubWsClient();
    const readback = makeStubReadback(OWNER_PRINCIPAL);
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      wsClient: ws.service,
      readback: readback.service,
      // SecureStore returns null → fail closed before any WS connection.
      clientSecretResolver: () => null,
    });

    await expect(callStartRoute(runtime, { ...QUALIFYING_BODY })).rejects.toMatchObject({
      code: "TS_RUNTIME_AGENT_RUNS_RETIRED",
      httpStatus: 503,
    });
    // The fail-closed branch fired BEFORE the WS client was ever dispatched.
    expect(ws.calls).toHaveLength(0);
    expect(readback.calls).toHaveLength(0);
    expect(countRows(db, "friday_agent_runs", RUN_ID)).toBe(0);
  });

  it("(e) re-running the same run_id is idempotent — no double-count (projector contract)", async () => {
    db = createTestDb();
    const ws = makeStubWsClient();
    const readback = makeStubReadback(OWNER_PRINCIPAL);
    // Both routes generate the SAME run id → re-projection of the same run.
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      wsClient: ws.service,
      readback: readback.service,
      idGenerator: makeIdGenerator(RUN_ID),
    });

    const first = (await callStartRoute(runtime, { ...QUALIFYING_BODY })) as { response: string };
    const second = (await callStartRoute(runtime, { ...QUALIFYING_BODY })) as { response: string };

    expect(first.response).toBe(OWNER_BODY);
    expect(second.response).toBe(OWNER_BODY);

    // The path ran twice, but the projector wrote exactly ONE row per surface (no double-count).
    expect(ws.calls).toHaveLength(2);
    expect(countRows(db, "friday_agent_runs", RUN_ID)).toBe(1);
    expect(countRows(db, "llm_usage_records", RUN_ID)).toBe(1);
  });

  // ── Fix 1 — apiRequestIdempotencyKey REPLAY in the compose path ──
  // Two requests sharing ONE Idempotency-Key, each minting a DISTINCT runId (the real
  // cross-request case test (e) masks by reusing one fixed id). The SECOND must REPLAY the
  // first's result (no second WS dispatch, no second runId, no second row), returning the
  // SAME owner body.
  it("(f) two requests sharing one Idempotency-Key → SECOND replays the first (no second run / no second row)", async () => {
    db = createTestDb();
    const ws = makeStubWsClient();
    const readback = makeStubReadback(OWNER_PRINCIPAL);
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      wsClient: ws.service,
      readback: readback.service,
      // Distinct ids: R1 for request #1; if the replay regressed and minted a second runId,
      // R2 would be handed out (and the row/WS assertions below would catch it).
      idGenerator: makeSequenceIdGenerator(RUN_ID, RUN_ID_2),
    });
    const headers = { "idempotency-key": "shared-key-abc" }; // pragma: allowlist secret

    const first = (await callStartRoute(runtime, { ...QUALIFYING_BODY }, { headers })) as {
      runId: string;
      response: string;
    };
    const second = (await callStartRoute(runtime, { ...QUALIFYING_BODY }, { headers })) as {
      runId: string;
      response: string;
      finalResponse?: string;
    };

    // Both return the owner body…
    expect(first.response).toBe(OWNER_BODY);
    expect(second.response).toBe(OWNER_BODY);
    expect(second.finalResponse).toBe(OWNER_BODY);
    // …but the SECOND replays the FIRST run id — it did NOT mint a fresh runId.
    expect(first.runId).toBe(RUN_ID);
    expect(second.runId).toBe(RUN_ID);

    // The WS path was dispatched exactly ONCE (the replay does NOT re-dispatch).
    expect(ws.calls).toHaveLength(1);
    // The first run was the only run projected; the second runId was NEVER created.
    expect(countRows(db, "friday_agent_runs", RUN_ID)).toBe(1);
    expect(countRows(db, "llm_usage_records", RUN_ID)).toBe(1);
    expect(countRows(db, "friday_agent_runs", RUN_ID_2)).toBe(0);
    expect(countRows(db, "llm_usage_records", RUN_ID_2)).toBe(0);
  });

  it("(g) same Idempotency-Key but DIFFERENT principal → no replay (scoped per principal)", async () => {
    db = createTestDb();
    const ws = makeStubWsClient();
    // Readback delivers to whichever principal is the caller (both are owners of their run).
    const readback: FridayRustHubRunAnswerReadbackService = {
      readAnswer: vi.fn(async (input: FridayRustHubRunAnswerReadbackInput): Promise<FridayRustHubRunAnswerReadbackReceipt> => ({
        truthLabel: "rust_wired_dev",
        proofOnly: true,
        outcome: "delivered",
        runId: input.runId,
        status: "finished",
        answer: OWNER_BODY,
        answerSha256: ANSWER_SHA256,
        answerLen: OWNER_BODY.length,
      })),
    };
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      wsClient: ws.service,
      readback,
      idGenerator: makeSequenceIdGenerator(RUN_ID, RUN_ID_2),
    });
    const headers = { "idempotency-key": "shared-key-xyz" }; // pragma: allowlist secret

    await callStartRoute(runtime, { ...QUALIFYING_BODY }, { headers, principalId: "principal-A" });
    const second = (await callStartRoute(runtime, { ...QUALIFYING_BODY }, {
      headers,
      principalId: "principal-B",
    })) as { runId: string };

    // The key is scoped to (principalId, idempotencyKey): principal-B finds no prior run,
    // so it routes a NEW run (second runId minted) — NOT a replay.
    expect(second.runId).toBe(RUN_ID_2);
    expect(ws.calls).toHaveLength(2);
    expect(countRows(db, "friday_agent_runs", RUN_ID)).toBe(1);
    expect(countRows(db, "friday_agent_runs", RUN_ID_2)).toBe(1);
  });

  it("(g2) same Idempotency-Key + SAME principal but DIFFERENT payload → idempotency CONFLICT (409)", async () => {
    db = createTestDb();
    const ws = makeStubWsClient();
    const readback = makeStubReadback(OWNER_PRINCIPAL);
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      wsClient: ws.service,
      readback: readback.service,
      idGenerator: makeSequenceIdGenerator(RUN_ID, RUN_ID_2),
    });
    const headers = { "idempotency-key": "shared-key-conflict" }; // pragma: allowlist secret

    // First request establishes the run under the key with payload-hash(A).
    await callStartRoute(runtime, { ...QUALIFYING_BODY }, { headers });
    // Second request reuses the key but a DIFFERENT task → different payload hash → the
    // mirrored conflict check fires (same precedence the bare startRun enforces).
    await expect(
      callStartRoute(runtime, { ...QUALIFYING_BODY, task: "A DIFFERENT read-only task." }, { headers }),
    ).rejects.toMatchObject({ httpStatus: 409 });
    // The conflict fired BEFORE any second WS dispatch / second run.
    expect(ws.calls).toHaveLength(1);
    expect(countRows(db, "friday_agent_runs", RUN_ID_2)).toBe(0);
  });

  // ── Fix 2 — body.planReviewOverride now reaches the predicate's clause-5 disqualifier ──
  // A run that otherwise FULLY qualifies but carries a plan-review override marker must be
  // DISQUALIFIED via HTTP → today's unchanged 503 (the slice-4 clause-5 now fires).
  it("(h) qualifying body + planReviewOverride → DISQUALIFIED → byte-identical 503; WS never touched", async () => {
    db = createTestDb();
    const ws = makeStubWsClient();
    const readback = makeStubReadback(OWNER_PRINCIPAL);
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      wsClient: ws.service,
      readback: readback.service,
    });

    await expect(
      callStartRoute(runtime, {
        ...QUALIFYING_BODY,
        planReviewOverride: { decision: "force-review" },
      }),
    ).rejects.toMatchObject({
      code: "TS_RUNTIME_AGENT_RUNS_RETIRED",
      httpStatus: 503,
    });
    // The plan-review override disqualified the run BEFORE any Rust route was touched.
    expect(ws.calls).toHaveLength(0);
    expect(readback.calls).toHaveLength(0);
    expect(countRows(db, "friday_agent_runs", RUN_ID)).toBe(0);
  });

  it("(i) planReviewOverride is presence-only — even a falsy value disqualifies", async () => {
    db = createTestDb();
    const ws = makeStubWsClient();
    const readback = makeStubReadback(OWNER_PRINCIPAL);
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      wsClient: ws.service,
      readback: readback.service,
    });

    // A FALSY value is still PRESENT → clause-5 disqualifies (presence-only contract).
    await expect(
      callStartRoute(runtime, { ...QUALIFYING_BODY, planReviewOverride: null }),
    ).rejects.toMatchObject({
      code: "TS_RUNTIME_AGENT_RUNS_RETIRED",
      httpStatus: 503,
    });
    expect(ws.calls).toHaveLength(0);
  });

  // ── execrun prod-provider-shape fix — qualification by RESOLVED provider kind ──
  // Production provider rows carry UUID ids (kind="deepseek", id="fa15f1fe-…"); only
  // test/RGG envs seed the literal id "deepseek". Before this fix the predicate's literal
  // clause + resolveRoute's id-only match were mutually unsatisfiable on prod data: the
  // literal id 404'd at validation, the UUID id failed the literal clause → 503 always.
  const PROD_UUID_PROVIDER_ID = "fa15f1fe-7e64-4d2c-9a1b-3c5d7e9f0a2b";

  /** A prod-shaped provider PROFILE row: UUID id, kind="deepseek". */
  function makeProdProviderRecord(overrides: { kind?: string; enabled?: boolean } = {}) {
    return {
      id: PROD_UUID_PROVIDER_ID,
      kind: (overrides.kind ?? "deepseek") as never,
      name: "DeepSeek (prod-shaped row)",
      baseUrl: "https://api.deepseek.com",
      enabled: overrides.enabled ?? true,
      config: {
        api: "openai-completions" as const,
        authMode: "api-key" as const,
        keySource: { kind: "env-ref" as const, envVar: "DEEPSEEK_API_KEY" },
        supportedModels: ["deepseek-v4-flash"],
        validation: { status: "ok" as const, checkedAt: NOW },
      },
      createdAt: NOW,
      updatedAt: NOW,
    };
  }

  function readProjectedProviderId(database: FridaySqliteLayer, runId: string): string | undefined {
    return database.withReadConnection((d) =>
      (d.prepare("SELECT provider_id AS p FROM friday_agent_runs WHERE id = ?").get(runId) as
        | { p: string }
        | undefined)?.p,
    );
  }

  it("(j) prod UUID-id deepseek provider row → QUALIFIES and routes via Rust (the prod-shape fix)", async () => {
    db = createTestDb();
    const ws = makeStubWsClient();
    const readback = makeStubReadback(OWNER_PRINCIPAL);
    const getProvider = vi.fn(async (providerId: string) =>
      providerId === PROD_UUID_PROVIDER_ID ? makeProdProviderRecord() : null,
    );
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      wsClient: ws.service,
      readback: readback.service,
      providerService: makeProviderService({ getProvider }),
    });

    const result = (await callStartRoute(runtime, {
      ...QUALIFYING_BODY,
      providerId: PROD_UUID_PROVIDER_ID,
    })) as { runId: string; response: string; finalResponse?: string };

    // The cheap read-by-id resolved the record, the run qualified, and the full Rust
    // path was invoked.
    expect(getProvider).toHaveBeenCalledWith(PROD_UUID_PROVIDER_ID);
    expect(ws.calls).toHaveLength(1);
    expect(result.runId).toBe(RUN_ID);
    expect(result.response).toBe(OWNER_BODY);
    expect(result.finalResponse).toBe(OWNER_BODY);
    // Truth-labeling: the projected continuity row carries the REAL provider row id (the
    // UUID the request used), not the literal — providerId downstream is labeling only.
    expect(readProjectedProviderId(db, RUN_ID)).toBe(PROD_UUID_PROVIDER_ID);
  });

  it("(k) literal providerId \"deepseek\" still qualifies WITHOUT any record read (no regression, zero extra reads)", async () => {
    db = createTestDb();
    const ws = makeStubWsClient();
    const readback = makeStubReadback(OWNER_PRINCIPAL);
    const getProvider = vi.fn(async () => null);
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      wsClient: ws.service,
      readback: readback.service,
      providerService: makeProviderService({ getProvider }),
    });

    const result = (await callStartRoute(runtime, { ...QUALIFYING_BODY })) as { response: string };

    expect(result.response).toBe(OWNER_BODY);
    expect(ws.calls).toHaveLength(1);
    // The literal shape short-circuits BEFORE the record read → byte-identical for the
    // existing test/RGG envs.
    expect(getProvider).not.toHaveBeenCalled();
  });

  it("(l) UUID provider row of a NON-deepseek kind → DISQUALIFIED → byte-identical 503; WS never touched", async () => {
    db = createTestDb();
    const ws = makeStubWsClient();
    const readback = makeStubReadback(OWNER_PRINCIPAL);
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      wsClient: ws.service,
      readback: readback.service,
      providerService: makeProviderService({
        getProvider: vi.fn(async () => makeProdProviderRecord({ kind: "anthropic" })),
      }),
    });

    await expect(
      callStartRoute(runtime, { ...QUALIFYING_BODY, providerId: PROD_UUID_PROVIDER_ID }),
    ).rejects.toMatchObject({ code: "TS_RUNTIME_AGENT_RUNS_RETIRED", httpStatus: 503 });
    expect(ws.calls).toHaveLength(0);
    expect(readback.calls).toHaveLength(0);
  });

  it("(m) DISABLED deepseek-kind provider row → DISQUALIFIED → byte-identical 503; WS never touched", async () => {
    db = createTestDb();
    const ws = makeStubWsClient();
    const readback = makeStubReadback(OWNER_PRINCIPAL);
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      wsClient: ws.service,
      readback: readback.service,
      providerService: makeProviderService({
        getProvider: vi.fn(async () => makeProdProviderRecord({ enabled: false })),
      }),
    });

    await expect(
      callStartRoute(runtime, { ...QUALIFYING_BODY, providerId: PROD_UUID_PROVIDER_ID }),
    ).rejects.toMatchObject({ code: "TS_RUNTIME_AGENT_RUNS_RETIRED", httpStatus: 503 });
    expect(ws.calls).toHaveLength(0);
    expect(readback.calls).toHaveLength(0);
  });

  it("(n) UNRESOLVABLE providerId (no record) → DISQUALIFIED → byte-identical 503, no new error class", async () => {
    db = createTestDb();
    const ws = makeStubWsClient();
    const readback = makeStubReadback(OWNER_PRINCIPAL);
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      wsClient: ws.service,
      readback: readback.service,
      providerService: makeProviderService({ getProvider: vi.fn(async () => null) }),
    });

    await expect(
      callStartRoute(runtime, { ...QUALIFYING_BODY, providerId: PROD_UUID_PROVIDER_ID }),
    ).rejects.toMatchObject({ code: "TS_RUNTIME_AGENT_RUNS_RETIRED", httpStatus: 503 });
    expect(ws.calls).toHaveLength(0);
  });

  it("(o) getProvider THROWS → resolution fails closed → byte-identical 503 (never a new error)", async () => {
    db = createTestDb();
    const ws = makeStubWsClient();
    const readback = makeStubReadback(OWNER_PRINCIPAL);
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      wsClient: ws.service,
      readback: readback.service,
      providerService: makeProviderService({
        getProvider: vi.fn(async () => {
          throw new Error("provider repo unavailable");
        }),
      }),
    });

    await expect(
      callStartRoute(runtime, { ...QUALIFYING_BODY, providerId: PROD_UUID_PROVIDER_ID }),
    ).rejects.toMatchObject({ code: "TS_RUNTIME_AGENT_RUNS_RETIRED", httpStatus: 503 });
    expect(ws.calls).toHaveLength(0);
    expect(readback.calls).toHaveLength(0);
  });

  it("(p) VALID resolved deepseek record + one EXTRA tool in the grant → DISQUALIFIED → byte-identical 503; WS never touched (clause-bypass guard)", async () => {
    // Review-MED regression guard: a valid resolved record must not short-circuit the
    // LATER predicate clauses at the compose level — the allowlist-exactness clause still
    // disqualifies even though the provider record fully qualifies.
    db = createTestDb();
    const ws = makeStubWsClient();
    const readback = makeStubReadback(OWNER_PRINCIPAL);
    const getProvider = vi.fn(async (providerId: string) =>
      providerId === PROD_UUID_PROVIDER_ID ? makeProdProviderRecord() : null,
    );
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      wsClient: ws.service,
      readback: readback.service,
      providerService: makeProviderService({ getProvider }),
    });

    await expect(
      callStartRoute(runtime, {
        ...QUALIFYING_BODY,
        providerId: PROD_UUID_PROVIDER_ID,
        allowedRustRouteTools: [...QUALIFYING_BODY.allowedRustRouteTools, "run_command"],
      }),
    ).rejects.toMatchObject({ code: "TS_RUNTIME_AGENT_RUNS_RETIRED", httpStatus: 503 });
    expect(ws.calls).toHaveLength(0);
    expect(readback.calls).toHaveLength(0);
    expect(countRows(db, "friday_agent_runs", RUN_ID)).toBe(0);
  });
});
