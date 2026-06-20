import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { evaluateDeepSeekRggCoreResult } from "../../../scripts/ops/friday-c1-c2-deepseek-rgg-core-gate.mjs";

let tempRoot: string | null = null;

function makeReportRoot(): string {
  tempRoot = mkdtempSync(join(tmpdir(), "friday-c1-c2-rgg-core-test-"));
  return tempRoot;
}

function writeReport(root: string, patch = {}, phasePatch = {}, meta = "deepseekRoutingConfigured=true\n"): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "real-green-gate-result.json"), `${JSON.stringify({
    schema_version: 1,
    status: "failed",
    blocked_reasons: ["external channel prerequisite is not ready: unknown"],
    scenarios_run: 55,
    scenarios_total: 55,
    scenarios_passed: 55,
    provider_lane_scope: {
      scope: "single_provider_default_only",
      fallback_resilience_proven: false,
    },
    ...patch,
  }, null, 2)}\n`);
  writeFileSync(join(root, "phase-status.json"), `${JSON.stringify({
    phases: {
      externalChannels: {
        status: "skipped",
        reason: "external_channels.ready is not true",
      },
    },
    ...phasePatch,
  }, null, 2)}\n`);
  writeFileSync(join(root, "self-hosted-runtime-meta.txt"), meta);
}

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

describe("C1/C2 DeepSeek RGG core gate", () => {
  it("passes when all RGG scenarios pass and only the separately tracked external-channel prerequisite blocks", async () => {
    const root = makeReportRoot();
    writeReport(root);

    const evaluation = await evaluateDeepSeekRggCoreResult(root);

    expect(evaluation.ok).toBe(true);
    expect(evaluation.status).toBe("passed");
    expect(evaluation.scenariosRun).toBe(55);
    expect(evaluation.scenariosPassed).toBe(55);
    expect(evaluation.deepseekRoutingConfigured).toBe(true);
    expect(evaluation.externalChannelsSkipped).toBe(true);
    expect(evaluation.truthLabel).toContain("strict organic=0");
  });

  it("also accepts a fully passed RGG result with no blocked reasons", async () => {
    const root = makeReportRoot();
    writeReport(root, { status: "passed", blocked_reasons: [] }, {
      phases: { externalChannels: { status: "completed" } },
    });

    const evaluation = await evaluateDeepSeekRggCoreResult(root);

    expect(evaluation.ok).toBe(true);
    expect(evaluation.blockedReasons).toEqual([]);
  });

  it("fails closed when any non-channel RGG reason is blocked", async () => {
    const root = makeReportRoot();
    writeReport(root, { blocked_reasons: ["provider routing failed"] });

    const evaluation = await evaluateDeepSeekRggCoreResult(root);

    expect(evaluation.ok).toBe(false);
    expect(evaluation.failures.join("\n")).toContain("unexpected blocked reasons");
  });

  it("fails closed when DeepSeek routing was not configured", async () => {
    const root = makeReportRoot();
    writeReport(root, {}, {}, "deepseekRoutingConfigured=false\n");

    const evaluation = await evaluateDeepSeekRggCoreResult(root);

    expect(evaluation.ok).toBe(false);
    expect(evaluation.failures).toContain("DeepSeek routing was not configured");
  });

  it("fails closed when the scenarios are not all green", async () => {
    const root = makeReportRoot();
    writeReport(root, { scenarios_passed: 54 });

    const evaluation = await evaluateDeepSeekRggCoreResult(root);

    expect(evaluation.ok).toBe(false);
    expect(evaluation.failures).toContain("RGG scenarios did not all pass");
  });

  it("fails closed when the result does not prove the DeepSeek single-provider lane", async () => {
    const root = makeReportRoot();
    writeReport(root, { provider_lane_scope: { scope: "multi_provider_fallback" } });

    const evaluation = await evaluateDeepSeekRggCoreResult(root);

    expect(evaluation.ok).toBe(false);
    expect(evaluation.failures).toContain("RGG did not prove the single-provider DeepSeek default lane");
  });
});
