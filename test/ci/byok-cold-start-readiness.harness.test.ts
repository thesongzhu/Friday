import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Unit coverage for the BYOK cold-start credential-entry readiness harness
 * (scripts/ci/byok-cold-start-readiness.mjs).
 *
 * The heavy real drive (npm pack → clean install → cold start) lives in the
 * harness's own `run()` and is exercised via `node scripts/ci/...`. Here we
 * pin the *discriminating* readiness predicates so the harness's PASS can never
 * be vacuous: the SAME predicates that gate a PASS must FAIL when the
 * credential-entry point is unreachable (route 404/503) or absent from the
 * served bundle. If these ever stop discriminating, the harness would green a
 * broken install — these tests are the tripwire.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const harnessPath = join(repoRoot, "scripts", "ci", "byok-cold-start-readiness.mjs");

async function harness(): Promise<Record<string, any>> {
  return (await import(pathToFileURL(harnessPath).href)) as Record<string, any>;
}

describe("BYOK cold-start readiness — credential-route predicate", () => {
  it("PASSES only for a structured validate-before-persist rejection (422 VALIDATION_ERROR)", async () => {
    const { classifyCredentialRouteProbe } = await harness();
    const v = classifyCredentialRouteProbe({ status: 422, code: "VALIDATION_ERROR" });
    expect(v).toMatchObject({ ok: true, reachable: true, functional: true });
  });

  it("also accepts a 400 VALIDATION_ERROR (schema reject before persist)", async () => {
    const { classifyCredentialRouteProbe } = await harness();
    expect(classifyCredentialRouteProbe({ status: 400, code: "VALIDATION_ERROR" }).ok).toBe(true);
  });

  // ── Non-vacuity: the predicate must FAIL when the point is unreachable ──
  it("FAILS (unreachable) when the route is missing (404)", async () => {
    const { classifyCredentialRouteProbe } = await harness();
    const v = classifyCredentialRouteProbe({ status: 404 });
    expect(v.ok).toBe(false);
    expect(v.reachable).toBe(false);
  });

  it("FAILS (not functional) when the route is fail-closed/disabled (503)", async () => {
    const { classifyCredentialRouteProbe } = await harness();
    const v = classifyCredentialRouteProbe({ status: 503 });
    expect(v.ok).toBe(false);
    expect(v.functional).toBe(false);
  });

  it("FAILS when an invalid body is accepted (2xx) — validate-before-persist not enforced", async () => {
    const { classifyCredentialRouteProbe } = await harness();
    expect(classifyCredentialRouteProbe({ status: 201, code: undefined }).ok).toBe(false);
    expect(classifyCredentialRouteProbe({ status: 200, code: undefined }).ok).toBe(false);
  });

  it("FAILS on a 422 without the VALIDATION_ERROR code (unstructured)", async () => {
    const { classifyCredentialRouteProbe } = await harness();
    expect(classifyCredentialRouteProbe({ status: 422, code: "SOMETHING_ELSE" }).ok).toBe(false);
  });
});

describe("BYOK cold-start readiness — served-marker predicate", () => {
  it("finds nothing missing when every credential-entry marker is present", async () => {
    const { findMissingMarkers, CREDENTIAL_ENTRY_MARKERS } = await harness();
    const served = [
      '<div data-testid="setup-page">',
      'providersApi.create({...,"validateOnSave":true})',
      'fetch("/v1/providers")',
    ];
    expect(findMissingMarkers(CREDENTIAL_ENTRY_MARKERS, served)).toEqual([]);
  });

  // ── Non-vacuity: an absent marker must be flagged ──
  it("flags a marker that is absent from every served asset", async () => {
    const { findMissingMarkers } = await harness();
    const served = ["nothing relevant here", "still nothing"];
    expect(findMissingMarkers(["validateOnSave"], served)).toEqual(["validateOnSave"]);
  });

  it("flags the credential-entry markers when the served bundle omits the wizard wiring", async () => {
    const { findMissingMarkers, CREDENTIAL_ENTRY_MARKERS } = await harness();
    // A bundle that ships the app shell but NOT the validate-before-persist step.
    const served = ["<div>app shell</div>", 'fetch("/v1/health")'];
    const missing = findMissingMarkers(CREDENTIAL_ENTRY_MARKERS, served);
    expect(missing).toContain("validateOnSave");
    expect(missing.length).toBeGreaterThan(0);
  });
});

describe("BYOK cold-start readiness — runtime digest + overall verdict", () => {
  it("computes a deterministic runtime digest that changes with any input", async () => {
    const { computeRuntimeDigest } = await harness();
    const base = { candidateSha: "88d99b0c", tarballSha256: "aaa", uiBundleDigest: "bbb" };
    const d1 = computeRuntimeDigest(base);
    const d2 = computeRuntimeDigest({ ...base });
    const d3 = computeRuntimeDigest({ ...base, uiBundleDigest: "ccc" });
    expect(d1).toMatch(/^[0-9a-f]{64}$/);
    expect(d1).toBe(d2);
    expect(d1).not.toBe(d3);
  });

  it("evaluateReadiness PASSES only when every readiness limb holds", async () => {
    const { evaluateReadiness } = await harness();
    const ok = {
      cleanState: { noOwner: true, noProviderSecret: true },
      ownerClaimed: true,
      servedMarkersMissing: [],
      routeProbe: { ok: true, reason: "ok" },
      nothingPersisted: true,
    };
    expect(evaluateReadiness(ok)).toMatchObject({ pass: true, failures: [] });
  });

  it("evaluateReadiness FAILS if the credential route is unreachable", async () => {
    const { evaluateReadiness } = await harness();
    const v = evaluateReadiness({
      cleanState: { noOwner: true, noProviderSecret: true },
      ownerClaimed: true,
      servedMarkersMissing: [],
      routeProbe: { ok: false, reason: "route missing (404)" },
      nothingPersisted: true,
    });
    expect(v.pass).toBe(false);
    expect(v.failures.join(" ")).toContain("credential-entry route not ready");
  });

  it("evaluateReadiness FAILS if the clean state already had an owner or secret", async () => {
    const { evaluateReadiness } = await harness();
    const v = evaluateReadiness({
      cleanState: { noOwner: false, noProviderSecret: false },
      ownerClaimed: true,
      servedMarkersMissing: [],
      routeProbe: { ok: true, reason: "ok" },
      nothingPersisted: true,
    });
    expect(v.pass).toBe(false);
    expect(v.failures.length).toBeGreaterThanOrEqual(2);
  });

  it("evaluateReadiness FAILS if the invalid-body probe persisted a provider", async () => {
    const { evaluateReadiness } = await harness();
    const v = evaluateReadiness({
      cleanState: { noOwner: true, noProviderSecret: true },
      ownerClaimed: true,
      servedMarkersMissing: [],
      routeProbe: { ok: true, reason: "ok" },
      nothingPersisted: false,
    });
    expect(v.pass).toBe(false);
    expect(v.failures.join(" ")).toContain("validate-before-persist violated");
  });
});

describe("BYOK cold-start readiness — harness shape guards", () => {
  it("declares the three stable credential-entry markers", async () => {
    const { CREDENTIAL_ENTRY_MARKERS } = await harness();
    expect([...CREDENTIAL_ENTRY_MARKERS].sort()).toEqual(["/v1/providers", "setup-page", "validateOnSave"]);
  });

  it("never submits an apiKey in its probe and never makes a provider call", () => {
    const src = readFileSync(harnessPath, "utf8");
    // The probe body must not carry a key; validateCreateBody rejects it first.
    expect(src).toContain('body: JSON.stringify({ validateOnSave: true })');
    expect(src).not.toMatch(/apiKey\s*:\s*["'`]/);
    // No outbound provider hostnames anywhere in the harness.
    expect(src).not.toMatch(/api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com/);
  });
});
