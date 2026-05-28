import { describe, expect, it } from "vitest";

import {
  REAL_GREEN_GATE_RESULT_FILENAME,
  REAL_GREEN_GATE_RESULT_SCHEMA_VERSION,
  REAL_GREEN_GATE_RESULT_STATUSES,
  buildBlockedByEnvResult,
  buildErroredResult,
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
      providerAttemptCount: 0,
      browserProbeAttemptCount: 0,
    },
    dailyCore: {
      resultCounts: { passed: 14 },
      providerAttemptCount: 6,
      browserProbeAttemptCount: 3,
    },
    publicSurface: {
      resultCounts: { passed: 29 },
      providerAttemptCount: 0,
      browserProbeAttemptCount: 18,
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
  it("returns status=passed with only observed evidence kinds when the gate passed", () => {
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
      provider_lane_scope: {
        scope: "default_only",
        fallback_resilience_proven: false,
        note: "No fallback provider lane was exercised in this run.",
      },
    });
  });

  it("does not claim provider or browser evidence when passed suites did not observe those attempts", () => {
    const summary = {
      ...passingSummary(),
      smoke: { resultCounts: { passed: 4 }, providerAttemptCount: 0, browserProbeAttemptCount: 0 },
      dailyCore: { resultCounts: { passed: 3 }, providerAttemptCount: 0, browserProbeAttemptCount: 0 },
      publicSurface: null,
    };
    const result = buildRealGreenGateResult({
      summary,
      commitSha: SHA_A,
      refName: "main",
      evaluatedAt: "2026-05-10T07:00:00.000Z",
    });
    expect(result).toMatchObject({
      status: "passed",
      evidence_kinds_observed: ["real-runtime"],
      scenarios_run: 7,
      scenarios_total: 7,
      scenarios_passed: 7,
    });
  });

  it("counts passed external channel scenarios and reports manual-external evidence", () => {
    const summary = {
      ...passingSummary(),
      externalChannels: {
        resultCounts: { passed: 1 },
        providerAttemptCount: 0,
        browserProbeAttemptCount: 0,
      },
    };
    const result = buildRealGreenGateResult({
      summary,
      commitSha: SHA_A,
      refName: "main",
      evaluatedAt: "2026-05-10T07:00:00.000Z",
    });
    expect(result).toMatchObject({
      status: "passed",
      evidence_kinds_observed: ["real-runtime", "real-provider", "real-browser", "manual-external"],
      scenarios_run: 48,
      scenarios_total: 48,
      scenarios_passed: 48,
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

  it("scopes a single-provider run to default-only and does NOT overclaim fallback resilience", () => {
    const summary = passingSummary();
    (summary.preflight as Record<string, unknown>).envTruth = {
      providerLanes: {
        default: { providerKind: "deepseek", model: "deepseek-v4-pro" },
        fallback: null,
      },
      providerLaneRequirements: { fallbackRequired: false, source: "single_provider_no_fallback_required" },
    };

    const result = buildRealGreenGateResult({
      summary,
      commitSha: SHA_A,
      refName: "main",
      evaluatedAt: "2026-05-28T00:00:00.000Z",
    });

    expect(result.status).toBe(REAL_GREEN_GATE_RESULT_STATUSES.PASSED);
    expect(result.provider_lane_scope.scope).toBe("single_provider_default_only");
    expect(result.provider_lane_scope.fallback_resilience_proven).toBe(false);
    expect(result.provider_lane_scope.note).toMatch(/single-provider default lane ONLY/i);
    expect(result.provider_lane_scope.note).toMatch(/does NOT prove provider fallback resilience/i);
  });

  it("does not prove fallback resilience from lane presence alone", () => {
    const summary = passingSummary();
    (summary.preflight as Record<string, unknown>).envTruth = {
      providerLanes: {
        default: { providerKind: "deepseek", model: "deepseek-v4-pro" },
        fallback: { providerKind: "anthropic", model: "claude-sonnet-4" },
      },
      providerLaneRequirements: { fallbackRequired: true, source: "validated_alternative_available" },
    };

    const result = buildRealGreenGateResult({
      summary,
      commitSha: SHA_A,
      refName: "main",
      evaluatedAt: "2026-05-28T00:00:00.000Z",
    });

    expect(result.provider_lane_scope.scope).toBe("default_and_fallback");
    expect(result.provider_lane_scope.fallback_resilience_proven).toBe(false);
    expect(result.provider_lane_scope.note).toMatch(/does NOT prove fallback resilience/i);
  });

  it("marks fallback resilience proven only when an explicit fallback proof signal exists", () => {
    const summary = {
      ...passingSummary(),
      providerFallbackProof: { status: "passed" },
    };
    (summary.preflight as Record<string, unknown>).envTruth = {
      providerLanes: {
        default: { providerKind: "deepseek", model: "deepseek-v4-pro" },
        fallback: { providerKind: "anthropic", model: "claude-sonnet-4" },
      },
      providerLaneRequirements: { fallbackRequired: true, source: "validated_alternative_available" },
    };

    const result = buildRealGreenGateResult({
      summary,
      commitSha: SHA_A,
      refName: "main",
      evaluatedAt: "2026-05-28T00:00:00.000Z",
    });

    expect(result.provider_lane_scope.scope).toBe("default_and_fallback");
    expect(result.provider_lane_scope.fallback_resilience_proven).toBe(true);
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

describe("buildErroredResult", () => {
  it("emits status=errored with zero scenarios and empty evidence", () => {
    const result = buildErroredResult({
      commitSha: SHA_A,
      refName: "main",
      evaluatedAt: "2026-05-10T07:00:00.000Z",
      blockedReasons: ["self_hosted_runtime_error"],
    });
    expect(result).toEqual({
      schema_version: 1,
      status: "errored",
      commit_sha: SHA_A,
      ref_name: "main",
      evaluated_at: "2026-05-10T07:00:00.000Z",
      evidence_kinds_observed: [],
      blocked_reasons: ["self_hosted_runtime_error"],
      scenarios_run: 0,
      scenarios_total: 0,
      scenarios_passed: 0,
    });
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

  it("rejects a passed artifact that is missing a required evidence kind", () => {
    const decision = validateRealGreenGateResult(
      validPassedResult(),
      { requiredEvidenceKinds: ["manual-external"] },
    );
    expect(decision.valid).toBe(false);
    expect(decision.reasons).toContain("evidence_kind_missing:manual-external");
  });

  it("accepts a passed artifact when the required evidence kind is observed", () => {
    const decision = validateRealGreenGateResult(
      validPassedResult({
        evidence_kinds_observed: ["real-runtime", "real-provider", "real-browser", "manual-external"],
      }),
      { requiredEvidenceKinds: ["manual-external"] },
    );
    expect(decision).toEqual({ valid: true, reasons: [] });
  });

  it("PR #187 review regression: rejects status=passed with all three counts = -1", () => {
    // The exact malformed artifact that an earlier validator wrongly accepted:
    // -1 is finite and -1 === -1, so the previous finite/equality checks were
    // both satisfied. The non-negative-integer check now catches all three.
    const decision = validateRealGreenGateResult(
      validPassedResult({ scenarios_run: -1, scenarios_total: -1, scenarios_passed: -1 }),
    );
    expect(decision.valid).toBe(false);
    expect(decision.reasons).toContain("scenarios_run_invalid");
    expect(decision.reasons).toContain("scenarios_total_invalid");
    expect(decision.reasons).toContain("scenarios_passed_invalid");
  });

  it("rejects negative scenarios_total", () => {
    const decision = validateRealGreenGateResult(
      validPassedResult({ scenarios_total: -1, scenarios_passed: 47, scenarios_run: 47 }),
    );
    expect(decision.valid).toBe(false);
    expect(decision.reasons).toContain("scenarios_total_invalid");
  });

  it("rejects negative scenarios_passed", () => {
    const decision = validateRealGreenGateResult(
      validPassedResult({ scenarios_total: 47, scenarios_passed: -1, scenarios_run: 47 }),
    );
    expect(decision.valid).toBe(false);
    expect(decision.reasons).toContain("scenarios_passed_invalid");
  });

  it("rejects negative scenarios_run", () => {
    const decision = validateRealGreenGateResult(
      validPassedResult({ scenarios_total: 47, scenarios_passed: 47, scenarios_run: -1 }),
    );
    expect(decision.valid).toBe(false);
    expect(decision.reasons).toContain("scenarios_run_invalid");
  });

  it("rejects decimal scenarios_total", () => {
    const decision = validateRealGreenGateResult(
      validPassedResult({ scenarios_total: 47.5, scenarios_passed: 47.5, scenarios_run: 47.5 }),
    );
    expect(decision.valid).toBe(false);
    expect(decision.reasons).toContain("scenarios_total_invalid");
  });

  it("rejects decimal scenarios_passed", () => {
    const decision = validateRealGreenGateResult(
      validPassedResult({ scenarios_total: 47, scenarios_passed: 46.5, scenarios_run: 47 }),
    );
    expect(decision.valid).toBe(false);
    expect(decision.reasons).toContain("scenarios_passed_invalid");
  });

  it("rejects decimal scenarios_run", () => {
    const decision = validateRealGreenGateResult(
      validPassedResult({ scenarios_total: 47, scenarios_passed: 47, scenarios_run: 46.5 }),
    );
    expect(decision.valid).toBe(false);
    expect(decision.reasons).toContain("scenarios_run_invalid");
  });

  it("rejects when scenarios_run !== scenarios_total even if both are valid non-negative integers", () => {
    // status=passed implies the gate ran every expected scenario.
    // run=5 + total=10 + passed=10 is structurally impossible (passed cannot
    // exceed run); the validator rejects with scenarios_run_not_equal_total.
    const decision = validateRealGreenGateResult(
      validPassedResult({ scenarios_run: 5, scenarios_total: 10, scenarios_passed: 10 }),
    );
    expect(decision.valid).toBe(false);
    expect(decision.reasons).toContain("scenarios_run_not_equal_total");
  });

  it("accepts zero as a valid non-negative integer for non-passed statuses", () => {
    // blocked_by_env writes all three counts as 0; the integer check should
    // accept 0 as valid, even though the artifact still gets rejected because
    // status !== passed.
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
    expect(decision.reasons).toEqual(["status_not_passed:blocked_by_env"]);
    expect(decision.reasons).not.toContain("scenarios_run_invalid");
    expect(decision.reasons).not.toContain("scenarios_total_invalid");
    expect(decision.reasons).not.toContain("scenarios_passed_invalid");
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
