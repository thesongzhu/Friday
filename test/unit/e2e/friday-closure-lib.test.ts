import { describe, expect, it } from "vitest";

import {
  FRIDAY_CLOSURE_STATUSES,
  FRIDAY_READINESS_VERDICTS,
  buildClosureScratchEnv,
  collectChannelBlockers,
  collectCloudBlockers,
  createClosureRunId,
  parseEnabledChannelKinds,
  resolveClosureVerdict,
  resolveReadinessReport,
} from "../../../scripts/e2e/friday-closure-lib.mjs";

describe("friday closure lib", () => {
  it("creates a filesystem-safe run id", () => {
    const runId = createClosureRunId(new Date("2026-03-11T12:34:56.789Z"));
    expect(runId).toBe("2026-03-11T12-34-56-789Z");
  });

  it("parses enabled channel kinds from FRIDAY_CHANNELS_JSON", () => {
    const kinds = parseEnabledChannelKinds(JSON.stringify({
      channels: [
        { kind: "discord" },
        { kind: "slack", enabled: true },
        { kind: "telegram", enabled: false },
      ],
    }));
    expect([...kinds]).toEqual(["discord", "slack"]);
  });

  it("flags missing cloud env contract", () => {
    const blockers = collectCloudBlockers({});
    expect(blockers).toContain("FRIDAY_E2E_CLOUD_BASE_URL is not set");
    expect(blockers).toContain("FRIDAY_E2E_CLOUD_AUTH_MODE is not set");
  });

  it("flags missing channel kinds from FRIDAY_CHANNELS_JSON", () => {
    const blockers = collectChannelBlockers({
      FRIDAY_CHANNELS_JSON: JSON.stringify({
        channels: [{ kind: "discord" }, { kind: "slack" }],
      }),
    });
    expect(blockers).toContain('Channel "telegram" is not configured in FRIDAY_CHANNELS_JSON');
    expect(blockers).not.toContain('Channel "discord" is not configured in FRIDAY_CHANNELS_JSON');
  });

  it("defaults local closure scratch env to local bypass login while preserving explicit overrides", () => {
    const scratch = buildClosureScratchEnv({}, { state: "/tmp/friday-state" });
    expect(scratch.FRIDAY_STATE_DIR).toBe("/tmp/friday-state");
    expect(scratch.FRIDAY_CHANNELS_JSON).toBe('{"enabled":true,"instances":[]}');
    expect(scratch.FRIDAY_BROWSER_HEADLESS).toBe("true");
    expect(scratch.FRIDAY_ALLOW_LOCAL_BYPASS_LOGIN).toBe("true");

    const explicit = buildClosureScratchEnv(
      {
        FRIDAY_ALLOW_LOCAL_BYPASS_LOGIN: "false",
        FRIDAY_CHANNELS_JSON: '{"enabled":true,"instances":[{"kind":"discord","token":"$DISCORD_BOT_TOKEN"}]}',
      },
      { state: "/tmp/other-state" },
    );
    expect(explicit.FRIDAY_ALLOW_LOCAL_BYPASS_LOGIN).toBe("false");
    expect(explicit.FRIDAY_CHANNELS_JSON).toContain('"discord"');
  });

  it("resolves NO-GO when ledger contains blockers", () => {
    const verdict = resolveClosureVerdict([
      { status: FRIDAY_CLOSURE_STATUSES.PASS },
      { status: FRIDAY_CLOSURE_STATUSES.BLOCKER },
    ]);
    expect(verdict.summary).toEqual({ pass: 1, fail: 0, blocker: 1 });
    expect(verdict.verdict).toBe("NO-GO");
  });

  it("reports readiness tiers for a local-only run", () => {
    const readiness = resolveReadinessReport([
      { id: "local.providers", status: FRIDAY_CLOSURE_STATUSES.PASS },
      { id: "local.backstop.release-verify", status: FRIDAY_CLOSURE_STATUSES.PASS },
    ], "local");

    expect(readiness).toEqual({
      mode: "local",
      repoReady: FRIDAY_READINESS_VERDICTS.GO,
      productReadyLocal: FRIDAY_READINESS_VERDICTS.GO,
      cloudReady: FRIDAY_READINESS_VERDICTS.NOT_RUN,
      overall: "GO",
    });
  });

  it("reports combined readiness tiers when cloud blockers exist", () => {
    const readiness = resolveReadinessReport([
      { id: "local.providers", status: FRIDAY_CLOSURE_STATUSES.PASS },
      { id: "local.backstop.release-verify", status: FRIDAY_CLOSURE_STATUSES.PASS },
      { id: "cloud.preflight.contract", status: FRIDAY_CLOSURE_STATUSES.BLOCKER },
    ], "all");

    expect(readiness).toEqual({
      mode: "all",
      repoReady: FRIDAY_READINESS_VERDICTS.GO,
      productReadyLocal: FRIDAY_READINESS_VERDICTS.GO,
      cloudReady: FRIDAY_READINESS_VERDICTS.NO_GO,
      overall: "NO-GO",
    });
  });

  it("treats hidden terminal run failures inside PASS entries as NO-GO", () => {
    const readiness = resolveReadinessReport([
      { id: "local.backstop.release-verify", status: FRIDAY_CLOSURE_STATUSES.PASS },
      {
        id: "local.sessions-agent-memory",
        status: FRIDAY_CLOSURE_STATUSES.PASS,
        details: {
          runStatus: "failed",
          closureFailures: ["agentRun.status=failed"],
        },
      },
    ], "local");

    expect(readiness).toEqual({
      mode: "local",
      repoReady: FRIDAY_READINESS_VERDICTS.GO,
      productReadyLocal: FRIDAY_READINESS_VERDICTS.NO_GO,
      cloudReady: FRIDAY_READINESS_VERDICTS.NOT_RUN,
      overall: "NO-GO",
    });
  });

  it("treats PASS entries with closureFailures as failed in closure verdict summaries", () => {
    const verdict = resolveClosureVerdict([
      {
        id: "local.sessions-agent-memory",
        status: FRIDAY_CLOSURE_STATUSES.PASS,
        details: {
          closureFailures: ["automationRun.status=failed"],
        },
      },
    ]);

    expect(verdict.summary).toEqual({ pass: 0, fail: 1, blocker: 0 });
    expect(verdict.verdict).toBe("NO-GO");
  });
});
