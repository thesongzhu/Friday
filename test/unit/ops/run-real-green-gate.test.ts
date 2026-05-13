import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveGateSuiteReportRoot, summarizeRun } from "../../../scripts/ops/run-real-green-gate.mjs";

describe("run-real-green-gate helpers", () => {
  it("preserves provider and browser attempt counters in suite summaries", () => {
    expect(summarizeRun({
      runId: "run-1",
      suite: "daily",
      reportRoot: "/tmp/report",
      resultCounts: { passed: 2 },
      failureClassCounts: {},
      defectBucketCounts: {},
      providerLanes: {},
      providerAttemptCount: 2,
      browserProbeAttemptCount: 1,
    })).toMatchObject({
      providerAttemptCount: 2,
      browserProbeAttemptCount: 1,
    });
  });

  it("keeps suite detail reports inside the RGG artifact root", () => {
    expect(resolveGateSuiteReportRoot("/tmp/rgg", "public-surface")).toBe(
      join("/tmp/rgg", "suites", "public-surface"),
    );
  });
});
