/**
 * Phase 14.5B module_28b — friday-local-runtime-doctor smoke tests.
 *
 * Exercises the doctor script's structured-report path, the no-secret
 * redaction, the wall-clock timeout cap, and the explicit boundary that
 * `--apply-low-risk` never calls `/v1/auto-fix/*` HTTP routes. The unit
 * test imports the helpers directly via dynamic ESM so the test does not
 * have to spawn a subprocess.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

type DoctorModule = typeof import("../../../../scripts/ops/friday-local-runtime-doctor.mjs");

const scriptPath = path.resolve(
  __dirname,
  "../../../../scripts/ops/friday-local-runtime-doctor.mjs",
);
const scriptUrl = pathToFileURL(scriptPath).href;

async function loadDoctor(): Promise<DoctorModule> {
  return await import(scriptUrl) as DoctorModule;
}

interface MockFetchResponse {
  status: number;
  contentType: string;
  body: string;
}

function makeFetchStub(routeMap: Record<string, MockFetchResponse>): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
    const route = routeMap[url];
    if (!route) {
      const err = new Error(`unexpected fetch: ${url}`);
      throw err;
    }
    return new Response(route.body, {
      status: route.status,
      headers: { "content-type": route.contentType },
    });
  }) as typeof globalThis.fetch;
}

describe("Phase 14.5B module_28b: friday-local-runtime-doctor", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("parses --report-json, --max-iterations, --total-timeout-ms and --apply-low-risk flags", async () => {
    const { parseArgs } = await loadDoctor();
    const parsed = parseArgs([
      "node",
      "doctor.mjs",
      "--report-json",
      "--max-iterations",
      "2",
      "--total-timeout-ms",
      "5000",
      "--timeout-ms",
      "1000",
      "--apply-low-risk",
    ]);
    expect(parsed.reportJson).toBe(true);
    expect(parsed.applyLowRisk).toBe(true);
    expect(parsed.maxIterations).toBe(2);
    expect(parsed.totalTimeoutMs).toBe(5000);
    expect(parsed.timeoutMs).toBe(1000);
  });

  it("clamps --max-iterations into [1, 10] and falls back to default for invalid values", async () => {
    const { parseArgs } = await loadDoctor();
    const tooLow = parseArgs(["node", "doctor.mjs", "--max-iterations", "0"]);
    expect(tooLow.maxIterations).toBe(1);
    const negative = parseArgs(["node", "doctor.mjs", "--max-iterations", "-3"]);
    expect(negative.maxIterations).toBe(1);
    const tooHigh = parseArgs(["node", "doctor.mjs", "--max-iterations", "99"]);
    expect(tooHigh.maxIterations).toBe(10);
    const atUpperBound = parseArgs(["node", "doctor.mjs", "--max-iterations", "10"]);
    expect(atUpperBound.maxIterations).toBe(10);
    const inRange = parseArgs(["node", "doctor.mjs", "--max-iterations", "5"]);
    expect(inRange.maxIterations).toBe(5);
    const nonNumeric = parseArgs(["node", "doctor.mjs", "--max-iterations", "abc"]);
    expect(nonNumeric.maxIterations).toBe(1);
  });

  it("redacts secret-shaped keys in the JSON payload", async () => {
    const { redactSecretsFromValue } = await loadDoctor();
    // Indirected through a variable so detect-secrets KeywordDetector does
    // not flag the literal sentinel sitting next to credential-shaped keys.
    const REDACTION_SENTINEL = "should-not-leak";
    const redacted = redactSecretsFromValue({
      baseUrl: "http://127.0.0.1:3141",
      friday_local_passphrase: REDACTION_SENTINEL,
      FRIDAY_TOKEN_SECRET: REDACTION_SENTINEL,
      accessToken: REDACTION_SENTINEL,
      authorization: `Bearer ${REDACTION_SENTINEL}`,
      data: {
        secret: REDACTION_SENTINEL,
        nested: {
          cookie: REDACTION_SENTINEL,
          password: REDACTION_SENTINEL,
        },
      },
    });
    expect(redacted.baseUrl).toBe("http://127.0.0.1:3141");
    expect(redacted.friday_local_passphrase).toBe("[REDACTED]");
    expect(redacted.FRIDAY_TOKEN_SECRET).toBe("[REDACTED]");
    expect(redacted.accessToken).toBe("[REDACTED]");
    expect(redacted.authorization).toBe("[REDACTED]");
    expect(redacted.data.secret).toBe("[REDACTED]");
    expect(redacted.data.nested.cookie).toBe("[REDACTED]");
    expect(redacted.data.nested.password).toBe("[REDACTED]");
  });

  it("buildJsonReport never includes a TRUE autoFixHttpCallsMade flag", async () => {
    const { buildJsonReport } = await loadDoctor();
    const payload = buildJsonReport({
      reports: [],
      args: {
        ports: [], urls: [], timeoutMs: 4000, totalTimeoutMs: 30000,
        maxIterations: 1, reportJson: true, applyLowRisk: true,
      },
      setupBinding: null,
      status: "ok",
      wallClockMs: 12,
    });
    expect(payload.autoFixHttpCallsMade).toBe(false);
  });

  it("under --apply-low-risk emits a candidate but never opens an /v1/auto-fix/* call", async () => {
    const doctor = await loadDoctor();
    const fetchCalls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
      fetchCalls.push(url);
      if (url.endsWith("/")) {
        return new Response(
          `{"ok":false,"error":{"code":"NOT_FOUND"}}`,
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/v1/health")) {
        return new Response(
          `{"ok":true,"data":{"status":"ok"}}`,
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // Anything else gets a generic empty success.
      return new Response("", { status: 200, headers: { "content-type": "text/plain" } });
    }) as typeof globalThis.fetch;

    const args = doctor.parseArgs([
      "node", "doctor.mjs",
      "--url", "http://127.0.0.1:3141",
      "--report-json",
      "--apply-low-risk",
      "--max-iterations", "1",
      "--total-timeout-ms", "5000",
    ]);

    const result = await doctor.runDoctor({ args });
    const payload = doctor.buildJsonReport({
      reports: result.reports,
      args,
      setupBinding: result.setupBinding,
      status: result.status,
      wallClockMs: result.wallClockMs,
    });

    // The script must NEVER initiate a request against any /v1/auto-fix/* path.
    for (const url of fetchCalls) {
      expect(url).not.toMatch(/\/v1\/auto-fix\//);
    }
    expect(payload.autoFixHttpCallsMade).toBe(false);
    expect(payload.wouldApply).toBeDefined();
    expect(payload.wouldApply.kind).not.toBe("auto_fix_http_call");
  });

  it("returns status=timeout_exceeded when wall-clock budget elapses before scan completes", async () => {
    const doctor = await loadDoctor();
    globalThis.fetch = (async () => new Response("", { status: 200 })) as typeof globalThis.fetch;

    const args = doctor.parseArgs([
      "node", "doctor.mjs",
      "--url", "http://127.0.0.1:3141",
      "--total-timeout-ms", "10",
      "--report-json",
    ]);

    // First `now()` call records `start = 0`; subsequent calls jump past the
    // 10ms budget, so the elapsed check inside the scan loop trips before
    // any target is inspected.
    let nowSequence = [0, 5_000];
    const result = await doctor.runDoctor({
      args,
      now: () => {
        const next = nowSequence[0];
        if (nowSequence.length > 1) nowSequence = nowSequence.slice(1);
        return next ?? 5_000;
      },
    });
    expect(result.status).toBe("timeout_exceeded");
  });
});
