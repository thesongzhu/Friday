/**
 * Real Green Gate result artifact — schema, writer helpers, and validator.
 *
 * P4-G1.1 introduces a structured machine-readable artifact that captures the
 * outcome of a `npm run ops:real-green-gate` invocation (or its CI workflow
 * skip path) so that a future release-time gate can decide ship eligibility
 * without depending on workflow exit codes alone.
 *
 * Design boundaries (per docs/release-evidence-policy.md and the P4-G1 design):
 *  - The validator never accepts `blocked_by_env`, `failed`, or `errored` as
 *    pass. The workflow may exit success for plumbing reasons; the artifact's
 *    `status` field tells the truth.
 *  - There is no escape hatch / break-glass / FAST_MODE field.
 *  - The validator accepts a caller-provided evidence-kind policy. Routine
 *    push checks may validate only the structural pass, while release gates
 *    must require the real-provider / real-browser evidence they claim.
 *  - Defense-in-depth: even if the writer ever marked `status: "passed"` while
 *    `blocked_reasons` was non-empty, the validator rejects.
 */

export const REAL_GREEN_GATE_RESULT_FILENAME = "real-green-gate-result.json";
export const REAL_GREEN_GATE_RESULT_SCHEMA_VERSION = 1;

export const REAL_GREEN_GATE_RESULT_STATUSES = Object.freeze({
  PASSED: "passed",
  FAILED: "failed",
  BLOCKED_BY_ENV: "blocked_by_env",
  ERRORED: "errored",
});

const VALID_STATUS_SET = new Set(Object.values(REAL_GREEN_GATE_RESULT_STATUSES));

const SUITE_KEYS = ["smoke", "dailyCore", "publicSurface", "externalChannels"];

function safeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function summarizeSuiteCounts(suite) {
  const counts = suite?.resultCounts ?? suite?.results ?? {};
  let total = 0;
  let passed = 0;
  for (const [key, raw] of Object.entries(counts)) {
    const value = safeNumber(Number(raw));
    total += value;
    if (key === "passed") {
      passed += value;
    }
  }
  return { total, passed };
}

function deriveScenarioCounts(summary) {
  let scenariosTotal = 0;
  let scenariosPassed = 0;
  let scenariosRun = 0;
  for (const key of SUITE_KEYS) {
    const suite = summary?.[key];
    if (!suite) {
      continue;
    }
    const { total, passed } = summarizeSuiteCounts(suite);
    scenariosTotal += total;
    scenariosPassed += passed;
    scenariosRun += total;
  }
  return { scenariosRun, scenariosTotal, scenariosPassed };
}

function deriveStatus(summary) {
  if (summary?.error) {
    return REAL_GREEN_GATE_RESULT_STATUSES.ERRORED;
  }
  if (summary?.gate?.passed === true) {
    return REAL_GREEN_GATE_RESULT_STATUSES.PASSED;
  }
  return REAL_GREEN_GATE_RESULT_STATUSES.FAILED;
}

function deriveBlockedReasons(summary) {
  const reasons = Array.isArray(summary?.gate?.reasons) ? summary.gate.reasons : [];
  return reasons.filter((reason) => typeof reason === "string" && reason.length > 0);
}

function deriveEvidenceKindsObserved(summary, status) {
  if (status !== REAL_GREEN_GATE_RESULT_STATUSES.PASSED) {
    return [];
  }
  const counts = deriveScenarioCounts(summary);
  const observed = [];
  if (counts.scenariosRun > 0) {
    observed.push("real-runtime");
  }
  if (SUITE_KEYS.some((key) => safeNumber(summary?.[key]?.providerAttemptCount) > 0)) {
    observed.push("real-provider");
  }
  if (SUITE_KEYS.some((key) => safeNumber(summary?.[key]?.browserProbeAttemptCount) > 0)) {
    observed.push("real-browser");
  }
  if (safeNumber(summary?.externalChannels?.resultCounts?.passed) > 0) {
    observed.push("manual-external");
  }
  return observed;
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry) => typeof entry === "string" && entry.length > 0)
    .slice();
}

/**
 * Truthfully scope what the provider lanes proved. A run with only one eligible
 * provider proves the single-provider DEFAULT lane only — it does NOT prove
 * provider fallback resilience (that is the explicit, gated C3/C4 lane). This
 * must never be over-claimed as a fallback/resilience proof.
 */
function deriveProviderLaneScope(summary) {
  const envTruth = summary?.preflight?.envTruth ?? {};
  const lanes = envTruth.providerLanes ?? {};
  const requirements = envTruth.providerLaneRequirements ?? {};
  if (lanes.fallback) {
    return {
      scope: "default_and_fallback",
      fallback_resilience_proven: true,
      note: "Default and fallback provider lanes were resolved and exercised.",
    };
  }
  if (requirements.fallbackRequired === false) {
    return {
      scope: "single_provider_default_only",
      fallback_resilience_proven: false,
      note: "Only one eligible provider was available; this run proves the single-provider default lane ONLY and does NOT prove provider fallback resilience. Multi-provider/fallback resilience is the explicit gated C3/C4 provider-routing lane.",
    };
  }
  return {
    scope: "default_only",
    fallback_resilience_proven: false,
    note: "No fallback provider lane was exercised in this run.",
  };
}

/**
 * Build a result artifact from the run-real-green-gate.mjs summary object.
 *
 * @param {object} input
 * @param {object} input.summary  The summary produced by buildSummary() inside run-real-green-gate.mjs.
 * @param {string} input.commitSha  Full 40-char commit SHA (or "" if unknown).
 * @param {string} input.refName  Git ref name (branch or tag).
 * @param {string} input.evaluatedAt  ISO 8601 timestamp.
 */
export function buildRealGreenGateResult({ summary, commitSha, refName, evaluatedAt }) {
  const status = deriveStatus(summary);
  const counts = deriveScenarioCounts(summary);
  const blockedReasons = deriveBlockedReasons(summary);
  return {
    schema_version: REAL_GREEN_GATE_RESULT_SCHEMA_VERSION,
    status,
    commit_sha: typeof commitSha === "string" ? commitSha : "",
    ref_name: typeof refName === "string" ? refName : "",
    evaluated_at: typeof evaluatedAt === "string" ? evaluatedAt : "",
    evidence_kinds_observed: deriveEvidenceKindsObserved(summary, status),
    blocked_reasons: blockedReasons,
    scenarios_run: counts.scenariosRun,
    scenarios_total: counts.scenariosTotal,
    scenarios_passed: counts.scenariosPassed,
    provider_lane_scope: deriveProviderLaneScope(summary),
  };
}

/**
 * Build a result artifact for the workflow skip path (no gate execution).
 *
 * @param {object} input
 * @param {string} input.commitSha
 * @param {string} input.refName
 * @param {string} input.evaluatedAt
 * @param {ReadonlyArray<string>} input.blockedReasons  Stable tokens like "env_var_missing:FRIDAY_BASE_URL".
 */
export function buildBlockedByEnvResult({ commitSha, refName, evaluatedAt, blockedReasons }) {
  return {
    schema_version: REAL_GREEN_GATE_RESULT_SCHEMA_VERSION,
    status: REAL_GREEN_GATE_RESULT_STATUSES.BLOCKED_BY_ENV,
    commit_sha: typeof commitSha === "string" ? commitSha : "",
    ref_name: typeof refName === "string" ? refName : "",
    evaluated_at: typeof evaluatedAt === "string" ? evaluatedAt : "",
    evidence_kinds_observed: [],
    blocked_reasons: normalizeStringList(blockedReasons),
    scenarios_run: 0,
    scenarios_total: 0,
    scenarios_passed: 0,
  };
}

/**
 * Build a result artifact for failures that happen before the normal gate
 * runner can emit its own summary, such as self-hosted runtime boot failure.
 */
export function buildErroredResult({ commitSha, refName, evaluatedAt, blockedReasons }) {
  return {
    schema_version: REAL_GREEN_GATE_RESULT_SCHEMA_VERSION,
    status: REAL_GREEN_GATE_RESULT_STATUSES.ERRORED,
    commit_sha: typeof commitSha === "string" ? commitSha : "",
    ref_name: typeof refName === "string" ? refName : "",
    evaluated_at: typeof evaluatedAt === "string" ? evaluatedAt : "",
    evidence_kinds_observed: [],
    blocked_reasons: normalizeStringList(blockedReasons),
    scenarios_run: 0,
    scenarios_total: 0,
    scenarios_passed: 0,
  };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Validate a parsed result object. Returns { valid, reasons }. Reasons are
 * stable token strings; they never embed validator free-text from the input.
 *
 * @param {unknown} result  The parsed JSON object (NOT a file path).
 * @param {object} [options]
 * @param {string} [options.expectedSha]  If provided, commit_sha must match.
 */
export function validateRealGreenGateResult(result, options = {}) {
  const reasons = [];

  if (!isPlainObject(result)) {
    reasons.push("not_an_object");
    return { valid: false, reasons };
  }

  if (result.schema_version !== REAL_GREEN_GATE_RESULT_SCHEMA_VERSION) {
    reasons.push("unsupported_schema_version");
  }

  if (typeof result.status !== "string" || !VALID_STATUS_SET.has(result.status)) {
    reasons.push("status_invalid_or_missing");
  } else if (result.status !== REAL_GREEN_GATE_RESULT_STATUSES.PASSED) {
    reasons.push(`status_not_passed:${result.status}`);
  }

  if (typeof result.commit_sha !== "string" || result.commit_sha.length === 0) {
    reasons.push("commit_sha_missing");
  } else if (typeof options.expectedSha === "string" && options.expectedSha.length > 0) {
    if (result.commit_sha !== options.expectedSha) {
      reasons.push("commit_sha_mismatch");
    }
  }

  // All three counts must be non-negative integers. Number.isFinite alone is
  // not enough — it accepts negatives and decimals, which are structurally
  // meaningless and would let a malformed `passed` artifact slip through
  // (PR #187 review caught: status=passed with all counts = -1 was accepted).
  const scenariosRunValid = isNonNegativeInteger(result.scenarios_run);
  const scenariosTotalValid = isNonNegativeInteger(result.scenarios_total);
  const scenariosPassedValid = isNonNegativeInteger(result.scenarios_passed);

  if (!scenariosRunValid) {
    reasons.push("scenarios_run_invalid");
  }
  if (!scenariosTotalValid) {
    reasons.push("scenarios_total_invalid");
  }
  if (!scenariosPassedValid) {
    reasons.push("scenarios_passed_invalid");
  }
  if (
    scenariosTotalValid
    && scenariosPassedValid
    && result.scenarios_passed !== result.scenarios_total
  ) {
    reasons.push("scenarios_passed_not_equal_total");
  }
  if (
    scenariosTotalValid
    && scenariosRunValid
    && result.scenarios_run !== result.scenarios_total
  ) {
    reasons.push("scenarios_run_not_equal_total");
  }

  // Defense-in-depth: status=passed must have an empty blocked_reasons.
  // Even if a future writer were to mark status=passed alongside blockers,
  // the validator rejects.
  const blocked = Array.isArray(result.blocked_reasons) ? result.blocked_reasons : null;
  if (blocked === null) {
    reasons.push("blocked_reasons_invalid");
  } else if (
    result.status === REAL_GREEN_GATE_RESULT_STATUSES.PASSED
    && blocked.length > 0
  ) {
    reasons.push("passed_with_blocked_reasons");
  }

  // scenarios_total must be > 0 for a credible pass; a "passed" with zero
  // scenarios is structurally meaningless and often indicates a skipped path.
  if (
    result.status === REAL_GREEN_GATE_RESULT_STATUSES.PASSED
    && scenariosTotalValid
    && result.scenarios_total === 0
  ) {
    reasons.push("passed_with_zero_scenarios");
  }

  const requiredEvidenceKinds = Array.isArray(options.requiredEvidenceKinds)
    ? options.requiredEvidenceKinds.filter((value) => typeof value === "string" && value.length > 0)
    : [];
  if (requiredEvidenceKinds.length > 0 && result.status === REAL_GREEN_GATE_RESULT_STATUSES.PASSED) {
    const observed = Array.isArray(result.evidence_kinds_observed) ? result.evidence_kinds_observed : [];
    for (const requiredKind of requiredEvidenceKinds) {
      if (!observed.includes(requiredKind)) {
        reasons.push(`evidence_kind_missing:${requiredKind}`);
      }
    }
  }

  return { valid: reasons.length === 0, reasons };
}
