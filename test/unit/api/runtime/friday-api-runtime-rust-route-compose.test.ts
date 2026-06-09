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
  FridayRustHubAgentRunWsClientService,
  FridayRustHubAgentRunWsRequest,
} from "../../../../src/api/mission-spine/friday-rust-hub-agent-run-ws-client.js";
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
      throw new Error("executeRun must not be reached on the Rust-route compose path");
    }),
    registerTool: vi.fn(),
    resumeStaleRunsOnBoot: vi.fn(() => 0),
  } as unknown as FridayAgentRuntime;
}

/** A scripted-stub WS client that records every dispatch (refs-only result). */
function makeStubWsClient() {
  const calls: FridayRustHubAgentRunWsRequest[] = [];
  const service: FridayRustHubAgentRunWsClientService = {
    dispatchRun: vi.fn(async (request: FridayRustHubAgentRunWsRequest) => {
      calls.push(request);
      return {
        truthLabel: "rust_wired" as const,
        runId: request.runId,
        status: "completed",
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
            status: "completed",
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
  wsClient?: FridayRustHubAgentRunWsClientService;
  readback?: FridayRustHubRunAnswerReadbackService;
  sessionKeyResolver?: () => Uint8Array | null;
  hubDbPath?: string;
  idGenerator?: () => string;
}

function makeRuntime(db: FridaySqliteLayer, opts: ComposeDeps) {
  return createFridayApiRuntime({
    db,
    idGenerator: opts.idGenerator ?? makeIdGenerator(RUN_ID),
    nowIso: () => NOW,
    providerService: makeProviderService(),
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
    // SecureStore resolver: fixture key by default; tests override to prove fail-closed.
    rustAgentRunWsSessionKeyResolver:
      opts.sessionKeyResolver ?? (() => new Uint8Array(32).fill(7)),
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
) {
  const startRoute = runtime.routes
    .getRoutes()
    .find((route) => route.operationId === "agent.runs.start");
  expect(startRoute).toBeDefined();
  return startRoute!.handler({
    body,
    principal: makeBoundPrincipal(OWNER_PRINCIPAL),
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
    expect(ws.calls[0].authProof.length).toBeGreaterThanOrEqual(32);
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
      sessionKeyResolver: () => null,
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
});
