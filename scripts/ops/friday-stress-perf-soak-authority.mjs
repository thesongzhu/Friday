#!/usr/bin/env node
/**
 * friday-stress-perf-soak-authority.mjs
 *
 * TEST-STRESS-PERF-SOAK-AUTHORITY-001 (#47, R13 EXHAUSTIVE-STRESS).
 *
 * A PROVISIONAL-ONLY, NON-AUTHORITY perf/soak resource-report harness. It binds
 * the AGENT-COMPUTABLE half of the R13 `FRIDAY_STRESS_RESOURCE_REPORT.json`
 * contract:
 *   1. the locked 96 R7 metric-instance census (denominator),
 *   2. a deterministic, independently-checkable R7 statistics recompute
 *      (linear_r7 quantile + seeded percentile-bootstrap CI) over
 *      CLEARLY-SYNTHETIC fixture samples,
 *   3. the resource-budget growth-slope structure,
 *   4. canonical-finite-timestamp + continuity + duration soak VALIDATION,
 *   5. the 8-boolean host-safety preflight structure,
 *   6. the RED-first sensitivity detectors (short_*_soak / metric_weakening /
 *      non-canonical-timestamp / <96-metric-count).
 *
 * IT CAN NEVER SELF-SEAL. The real soaks (Hub 72h, iOS 24h, Android 24h,
 * uninterrupted) and the physical signed device campaigns are OPERATOR- and
 * PHYSICALLY-gated: this harness NEVER synthesises uninterrupted-72h/24h soak
 * evidence and NEVER fabricates physical-device identity. `seal_status` is always
 * `PROVISIONAL_UNSEALED`; the emitted report's `soaks[]` are HONEST provisional
 * placeholders that do NOT pass, so the INDEPENDENT R13 validator correctly REDs
 * (SOAK_INVALID) rather than being deceived. A self-reported "72h/96 passed" is
 * forbidden and never emitted. A `FRIDAY_STRESS_RESOURCE_REPORT.SEAL_STATUS.json`
 * sidecar (NOT a validator-graded artifact) names every provisional/gated reason
 * and records that every required sensitivity detector demonstrably turned RED.
 *
 * The 96 metric-instance ids are NOT invented here: they are re-expanded from the
 * operator-frozen `metric_matrix_rules` (see ./lib/friday-perf-metric-instances.locked.mjs
 * for provenance) with the EXACT algorithm of the authoritative product-policy
 * validator and REQUIRED to reproduce the operator-locked per-rule and global
 * `metric_instance_set_sha256` hashes; any drift => RED (LOCKED_METRIC_SET_DRIFT).
 *
 * NO ARBITRARY WRITE CAPABILITY: the CLI writes ONLY to the single `--out` path
 * (and its sibling sidecar / `raw/` dir); there is NO env/argv route to an
 * arbitrary destination and NO env-gated write primitive. Test fault-injection is
 * done by importing the exported pure functions in-process.
 *
 * Exit: 0 = an honest PROVISIONAL bundle was produced (0 does NOT mean sealed/PASS;
 * a loud PROVISIONAL_UNSEALED banner is printed to stderr). 3 = RED (locked-set
 * drift, a recompute self-check failure, a sensitivity detector that failed to
 * fire, or an internal invariant break). 4 = `--strict` and not SEALED (always the
 * case agent-side) — the only exit-code path that fails a `&& GATE` wrapper closed.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  LOCKED_METRIC_MATRIX_RULES,
  LOCKED_METRIC_INSTANCE_SET_SHA256,
  LOCKED_METRIC_INSTANCE_COUNT,
  LOCKED_STATISTICS_POLICY,
  LOCKED_STATS_RECOMPUTE_OPTS,
  LOCKED_STATS_RECOMPUTE_OPTS_SHA256,
  PERFORMANCE_POLICY_FROZEN_AT,
} from "./lib/friday-perf-metric-instances.locked.mjs";

// ---------------------------------------------------------------------------
// (A) Canonicalisation mirrored BYTE-FOR-BYTE from the R13 evidence validator
//     tools/verify-endbar-stress-evidence-r13.mjs:8-9 (used for evidence-ref /
//     tuple digests so this harness speaks the validator's exact dialect).
// ---------------------------------------------------------------------------
export const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
export const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
          .join(",")}}`
      : JSON.stringify(value);
export const digestOf = (value) => sha(Buffer.from(canonical(value)));

// ---------------------------------------------------------------------------
// (B) Metric-instance expansion mirrored from the authoritative product-policy
//     validator (tools/endbar-product-policy/product-policy-validator.mjs). This
//     is a DISTINCT canonicalisation (utf8-ordered stableJson) — it is the one
//     that produced the operator-locked expanded_instance_set_sha256 hashes, so
//     it MUST be reproduced exactly to authenticate the 96 ids.
// ---------------------------------------------------------------------------
const compareUtf8 = (left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compareUtf8).map((k) => [k, stableValue(value[k])]));
  }
  return value;
};
const stableJson = (value) => JSON.stringify(stableValue(value));
const policySha256 = (value) => crypto.createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");

// Byte-for-byte the validator's `instanceRowsForRule` (same field order + values).
export function instanceRowsForRule(rule) {
  return [...rule.profile_ids].sort(compareUtf8).map((profileId) => ({
    metric_instance_id: `perf:${policySha256(`${rule.metric_id}\0${profileId}\0${rule.scenario_id}`).slice(0, 40)}`,
    metric_id: rule.metric_id,
    policy_profile_id: profileId,
    scenario_id: rule.scenario_id,
    unit: rule.unit,
    p95_budget: rule.p95_budget,
    measurement_semantics_id: rule.measurement_semantics_id,
  }));
}

// The authoritative product-policy hashes for a rule / the whole rule set, using
// the mirrored algorithm. Exported so a test can INDEPENDENTLY confirm the vendored
// rules reproduce the operator-locked hashes (and that a tampered rule breaks them).
export function expandedInstanceSetSha256(rule) {
  return policySha256(instanceRowsForRule(rule));
}
export function globalMetricInstanceSetSha256(rules) {
  const all = rules.flatMap(instanceRowsForRule).sort((a, b) => compareUtf8(a.metric_instance_id, b.metric_instance_id));
  return policySha256(all);
}

export class Red extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Re-derive the locked 96 metric instances and SELF-AUTHENTICATE them against the
 * operator-frozen hashes. Returns the full instance rows (sorted by instance id).
 * Throws Red(LOCKED_METRIC_SET_DRIFT) if the vendored rules or the algorithm fail
 * to reproduce ANY per-rule hash, the global set hash, or the count of 96.
 */
export function deriveLockedMetricInstances() {
  for (const rule of LOCKED_METRIC_MATRIX_RULES) {
    const rows = instanceRowsForRule(rule);
    if (rows.length !== rule.expanded_instance_count) {
      throw new Red("LOCKED_METRIC_SET_DRIFT", { rule_id: rule.rule_id, reason: "expanded_count_mismatch", got: rows.length, want: rule.expanded_instance_count });
    }
    const perRule = policySha256(rows);
    if (perRule !== rule.expanded_instance_set_sha256) {
      throw new Red("LOCKED_METRIC_SET_DRIFT", { rule_id: rule.rule_id, reason: "per_rule_hash_mismatch", got: perRule, want: rule.expanded_instance_set_sha256 });
    }
  }
  const all = LOCKED_METRIC_MATRIX_RULES.flatMap(instanceRowsForRule).sort((a, b) => compareUtf8(a.metric_instance_id, b.metric_instance_id));
  if (all.length !== LOCKED_METRIC_INSTANCE_COUNT) {
    throw new Red("LOCKED_METRIC_SET_DRIFT", { reason: "count_mismatch", got: all.length, want: LOCKED_METRIC_INSTANCE_COUNT });
  }
  if (new Set(all.map((r) => r.metric_instance_id)).size !== all.length) {
    throw new Red("LOCKED_METRIC_SET_DRIFT", { reason: "instance_id_collision" });
  }
  const globalSha = policySha256(all);
  if (globalSha !== LOCKED_METRIC_INSTANCE_SET_SHA256) {
    throw new Red("LOCKED_METRIC_SET_DRIFT", { reason: "global_set_hash_mismatch", got: globalSha, want: LOCKED_METRIC_INSTANCE_SET_SHA256 });
  }
  return all;
}

export function lockedMetricInstanceIds() {
  return deriveLockedMetricInstances().map((r) => r.metric_instance_id);
}

// ---------------------------------------------------------------------------
// (C) EXACT R7 statistics recompute. This is the seal-truth analog: a fabricated
//     or weakened estimator is a false green, so the recompute is a REAL,
//     deterministic estimator that is independently checkable (same samples +
//     same locked seed => byte-identical p95/CI; golden values pinned in tests).
// ---------------------------------------------------------------------------

// Type-7 (R-7 / "linear_r7") linear-interpolation quantile over a SORTED array.
export function linearR7Quantile(sorted, p) {
  const n = sorted.length;
  if (n === 0 || !Number.isFinite(p)) return NaN;
  if (n === 1) return sorted[0];
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, n - 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

// Deterministic PRNG (mulberry32). A fixed seed => a fixed resample stream, so the
// bootstrap CI is reproducible and independently re-derivable.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Seeded percentile-bootstrap CI for the p-quantile. Deterministic in (samples,
// seed, iterations). Uses the operator-locked seed/iterations/confidence by default.
export function percentileBootstrapCi(samples, p, opts = {}) {
  const seed = opts.seed ?? LOCKED_STATISTICS_POLICY.bootstrap_seed;
  const iterations = opts.iterations ?? LOCKED_STATISTICS_POLICY.bootstrap_iterations;
  const confidence = opts.confidence ?? LOCKED_STATISTICS_POLICY.confidence_level;
  const n = samples.length;
  if (n === 0) return { low: NaN, high: NaN };
  const rng = mulberry32(seed);
  const stats = new Array(iterations);
  const buf = new Array(n);
  for (let i = 0; i < iterations; i += 1) {
    for (let j = 0; j < n; j += 1) buf[j] = samples[Math.floor(rng() * n)];
    buf.sort((x, y) => x - y);
    stats[i] = linearR7Quantile(buf, p);
  }
  stats.sort((x, y) => x - y);
  const alpha = (1 - confidence) / 2;
  return { low: linearR7Quantile(stats, alpha), high: linearR7Quantile(stats, 1 - alpha) };
}

/**
 * Recompute one metric-instance row from raw measured samples (+ warmups) using
 * the EXACT R7 method. Returns the R13 resource-report row PLUS the derived
 * statistics (so the recompute is inspectable). `result === "passed"` requires
 * warmups >= 5 AND raw_samples >= 50 AND p95_ci_upper_pass AND
 * relative_ci_width_percent <= 15 — the same gate the R13 validator enforces.
 */
export function recomputeMetric({ metric_instance_id, samples, warmups, budget, evidence_refs, statsOpts }) {
  if (!Array.isArray(samples) || samples.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
    throw new Red("RECOMPUTE_SAMPLES_INVALID", { metric_instance_id });
  }
  if (typeof budget !== "number" || !(budget > 0)) throw new Red("RECOMPUTE_BUDGET_INVALID", { metric_instance_id });
  const warmupCount = typeof warmups === "number" ? warmups : Array.isArray(warmups) ? warmups.length : 0;
  const raw = samples.length;
  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = linearR7Quantile(sorted, 0.5);
  const p95 = linearR7Quantile(sorted, 0.95);
  const ci = percentileBootstrapCi(samples, 0.95, statsOpts);
  const relativeCiWidth = p95 > 0 ? (ci.high - ci.low) / p95 : Infinity;
  const relativeCiWidthPercent = relativeCiWidth * 100;
  const p95CiUpperPass = Number.isFinite(ci.high) && ci.high <= budget;
  const result =
    warmupCount >= WARMUPS_MIN &&
    raw >= RAW_SAMPLES_MIN &&
    p95CiUpperPass &&
    Number.isFinite(relativeCiWidthPercent) &&
    relativeCiWidthPercent <= MAX_RELATIVE_CI_WIDTH_PERCENT
      ? "passed"
      : "failed";
  return {
    row: {
      metric_id: metric_instance_id,
      warmups: warmupCount,
      raw_samples: raw,
      p95_ci_upper_pass: p95CiUpperPass,
      relative_ci_width_percent: relativeCiWidthPercent,
      result,
      evidence_refs,
    },
    stats: { p50, p95, p95_ci_low: ci.low, p95_ci_high: ci.high, p95_budget: budget, relative_ci_width: relativeCiWidth },
  };
}

// Least-squares growth slope over an ordered resource sample series. Agent-computable
// structure for resource_budgets{ bounded, growth_slope_pass, teardown_baseline_restored }.
export function recomputeResourceBudget({ samples, cap, baseline, teardownTolerance = 0.05, slopeTolerance = 0 }) {
  if (!Array.isArray(samples) || samples.length < 2 || samples.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
    throw new Red("RESOURCE_BUDGET_SAMPLES_INVALID");
  }
  const n = samples.length;
  const meanX = (n - 1) / 2;
  const meanY = samples.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (i - meanX) * (samples[i] - meanY);
    den += (i - meanX) * (i - meanX);
  }
  const slope = den === 0 ? 0 : num / den;
  const peak = Math.max(...samples);
  const bounded = typeof cap === "number" ? peak <= cap : true;
  const growthSlopePass = slope <= slopeTolerance;
  const teardownBaselineRestored =
    typeof baseline === "number" ? samples[n - 1] <= baseline * (1 + teardownTolerance) : true;
  const result = bounded && growthSlopePass && teardownBaselineRestored ? "passed" : "failed";
  return { bounded, growth_slope_pass: growthSlopePass, teardown_baseline_restored: teardownBaselineRestored, result, slope, peak };
}

// ---------------------------------------------------------------------------
// (D) Locked resource-report shape + thresholds. Mirrored from the R13 validator
//     (tools/verify-endbar-stress-evidence-r13.mjs lines 60 & 64). A drift-lock
//     unit test binds these to the vendored validator source so a silent
//     divergence from the authoritative validator goes RED.
// ---------------------------------------------------------------------------
export const RESOURCE_REPORT_SCHEMA_VERSION = "friday.endbar.stress-resource-report.r13.v1";
export const SEAL_STATUS_SCHEMA_VERSION = "friday.stress.resource-report-seal-status.r13.v1";
export const RESOURCE_REPORT_KEYS = Object.freeze(["schema_version", "contract_revision", "final_release_candidate_tuple_sha256", "performance_metrics", "resource_budgets", "soaks", "host_safety"]);
export const PERF_METRIC_KEYS = Object.freeze(["metric_id", "warmups", "raw_samples", "p95_ci_upper_pass", "relative_ci_width_percent", "result", "evidence_refs"]);
export const RESOURCE_BUDGET_KEYS = Object.freeze(["resource_budget_id", "bounded", "growth_slope_pass", "teardown_baseline_restored", "result", "evidence_refs"]);
export const SOAK_KEYS = Object.freeze(["campaign_id", "platform_id", "started_at", "completed_at", "uninterrupted", "final_release_candidate_tuple_sha256", "result", "evidence_refs"]);
export const HOST_SAFETY_KEYS = Object.freeze(["isolated_non_prod", "hard_quotas", "scratch_keychain", "owned_processes_only", "prod_ports_untouched", "prod_db_data_services_untouched", "destructive_host_lifecycle_absent", "preflight_passed", "evidence_refs"]);
export const WARMUPS_MIN = 5;
export const RAW_SAMPLES_MIN = 50;
export const MAX_RELATIVE_CI_WIDTH_PERCENT = 15;
export const SOAK_NEED_HOURS = Object.freeze({ hub: 72, ios: 24, android: 24 });
const CONTRACT_REVISION = "ENDBAR-20260713-R13-EXHAUSTIVE-STRESS";

function exactKeys(obj, keys) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const a = Object.keys(obj).sort();
  const b = [...keys].sort();
  return a.length === b.length && a.every((k, i) => k === b[i]);
}
function setEqual(a, b) {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}
// Evidence-ref SHAPE check (mirrors the shape half of the validator's ref(): exact
// keys, raw/ prefix, 64-hex sha, positive int bytes, string kind). It intentionally
// does NOT touch the filesystem so it can grade in-memory reports and fixtures.
function refShapeOk(r) {
  return (
    exactKeys(r, ["path", "sha256", "bytes", "kind"]) &&
    typeof r.path === "string" &&
    r.path.startsWith("raw/") &&
    typeof r.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(r.sha256) &&
    Number.isInteger(r.bytes) &&
    r.bytes >= 1 &&
    typeof r.kind === "string" &&
    r.kind.length > 0
  );
}
function refsShapeOk(x) {
  return Array.isArray(x) && x.length >= 1 && x.every(refShapeOk);
}

/**
 * NON-AUTHORITATIVE, resource-report-scoped SUBSET of the vendored R13 validator's
 * resource gates (lines 60 & 64) PLUS canonical-finite-timestamp + monotonic continuity +
 * duration. Returns { result: "GREEN"|"RED", code, detail }.
 *
 * This is a FAST in-process tripwire used ONLY to flip the sensitivity detectors — it is
 * NOT the authority for any SOAK_INVALID / HOST_SAFETY_INVALID claim. It deliberately
 * CANNOT reproduce the real validator's ledger-derived bindings (e.g. the obligation-derived
 * resource-budget / performance-metric denominators, tuple/component reconciliation across
 * the 10-doc bundle), because it sees only the resource report in isolation. The
 * AUTHORITATIVE oracle is the vendored `verify-endbar-stress-evidence-r13` validator,
 * EXECUTED end-to-end over a complete fixture in the (FIX 4) test — so this mirror is never
 * the sole oracle. `lockedMetricIds` defaults to the self-authenticated locked 96 so the
 * one denominator this subset DOES enforce can never be silently shrunk.
 */
export function validateResourceReport(report, opts = {}) {
  const lockedMetricIds = opts.lockedMetricIds ?? lockedMetricInstanceIds();
  const expectTuple = opts.tuple ?? null;
  const RED = (code, detail = {}) => ({ result: "RED", code, detail });
  try {
    if (!exactKeys(report, RESOURCE_REPORT_KEYS)) return RED("RESOURCE_REPORT_SHAPE");
    if (report.schema_version !== RESOURCE_REPORT_SCHEMA_VERSION) return RED("RESOURCE_REPORT_SCHEMA_VERSION");
    if (typeof report.final_release_candidate_tuple_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(report.final_release_candidate_tuple_sha256)) return RED("RESOURCE_REPORT_TUPLE");
    if (expectTuple && report.final_release_candidate_tuple_sha256 !== expectTuple) return RED("RESOURCE_REPORT_TUPLE_DRIFT");
    if (!Array.isArray(report.performance_metrics) || !Array.isArray(report.resource_budgets) || !Array.isArray(report.soaks)) return RED("RESOURCE_REPORT_SHAPE");

    // --- performance metrics (validator line 60 metric loop) ---
    const seenMetric = new Set();
    for (const m of report.performance_metrics) {
      if (!exactKeys(m, PERF_METRIC_KEYS)) return RED("PERFORMANCE_METRIC_INVALID", { metric: m && m.metric_id, reason: "shape" });
      if (seenMetric.has(m.metric_id)) return RED("PERFORMANCE_METRIC_INVALID", { metric: m.metric_id, reason: "duplicate" });
      if (typeof m.warmups !== "number" || m.warmups < WARMUPS_MIN) return RED("PERFORMANCE_METRIC_INVALID", { metric: m.metric_id, reason: "warmups" });
      if (typeof m.raw_samples !== "number" || m.raw_samples < RAW_SAMPLES_MIN) return RED("PERFORMANCE_METRIC_INVALID", { metric: m.metric_id, reason: "raw_samples" });
      if (m.p95_ci_upper_pass !== true) return RED("PERFORMANCE_METRIC_INVALID", { metric: m.metric_id, reason: "p95_ci_upper_pass" });
      if (typeof m.relative_ci_width_percent !== "number" || m.relative_ci_width_percent > MAX_RELATIVE_CI_WIDTH_PERCENT) return RED("PERFORMANCE_METRIC_INVALID", { metric: m.metric_id, reason: "relative_ci_width_percent" });
      if (m.result !== "passed") return RED("PERFORMANCE_METRIC_INVALID", { metric: m.metric_id, reason: "result" });
      if (!refsShapeOk(m.evidence_refs)) return RED("PERFORMANCE_METRIC_INVALID", { metric: m.metric_id, reason: "evidence_refs" });
      seenMetric.add(m.metric_id);
    }
    if (seenMetric.size !== LOCKED_METRIC_INSTANCE_COUNT || lockedMetricIds.length !== LOCKED_METRIC_INSTANCE_COUNT || !setEqual([...seenMetric], lockedMetricIds)) {
      return RED("PERFORMANCE_DENOMINATOR", { rows: seenMetric.size, declared: lockedMetricIds.length });
    }

    // --- resource budgets ---
    const seenBudget = new Set();
    for (const b of report.resource_budgets) {
      if (!exactKeys(b, RESOURCE_BUDGET_KEYS) || seenBudget.has(b.resource_budget_id)) return RED("RESOURCE_BUDGET_INVALID", { budget: b && b.resource_budget_id });
      if (b.bounded !== true || b.growth_slope_pass !== true || b.teardown_baseline_restored !== true || b.result !== "passed") return RED("RESOURCE_BUDGET_INVALID", { budget: b.resource_budget_id });
      if (!refsShapeOk(b.evidence_refs)) return RED("RESOURCE_BUDGET_INVALID", { budget: b.resource_budget_id, reason: "evidence_refs" });
      seenBudget.add(b.resource_budget_id);
    }

    // --- soaks (validator line 60 soak loop + line 64 canonical timestamp) ---
    const soakSeen = new Set();
    for (const s of report.soaks) {
      if (!exactKeys(s, SOAK_KEYS) || soakSeen.has(s.platform_id) || !Object.hasOwn(SOAK_NEED_HOURS, s.platform_id)) return RED("SOAK_INVALID", { platform: s && s.platform_id });
      if (s.uninterrupted !== true || s.result !== "passed") return RED("SOAK_INVALID", { platform: s.platform_id, reason: "not_passed" });
      if (expectTuple && s.final_release_candidate_tuple_sha256 !== expectTuple) return RED("SOAK_INVALID", { platform: s.platform_id, reason: "tuple" });
      if (typeof s.final_release_candidate_tuple_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(s.final_release_candidate_tuple_sha256)) return RED("SOAK_INVALID", { platform: s.platform_id, reason: "tuple_shape" });
      const start = Date.parse(s.started_at);
      const end = Date.parse(s.completed_at);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return RED("SOAK_INVALID", { platform: s.platform_id, reason: "unparseable_timestamp" });
      // line 64: canonical finite ISO round-trip.
      if (new Date(start).toISOString() !== s.started_at || new Date(end).toISOString() !== s.completed_at) return RED("SOAK_TIMESTAMP_INVALID", { platform: s.platform_id });
      if (!(end > start)) return RED("SOAK_INVALID", { platform: s.platform_id, reason: "non_monotonic" });
      if (end - start < SOAK_NEED_HOURS[s.platform_id] * 3600000) return RED("SOAK_INVALID", { platform: s.platform_id, reason: "short_soak" });
      if (!refsShapeOk(s.evidence_refs)) return RED("SOAK_INVALID", { platform: s.platform_id, reason: "evidence_refs" });
      soakSeen.add(s.platform_id);
    }
    if (!setEqual([...soakSeen], Object.keys(SOAK_NEED_HOURS))) return RED("SOAK_DENOMINATOR", { seen: [...soakSeen].sort() });

    // --- host safety ---
    const hs = report.host_safety;
    if (!exactKeys(hs, HOST_SAFETY_KEYS)) return RED("HOST_SAFETY_INVALID", { reason: "shape" });
    for (const [k, v] of Object.entries(hs)) {
      if (k === "evidence_refs") continue;
      if (v !== true) return RED("HOST_SAFETY_INVALID", { field: k });
    }
    if (!refsShapeOk(hs.evidence_refs)) return RED("HOST_SAFETY_INVALID", { reason: "evidence_refs" });

    return { result: "GREEN", code: null, detail: {} };
  } catch (error) {
    return RED("VALIDATE_UNEXPECTED", { detail: String(error) });
  }
}

// ---------------------------------------------------------------------------
// (E) RED-first sensitivity detectors. Each mutation of a would-be-GREEN reference
//     MUST flip validateResourceReport to RED. `buildSensitivityReferenceReport`
//     builds a STRUCTURALLY-COMPLETE in-memory detector fixture — it is NEVER
//     written to disk and NEVER presented as real soak/device evidence; it exists
//     only so a short/weakened mutation has a green baseline to break.
// ---------------------------------------------------------------------------
function placeholderRef(kind, tag) {
  return { path: `raw/${tag}.json`, sha256: sha(Buffer.from(`${kind}:${tag}`)), bytes: Math.max(1, tag.length), kind };
}
function isoAfter(startIso, hours) {
  return new Date(Date.parse(startIso) + hours * 3600000).toISOString();
}

export function buildSensitivityReferenceReport(tuple) {
  const tupleSha = tuple ?? "f".repeat(64);
  const instances = deriveLockedMetricInstances();
  const performance_metrics = instances.map((inst) => ({
    metric_id: inst.metric_instance_id,
    warmups: 5,
    raw_samples: 50,
    p95_ci_upper_pass: true,
    relative_ci_width_percent: 7.5,
    result: "passed",
    evidence_refs: [placeholderRef("stress_resource_sample", `perf-ref-${inst.metric_instance_id.slice(5, 17)}`)],
  }));
  const resource_budgets = [
    { resource_budget_id: "budget:hub-rss", bounded: true, growth_slope_pass: true, teardown_baseline_restored: true, result: "passed", evidence_refs: [placeholderRef("stress_resource_sample", "budget-hub-rss")] },
  ];
  const startIso = "2026-07-01T00:00:00.000Z";
  const soaks = Object.entries(SOAK_NEED_HOURS).map(([platform, hours]) => ({
    campaign_id: `soak:${platform}`,
    platform_id: platform,
    started_at: startIso,
    completed_at: isoAfter(startIso, hours + 1),
    uninterrupted: true,
    final_release_candidate_tuple_sha256: tupleSha,
    result: "passed",
    evidence_refs: [placeholderRef("stress_soak_sample", `soak-${platform}`)],
  }));
  const host_safety = {
    isolated_non_prod: true,
    hard_quotas: true,
    scratch_keychain: true,
    owned_processes_only: true,
    prod_ports_untouched: true,
    prod_db_data_services_untouched: true,
    destructive_host_lifecycle_absent: true,
    preflight_passed: true,
    evidence_refs: [placeholderRef("stress_host_safety", "host-safety-preflight")],
  };
  return {
    schema_version: RESOURCE_REPORT_SCHEMA_VERSION,
    contract_revision: CONTRACT_REVISION,
    final_release_candidate_tuple_sha256: tupleSha,
    performance_metrics,
    resource_budgets,
    soaks,
    host_safety,
  };
}

// The required RED-first detectors for this slice. Each returns a mutated report
// that MUST make validateResourceReport go RED with the expected code.
export const SENSITIVITY_DETECTORS = Object.freeze({
  short_hub_soak: (r) => mutate(r, (c) => {
    const s = c.soaks.find((x) => x.platform_id === "hub");
    s.completed_at = isoAfter(s.started_at, SOAK_NEED_HOURS.hub - 1); // < 72h
  }),
  short_ios_soak: (r) => mutate(r, (c) => {
    const s = c.soaks.find((x) => x.platform_id === "ios");
    s.completed_at = isoAfter(s.started_at, SOAK_NEED_HOURS.ios - 1); // < 24h
  }),
  short_android_soak: (r) => mutate(r, (c) => {
    const s = c.soaks.find((x) => x.platform_id === "android");
    s.completed_at = isoAfter(s.started_at, SOAK_NEED_HOURS.android - 1); // < 24h
  }),
  metric_weakening_ci_width: (r) => mutate(r, (c) => {
    c.performance_metrics[0].relative_ci_width_percent = 15.01; // > 15%
  }),
  metric_weakening_p95_ci_upper: (r) => mutate(r, (c) => {
    c.performance_metrics[0].p95_ci_upper_pass = false;
  }),
  metric_weakening_result: (r) => mutate(r, (c) => {
    c.performance_metrics[0].result = "failed";
  }),
  non_canonical_timestamp: (r) => mutate(r, (c) => {
    // parseable but NOT canonical-round-trip (no milliseconds / offset form).
    const s = c.soaks.find((x) => x.platform_id === "hub");
    s.started_at = "2026-07-01T00:00:00Z";
    s.completed_at = isoAfter("2026-07-01T00:00:00.000Z", SOAK_NEED_HOURS.hub + 1);
  }),
  metric_count_below_96: (r) => mutate(r, (c) => {
    c.performance_metrics.pop(); // 95 rows
  }),
});
function mutate(report, fn) {
  const clone = structuredClone(report);
  fn(clone);
  return clone;
}

/**
 * Run every required detector against a fresh reference fixture and confirm each
 * one turns validateResourceReport RED (and the un-mutated reference is GREEN).
 * Returns { reference_green, detectors: [{detector_id, turned_red, code}], all_fired }.
 */
export function runSensitivity(tuple) {
  const reference = buildSensitivityReferenceReport(tuple);
  const referenceVerdict = validateResourceReport(reference, { tuple: reference.final_release_candidate_tuple_sha256 });
  const detectors = [];
  for (const [detector_id, apply] of Object.entries(SENSITIVITY_DETECTORS)) {
    const mutated = apply(reference);
    const verdict = validateResourceReport(mutated, { tuple: reference.final_release_candidate_tuple_sha256 });
    detectors.push({ detector_id, turned_red: verdict.result === "RED", code: verdict.code });
  }
  return {
    reference_green: referenceVerdict.result === "GREEN",
    detectors,
    all_fired: referenceVerdict.result === "GREEN" && detectors.every((d) => d.turned_red),
  };
}

// ---------------------------------------------------------------------------
// (F) CLEARLY-SYNTHETIC fixture samples. Deterministically derived from the metric
//     instance id — NOT physical-device measurements. Labeled `synthetic_fixture`
//     everywhere. Values sit comfortably under budget with low variance so the
//     recompute yields a passing row: this exercises the recompute engine, it is
//     NOT a claim that the real 96 metrics passed on a device.
// ---------------------------------------------------------------------------
export function syntheticSamplesFor(metricInstanceId, budget, count = 50, warmups = 5) {
  const seed = parseInt(policySha256(metricInstanceId).slice(0, 8), 16) >>> 0;
  const rng = mulberry32(seed);
  const center = budget * 0.4; // well under budget
  const spread = budget * 0.05; // tight -> small relative CI width
  const gen = () => {
    const v = center + (rng() - 0.5) * 2 * spread;
    return v < 0 ? 0 : v;
  };
  return { samples: Array.from({ length: count }, gen), warmupSamples: Array.from({ length: warmups }, gen) };
}

// ---------------------------------------------------------------------------
// (G) HONEST GATED host-safety placeholder. FIX 2 (P0 evidence-truth): an agent CANNOT
//     truthfully attest host isolation / hard quotas / scratch keychain / owned-process /
//     prod-port + prod-DB untouched / destructive-lifecycle-absent for a REAL stress
//     campaign harness — those are operator- and physically-gated observations. So every
//     one of the 8 booleans is emitted as `false` (a non-passing placeholder, exactly like
//     soaks[]), and the independent R13 validator correctly REDs (HOST_SAFETY_INVALID) once
//     it reaches the host-safety gate. There is NO fabricated preflight_passed=true. The
//     generator-only, non-authoritative status/basis disclosure lives OUTSIDE these
//     authoritative fields — in the SEAL_STATUS sidecar — so nothing here over-claims.
// ---------------------------------------------------------------------------
export const HOST_SAFETY_STATUS_GATED = "operator_physical_gated";
function hostSafetyGatedPlaceholder() {
  return {
    isolated_non_prod: false,
    hard_quotas: false,
    scratch_keychain: false,
    owned_processes_only: false,
    prod_ports_untouched: false,
    prod_db_data_services_untouched: false,
    destructive_host_lifecycle_absent: false,
    preflight_passed: false,
  };
}

// ---------------------------------------------------------------------------
// (H) PROVISIONAL report builder. Emits a schema-shaped FRIDAY_STRESS_RESOURCE_REPORT
//     whose agent-computable halves (perf census recompute over synthetic samples,
//     resource-budget structure, host-safety preflight) are structurally real, and
//     whose soaks[] are HONEST provisional placeholders that do NOT pass (so the
//     independent R13 validator REDs at SOAK_INVALID). NEVER synthesises a passing
//     72h/24h soak or a physical device identity.
// ---------------------------------------------------------------------------
// Internal, deeply-frozen PLAIN-SCALAR snapshot of the locked recompute policy. The report
// path computes the 96 recomputes ONLY from THESE primitives — never from a caller-supplied
// object, getter, or proxy. This is the single source of the estimator's seed/iterations/
// confidence.
export const LOCKED_STATS_INTERNAL_SNAPSHOT = Object.freeze({
  seed: Number(LOCKED_STATS_RECOMPUTE_OPTS.seed),
  iterations: Number(LOCKED_STATS_RECOMPUTE_OPTS.iterations),
  confidence: Number(LOCKED_STATS_RECOMPUTE_OPTS.confidence),
});

/**
 * The report-producing path MUST use ONLY the locked R7 statistics policy, and MUST NOT be
 * influenceable by a caller object even one that passes validation (the Advisor's TOCTOU:
 * an enumerable-getter / Proxy statsOpts that returns the locked values during validation
 * and weakened values during the 96 bootstrap reads, or an object mutated after validation).
 *
 * If a caller passes `statsOpts` at all, we take a ONE-SHOT snapshot — reading each field
 * EXACTLY ONCE, coerced to a primitive number — plus an exact key-set check (Object.keys does
 * NOT invoke value getters). We validate THAT plain-scalar snapshot against the internal
 * locked scalars; anything omitted/extra/weakened THROWS `LOCKED_STATS_POLICY_DRIFT`. The
 * caller object is then DISCARDED and NEVER read again — the actual recompute uses only
 * `LOCKED_STATS_INTERNAL_SNAPSHOT`, so even a statsOpts that passes cannot change the numbers.
 * The locked constant is self-authenticated against its pinned sha first (tamper => RED).
 */
export function assertLockedStatisticsPolicy(statsOpts) {
  if (sha(Buffer.from(canonical(LOCKED_STATS_RECOMPUTE_OPTS))) !== LOCKED_STATS_RECOMPUTE_OPTS_SHA256) {
    throw new Red("LOCKED_STATS_POLICY_SELF_AUTH_FAILED", { got: canonical(LOCKED_STATS_RECOMPUTE_OPTS) });
  }
  if (statsOpts === undefined) return; // no override -> the internal locked snapshot is used.
  if (statsOpts === null || typeof statsOpts !== "object") {
    throw new Red("LOCKED_STATS_POLICY_DRIFT", { reason: "not_an_object" });
  }
  // ONE-SHOT read: each field read EXACTLY once, coerced to a primitive. The object is never
  // read again after this line (defeats getter/proxy/TOCTOU and post-validation mutation).
  const snap = {
    seed: Number(statsOpts.seed),
    iterations: Number(statsOpts.iterations),
    confidence: Number(statsOpts.confidence),
  };
  // Exact key set (no omitted / no extra). Object.keys enumerates names without reading values.
  const keys = Object.keys(statsOpts).sort();
  const wantKeys = ["confidence", "iterations", "seed"];
  const keysOk = keys.length === wantKeys.length && keys.every((k, i) => k === wantKeys[i]);
  if (
    !keysOk ||
    !Object.is(snap.seed, LOCKED_STATS_INTERNAL_SNAPSHOT.seed) ||
    !Object.is(snap.iterations, LOCKED_STATS_INTERNAL_SNAPSHOT.iterations) ||
    !Object.is(snap.confidence, LOCKED_STATS_INTERNAL_SNAPSHOT.confidence)
  ) {
    throw new Red("LOCKED_STATS_POLICY_DRIFT", { got: snap, want: LOCKED_STATS_INTERNAL_SNAPSHOT });
  }
  // snapshot + caller object are DISCARDED: the recompute uses LOCKED_STATS_INTERNAL_SNAPSHOT.
}

/**
 * FIX 5 (P0 evidence-integrity / caller-controlled check-use, 3rd recurrence): materialize a
 * caller-produced sample array ONCE, at the entry barrier, into a plain, deeply-FROZEN
 * `number[]`. Each element is read EXACTLY ONCE (defeating enumerable getters / Proxies /
 * two-stage accessors that return over-budget values during raw-evidence serialization and
 * under-budget values during recompute, and defeating post-call mutation). Fails CLOSED on any
 * unsupported shape: a non-array/array-like (`UNSUPPORTED_CALLER_STRUCTURE`), a sparse/holey
 * array, or any element that is not a plain finite number (`RAW_SAMPLE_INVALID`). Every
 * downstream stage (raw-evidence serialization, sha256 hashing, p95/bootstrap recompute, the
 * per-metric row, the aggregate) then reads ONLY this frozen snapshot, so the persisted
 * evidence and the verdict are bound to one immutable copy.
 */
export function materializeSampleArray(value, { field, metricId } = {}) {
  if (!Array.isArray(value)) {
    throw new Red("UNSUPPORTED_CALLER_STRUCTURE", { metric_instance_id: metricId, field, reason: "not_an_array" });
  }
  const n = value.length;
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, i)) {
      throw new Red("RAW_SAMPLE_INVALID", { metric_instance_id: metricId, field, index: i, reason: "sparse_or_holey" });
    }
    const raw = value[i]; // the ONLY read of this element
    // map through Number() for plain number/string; anything else (object/symbol/getter that
    // does not yield a plain scalar) becomes NaN and is rejected below (fail closed).
    const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
    if (!Number.isFinite(num)) {
      throw new Red("RAW_SAMPLE_INVALID", { metric_instance_id: metricId, field, index: i, reason: "non_finite_or_non_number" });
    }
    out[i] = num;
  }
  return Object.freeze(out);
}

export function buildResourceReport(opts = {}) {
  // FIX 5 entry barrier: materialize `opts.tuple` with a SINGLE read + primitive coercion.
  const rawTuple = opts.tuple; // one read of the caller value
  const tuple = rawTuple === undefined || rawTuple === null ? null : String(rawTuple);
  if (tuple !== null && !/^[0-9a-f]{64}$/.test(tuple)) throw new Red("TUPLE_INVALID", { tuple });
  // FIX 1 (P0 false-green + TOCTOU): the locked statistics policy is not caller-weakenable.
  // Validate any caller statsOpts via a one-shot plain-scalar snapshot, then DISCARD it — the
  // recompute below reads ONLY the internal frozen snapshot, so a getter/proxy/mutated object
  // that survives validation still cannot influence the 96 recomputes. Guard BEFORE deriving/
  // emitting anything so a drifting statsOpts never produces a report.
  assertLockedStatisticsPolicy(opts.statsOpts); // one read of the caller object happens HERE only.
  const lockedStats = LOCKED_STATS_INTERNAL_SNAPSHOT; // internal, frozen, plain scalars.
  // Provisional sentinel tuple when none supplied (the real tuple is produced by the
  // subject-inventory/policy-binding siblings; here it is explicitly unsealed).
  const tupleSha = tuple ?? sha(Buffer.from("PROVISIONAL_UNSEALED_TUPLE_NOT_FROZEN_CANDIDATE"));
  const instances = deriveLockedMetricInstances();

  // FIX 5 entry barrier: the sample producer is called EXACTLY ONCE per metric and its result is
  // materialized immediately into frozen internal number[] snapshots. Nothing below reads the
  // caller's object again — raw-evidence serialization, hashing AND recompute all read the SAME
  // frozen `samples`/`warmupSamples`, so persisted evidence and verdict can never diverge.
  const sampleProducer = opts.samplesFor ?? syntheticSamplesFor;
  const rawFiles = [];
  const performance_metrics = [];
  for (const inst of instances) {
    const produced = sampleProducer(inst.metric_instance_id, inst.p95_budget); // called ONCE per metric
    const samples = materializeSampleArray(produced == null ? undefined : produced.samples, { field: "samples", metricId: inst.metric_instance_id });
    const warmupSamples = materializeSampleArray(produced == null ? undefined : produced.warmupSamples, { field: "warmup_samples", metricId: inst.metric_instance_id });
    const rawContent = `${JSON.stringify({ synthetic_fixture: true, not_physical_device_evidence: true, metric_instance_id: inst.metric_instance_id, policy_profile_id: inst.policy_profile_id, scenario_id: inst.scenario_id, unit: inst.unit, p95_budget: inst.p95_budget, warmup_samples: warmupSamples, samples }, null, 2)}\n`;
    const rawSha = sha(Buffer.from(rawContent));
    const rawPath = `raw/perf-synthetic-${rawSha}.json`;
    rawFiles.push({ path: rawPath, content: rawContent });
    const evidence_refs = [{ path: rawPath, sha256: rawSha, bytes: Buffer.byteLength(rawContent), kind: "stress_resource_sample" }];
    const { row } = recomputeMetric({ metric_instance_id: inst.metric_instance_id, samples, warmups: warmupSamples.length, budget: inst.p95_budget, evidence_refs, statsOpts: lockedStats });
    performance_metrics.push(row);
  }

  // Resource budget: agent-computable growth-slope structure over a synthetic series.
  const budgetSamples = Array.from({ length: 24 }, (_v, i) => 100 + Math.sin(i) * 2); // bounded, flat, returns to baseline
  const budgetStats = recomputeResourceBudget({ samples: budgetSamples, cap: 128, baseline: 102 });
  const budgetRawContent = `${JSON.stringify({ synthetic_fixture: true, not_physical_device_evidence: true, resource_budget_id: "budget:hub-rss-mib", samples: budgetSamples, ...budgetStats }, null, 2)}\n`;
  const budgetRawSha = sha(Buffer.from(budgetRawContent));
  const budgetRawPath = `raw/budget-synthetic-${budgetRawSha}.json`;
  rawFiles.push({ path: budgetRawPath, content: budgetRawContent });
  const resource_budgets = [
    { resource_budget_id: "budget:hub-rss-mib", bounded: budgetStats.bounded, growth_slope_pass: budgetStats.growth_slope_pass, teardown_baseline_restored: budgetStats.teardown_baseline_restored, result: budgetStats.result, evidence_refs: [{ path: budgetRawPath, sha256: budgetRawSha, bytes: Buffer.byteLength(budgetRawContent), kind: "stress_resource_sample" }] },
  ];

  // Host-safety: HONEST gated placeholder (all 8 booleans false, preflight_passed false).
  // An agent cannot attest a real campaign harness's host isolation/quota/keychain, so this
  // is non-passing exactly like soaks[]; the independent R13 validator REDs (HOST_SAFETY_INVALID)
  // at the host-safety gate. The status/basis disclosure lives in the sidecar, NOT here.
  const preflight = hostSafetyGatedPlaceholder();
  const preflightContent = `${JSON.stringify({ host_safety: preflight, host_safety_status: HOST_SAFETY_STATUS_GATED, basis: "operator_and_physically_gated_no_agent_side_host_isolation_quota_or_keychain_attestation", not_campaign_harness_attestation: true }, null, 2)}\n`;
  const preflightSha = sha(Buffer.from(preflightContent));
  const preflightPath = `raw/host-safety-gated-${preflightSha}.json`;
  rawFiles.push({ path: preflightPath, content: preflightContent });
  const host_safety = { ...preflight, evidence_refs: [{ path: preflightPath, sha256: preflightSha, bytes: Buffer.byteLength(preflightContent), kind: "operator_physical_gated_placeholder" }] };

  // Soaks: HONEST provisional placeholders. uninterrupted:false and
  // result:"operator_physical_gated" => never a passing/uninterrupted claim; the
  // independent R13 validator REDs at SOAK_INVALID. started_at/completed_at are
  // explicit non-timestamp sentinels so nothing here can be mistaken for a real run.
  const soaks = Object.keys(SOAK_NEED_HOURS).map((platform) => {
    const rawContent = `${JSON.stringify({ operator_physical_gated: true, platform_id: platform, needed_hours: SOAK_NEED_HOURS[platform], note: "no uninterrupted soak evidence synthesised agent-side" }, null, 2)}\n`;
    const rawSha = sha(Buffer.from(rawContent));
    const rawPath = `raw/soak-${platform}-PROVISIONAL-${rawSha}.json`;
    rawFiles.push({ path: rawPath, content: rawContent });
    return {
      campaign_id: `soak:${platform}:PROVISIONAL`,
      platform_id: platform,
      started_at: "PENDING_OPERATOR_PHYSICAL_SOAK",
      completed_at: "PENDING_OPERATOR_PHYSICAL_SOAK",
      uninterrupted: false,
      final_release_candidate_tuple_sha256: tupleSha,
      result: "operator_physical_gated",
      evidence_refs: [{ path: rawPath, sha256: rawSha, bytes: Buffer.byteLength(rawContent), kind: "operator_physical_gated_placeholder" }],
    };
  });

  const report = {
    schema_version: RESOURCE_REPORT_SCHEMA_VERSION,
    contract_revision: CONTRACT_REVISION,
    final_release_candidate_tuple_sha256: tupleSha,
    performance_metrics,
    resource_budgets,
    soaks,
    host_safety,
  };

  // Sensitivity self-check: prove the anti-false-green tripwires actually fire.
  const sensitivity = runSensitivity(tupleSha);

  const unsealed_reasons = [
    "soaks_operator_and_physically_gated_no_uninterrupted_72h_24h_evidence_synthesised",
    "physical_signed_device_identity_and_campaigns_physically_gated",
    "performance_metric_samples_are_synthetic_fixture_not_physical_device_measurements",
    "resource_budget_series_is_synthetic_fixture_not_real_soak_measurement",
    "final_release_candidate_tuple_is_provisional_sentinel_unless_supplied",
    "host_safety_is_operator_and_physically_gated_all_booleans_false_no_agent_side_attestation",
  ];
  const sealStatus = {
    schema_version: SEAL_STATUS_SCHEMA_VERSION,
    contract_revision: CONTRACT_REVISION,
    generator_id: "scripts/ops/friday-stress-perf-soak-authority.mjs",
    seal_status: "PROVISIONAL_UNSEALED",
    final_authority: false,
    can_ever_self_seal_agent_side: false,
    host_safety_status: HOST_SAFETY_STATUS_GATED,
    final_release_candidate_tuple_sha256: tupleSha,
    performance_policy_frozen_at: PERFORMANCE_POLICY_FROZEN_AT,
    locked_metric_instance_set_sha256: LOCKED_METRIC_INSTANCE_SET_SHA256,
    locked_metric_instances: performance_metrics.length,
    metric_denominator_self_authenticated: true,
    component_basis: {
      performance_metrics: { basis: "recompute_over_synthetic_fixture_samples_not_physical_device", sealed: false },
      resource_budgets: { basis: "growth_slope_over_synthetic_fixture_series", sealed: false },
      host_safety: { basis: "operator_and_physically_gated_placeholder", sealed: false, note: "all 8 host-safety booleans are emitted as false: an agent cannot truthfully attest a real stress-campaign harness's host isolation/quota/keychain/prod-boundary, which is operator/physically gated. The independent R13 validator REDs (HOST_SAFETY_INVALID) at this gate." },
      soaks: { basis: "operator_and_physically_gated_provisional_placeholder", sealed: false },
      device_identity: { basis: "physical_signed_campaign_gated", sealed: false },
    },
    sensitivity_self_check: sensitivity,
    unsealed_reasons,
    does_not_prove:
      "Does not close #47 / TEST-STRESS-PERF-SOAK-AUTHORITY-001 or any R13 requirement. Agent-side this harness is ALWAYS provisional: no uninterrupted 72h/24h soak, no physical device identity, no real physical-device samples are proven. Not R13 GO, not final authority, not closure of any product, soak, device, execution or external leaf.",
  };

  return { report, sealStatus, rawFiles, tuple: tupleSha, sensitivity };
}

// FIX 3 (P1 filesystem boundary): hardened single-destination writer. A lexical path
// check follows a pre-existing symlink (the Advisor's probe: `<out>/raw` as a symlink to a
// sibling wrote 101 files OUTSIDE the declared dir at exit 0). This writer fails CLOSED:
//   * the output ROOT is `realpathSync(outDir)` (absorbs only legitimate system-level
//     symlinks like macOS /var), and ALL writes are re-based onto that resolved root;
//   * every intermediate directory component is `lstat`-checked — an existing symlink or a
//     non-directory special file (FIFO/socket/device) is rejected (SYMLINK_REJECTED);
//   * every file is created with `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW` (exclusive + no-follow),
//     so a symlink or pre-existing file at the target fails the open, and the fresh file is
//     asserted regular with nlink===1 (no hardlink) and a realpath strictly inside the root.
// On ANY violation it throws (Red) and writes ZERO files outside the resolved root.
const NOFOLLOW_CREATE = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

// Ensure `<root>/<relDir>` exists as a chain of REAL directories, creating missing links
// and rejecting any existing component that is a symlink or a non-directory special file.
function ensureDirNoFollow(root, relDir) {
  if (relDir === "" || relDir === ".") return;
  if (relDir.startsWith("..") || path.isAbsolute(relDir)) throw new Red("RAW_PATH_ESCAPE", { path: relDir });
  let cur = root;
  for (const part of relDir.split(path.sep)) {
    if (part === "" || part === "." || part === "..") throw new Red("RAW_PATH_ESCAPE", { path: relDir });
    cur = path.join(cur, part);
    const st = lstatOrNull(cur);
    if (st === null) {
      fs.mkdirSync(cur); // fresh, cannot be a symlink
    } else if (st.isSymbolicLink()) {
      throw new Red("SYMLINK_REJECTED", { path: cur });
    } else if (!st.isDirectory()) {
      throw new Red("SYMLINK_REJECTED", { path: cur, reason: "non_directory_component" });
    }
  }
}

// Create + write `<root>/<rel>` with no-follow exclusive semantics. Rejects a symlink at the
// final component, a pre-existing file, a hardlink, or any escape of the resolved root.
function writeFileNoFollow(root, rel, content) {
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Red("RAW_PATH_ESCAPE", { path: rel });
  ensureDirNoFollow(root, path.dirname(rel) === "." ? "" : path.dirname(rel));
  const abs = path.join(root, rel);
  if (path.relative(root, abs).startsWith("..")) throw new Red("RAW_PATH_ESCAPE", { path: rel });
  const pre = lstatOrNull(abs);
  if (pre && pre.isSymbolicLink()) throw new Red("SYMLINK_REJECTED", { path: abs });
  let fd;
  try {
    fd = fs.openSync(abs, NOFOLLOW_CREATE, 0o600);
  } catch (error) {
    // ELOOP (symlink under O_NOFOLLOW) / EEXIST (pre-existing) / etc. => fail closed.
    throw new Red("SYMLINK_REJECTED", { path: abs, detail: (error && error.code) || String(error) });
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw new Red("SYMLINK_REJECTED", { path: abs, reason: "not_a_fresh_regular_file" });
    const real = fs.realpathSync(abs);
    if (real !== abs || path.relative(root, real).startsWith("..")) throw new Red("RAW_PATH_ESCAPE", { path: abs, real });
    fs.writeFileSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
  return abs;
}

export function writeBundle(outPath, built) {
  const resolvedOut = path.resolve(outPath);
  const outDir = path.dirname(resolvedOut);
  // Ensure the declared out dir exists, then anchor on its realpath (the resolved ROOT).
  fs.mkdirSync(outDir, { recursive: true });
  const outRoot = fs.realpathSync(outDir);
  const reportRel = path.basename(resolvedOut);
  const sidecarRel = `${reportRel.replace(/\.json$/, "")}.SEAL_STATUS.json`;

  // raw/ evidence first (each under the resolved root, no-follow).
  for (const file of built.rawFiles) {
    if (typeof file.path !== "string" || !file.path.startsWith("raw/")) throw new Red("RAW_PATH_ESCAPE", { path: file.path });
    writeFileNoFollow(outRoot, file.path, file.content);
  }
  const reportAbs = writeFileNoFollow(outRoot, reportRel, `${JSON.stringify(built.report, null, 2)}\n`);
  const sidecarAbs = writeFileNoFollow(outRoot, sidecarRel, `${JSON.stringify(built.sealStatus, null, 2)}\n`);

  // Self-verify every evidence ref resolves + hash-matches on disk (read no-follow).
  const allRefs = [
    ...built.report.performance_metrics.flatMap((m) => m.evidence_refs),
    ...built.report.resource_budgets.flatMap((b) => b.evidence_refs),
    ...built.report.soaks.flatMap((s) => s.evidence_refs),
    ...built.report.host_safety.evidence_refs,
  ];
  for (const ref of allRefs) {
    if (typeof ref.path !== "string" || ref.path.startsWith("/") || ref.path.split("/").includes("..")) throw new Red("RAW_PATH_ESCAPE", { path: ref.path });
    const abs = path.join(outRoot, ref.path);
    let rfd;
    try {
      rfd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error) {
      throw new Red("SELF_VERIFY_DRIFT", { path: ref.path, detail: (error && error.code) || String(error) });
    }
    try {
      const bytes = fs.readFileSync(rfd);
      if (sha(bytes) !== ref.sha256 || bytes.length !== ref.bytes) throw new Red("SELF_VERIFY_DRIFT", { path: ref.path });
    } finally {
      fs.closeSync(rfd);
    }
  }
  return { outPath: reportAbs, sidecarPath: sidecarAbs, rawCount: built.rawFiles.length };
}

// A malformed/unknown CLI invocation. Distinct from Red so it maps to a fail-fast USAGE
// exit (2) BEFORE any evidence is produced, not the RED (exit 3) evidence-error path.
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

export const CLI_USAGE = "usage: friday-stress-perf-soak-authority.mjs [--out <path>] [--tuple <64-hex>] [--strict]";

/**
 * FIX 6 (P1 fail-open CLI): a CLOSED, fail-fast argv grammar. Recognized options are EXACTLY
 * `--out <value>`, `--tuple <value>` (each takes one NON-option-looking value), and `--strict`
 * (boolean flag, no value). Everything else — unknown/misspelled option, missing value,
 * option-looking value (e.g. swallowing `--strict`), duplicate option, or unexpected positional
 * — throws `UsageError`. The WHOLE argv is validated up front so `main` can fail closed (no
 * report, no sidecar, no raw dir, zero filesystem output) BEFORE calling buildResourceReport.
 */
export function parseArgs(argv) {
  const args = { out: null, tuple: null, strict: false };
  const seen = new Set();
  const optionLike = (t) => typeof t === "string" && t.startsWith("-");
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === "--out" || tok === "--tuple") {
      if (seen.has(tok)) throw new UsageError(`duplicate option ${tok}`);
      seen.add(tok);
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(`option ${tok} requires a value`);
      if (optionLike(value)) throw new UsageError(`option ${tok} requires a value but got option-like token '${value}'`);
      args[tok.slice(2)] = value;
      i += 1; // consume the value token
    } else if (tok === "--strict") {
      if (seen.has(tok)) throw new UsageError(`duplicate option ${tok}`);
      seen.add(tok);
      args.strict = true;
    } else if (optionLike(tok)) {
      throw new UsageError(`unknown option ${tok}`);
    } else {
      throw new UsageError(`unexpected positional argument '${tok}'`);
    }
  }
  return args;
}

function main() {
  // FIX 6: parse + validate the WHOLE argv up front and fail CLOSED (exit 2) BEFORE any
  // buildResourceReport/writeBundle/write — a malformed invocation produces zero evidence.
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(JSON.stringify({ result: "RED", code: "USAGE_ERROR", detail: error.message }));
      console.error(CLI_USAGE);
      process.exit(2);
    }
    throw error;
  }
  const fail = (code, detail = {}) => {
    console.error(JSON.stringify({ result: "RED", code, detail }));
    process.exit(3);
  };
  try {
    const built = buildResourceReport({ tuple: args.tuple });
    // Self-checks: locked denominator + recompute already ran; assert the emitted
    // perf census matches the self-authenticated locked set and every sensitivity
    // detector fired. These are internal invariants — a break is RED, never a pass.
    const lockedIds = lockedMetricInstanceIds();
    if (!setEqual(built.report.performance_metrics.map((m) => m.metric_id), lockedIds)) return fail("EMITTED_DENOMINATOR_MISMATCH");
    if (!built.sensitivity.all_fired) return fail("SENSITIVITY_DETECTOR_DID_NOT_FIRE", { sensitivity: built.sensitivity });
    // The emitted report is PROVISIONAL: the independent-mirror verdict MUST be RED
    // at the soak gate (never a false green from this agent-side harness).
    const verdict = validateResourceReport(built.report, { tuple: built.tuple });
    if (verdict.result !== "RED" || verdict.code !== "SOAK_INVALID") return fail("PROVISIONAL_REPORT_NOT_HONESTLY_GATED", { verdict });

    let outInfo = null;
    if (args.out) outInfo = writeBundle(path.resolve(args.out), built);

    console.log(
      JSON.stringify({
        result: "OK",
        seal_status: "PROVISIONAL_UNSEALED",
        final_authority: false,
        can_ever_self_seal_agent_side: false,
        contract_revision: CONTRACT_REVISION,
        final_release_candidate_tuple_sha256: built.tuple,
        locked_metric_instances: built.report.performance_metrics.length,
        locked_metric_instance_set_sha256: LOCKED_METRIC_INSTANCE_SET_SHA256,
        metric_denominator_self_authenticated: true,
        independent_mirror_verdict: verdict,
        sensitivity_all_detectors_fired: built.sensitivity.all_fired,
        soaks_status: "operator_physical_gated_provisional_placeholder",
        out: outInfo,
        does_not_prove: built.sealStatus.does_not_prove,
      }),
    );
    console.error(
      "PROVISIONAL_UNSEALED — exit 0 does NOT mean sealed/PASS. Agent-side this perf/soak harness can NEVER self-seal " +
        "(no uninterrupted 72h/24h soak, no physical device identity, samples are synthetic fixture). Do NOT treat generation " +
        "success as a gate PASS. Use --strict to fail closed (exit 4).",
    );
    if (args.strict) process.exit(4);
    process.exit(0);
  } catch (error) {
    if (error instanceof Red) return fail(error.code, error.detail);
    return fail("UNEXPECTED", { detail: String(error) });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
