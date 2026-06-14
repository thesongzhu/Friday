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
    // (A3 courier) The compose read-only path never resumes; this stub method is unused here.
    resumeWithApproval: vi.fn(async () => {
      throw new Error("resumeWithApproval not used by the read-only compose path");
    }),
  };
  return { service, calls };
}

/**
 * (A3 courier) A scripted-stub sealed WS client that settles every dispatch with a PAUSED outcome
 * (the Rust loop gate paused a mutating tool). Refs only — no signing material (INV-1).
 */
function makeStubPausedWsClient() {
  const calls: FridayRustHubAgentRunSealedClientServiceRequest[] = [];
  const service: FridayRustHubAgentRunSealedClientService = {
    dispatchRun: vi.fn(async (request: FridayRustHubAgentRunSealedClientServiceRequest) => {
      calls.push(request);
      return {
        outcome: "paused" as const,
        truthLabel: "rust_wired" as const,
        runId: request.runId,
        approvalId: "approval-nonce-xyz",
        actionDigest: "d".repeat(64),
        ownerSealedSummary: "write_file",
      };
    }),
    resumeWithApproval: vi.fn(async () => {
      throw new Error("resumeWithApproval not used by this paused-dispatch test");
    }),
  };
  return { service, calls };
}

/**
 * (honest-non-finished) A scripted-stub sealed WS client that settles every dispatch with a
 * caller-chosen loop `status` and NO answer refs (the refs-only result a NON-deliverable terminal
 * carries). Used to drive the readback-not_found compose branch with a specific wire status.
 */
function makeStubStatusWsClient(status: string) {
  const calls: FridayRustHubAgentRunSealedClientServiceRequest[] = [];
  const service: FridayRustHubAgentRunSealedClientService = {
    dispatchRun: vi.fn(async (request: FridayRustHubAgentRunSealedClientServiceRequest) => {
      calls.push(request);
      return {
        truthLabel: "rust_wired" as const,
        runId: request.runId,
        status,
        // A non-deliverable terminal carries NO answer refs (no sha / no len).
      };
    }),
    resumeWithApproval: vi.fn(async () => {
      throw new Error("resumeWithApproval not used by this status-dispatch test");
    }),
  };
  return { service, calls };
}

/**
 * (honest-non-finished) A stub readback that always returns the body-free `not_found` outcome —
 * the LEGITIMATE outcome for a run whose Rust loop terminated NON-Finished (it skipped the persist
 * guard, so no `run_result` row exists). Records each call so the path can be asserted.
 */
function makeNotFoundReadback() {
  const calls: FridayRustHubRunAnswerReadbackInput[] = [];
  const service: FridayRustHubRunAnswerReadbackService = {
    readAnswer: vi.fn(
      async (input: FridayRustHubRunAnswerReadbackInput): Promise<FridayRustHubRunAnswerReadbackReceipt> => {
        calls.push(input);
        return {
          truthLabel: "rust_wired_dev",
          proofOnly: true,
          outcome: "not_found",
          runId: input.runId,
        };
      },
    ),
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
  agentRunControlViaRust?: boolean;
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
    ...(opts.agentRunControlViaRust === undefined ? {} : { agentRunControlViaRust: opts.agentRunControlViaRust }),
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
    // (A1 run-controls) compose forwards the per-run read-only constraint on the dispatch — the
    // qualifier (clause 2) already REQUIRES readOnly:true, so the guarantee now travels on the
    // wire + is enforced in Rust (defense-in-depth), not only by this TS qualifier.
    expect(ws.calls[0].constraints).toEqual({ readOnly: true });
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

  it("(a-paused) (A3 courier) a PAUSED dispatch → HONEST non-Finished row (cancelled), refs-only, readback SKIPPED", async () => {
    db = createTestDb();
    const ws = makeStubPausedWsClient();
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
      toolCallCount: number;
    };

    // The dispatch ran; the paused branch was taken BEFORE the delivered-body readback (no readback
    // call — a paused run has no body, and routing it through the readback would fail-close).
    expect(ws.calls).toHaveLength(1);
    expect(readback.calls).toHaveLength(0);

    // The continuity row is projected HONESTLY: NOT "completed"/Finished — the projector maps the
    // "Paused" loop status to the terminal "cancelled" run status (a resumable, non-error stop).
    expect(result.status).toBe("cancelled");
    // No body exists for a paused run — the response is empty (the owner-sealed summary is kept OUT
    // of the plaintext response; INV-5 refs-only). A LATER PR's resume leg delivers the answer. The
    // route omits an empty `finalResponse` (`result.finalResponse ? {...} : {}`), so it is undefined.
    expect(result.response).toBe("");
    expect(result.finalResponse).toBeUndefined();
    expect(result.toolCallCount).toBe(0);

    // Exactly ONE TS continuity row was projected (idempotent on run_id), with the cancelled status.
    expect(countRows(db, "friday_agent_runs", RUN_ID)).toBe(1);
    const rowStatus = db.withReadConnection((d) =>
      (d.prepare("SELECT status FROM friday_agent_runs WHERE id = ?").get(RUN_ID) as { status: string }).status,
    );
    expect(rowStatus).toBe("cancelled");
    // The projected row stores a body REF over the pause refs (the action digest) — NEVER the body.
    const rowResponse = db.withReadConnection((d) =>
      (d.prepare("SELECT response_text FROM friday_agent_runs WHERE id = ?").get(RUN_ID) as
        | { response_text: string | null }
        | undefined)?.response_text ?? "",
    );
    expect(rowResponse).toContain("rust-run-body-ref:");
    expect(rowResponse).not.toBe(OWNER_BODY);

    // (S6 mutating-chat) The paused row now STAMPS the run's BOUND OWNER at
    // `metadata.apiRequest.principalId` — so the resume route's owner-binding gate has a real owner
    // to authorize against. Before the fix the paused branch returned BEFORE any owner stamp, so the
    // resume route would have rejected EVERY resume (including the legitimate owner). The owner is a
    // ref, never the body.
    const rowMetadata = db.withReadConnection((d) =>
      (d.prepare("SELECT metadata_json FROM friday_agent_runs WHERE id = ?").get(RUN_ID) as
        | { metadata_json: string | null }
        | undefined)?.metadata_json ?? "{}",
    );
    const parsedMetadata = JSON.parse(rowMetadata) as { apiRequest?: { principalId?: string } };
    expect(parsedMetadata.apiRequest?.principalId).toBe(OWNER_PRINCIPAL);
  });

  // ── (honest-non-finished) the readback_not_found 503 defect fix ──
  //
  // THE DEFECT: a run whose Rust loop terminated NON-Finished (Blocked/Errored/Bounded → the
  // no-answer terminal) DELIBERATELY skips the Rust-side persist guard, so NO `run_result` row is
  // written and the owner-gated body readback LEGITIMATELY returns `not_found`. Compose used to throw
  // the `readback_not_found` 503 for that case — MISREPORTING an honest terminal settle as a
  // transport failure (the hourly self-probe + S6 saw exactly this). THE FIX: a strict allowlist
  // (not_found AND a non-Finished terminal wire status) projects an HONEST "failed" continuity row
  // instead of the 503 — while EVERY other not-delivered case (denied, finished-but-missing-row, any
  // error status) keeps today's 503 EXACTLY (no gate-weakening).

  /** Read the projected continuity-row's stored loop-status label off `metadata_json`. */
  function readProjectedLoopStatus(database: FridaySqliteLayer, runId: string): string | undefined {
    const meta = database.withReadConnection((d) =>
      (d.prepare("SELECT metadata_json FROM friday_agent_runs WHERE id = ?").get(runId) as
        | { metadata_json: string | null }
        | undefined)?.metadata_json ?? "{}",
    );
    return (JSON.parse(meta) as { rustContinuity?: { loopStatus?: string } }).rustContinuity?.loopStatus;
  }

  it("(nf-a) non-Finished wire status (no_answer_safe_failure) + readback not_found → NO 503; honest failed row, NO body", async () => {
    db = createTestDb();
    // The PRODUCTION wire value: a NON-deliverable terminal collapses to AuthedAnswer::NoAnswer →
    // compose sees the `no_answer_safe_failure` status (the value the live server actually emits).
    const ws = makeStubStatusWsClient("no_answer_safe_failure");
    const readback = makeNotFoundReadback();
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
      toolCallCount: number;
    };

    // The dispatch ran AND the readback ran (not_found is a real read, not a skip).
    expect(ws.calls).toHaveLength(1);
    expect(readback.calls).toHaveLength(1);

    // NO 503: the honest non-Finished terminal is surfaced as the projector's "failed" status —
    // NEVER "completed", NEVER "cancelled" (cancelled is the resumable Paused mapping; this is not).
    expect(result.status).toBe("failed");
    // NO fabricated body — the response is empty and the route omits the empty finalResponse.
    expect(result.response).toBe("");
    expect(result.finalResponse).toBeUndefined();
    expect(result.toolCallCount).toBe(0);

    // Exactly ONE continuity row, mapped to the failed status with the Errored loop-status label.
    expect(countRows(db, "friday_agent_runs", RUN_ID)).toBe(1);
    const rowStatus = db.withReadConnection((d) =>
      (d.prepare("SELECT status FROM friday_agent_runs WHERE id = ?").get(RUN_ID) as { status: string }).status,
    );
    expect(rowStatus).toBe("failed");
    expect(readProjectedLoopStatus(db, RUN_ID)).toBe("Errored");

    // REFS-ONLY: the row stores an empty-body ref (len 0) — NEVER the owner body.
    const rowResponse = db.withReadConnection((d) =>
      (d.prepare("SELECT response_text FROM friday_agent_runs WHERE id = ?").get(RUN_ID) as
        | { response_text: string | null }
        | undefined)?.response_text ?? "",
    );
    expect(rowResponse).toContain("rust-run-body-ref:");
    expect(rowResponse).toContain("len=0");
    expect(rowResponse).not.toBe(OWNER_BODY);

    // The owner is stamped so the row is owner-scoped for the read routes (a ref, never a body).
    const rowMetadata = db.withReadConnection((d) =>
      (d.prepare("SELECT metadata_json FROM friday_agent_runs WHERE id = ?").get(RUN_ID) as
        | { metadata_json: string | null }
        | undefined)?.metadata_json ?? "{}",
    );
    expect((JSON.parse(rowMetadata) as { apiRequest?: { principalId?: string } }).apiRequest?.principalId).toBe(
      OWNER_PRINCIPAL,
    );
  });

  it("(nf-b) the task's case — wire status \"blocked\" + readback not_found → NO 503; honest failed row", async () => {
    db = createTestDb();
    // A raw loop-status token a server MIGHT surface directly (the allowlist admits it too).
    const ws = makeStubStatusWsClient("blocked");
    const readback = makeNotFoundReadback();
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      wsClient: ws.service,
      readback: readback.service,
    });

    const result = (await callStartRoute(runtime, { ...QUALIFYING_BODY })) as { status: string; response: string };

    expect(ws.calls).toHaveLength(1);
    expect(readback.calls).toHaveLength(1);
    expect(result.status).toBe("failed");
    expect(result.response).toBe("");
    expect(countRows(db, "friday_agent_runs", RUN_ID)).toBe(1);
    // A RAW loop-status token keeps its FAITHFUL capitalized label in metadata — but the
    // product-visible status is STILL "failed" (mapLoopStatusToTsStatus maps Blocked → failed).
    expect(readProjectedLoopStatus(db, RUN_ID)).toBe("Blocked");
  });

  it("(nf-c) Case A — wire status \"finished\" + readback not_found → STILL 503 (a finished run's missing row is a REAL failure; gate preserved)", async () => {
    db = createTestDb();
    // status "finished" ⇒ a body SHOULD exist; a missing row is a genuine readback failure → 503.
    const ws = makeStubStatusWsClient("finished");
    const readback = makeNotFoundReadback();
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      wsClient: ws.service,
      readback: readback.service,
    });

    await expect(callStartRoute(runtime, { ...QUALIFYING_BODY })).rejects.toMatchObject({
      code: "TS_RUNTIME_AGENT_RUNS_RETIRED",
      httpStatus: 503,
    });
    // The dispatch + readback both ran, and NO honest row was projected — the 503 is preserved.
    expect(ws.calls).toHaveLength(1);
    expect(readback.calls).toHaveLength(1);
    expect(countRows(db, "friday_agent_runs", RUN_ID)).toBe(0);
  });

  it("(nf-d) no-weakening guard — an ERROR wire status (storage_failed) + not_found → STILL 503 (not an honest terminal)", async () => {
    db = createTestDb();
    // An ERROR status is NOT in the non-Finished-terminal allowlist → it must fall through to the
    // unchanged 503. This is the strongest no-gate-weakening proof: a real storage failure (which
    // could otherwise leak through a naive binary as a "failed" row) still fails closed.
    const ws = makeStubStatusWsClient("storage_failed");
    const readback = makeNotFoundReadback();
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      wsClient: ws.service,
      readback: readback.service,
    });

    await expect(callStartRoute(runtime, { ...QUALIFYING_BODY })).rejects.toMatchObject({
      code: "TS_RUNTIME_AGENT_RUNS_RETIRED",
      httpStatus: 503,
    });
    expect(ws.calls).toHaveLength(1);
    expect(readback.calls).toHaveLength(1);
    expect(countRows(db, "friday_agent_runs", RUN_ID)).toBe(0);
  });

  it("(nf-e) no-weakening guard — a DENIED ownership refusal (even with a non-Finished status) → STILL 503", async () => {
    db = createTestDb();
    // `denied` is an OWNERSHIP-GATE refusal — it MUST stay 503 even if the loop status is a
    // non-Finished terminal. Only `not_found` (a genuinely missing row) is the honest-terminal signal.
    const ws = makeStubStatusWsClient("no_answer_safe_failure");
    const deniedReadback: FridayRustHubRunAnswerReadbackService = {
      readAnswer: vi.fn(
        async (input: FridayRustHubRunAnswerReadbackInput): Promise<FridayRustHubRunAnswerReadbackReceipt> => ({
          truthLabel: "rust_wired_dev",
          proofOnly: true,
          outcome: "denied",
          runId: input.runId,
          denyReason: "principal_mismatch",
        }),
      ),
    };
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      wsClient: ws.service,
      readback: deniedReadback,
    });

    await expect(callStartRoute(runtime, { ...QUALIFYING_BODY })).rejects.toMatchObject({
      code: "TS_RUNTIME_AGENT_RUNS_RETIRED",
      httpStatus: 503,
    });
    expect(ws.calls).toHaveLength(1);
    expect(countRows(db, "friday_agent_runs", RUN_ID)).toBe(0);
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

  // ─── (B4 organic mutating dispatch) the readOnly the courier FORWARDS on the wire ───
  //
  // THE DEFECT this fixes: a gated-mutating run the qualifier ADMITS used to dispatch the
  // HARDCODED `constraints: { readOnly: true }` — so the real Rust server blocked the write
  // tool BEFORE execution → no pause → awaiting_clarification → 503. The fix forwards the REAL
  // constraint the qualifier validated (`readOnly:false` for a gated-mutating run; unchanged
  // `readOnly:true` for a read-only run), so a genuinely-organic HTTP mutating chat reaches the
  // Rust gate and PAUSES. We capture the dispatched `constraints` off the stub to assert this
  // WITHOUT a real server, and prove the read-only path is unchanged + the qualifier unweakened.
  //
  // A gated-mutating body that QUALIFIES: agentRunControlViaRust on (set on the runtime),
  // readOnly:false, a grant ⊆ the closed mutating allow-list, the operator-signed gate marker,
  // a bound owner principal (the route's authenticated principal), deepseek-flash, the 4-read grant.
  const GATED_MUTATING_BODY = {
    ...QUALIFYING_BODY,
    constraints: { readOnly: false },
    mutatingToolGrant: ["write_file"],
    mutationGate: "operator_signed_ed25519",
  };

  it("(b4-a) gated-mutating qualifying run → compose dispatches constraints.readOnly:FALSE (the real verdict, not hardcoded true)", async () => {
    db = createTestDb();
    // The dispatch PAUSES (a mutating tool hit the gate) — the realistic organic outcome.
    const ws = makeStubPausedWsClient();
    const readback = makeStubReadback(OWNER_PRINCIPAL);
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      // The SAME default-off flag the qualifier's mutating verdict + the courier's pause both gate on.
      agentRunControlViaRust: true,
      wsClient: ws.service,
      readback: readback.service,
    });

    const result = (await callStartRoute(runtime, { ...GATED_MUTATING_BODY })) as { status: string };

    // The run was ADMITTED and the courier was dispatched (NOT 503'd at the qualifier).
    expect(ws.calls).toHaveLength(1);
    // THE FIX: the courier forwards readOnly:FALSE — the real constraint the qualifier validated.
    // Before the fix this was the hardcoded { readOnly: true }, which would block the write tool in
    // Rust before it could pause. (No disabled-tools / max-turns asserted on this route → absent.)
    expect(ws.calls[0].constraints).toEqual({ readOnly: false });
    // And the organic outcome is the operator-gated PAUSE (projected as the terminal "cancelled"),
    // never a 503 — which is the whole point of the B4 fix.
    expect(result.status).toBe("cancelled");
  });

  it("(b4-b) read-only qualifying run → compose STILL dispatches constraints.readOnly:TRUE (no degrade)", async () => {
    db = createTestDb();
    const ws = makeStubWsClient();
    const readback = makeStubReadback(OWNER_PRINCIPAL);
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      // Flag ON to prove the read-only path is byte-identical even when the mutating branch is live.
      agentRunControlViaRust: true,
      wsClient: ws.service,
      readback: readback.service,
    });

    const result = (await callStartRoute(runtime, { ...QUALIFYING_BODY })) as { response: string };

    expect(ws.calls).toHaveLength(1);
    // UNCHANGED: a read-only run forwards exactly { readOnly: true } — the read-only path does not
    // degrade now that the mutating branch can forward { readOnly: false }.
    expect(ws.calls[0].constraints).toEqual({ readOnly: true });
    expect(result.response).toBe(OWNER_BODY);
  });

  it("(b4-c) mutating run MISSING the gate marker → qualifier REJECTS → byte-identical 503; courier NEVER dispatched (no new hole)", async () => {
    db = createTestDb();
    const ws = makeStubPausedWsClient();
    const readback = makeStubReadback(OWNER_PRINCIPAL);
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      agentRunControlViaRust: true,
      wsClient: ws.service,
      readback: readback.service,
    });

    // readOnly:false + a valid grant + a bound principal, but NO operator-signed gate marker →
    // the qualifier's gated-mutating verdict is false → clause-2 disqualifies → 503. A mutating run
    // without the full gate can NEVER dispatch.
    const { mutationGate: _omitted, ...noGateBody } = GATED_MUTATING_BODY;
    await expect(callStartRoute(runtime, { ...noGateBody })).rejects.toMatchObject({
      code: "TS_RUNTIME_AGENT_RUNS_RETIRED",
      httpStatus: 503,
    });
    // The "no new hole" check: the courier was NEVER dispatched (the run never even reached compose).
    expect(ws.calls).toHaveLength(0);
    expect(readback.calls).toHaveLength(0);
    expect(countRows(db, "friday_agent_runs", RUN_ID)).toBe(0);
  });

  it("(b4-d) mutating run with the gate but NO grant → qualifier REJECTS → 503; courier NEVER dispatched", async () => {
    db = createTestDb();
    const ws = makeStubPausedWsClient();
    const readback = makeStubReadback(OWNER_PRINCIPAL);
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      agentRunControlViaRust: true,
      wsClient: ws.service,
      readback: readback.service,
    });

    // readOnly:false + the gate marker + a bound principal, but the mutatingToolGrant is OMITTED →
    // the gated-mutating verdict is false → 503. A mutating run with no positive grant fails closed.
    const { mutatingToolGrant: _omitted, ...noGrantBody } = GATED_MUTATING_BODY;
    await expect(callStartRoute(runtime, { ...noGrantBody })).rejects.toMatchObject({
      code: "TS_RUNTIME_AGENT_RUNS_RETIRED",
      httpStatus: 503,
    });
    expect(ws.calls).toHaveLength(0);
    expect(readback.calls).toHaveLength(0);
  });

  it("(b4-f) gated-mutating body but a BLANK owner principal → qualifier REJECTS → 503; courier NEVER dispatched", async () => {
    db = createTestDb();
    const ws = makeStubPausedWsClient();
    const readback = makeStubReadback(OWNER_PRINCIPAL);
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      agentRunControlViaRust: true,
      wsClient: ws.service,
      readback: readback.service,
    });

    // readOnly:false + the gate marker + a valid grant, but a BLANK/whitespace owner principal →
    // the `hasBoundOwnerPrincipal` conjunct fails → the gated-mutating verdict is false → 503. An
    // ownerless mutating run can never own a gated run (the body readback could not be owner-scoped).
    await expect(
      callStartRoute(runtime, { ...GATED_MUTATING_BODY }, { principalId: "   " }),
    ).rejects.toMatchObject({
      code: "TS_RUNTIME_AGENT_RUNS_RETIRED",
      httpStatus: 503,
    });
    expect(ws.calls).toHaveLength(0);
    expect(readback.calls).toHaveLength(0);
  });

  it("(b4-e) gated-mutating body but the run-control FLAG is OFF → qualifier REJECTS → 503; courier NEVER dispatched (byte-identical-when-off)", async () => {
    db = createTestDb();
    const ws = makeStubPausedWsClient();
    const readback = makeStubReadback(OWNER_PRINCIPAL);
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      // agentRunControlViaRust OMITTED → default off. The mutating verdict's FIRST conjunct is this
      // flag, so off ⇒ a readOnly:false run stays disqualified EXACTLY as today (no behavior change).
      wsClient: ws.service,
      readback: readback.service,
    });

    await expect(callStartRoute(runtime, { ...GATED_MUTATING_BODY })).rejects.toMatchObject({
      code: "TS_RUNTIME_AGENT_RUNS_RETIRED",
      httpStatus: 503,
    });
    expect(ws.calls).toHaveLength(0);
    expect(readback.calls).toHaveLength(0);
  });

  // ─── (S6 mutating-chat) routeResumeRun — the runtime resume relay's fail-closed branches ───
  //
  // These exercise the RUNTIME function the resume route delegates to (NOT a mocked deps.resumeRun):
  // the defense-in-depth flag check, the X25519-secret preflight, the WS-error fail-closed, and the
  // success mapping. We drive a paused MUTATING run to the DB first (so the owner is stamped + the
  // resume route's owner-binding passes), then call the resume route on that run.

  // A mutating body that pauses on the gate: readOnly:false + the operator-signed gate marker + a
  // grant ⊆ the closed mutating allow-list. The owner is OWNER_PRINCIPAL (stamped on the paused row).
  const MUTATING_PAUSING_BODY = {
    ...QUALIFYING_BODY,
    constraints: { readOnly: false },
    mutatingToolGrant: ["write_file"],
    mutationGate: "operator_signed_ed25519",
  };

  /** Make a stub WS client whose resume returns/throws a scripted control outcome. */
  function makeResumeWsClient(
    resume: (req: { runId: string; clientSecret: Uint8Array; opaqueSignedBlob: Uint8Array }) =>
      | Promise<{ truthLabel: "rust_wired"; runId: string; op: string; accepted: boolean; status: string; auditRef?: string }>,
  ) {
    const paused = makeStubPausedWsClient();
    const resumeCalls: Array<{ runId: string; opaqueSignedBlob: Uint8Array }> = [];
    const service: FridayRustHubAgentRunSealedClientService = {
      dispatchRun: paused.service.dispatchRun,
      resumeWithApproval: vi.fn(async (req: { runId: string; clientSecret: Uint8Array; opaqueSignedBlob: Uint8Array }) => {
        resumeCalls.push({ runId: req.runId, opaqueSignedBlob: req.opaqueSignedBlob });
        return resume(req);
      }),
    };
    return { service, resumeCalls };
  }

  async function pauseAMutatingRun(
    runtime: ReturnType<typeof createFridayApiRuntime>,
  ): Promise<void> {
    // Flag-on + mutating body ⇒ the paused dispatch ⇒ a continuity row stamped with OWNER_PRINCIPAL.
    await callStartRoute(runtime, { ...MUTATING_PAUSING_BODY });
  }

  function resumeRoute(runtime: ReturnType<typeof createFridayApiRuntime>) {
    const route = runtime.routes.getRoutes().find((r) => r.operationId === "agent.runs.resume");
    expect(route).toBeDefined();
    return route!;
  }

  async function callResume(
    runtime: ReturnType<typeof createFridayApiRuntime>,
    opts: { blob?: Uint8Array; principalId?: string } = {},
  ) {
    return resumeRoute(runtime).handler({
      body: { signedApproval: Buffer.from(opts.blob ?? new Uint8Array([9, 9, 9])).toString("base64") },
      params: { runId: RUN_ID },
      principal: makeBoundPrincipal(opts.principalId ?? OWNER_PRINCIPAL),
      receivedAt: NOW,
    } as never);
  }

  it("(resume-ok) flag ON + owner + valid secret → relays the opaque blob VERBATIM and maps the outcome", async () => {
    db = createTestDb();
    const blob = new Uint8Array([1, 2, 3, 200, 0, 255]);
    const ws = makeResumeWsClient(async (req) => ({
      truthLabel: "rust_wired" as const,
      runId: req.runId,
      op: "resume",
      accepted: true,
      status: "mutation_completed",
      auditRef: "audit-xyz",
    }));
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      agentRunControlViaRust: true,
      wsClient: ws.service,
    });
    await pauseAMutatingRun(runtime);

    const res = (await callResume(runtime, { blob })) as { accepted: boolean; status: string; auditRef?: string; op: string };
    expect(res).toMatchObject({ op: "resume", accepted: true, status: "mutation_completed", auditRef: "audit-xyz" });
    // The opaque blob was relayed VERBATIM (no parse / re-encode).
    expect(ws.resumeCalls).toHaveLength(1);
    expect(Array.from(ws.resumeCalls[0].opaqueSignedBlob)).toEqual(Array.from(blob));
  });

  it("(resume-deny) flag ON + a Rust REFUSAL (forged/expired/replayed) → accepted:false, no throw", async () => {
    db = createTestDb();
    const ws = makeResumeWsClient(async (req) => ({
      truthLabel: "rust_wired" as const,
      runId: req.runId,
      op: "resume",
      accepted: false,
      status: "approval_refused",
    }));
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      agentRunControlViaRust: true,
      wsClient: ws.service,
    });
    await pauseAMutatingRun(runtime);

    const res = (await callResume(runtime)) as { accepted: boolean; status: string };
    expect(res).toMatchObject({ accepted: false, status: "approval_refused" });
  });

  it("(resume-secret) flag ON but the X25519 secret is MISSING → byte-identical 503; WS resume NEVER called", async () => {
    db = createTestDb();
    const ws = makeResumeWsClient(async () => {
      throw new Error("resume must not be reached when the secret is missing");
    });
    // Pre-seed an OWNED paused row DIRECTLY via the projector (so the owner-binding passes) — we
    // cannot use the dispatch pause here because the dispatch preflight ALSO resolves the (null)
    // secret and would 503 before pausing. This isolates the RESUME secret-preflight branch.
    db.withWriteTransaction((d) =>
      createFridayRustHubRunContinuityProjectorService().project(d, {
        truthLabel: "rust_wired_dev",
        proofOnly: true,
        ok: true,
        runId: RUN_ID,
        routeId: "deepseek:deepseek-v4-flash",
        providerId: "deepseek",
        model: "deepseek-v4-flash",
        loopStatus: "Paused",
        turns: 0,
        executedTools: 0,
        finalMessageSha256: "d".repeat(64),
        finalMessageLen: 0,
        auditChainVerified: false,
        usagePromptTokens: 0,
        usageCompletionTokens: 0,
        usageTotalTokens: 0,
        completedAtIso: NOW,
        ownerPrincipalId: OWNER_PRINCIPAL,
      }),
    );
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      agentRunControlViaRust: true,
      wsClient: ws.service,
      clientSecretResolver: () => null, // no SecureStore secret
    });

    await expect(callResume(runtime)).rejects.toMatchObject({
      code: "TS_RUNTIME_AGENT_RUNS_RETIRED",
      httpStatus: 503,
    });
    expect(ws.resumeCalls).toHaveLength(0);
  });

  it("(resume-wserror) flag ON but the sealed-WS resume THROWS → byte-identical 503 (fail-closed)", async () => {
    db = createTestDb();
    const ws = makeResumeWsClient(async () => {
      throw new Error("transport closed");
    });
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      agentRunControlViaRust: true,
      wsClient: ws.service,
    });
    await pauseAMutatingRun(runtime);

    await expect(callResume(runtime)).rejects.toMatchObject({
      code: "TS_RUNTIME_AGENT_RUNS_RETIRED",
      httpStatus: 503,
    });
  });

  it("(resume-flagoff) flag OFF → the resume route short-circuits to the retired 503 BEFORE any run lookup", async () => {
    db = createTestDb();
    const ws = makeResumeWsClient(async () => {
      throw new Error("resume must not be reached with the control flag off");
    });
    // routeAgentRunViaRust on (so we could pause) but agentRunControlViaRust OFF — except with the
    // control flag off the dispatch never pauses; so just assert the resume route is 503 on a
    // flag-off runtime regardless of run state.
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      // agentRunControlViaRust omitted → default off.
      wsClient: ws.service,
    });

    await expect(callResume(runtime)).rejects.toMatchObject({
      code: "TS_RUNTIME_AGENT_RUNS_RETIRED",
      httpStatus: 503,
    });
    expect(ws.resumeCalls).toHaveLength(0);
  });
});

// (NS45-PR2 mission-bound driver — DARK) The route now threads an optional first-class Mission
// handle (`{fridayConversationId, missionId, workItemId}`) from `POST /v1/agent/runs` down the
// route→routeStartRun→compose→dispatch chain to the sealed-WS client (#750), which emits the
// snake_case `mission_context` wire block ONLY when the handle is present. These tests assert the
// THREADING (the handle reaches `dispatchRun` unchanged when present, is ABSENT on the dispatch
// when omitted, and a PARTIAL body is treated as absent — never forwarded, never a crash). The
// camelCase→snake_case wire conversion + the bound run path are #750's / Rust's tested job and are
// NOT re-asserted here.
describe("FridayApiRuntime — NS45-PR2 mission-bound run driver (DARK, additive-optional)", () => {
  let db: FridaySqliteLayer;

  afterEach(() => {
    db?.close();
  });

  const VALID_MISSION_CONTEXT = {
    fridayConversationId: "conv-abc-123",
    missionId: "mission-def-456",
    workItemId: "workitem-ghi-789",
  };

  it("ABSENT: a qualifying run WITHOUT missionContext → the dispatch carries NO missionContext key (byte-identical)", async () => {
    db = createTestDb();
    const ws = makeStubWsClient();
    const readback = makeStubReadback(OWNER_PRINCIPAL);
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      wsClient: ws.service,
      readback: readback.service,
    });

    await callStartRoute(runtime, { ...QUALIFYING_BODY });

    expect(ws.calls).toHaveLength(1);
    // The OMITTED-key guarantee: not merely `undefined`, but the KEY is absent on the dispatch
    // request — so the sealed client's `request.missionContext !== undefined` check fails and the
    // `mission_context` wire block is never emitted (byte-identical to the pre-NS45 unbound wire).
    expect("missionContext" in ws.calls[0]).toBe(false);
    expect(ws.calls[0].missionContext).toBeUndefined();
  });

  it("PRESENT: a valid 3-field missionContext → threaded UNCHANGED (camelCase) to dispatchRun", async () => {
    db = createTestDb();
    const ws = makeStubWsClient();
    const readback = makeStubReadback(OWNER_PRINCIPAL);
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      wsClient: ws.service,
      readback: readback.service,
    });

    await callStartRoute(runtime, {
      ...QUALIFYING_BODY,
      missionContext: { ...VALID_MISSION_CONTEXT },
    });

    expect(ws.calls).toHaveLength(1);
    // Threaded UNCHANGED, camelCase preserved — the sealed client converts to snake_case (#750).
    expect(ws.calls[0].missionContext).toEqual(VALID_MISSION_CONTEXT);
    // Auth UNCHANGED: the bound owner is the authenticated forwarded principal, NEVER the handle.
    expect(ws.calls[0].forwardedPrincipal).toBe(OWNER_PRINCIPAL);
    // Qualification UNCHANGED: a missionContext-bearing run still qualifies via the SAME read-only
    // clauses (it routed to the sealed dispatch + the read-only constraint is forwarded as before).
    expect(ws.calls[0].constraints).toEqual({ readOnly: true });
  });

  it("PARTIAL: a missionContext missing workItemId → treated as UNDEFINED (NOT forwarded, no crash)", async () => {
    db = createTestDb();
    const ws = makeStubWsClient();
    const readback = makeStubReadback(OWNER_PRINCIPAL);
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      wsClient: ws.service,
      readback: readback.service,
    });

    // No throw (the run still completes) AND the partial handle is dropped at the route.
    const result = (await callStartRoute(runtime, {
      ...QUALIFYING_BODY,
      missionContext: {
        fridayConversationId: "conv-abc-123",
        missionId: "mission-def-456",
        // workItemId intentionally OMITTED → the whole handle collapses to undefined.
      },
    })) as { status: string };

    expect(result.status).toBe("completed");
    expect(ws.calls).toHaveLength(1);
    expect("missionContext" in ws.calls[0]).toBe(false);
    expect(ws.calls[0].missionContext).toBeUndefined();
  });

  it("PARTIAL: a missionContext with a BLANK field → treated as UNDEFINED (not fabricated, not forwarded)", async () => {
    db = createTestDb();
    const ws = makeStubWsClient();
    const readback = makeStubReadback(OWNER_PRINCIPAL);
    const runtime = makeRuntime(db, {
      routeAgentRunViaRust: true,
      wsClient: ws.service,
      readback: readback.service,
    });

    await callStartRoute(runtime, {
      ...QUALIFYING_BODY,
      missionContext: {
        fridayConversationId: "conv-abc-123",
        missionId: "   ", // blank/whitespace → not a valid handle field
        workItemId: "workitem-ghi-789",
      },
    });

    expect(ws.calls).toHaveLength(1);
    expect(ws.calls[0].missionContext).toBeUndefined();
  });
});
