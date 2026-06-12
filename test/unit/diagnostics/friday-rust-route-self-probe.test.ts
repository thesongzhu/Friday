import * as crypto from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createFridayTokenValidator } from "#api";
import type { FridayProviderProfile } from "#providers";

import {
  buildRustRouteSelfProbeBody,
  createRustRouteProbeOutcomeHolder,
  isRetryableConnectionFailure,
  maybeBuildRustRouteSelfProbeJob,
  mintDiagnosticAdminBearer,
  resolveEnabledDeepseekProviderId,
  resolveRustRouteDiagnosticConfig,
  runRustRouteSelfProbe,
  RUST_ROUTE_DIAGNOSTIC_BEARER_TTL_SEC,
  RUST_ROUTE_DIAGNOSTIC_DEFAULT_INTERVAL_MS,
  RUST_ROUTE_DIAGNOSTIC_JOB_ID,
  RUST_ROUTE_DIAGNOSTIC_MIN_INTERVAL_MS,
  RUST_ROUTE_DIAGNOSTIC_READ_TOOLS,
  type RustRouteLoopbackTransport,
} from "../../../src/diagnostics/friday-rust-route-self-probe.js";
import {
  qualifiesForRustReadOnlyRoute,
  RUST_ROUTE_READ_TOOL_ALLOWLIST,
} from "../../../src/api/runtime/friday-api-runtime.js";

// F1.5 — Headless Rust-route self-probe diagnostic (DARK, DEFAULT-OFF; OPTION-1 / H-b).
// These tests pin the security-sensitive + correctness-critical behaviors WITHOUT any network:
//   • DEFAULT-OFF: flag unset/anything-but-"true" ⇒ job is NOT built (null) ⇒ never fires.
//   • Flag ON ⇒ job built with the correct interval, and the produced body EXACTLY satisfies
//     the real `qualifiesForRustReadOnlyRoute` predicate (clause-by-clause).
//   • The self-minted bearer decodes (through the REAL token validator) to principalId
//     'admin-001', is short-lived, sessionless, minimally-scoped, and single-use (fresh tokenId).
//   • The probe loopback POST is mocked — the real landing is proven at enable-time on prod.

const SECRET = "test-token-secret-at-least-32-bytes-long-aaaa"; // pragma: allowlist secret
const FIXED_NOW_ISO = "2026-06-10T12:00:00.000Z";
const FIXED_NOW_MS = new Date(FIXED_NOW_ISO).getTime();

function deepseekProfile(overrides: Partial<FridayProviderProfile> = {}): FridayProviderProfile {
  return {
    id: "fa15f1fe-a0b6-4f79-96c3-4ae8e1be28a4",
    kind: "deepseek",
    enabled: true,
    // The predicate + probe only read id/kind/enabled; the rest is filler for the type.
    ...(overrides as object),
  } as FridayProviderProfile;
}

// ─── Config (DEFAULT-OFF kill-switch) ───

describe("resolveRustRouteDiagnosticConfig (DEFAULT-OFF kill-switch)", () => {
  it("is DISABLED when the flag is unset", () => {
    expect(resolveRustRouteDiagnosticConfig({}).enabled).toBe(false);
  });

  it("is DISABLED for anything other than the exact string 'true'", () => {
    for (const raw of ["1", "TRUE", "yes", "on", "false", ""]) {
      expect(resolveRustRouteDiagnosticConfig({ FRIDAY_RUST_ROUTE_DIAGNOSTIC_ENABLED: raw }).enabled).toBe(false);
    }
  });

  it("is ENABLED only for exactly 'true'", () => {
    expect(resolveRustRouteDiagnosticConfig({ FRIDAY_RUST_ROUTE_DIAGNOSTIC_ENABLED: "true" }).enabled).toBe(true);
  });

  it("defaults the interval to hourly and clamps to the 5-min floor", () => {
    expect(resolveRustRouteDiagnosticConfig({}).intervalMs).toBe(RUST_ROUTE_DIAGNOSTIC_DEFAULT_INTERVAL_MS);
    // below the floor → clamped up
    expect(
      resolveRustRouteDiagnosticConfig({ FRIDAY_RUST_ROUTE_DIAGNOSTIC_INTERVAL_MS: "1000" }).intervalMs,
    ).toBe(RUST_ROUTE_DIAGNOSTIC_MIN_INTERVAL_MS);
    // above the floor → honored
    expect(
      resolveRustRouteDiagnosticConfig({ FRIDAY_RUST_ROUTE_DIAGNOSTIC_INTERVAL_MS: "900000" }).intervalMs,
    ).toBe(900_000);
    // garbage → default
    expect(
      resolveRustRouteDiagnosticConfig({ FRIDAY_RUST_ROUTE_DIAGNOSTIC_INTERVAL_MS: "not-a-number" }).intervalMs,
    ).toBe(RUST_ROUTE_DIAGNOSTIC_DEFAULT_INTERVAL_MS);
  });
});

// ─── Scheduler job builder: OFF ⇒ null, ON ⇒ correct shape ───

function probeDepsStub() {
  return {
    tokenSecret: SECRET,
    nowIso: () => FIXED_NOW_ISO,
    idGenerator: () => crypto.randomUUID(),
    providerService: { listProviders: async () => [deepseekProfile()] },
    transport: { postAgentRun: vi.fn(async () => ({ httpStatus: 200, runId: "run-1" })) },
    outcomeHolder: createRustRouteProbeOutcomeHolder(),
  };
}

describe("maybeBuildRustRouteSelfProbeJob (default-OFF ⇒ never registered)", () => {
  it("returns null when disabled ⇒ the bootstrap never pushes a job ⇒ it NEVER fires", () => {
    const job = maybeBuildRustRouteSelfProbeJob({ enabled: false, intervalMs: 3_600_000 }, probeDepsStub());
    expect(job).toBeNull();
  });

  it("builds a job with the correct id + interval when enabled", () => {
    const job = maybeBuildRustRouteSelfProbeJob({ enabled: true, intervalMs: 3_600_000 }, probeDepsStub());
    expect(job).not.toBeNull();
    expect(job?.id).toBe(RUST_ROUTE_DIAGNOSTIC_JOB_ID);
    expect(job?.intervalMs).toBe(3_600_000);
    expect(job?.catchUpRuns).toBe(1);
  });

  it("the built job, when run, makes EXACTLY one loopback call (no burst) and never throws", async () => {
    const deps = probeDepsStub();
    const job = maybeBuildRustRouteSelfProbeJob({ enabled: true, intervalMs: 3_600_000 }, deps);
    await expect(job!.run()).resolves.toBeDefined();
    expect(deps.transport.postAgentRun).toHaveBeenCalledTimes(1);
  });
});

// ─── The qualifying body EXACTLY satisfies the real predicate ───

describe("buildRustRouteSelfProbeBody (the FIXED slice6 qualifying shape)", () => {
  it("uses EXACTLY the four read tools and the same set as the predicate's allowlist", () => {
    const body = buildRustRouteSelfProbeBody("fa15f1fe-a0b6-4f79-96c3-4ae8e1be28a4");
    expect(body.allowedRustRouteTools).toEqual([...RUST_ROUTE_DIAGNOSTIC_READ_TOOLS]);
    expect([...RUST_ROUTE_DIAGNOSTIC_READ_TOOLS].sort()).toEqual([...RUST_ROUTE_READ_TOOL_ALLOWLIST].sort());
  });

  it("produces a body that QUALIFIES for the live Rust read-only route (clause-by-clause)", () => {
    const providerId = "fa15f1fe-a0b6-4f79-96c3-4ae8e1be28a4"; // prod UUID, kind=deepseek
    const body = buildRustRouteSelfProbeBody(providerId);
    // Mirror the route wrapper: clause-1 marker is hardcoded-true inside routeStartRun, and the
    // wrapper resolves the provider record (kind=deepseek, enabled). The diagnostic carries
    // principalId admin-001 (GAP A), but the body itself is sessionless so the predicate's
    // session sub-clause does not even engage.
    expect(
      qualifiesForRustReadOnlyRoute({
        invokedFromHttpStartRunRoute: true,
        providerId: body.providerId,
        resolvedProvider: { kind: "deepseek", enabled: true },
        model: body.model,
        constraints: body.constraints,
        allowedRustRouteTools: body.allowedRustRouteTools,
        principalId: "admin-001",
      }),
    ).toBe(true);
  });

  it("sends NONE of the disqualifying fields (sessionKey/requireReview/planReviewOverride/taskProfile)", () => {
    const body = buildRustRouteSelfProbeBody("fa15f1fe");
    const keys = Object.keys(body);
    expect(keys).not.toContain("sessionKey");
    expect(keys).not.toContain("requireReview");
    expect(keys).not.toContain("planReviewOverride");
    expect(keys).not.toContain("taskProfile");
  });
});

// ─── Bearer self-mint: principalId=admin-001, short-lived, sessionless, minimal scope, single-use ───

describe("mintDiagnosticAdminBearer (security-sensitive self-mint)", () => {
  function makeValidator() {
    // Real validator, fresh tokenId is never revoked. Sessionless ⇒ lookupSessionTokenState
    // short-circuits to "active" without a DB read; we stub it to prove no DB dependency.
    return createFridayTokenValidator({
      tokenSecret: SECRET,
      nowMs: () => FIXED_NOW_MS,
      lookupTokenRevocation: () => false,
    });
  }

  it("decodes (through the REAL validator) to principalId === 'admin-001'", () => {
    const token = mintDiagnosticAdminBearer({
      tokenSecret: SECRET,
      nowMs: () => FIXED_NOW_MS,
      idGenerator: () => crypto.randomUUID(),
    });
    const { principal, claims } = makeValidator().validate(token);
    expect(principal.principalId).toBe("admin-001");
    expect(claims?.principalType).toBe("user");
    // MUST-FIX (review): no `role` is minted — principalId alone satisfies GAP A and the happy
    // path. `role` is omitted so the latent `principal.role==="admin"` / principalHasAnyRole
    // authz paths cannot grant full admin within the bearer's TTL. Assert it is absent on BOTH
    // the raw claims AND the validator-projected principal (the load-bearing one for authz).
    expect(claims?.role).toBeUndefined();
    expect(principal.role).toBeUndefined();
  });

  it("is short-lived (exp - iat === the smallest viable TTL) and sessionless (no sid)", () => {
    const token = mintDiagnosticAdminBearer({
      tokenSecret: SECRET,
      nowMs: () => FIXED_NOW_MS,
      idGenerator: () => crypto.randomUUID(),
    });
    const { claims } = makeValidator().validate(token);
    expect(claims!.exp - claims!.iat).toBe(RUST_ROUTE_DIAGNOSTIC_BEARER_TTL_SEC);
    expect(claims!.sid).toBeUndefined();
  });

  it("is rejected by the validator once expired (TTL is actually enforced)", () => {
    const token = mintDiagnosticAdminBearer({
      tokenSecret: SECRET,
      nowMs: () => FIXED_NOW_MS,
      idGenerator: () => crypto.randomUUID(),
      ttlSec: 5,
    });
    // A validator whose clock is well past exp must reject it.
    const lateValidator = createFridayTokenValidator({
      tokenSecret: SECRET,
      nowMs: () => FIXED_NOW_MS + 10_000,
      lookupTokenRevocation: () => false,
    });
    expect(() => lateValidator.validate(token)).toThrow();
  });

  it("mints ONLY the agent.run scope (minimal — not the full admin set)", () => {
    const token = mintDiagnosticAdminBearer({
      tokenSecret: SECRET,
      nowMs: () => FIXED_NOW_MS,
      idGenerator: () => crypto.randomUUID(),
    });
    const { claims } = makeValidator().validate(token);
    expect(claims!.scopes).toEqual(["agent.run"]);
    expect(claims!.scopes).not.toContain("hub.admin");
    expect(claims!.scopes).not.toContain("desktop.execute");
  });

  it("is single-use: each mint carries a fresh tokenId", () => {
    let n = 0;
    const idGenerator = () => `token-${n++}`;
    const a = makeValidator().validate(
      mintDiagnosticAdminBearer({ tokenSecret: SECRET, nowMs: () => FIXED_NOW_MS, idGenerator }),
    );
    const b = makeValidator().validate(
      mintDiagnosticAdminBearer({ tokenSecret: SECRET, nowMs: () => FIXED_NOW_MS, idGenerator }),
    );
    expect(a.claims!.tokenId).not.toBe(b.claims!.tokenId);
  });
});

// ─── Boot-race connection-failure classifier (narrowness is load-bearing for spend-safety) ───

describe("isRetryableConnectionFailure (spend-safe boot-race gate)", () => {
  function fetchFailed(code: string): TypeError {
    const err = new TypeError("fetch failed");
    (err as { cause?: unknown }).cause = { code };
    return err;
  }

  it("is TRUE for undici TypeError('fetch failed') with a pre-connect errno cause", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]) {
      expect(isRetryableConnectionFailure(fetchFailed(code))).toBe(true);
    }
  });

  it("is FALSE for a TypeError without a connection-level cause code, and for ECONNRESET (can be mid-stream → run may have started server-side)", () => {
    expect(isRetryableConnectionFailure(new TypeError("fetch failed"))).toBe(false);
    const other = new TypeError("fetch failed");
    (other as { cause?: unknown }).cause = { code: "ERR_SOMETHING_ELSE" };
    expect(isRetryableConnectionFailure(other)).toBe(false);
    expect(isRetryableConnectionFailure(fetchFailed("ECONNRESET"))).toBe(false);
  });

  it("is FALSE for a generic Error, an AbortError, and a plain ECONNREFUSED-message Error", () => {
    expect(isRetryableConnectionFailure(new Error("ECONNREFUSED"))).toBe(false);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isRetryableConnectionFailure(abort)).toBe(false);
    expect(isRetryableConnectionFailure("ECONNREFUSED")).toBe(false);
    expect(isRetryableConnectionFailure(undefined)).toBe(false);
  });
});

// ─── Provider resolution: prod UUID, not the literal "deepseek" ───

describe("resolveEnabledDeepseekProviderId", () => {
  it("returns the enabled deepseek provider's (UUID) id", async () => {
    const id = await resolveEnabledDeepseekProviderId({
      listProviders: async () => [
        deepseekProfile({ id: "uuid-deepseek", enabled: true }),
        deepseekProfile({ id: "uuid-anthropic", kind: "anthropic" as FridayProviderProfile["kind"] }),
      ],
    });
    expect(id).toBe("uuid-deepseek");
  });

  it("returns undefined when no enabled deepseek provider exists", async () => {
    const id = await resolveEnabledDeepseekProviderId({
      listProviders: async () => [deepseekProfile({ enabled: false })],
    });
    expect(id).toBeUndefined();
  });
});

// ─── Probe runner: mocked transport, log-and-continue ───

describe("runRustRouteSelfProbe (no network in CI; the real landing is proven at enable-time on prod)", () => {
  const baseDeps = () => ({
    tokenSecret: SECRET,
    nowIso: () => FIXED_NOW_ISO,
    idGenerator: () => crypto.randomUUID(),
    providerService: { listProviders: async () => [deepseekProfile()] },
    outcomeHolder: createRustRouteProbeOutcomeHolder(),
    logger: { warn: vi.fn(), info: vi.fn() },
  });

  it("posts the qualifying body with a bearer and records an 'ok' outcome on 2xx", async () => {
    const postAgentRun = vi.fn(async () => ({ httpStatus: 200, runId: "run-xyz" }));
    const transport: RustRouteLoopbackTransport = { postAgentRun };
    const deps = { ...baseDeps(), transport };
    const outcome = await runRustRouteSelfProbe(deps);

    expect(outcome.status).toBe("ok");
    expect(outcome.httpStatus).toBe(200);
    expect(outcome.runId).toBe("run-xyz");
    expect(deps.outcomeHolder.get()?.status).toBe("ok");

    // body shape forwarded to the transport is the fixed qualifying shape
    const call = postAgentRun.mock.calls[0][0];
    expect(call.body.model).toBe("deepseek-v4-flash");
    expect(call.body.providerId).toBe("fa15f1fe-a0b6-4f79-96c3-4ae8e1be28a4");
    expect(call.body.allowedRustRouteTools).toEqual([...RUST_ROUTE_DIAGNOSTIC_READ_TOOLS]);
    // a bearer was attached; we never assert its literal value (and it is never logged)
    expect(typeof call.bearer).toBe("string");
    expect(call.bearer.length).toBeGreaterThan(0);
  });

  it("records 'skipped' (no call) when no enabled deepseek provider exists", async () => {
    const postAgentRun = vi.fn();
    const deps = {
      ...baseDeps(),
      providerService: { listProviders: async () => [] },
      transport: { postAgentRun },
    };
    const outcome = await runRustRouteSelfProbe(deps);
    expect(outcome.status).toBe("skipped");
    expect(postAgentRun).not.toHaveBeenCalled();
  });

  it("LOG-AND-CONTINUEs (never throws) when the loopback rejects — no crash-loop", async () => {
    const deps = {
      ...baseDeps(),
      transport: { postAgentRun: vi.fn(async () => { throw new Error("ECONNREFUSED"); }) },
    };
    const outcome = await runRustRouteSelfProbe(deps);
    expect(outcome.status).toBe("error");
    expect(deps.outcomeHolder.get()?.status).toBe("error");
  });

  it("records 'error' on a non-2xx loopback status", async () => {
    const deps = {
      ...baseDeps(),
      transport: { postAgentRun: vi.fn(async () => ({ httpStatus: 503 })) },
    };
    const outcome = await runRustRouteSelfProbe(deps);
    expect(outcome.status).toBe("error");
    expect(outcome.httpStatus).toBe(503);
  });

  // ─── Boot-race: first-tick fires before the hub HTTP server finished listen() ───
  // The loopback POST then hits a not-yet-accepting 127.0.0.1:<port> → undici surfaces a
  // `TypeError: fetch failed` with `cause.code === "ECONNREFUSED"`. The probe must retry EXACTLY
  // once after a short (injected-0) backoff and SUCCEED on the second call — eliminating the
  // boot-time fetch-failed without changing cadence/spend posture.
  function fetchFailedTypeError(code: string): TypeError {
    const err = new TypeError("fetch failed");
    (err as { cause?: unknown }).cause = { code };
    return err;
  }

  it("retries ONCE on a boot-race ECONNREFUSED and records 'ok' when the retry succeeds (two calls)", async () => {
    const postAgentRun = vi
      .fn()
      .mockRejectedValueOnce(fetchFailedTypeError("ECONNREFUSED"))
      .mockResolvedValueOnce({ httpStatus: 200, runId: "run-after-retry" });
    const deps = {
      ...baseDeps(),
      transport: { postAgentRun },
      connectRetryBackoffMs: 0, // no real sleep in CI
    };
    const outcome = await runRustRouteSelfProbe(deps);
    expect(outcome.status).toBe("ok");
    expect(outcome.httpStatus).toBe(200);
    expect(outcome.runId).toBe("run-after-retry");
    expect(postAgentRun).toHaveBeenCalledTimes(2);
    // Each attempt carried a (fresh, single-use) bearer; never asserted by value, never logged.
    expect(typeof postAgentRun.mock.calls[0][0].bearer).toBe("string");
    expect(typeof postAgentRun.mock.calls[1][0].bearer).toBe("string");
  });

  it("uses the injected sleep for the retry backoff (no real timer)", async () => {
    const sleep = vi.fn(async () => {});
    const postAgentRun = vi
      .fn()
      .mockRejectedValueOnce(fetchFailedTypeError("ECONNREFUSED"))
      .mockResolvedValueOnce({ httpStatus: 200, runId: "r" });
    const deps = {
      ...baseDeps(),
      transport: { postAgentRun },
      connectRetryBackoffMs: 1234,
      sleep,
    };
    await runRustRouteSelfProbe(deps);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1234);
  });

  // SPEND-SAFETY (locks the retry narrowness against future double-spend): a non-connection
  // failure (e.g. a generic Error, an AbortError/timeout, or any error that is NOT a pre-connect
  // `fetch failed`+ECONNREFUSED) must NOT be retried — the run may have started server-side, so a
  // retry could double-spend real DeepSeek. It is recorded as 'error' on a SINGLE call.
  it("does NOT retry a non-connection error — single call, 'error' outcome (no double-spend)", async () => {
    const postAgentRun = vi.fn(async () => {
      throw new Error("some downstream failure that is not a pre-connect refusal");
    });
    const deps = { ...baseDeps(), transport: { postAgentRun }, connectRetryBackoffMs: 0 };
    const outcome = await runRustRouteSelfProbe(deps);
    expect(outcome.status).toBe("error");
    expect(postAgentRun).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry an AbortError/timeout (run may have started server-side) — single call", async () => {
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    const postAgentRun = vi.fn(async () => {
      throw abortErr;
    });
    const deps = { ...baseDeps(), transport: { postAgentRun }, connectRetryBackoffMs: 0 };
    const outcome = await runRustRouteSelfProbe(deps);
    expect(outcome.status).toBe("error");
    expect(postAgentRun).toHaveBeenCalledTimes(1);
  });

  it("retries ONCE then LOG-AND-CONTINUEs when the connection is STILL refused (two calls, never throws)", async () => {
    const postAgentRun = vi
      .fn()
      .mockRejectedValueOnce(fetchFailedTypeError("ECONNREFUSED"))
      .mockRejectedValueOnce(fetchFailedTypeError("ECONNREFUSED"));
    const deps = { ...baseDeps(), transport: { postAgentRun }, connectRetryBackoffMs: 0 };
    const outcome = await runRustRouteSelfProbe(deps);
    expect(outcome.status).toBe("error");
    expect(postAgentRun).toHaveBeenCalledTimes(2);
  });

  it("never includes the self-minted bearer in any recorded outcome detail", async () => {
    let capturedBearer = "";
    const deps = {
      ...baseDeps(),
      transport: {
        postAgentRun: vi.fn(async ({ bearer }: { bearer: string }) => {
          capturedBearer = bearer;
          return { httpStatus: 200, runId: "r" };
        }),
      },
    };
    await runRustRouteSelfProbe(deps);
    const detail = deps.outcomeHolder.get()?.detail ?? "";
    expect(detail.length).toBeGreaterThan(0);
    expect(capturedBearer.length).toBeGreaterThan(0);
    // The recorded diagnostic outcome must NOT leak the bearer (nor its signature half).
    expect(detail).not.toContain(capturedBearer);
    expect(detail).not.toContain(capturedBearer.split(".")[1] ?? "__none__");
  });
});
