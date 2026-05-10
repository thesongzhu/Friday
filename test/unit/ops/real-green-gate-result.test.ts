import { describe, expect, it } from "vitest";

import {
  REAL_GREEN_GATE_RESULT_FILENAME,
  REAL_GREEN_GATE_RESULT_SCHEMA_VERSION,
  REAL_GREEN_GATE_RESULT_STATUSES,
  buildBlockedByEnvResult,
  buildRealGreenGateResult,
  validateRealGreenGateResult,
} from "../../../scripts/ops/lib/real-green-gate-result.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function passingSummary() {
  return {
    runId: "run-id",
    branch: "main",
    error: null,
    preflight: {
      gitHead: { stdout: `${SHA_A}\n` },
    },
    smoke: {
      resultCounts: { passed: 4 },
    },
    dailyCore: {
      resultCounts: { passed: 14 },
    },
    publicSurface: {
      resultCounts: { passed: 29 },
    },
    gate: {
      passed: true,
      reasons: [],
    },
  };
}

function failingSummary(reasons: string[] = ["smoke suite is not fully passed"]) {
  return {
    ...passingSummary(),
    smoke: {
      resultCounts: { passed: 3, failed: 1 },
    },
    gate: {
      passed: false,
      reasons,
    },
  };
}

function erroredSummary() {
  return {
    ...passingSummary(),
    error: { phase: "smoke", message: "timeout" },
    gate: {
      passed: false,
      reasons: ["smoke suite did not complete"],
    },
  };
}

describe("REAL_GREEN_GATE_RESULT constants", () => {
  it("exposes the filename constant for the artifact path", () => {
    expect(REAL_GREEN_GATE_RESULT_FILENAME).toBe("real-green-gate-result.json");
  });

  it("pins the schema version at 1", () => {
    expect(REAL_GREEN_GATE_RESULT_SCHEMA_VERSION).toBe(1);
  });

  it("freezes the status enum and exposes the four canonical states", () => {
    expect(REAL_GREEN_GATE_RESULT_STATUSES).toEqual({
      PASSED: "passed",
      FAILED: "failed",
      BLOCKED_BY_ENV: "blocked_by_env",
      ERRORED: "errored",
    });
    expect(Object.isFrozen(REAL_GREEN_GATE_RESULT_STATUSES)).toBe(true);
  });
});

describe("buildRealGreenGateResult", () => {
  it("returns status=passed with full evidence kinds when the gate passed", () => {
    const result = buildRealGreenGateResult({
      summary: passingSummary(),
      commitSha: SHA_A,
      refName: "main",
      evaluatedAt: "2026-05-10T07:00:00.000Z",
    });
    expect(result).toEqual({
      schema_version: 1,
      status: "passed",
      commit_sha: SHA_A,
      ref_name: "main",
      evaluated_at: "2026-05-10T07:00:00.000Z",
      evidence_kinds_observed: ["real-runtime", "real-provider", "real-browser"],
      blocked_reasons: [],
      scenarios_run: 47,
      scenarios_total: 47,
      scenarios_passed: 47,
    });
  });

  it("returns status=failed and empty evidence kinds when the gate did not pass", () => {
    const result = buildRealGreenGateResult({
      summary: failingSummary(),
      commitSha: SHA_A,
      refName: "main",
      evaluatedAt: "2026-05-10T07:00:00.000Z",
    });
    expect(result.status).toBe("failed");
    expect(result.evidence_kinds_observed).toEqual([]);
    expect(result.blocked_reasons).toEqual(["smoke suite is not fully passed"]);
    expect(result.scenarios_run).toBe(47);
    expect(result.scenarios_total).toBe(47);
    expect(result.scenarios_passed).toBe(46);
  });

  it("returns status=errored when the summary carries a terminal error", () => {
    const result = buildRealGreenGateResult({
      summary: erroredSummary(),
      commitSha: SHA_A,
      refName: "main",
      evaluatedAt: "2026-05-10T07:00:00.000Z",
    });
    expect(result.status).toBe("errored");
    expect(result.evidence_kinds_observed).toEqual([]);
    expect(result.blocked_reasons).toContain("smoke suite did not complete");
  });

  it("coerces missing commitSha / refName / evaluatedAt to empty strings without throwing", () => {
    const result = buildRealGreenGateResult({
      summary: passingSummary(),
      commitSha: undefined as unknown as string,
      refName: undefined as unknown as string,
      evaluatedAt: undefined as unknown as string,
    });
    expect(result.commit_sha).toBe("");
    expect(result.ref_name).toBe("");
    expect(result.evaluated_at).toBe("");
  });
});

describe("buildBlockedByEnvResult", () => {
  it("emits status=blocked_by_env with zero scenarios and empty evidence", () => {
    const result = buildBlockedByEnvResult({
      commitSha: SHA_A,
      refName: "main",
      evaluatedAt: "2026-05-10T07:00:00.000Z",
      blockedReasons: ["env_var_missing:FRIDAY_BASE_URL"],
    });
    expect(result).toEqual({
      schema_version: 1,
      status: "blocked_by_env",
      commit_sha: SHA_A,
      ref_name: "main",
      evaluated_at: "2026-05-10T07:00:00.000Z",
      evidence_kinds_observed: [],
      blocked_reasons: ["env_var_missing:FRIDAY_BASE_URL"],
      scenarios_run: 0,
      scenarios_total: 0,
      scenarios_passed: 0,
    });
  });

  it("filters out non-string blocked reasons defensively", () => {
    const result = buildBlockedByEnvResult({
      commitSha: SHA_A,
      refName: "main",
      evaluatedAt: "2026-05-10T07:00:00.000Z",
      blockedReasons: [
        "env_var_missing:FRIDAY_BASE_URL",
        "",
        null as unknown as string,
        42 as unknown as string,
        "env_var_missing:FRIDAY_ACCESS_TOKEN",
      ],
    });
    expect(result.blocked_reasons).toEqual([
      "env_var_missing:FRIDAY_BASE_URL",
      "env_var_missing:FRIDAY_ACCESS_TOKEN",
    ]);
  });
});

describe("validateRealGreenGateResult — accepts only a clean pass", () => {
  function validPassedResult(overrides: Record<string, unknown> = {}) {
    return {
      schema_version: 1,
      status: "passed",
      commit_sha: SHA_A,
      ref_name: "main",
      evaluated_at: "2026-05-10T07:00:00.000Z",
      evidence_kinds_observed: ["real-runtime", "real-provider", "real-browser"],
      blocked_reasons: [],
      scenarios_run: 47,
      scenarios_total: 47,
      scenarios_passed: 47,
      ...overrides,
    };
  }

  it("accepts a well-formed passed result", () => {
    const decision = validateRealGreenGateResult(validPassedResult());
    expect(decision).toEqual({ valid: true, reasons: [] });
  });

  it("rejects a non-object input", () => {
    const decision = validateRealGreenGateResult("not an object" as unknown);
    expect(decision.valid).toBe(false);
    expect(decision.reasons).toContain("not_an_object");
  });

  it("rejects an unsupported schema_version", () => {
    const decision = validateRealGreenGateResult(validPassedResult({ schema_version: 2 }));
    expect(decision.valid).toBe(false);
    expect(decision.reasons).toContain("unsupported_schema_version");
  });

  it("rejects an unknown status string", () => {
    const decision = validateRealGreenGateResult(validPassedResult({ status: "almost_passed" }));
    expect(decision.valid).toBe(false);
    expect(decision.reasons).toContain("status_invalid_or_missing");
  });

  it("rejects status=blocked_by_env even if everything else looks plausible", () => {
    const decision = validateRealGreenGateResult({
      schema_version: 1,
      status: "blocked_by_env",
      commit_sha: SHA_A,
      ref_name: "main",
      evaluated_at: "2026-05-10T07:00:00.000Z",
      evidence_kinds_observed: [],
      blocked_reasons: ["env_var_missing:FRIDAY_BASE_URL"],
      scenarios_run: 0,
      scenarios_total: 0,
      scenarios_passed: 0,
    });
    expect(decision.valid).toBe(false);
    expect(decision.reasons).toContain("status_not_passed:blocked_by_env");
  });

  it("rejects status=failed", () => {
    const decision = validateRealGreenGateResult(validPassedResult({ status: "failed" }));
    expect(decision.valid).toBe(false);
    expect(decision.reasons).toContain("status_not_passed:failed");
  });

  it("rejects status=errored", () => {
    const decision = validateRealGreenGateResult(validPassedResult({ status: "errored" }));
    expect(decision.valid).toBe(false);
    expect(decision.reasons).toContain("status_not_passed:errored");
  });

  it("rejects when commit_sha is missing", () => {
    const decision = validateRealGreenGateResult(validPassedResult({ commit_sha: "" }));
    expect(decision.valid).toBe(false);
    expect(decision.reasons).toContain("commit_sha_missing");
  });

  it("rejects when expectedSha is provided and commit_sha does not match", () => {
    const decision = validateRealGreenGateResult(validPassedResult(), { expectedSha: SHA_B });
    expect(decision.valid).toBe(false);
    expect(decision.reasons).toContain("commit_sha_mismatch");
  });

  it("accepts when expectedSha matches commit_sha exactly", () => {
    const decision = validateRealGreenGateResult(validPassedResult(), { expectedSha: SHA_A });
    expect(decision).toEqual({ valid: true, reasons: [] });
  });

  it("rejects when scenarios_passed !== scenarios_total", () => {
    const decision = validateRealGreenGateResult(
      validPassedResult({ scenarios_total: 47, scenarios_passed: 46 }),
    );
    expect(decision.valid).toBe(false);
    expect(decision.reasons).toContain("scenarios_passed_not_equal_total");
  });

  it("rejects when scenarios_total or scenarios_passed are not finite numbers", () => {
    const decision = validateRealGreenGateResult(
      validPassedResult({ scenarios_total: "47" as unknown, scenarios_passed: null as unknown }),
    );
    expect(decision.valid).toBe(false);
    expect(decision.reasons).toContain("scenarios_total_invalid");
    expect(decision.reasons).toContain("scenarios_passed_invalid");
  });

  it("rejects when blocked_reasons is not an array", () => {
    const decision = validateRealGreenGateResult(
      validPassedResult({ blocked_reasons: null as unknown }),
    );
    expect(decision.valid).toBe(false);
    expect(decision.reasons).toContain("blocked_reasons_invalid");
  });

  it("security regression: rejects status=passed when blocked_reasons is non-empty", () => {
    // Defense-in-depth: even if a future writer marked status=passed alongside
    // a non-empty blocked_reasons, the validator must reject.
    const decision = validateRealGreenGateResult(
      validPassedResult({ blocked_reasons: ["env_var_missing:FRIDAY_BASE_URL"] }),
    );
    expect(decision.valid).toBe(false);
    expect(decision.reasons).toContain("passed_with_blocked_reasons");
  });

  it("rejects status=passed with zero scenarios", () => {
    const decision = validateRealGreenGateResult(
      validPassedResult({ scenarios_total: 0, scenarios_passed: 0, scenarios_run: 0 }),
    );
    expect(decision.valid).toBe(false);
    expect(decision.reasons).toContain("passed_with_zero_scenarios");
  });
});

describe("validator round-trip with the writers", () => {
  it("a passed summary round-trips through builder + validator successfully", () => {
    const built = buildRealGreenGateResult({
      summary: passingSummary(),
      commitSha: SHA_A,
      refName: "main",
      evaluatedAt: "2026-05-10T07:00:00.000Z",
    });
    const decision = validateRealGreenGateResult(built, { expectedSha: SHA_A });
    expect(decision).toEqual({ valid: true, reasons: [] });
  });

  it("a blocked_by_env artifact is rejected by the validator", () => {
    const built = buildBlockedByEnvResult({
      commitSha: SHA_A,
      refName: "main",
      evaluatedAt: "2026-05-10T07:00:00.000Z",
      blockedReasons: ["env_var_missing:FRIDAY_BASE_URL"],
    });
    const decision = validateRealGreenGateResult(built, { expectedSha: SHA_A });
    expect(decision.valid).toBe(false);
    expect(decision.reasons).toContain("status_not_passed:blocked_by_env");
  });

  it("a failing summary is rejected with a non-passed status reason", () => {
    const built = buildRealGreenGateResult({
      summary: failingSummary(),
      commitSha: SHA_A,
      refName: "main",
      evaluatedAt: "2026-05-10T07:00:00.000Z",
    });
    const decision = validateRealGreenGateResult(built, { expectedSha: SHA_A });
    expect(decision.valid).toBe(false);
    expect(decision.reasons).toContain("status_not_passed:failed");
  });
});
