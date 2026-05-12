import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeReports } from "../../../validation/real-world/lib/reporting.mjs";

describe("real-world reporting", () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it("summarizes provider and browser probe attempts for RGG evidence-kind derivation", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "friday-real-world-reporting-"));
    const reportRoot = join(tempRoot, "report");

    const summary = writeReports({
      repoRoot: tempRoot,
      reportRoot,
      runId: "reporting-test",
      suite: "daily",
      scenarios: [
        { id: "provider-scenario", layer: "L3" },
        { id: "browser-scenario", layer: "L1" },
      ],
      artifacts: [
        {
          scenarioId: "provider-scenario",
          lane: "default",
          result: "passed",
          metrics: { durationMs: 12 },
        },
        {
          scenarioId: "browser-scenario",
          lane: "none",
          result: "passed",
          metrics: { uiRequestCount: 3 },
        },
      ],
      envTruth: {
        baseUrl: "http://127.0.0.1:3141",
        uiBaseUrl: "http://127.0.0.1:3141",
        collectedAt: "2026-05-12T00:00:00.000Z",
        publicChecks: { health: { ok: true, status: 200 } },
        auth: { ok: true, source: "local_passphrase_login", user: { id: "user" } },
        setupStatus: { needsSetup: false },
        userProfile: { profileType: "local", onboardedAt: "2026-05-12T00:00:00.000Z" },
        providerLanes: { default: { providerName: "Provider", model: "model" }, fallback: null },
        derived: { setupUserProfileTruthMismatch: false },
      },
      options: {},
    });

    expect(summary.providerAttemptCount).toBe(1);
    expect(summary.browserProbeAttemptCount).toBe(1);

    const written = JSON.parse(readFileSync(join(reportRoot, "summary.json"), "utf8"));
    expect(written.providerAttemptCount).toBe(1);
    expect(written.browserProbeAttemptCount).toBe(1);
  });

  it("redacts credential-shaped options from written summaries", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "friday-real-world-reporting-"));
    const reportRoot = join(tempRoot, "report");

    writeReports({
      repoRoot: tempRoot,
      reportRoot,
      runId: "reporting-redaction-test",
      suite: "daily",
      scenarios: [{ id: "runtime-scenario", layer: "L0" }],
      artifacts: [
        {
          scenarioId: "runtime-scenario",
          lane: "none",
          result: "passed",
          metrics: {},
        },
      ],
      envTruth: {
        baseUrl: "http://127.0.0.1:3141",
        uiBaseUrl: "http://127.0.0.1:3141",
        collectedAt: "2026-05-12T00:00:00.000Z",
        publicChecks: { health: { ok: true, status: 200 } },
        auth: { ok: true, source: "local_passphrase_login", user: { id: "user" } },
        setupStatus: { needsSetup: false },
        userProfile: { profileType: "local", onboardedAt: "2026-05-12T00:00:00.000Z" },
        providerLanes: { default: null, fallback: null },
        derived: { setupUserProfileTruthMismatch: false },
      },
      options: {
        localPassphrase: "runtime-passphrase", // pragma: allowlist secret
        mintTokenSecret: "runtime-token-secret", // pragma: allowlist secret
        accessToken: "runtime-access-token", // pragma: allowlist secret
        safeOption: "visible",
        nested: { refreshToken: "runtime-refresh-token" }, // pragma: allowlist secret
      },
    });

    const written = JSON.parse(readFileSync(join(reportRoot, "summary.json"), "utf8"));
    expect(written.options).toMatchObject({
      localPassphrase: "[redacted]",
      mintTokenSecret: "[redacted]",
      accessToken: "[redacted]",
      safeOption: "visible",
      nested: { refreshToken: "[redacted]" },
    });
    expect(JSON.stringify(written)).not.toContain("runtime-passphrase");
    expect(JSON.stringify(written)).not.toContain("runtime-token-secret");
    expect(JSON.stringify(written)).not.toContain("runtime-access-token");
    expect(JSON.stringify(written)).not.toContain("runtime-refresh-token");
  });
});
