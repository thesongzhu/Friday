/**
 * TEST-STRESS-PERF-SOAK-AUTHORITY-001 (#47) — PROVISIONAL-ONLY perf/soak
 * resource-report harness.
 *
 * Agent-side this harness can NEVER self-seal: the real soaks (Hub 72h, iOS 24h,
 * Android 24h uninterrupted) and the physical signed device campaigns are operator-
 * and physically-gated. `seal_status` is always PROVISIONAL_UNSEALED and the emitted
 * report's soaks[] are HONEST non-passing placeholders, so the INDEPENDENT vendored
 * R13 validator's resource gate correctly REDs (SOAK_INVALID). These tests verify:
 *
 *  (1) SOURCING — the locked 96 R7 metric instances are re-derived from the operator-
 *      frozen metric-matrix rules and SELF-AUTHENTICATE against the operator-locked
 *      per-rule + global metric_instance_set_sha256 (399d88f0...). A tampered rule
 *      breaks the seal (red-first). An independent second expansion in this test
 *      reproduces both the module output and the locked hash.
 *  (2) DRIFT-LOCK — the mirrored resource-report shape + thresholds + soak minima are
 *      bound to the vendored R13 validator's OWN source, so a silent divergence RED.
 *  (3) RECOMPUTE FIDELITY — the R7 recompute (linear_r7 quantile + seeded percentile
 *      bootstrap) is deterministic + hand-verifiable (golden values), and a weakened
 *      estimator/input flips the row to "failed" (a fabricated green is caught).
 *  (4) SENSITIVITY (RED-first, MANDATORY) — short_*_soak / metric-weakening /
 *      non-canonical-timestamp / <96-metric-count each turn the verdict RED, while the
 *      un-mutated reference is GREEN.
 *  (5) BOUNDARY HONESTY — the emitted report never synthesises an uninterrupted
 *      72h/24h soak or a physical device identity; soaks are provisional/non-passing.
 *  (6) NO ARBITRARY WRITE — the CLI writes ONLY under --out; no env/argv arbitrary
 *      destination; running without --out writes nothing.
 *  (FIX 1) LOCKED STATS POLICY — the R7 estimator is not caller-weakenable: a drifting
 *      statsOpts (iterations=1 / looser confidence / different seed / omitted field) throws
 *      LOCKED_STATS_POLICY_DRIFT BEFORE any report is produced (Advisor's zero-width-CI probe).
 *  (FIX 2) HONEST HOST-SAFETY — the emitted host_safety is a non-passing gated placeholder
 *      (all 8 booleans false); no fabricated preflight; the disclosure lives in the sidecar.
 *  (FIX 3) FILESYSTEM BOUNDARY — the writer fails closed on pre-existing symlinks / special
 *      files / no-follow targets and never writes outside the resolved output root.
 *  (FIX 4) AUTHORITATIVE ORACLE — the REAL vendored R13 validator is EXECUTED over a complete
 *      fixture and authoritatively REDs at SOAK_INVALID (and HOST_SAFETY_INVALID once soaks are
 *      structurally patched); the in-process mirror is a non-authoritative subset, never the sole oracle.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

import {
  deriveLockedMetricInstances,
  lockedMetricInstanceIds,
  instanceRowsForRule,
  expandedInstanceSetSha256,
  globalMetricInstanceSetSha256,
  recomputeMetric,
  linearR7Quantile,
  validateResourceReport,
  runSensitivity,
  SENSITIVITY_DETECTORS,
  buildSensitivityReferenceReport,
  buildResourceReport,
  RESOURCE_REPORT_KEYS,
  PERF_METRIC_KEYS,
  RESOURCE_BUDGET_KEYS,
  SOAK_KEYS,
  HOST_SAFETY_KEYS,
  WARMUPS_MIN,
  RAW_SAMPLES_MIN,
  MAX_RELATIVE_CI_WIDTH_PERCENT,
  SOAK_NEED_HOURS,
  canonical,
  digestOf,
  parseArgs,
  UsageError,
  // eslint-disable-next-line import/extensions
} from "../../../../scripts/ops/friday-stress-perf-soak-authority.mjs";
import {
  LOCKED_METRIC_MATRIX_RULES,
  LOCKED_METRIC_INSTANCE_SET_SHA256,
  LOCKED_METRIC_INSTANCE_COUNT,
  // eslint-disable-next-line import/extensions
} from "../../../../scripts/ops/lib/friday-perf-metric-instances.locked.mjs";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const GEN = path.join(REPO_ROOT, "scripts", "ops", "friday-stress-perf-soak-authority.mjs");
const VENDORED_VALIDATOR = path.join(__dirname, "fixtures", "verify-endbar-stress-evidence-r13.vendored.mjs");
// Operator-attested hash-of-record of the vendored R13 validator (identical to the
// one #45 attests): the ONLY drift gate reachable in CI (ubuntu has no ~/Desktop).
const VENDORED_VALIDATOR_SHA = "4287ef02e4cae753f457fa8ef61e8436fe6e8e291ad62f2750cd69d81dbbb323"; // pragma: allowlist secret
const LIVE_VALIDATOR = path.join(os.homedir(), "Desktop", "Friday-Handoff-Log", "tools", "verify-endbar-stress-evidence-r13.mjs");

const sha = (bytes: Buffer | string): string => crypto.createHash("sha256").update(bytes).digest("hex");
const asArr = (v: unknown): string[] => v as string[];

// Independent second lens of the product-policy metric-instance expansion (utf8-ordered
// stableJson + sha256), re-implemented here to confirm the module did not hardcode ids.
const compareUtf8 = (l: string, r: string): number => Buffer.compare(Buffer.from(l, "utf8"), Buffer.from(r, "utf8"));
const stableValue = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(stableValue)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v as object).sort(compareUtf8).map((k) => [k, stableValue((v as Record<string, unknown>)[k])]))
      : v;
const policySha = (v: unknown): string => crypto.createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(stableValue(v))).digest("hex");
function independentInstanceRows(rule: any): any[] {
  return [...rule.profile_ids].sort(compareUtf8).map((profileId: string) => ({
    metric_instance_id: `perf:${policySha(`${rule.metric_id}\0${profileId}\0${rule.scenario_id}`).slice(0, 40)}`,
    metric_id: rule.metric_id,
    policy_profile_id: profileId,
    scenario_id: rule.scenario_id,
    unit: rule.unit,
    p95_budget: rule.p95_budget,
    measurement_semantics_id: rule.measurement_semantics_id,
  }));
}

// FIX 1 LOCKED the R7 statistics policy, so EVERY report build now runs the full
// 10,000-iteration seeded bootstrap over all 96 metrics (no fast statsOpts shortcut). A
// single build takes several seconds; two builds in one test blow vitest's default 10 s
// per-test timeout on a loaded CI runner. Raise the file-level test + hook timeouts to 60 s
// (comfortable margin) — this covers ALL heavy tests uniformly (the legit-policy compare,
// the golden/determinism tests, and the FIX-4 full-build + real-validator-spawn probes). We
// do NOT reduce bootstrap iterations (that would undo FIX 1); we only give the tests time.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// The default full report is built ONCE here and reused everywhere a test compares against
// "the default", so no test needs to rebuild it (each heavy test builds at most one report).
let EMITTED: any;
beforeAll(() => {
  EMITTED = buildResourceReport({});
}, 60000);

// ---------------------------------------------------------------------------
describe("perf-soak-authority (1) locked-96 sourcing self-authentication", () => {
  it("re-derives exactly 96 unique perf:<40hex> instance ids", () => {
    const rows = deriveLockedMetricInstances();
    expect(rows).toHaveLength(LOCKED_METRIC_INSTANCE_COUNT);
    expect(LOCKED_METRIC_INSTANCE_COUNT).toBe(96);
    const ids = rows.map((r: any) => r.metric_instance_id);
    expect(new Set(ids).size).toBe(96);
    for (const id of ids) expect(id).toMatch(/^perf:[0-9a-f]{40}$/);
    expect(lockedMetricInstanceIds()).toEqual(ids);
  });

  it("reproduces the operator-locked global metric_instance_set_sha256 (399d88f0...)", () => {
    // The module's own derivation matches the locked global hash...
    expect(globalMetricInstanceSetSha256(LOCKED_METRIC_MATRIX_RULES)).toBe(LOCKED_METRIC_INSTANCE_SET_SHA256);
    expect(LOCKED_METRIC_INSTANCE_SET_SHA256).toBe("399d88f018db7448b660e75e8128b94c6af9e69b307e7dc8b60923b34304d414"); // pragma: allowlist secret
    // ...AND a genuinely independent second expansion (re-implemented in this test)
    // reproduces both the locked hash and the module's instance ids — proving the 96
    // are the REAL locked set, not a plausible hardcode.
    const indepAll = LOCKED_METRIC_MATRIX_RULES.flatMap(independentInstanceRows).sort((a: any, b: any) => compareUtf8(a.metric_instance_id, b.metric_instance_id));
    expect(policySha(indepAll)).toBe(LOCKED_METRIC_INSTANCE_SET_SHA256);
    expect(indepAll.map((r: any) => r.metric_instance_id)).toEqual(deriveLockedMetricInstances().map((r: any) => r.metric_instance_id));
  });

  it("every rule reproduces its operator-locked expanded_instance_set_sha256", () => {
    let sum = 0;
    for (const rule of LOCKED_METRIC_MATRIX_RULES) {
      expect(expandedInstanceSetSha256(rule)).toBe(rule.expanded_instance_set_sha256);
      expect(instanceRowsForRule(rule)).toHaveLength(rule.expanded_instance_count);
      sum += rule.expanded_instance_count;
    }
    expect(sum).toBe(96);
  });

  it("RED-FIRST: a tampered rule (weakened budget) breaks the locked global seal", () => {
    const tampered = LOCKED_METRIC_MATRIX_RULES.map((r: any) => ({ ...r }));
    tampered[0] = { ...tampered[0], p95_budget: tampered[0].p95_budget + 1 };
    // Per-rule and global hashes both diverge from the locked oracle -> deriveLocked
    // would throw LOCKED_METRIC_SET_DRIFT (the guard is load-bearing).
    expect(expandedInstanceSetSha256(tampered[0])).not.toBe(LOCKED_METRIC_MATRIX_RULES[0].expanded_instance_set_sha256);
    expect(globalMetricInstanceSetSha256(tampered)).not.toBe(LOCKED_METRIC_INSTANCE_SET_SHA256);
  });
});

// ---------------------------------------------------------------------------
describe("perf-soak-authority (2) drift-lock vs the independent vendored R13 validator", () => {
  it("vendored validator is byte-identical to the operator-attested record", () => {
    expect.hasAssertions();
    const vendoredSha = sha(fs.readFileSync(VENDORED_VALIDATOR));
    expect(vendoredSha).toBe(VENDORED_VALIDATOR_SHA);
    if (fs.existsSync(LIVE_VALIDATOR)) expect(sha(fs.readFileSync(LIVE_VALIDATOR))).toBe(vendoredSha);
  });

  it("the drift gate is not vacuous: any fixture byte change breaks the record", () => {
    const original = fs.readFileSync(VENDORED_VALIDATOR);
    expect(sha(original)).toBe(VENDORED_VALIDATOR_SHA);
    expect(sha(Buffer.concat([original, Buffer.from("\n// drift\n")]))).not.toBe(VENDORED_VALIDATOR_SHA);
  });

  it("mirrored resource-report shape + thresholds + soak minima match the vendored validator source", () => {
    const src = fs.readFileSync(VENDORED_VALIDATOR, "utf8");
    const grabArr = (re: RegExp): string[] => {
      const m = src.match(re);
      if (!m) throw new Error(`vendored anchor not found: ${re}`);
      return JSON.parse(m[1]);
    };
    const grabNum = (re: RegExp): number => {
      const m = src.match(re);
      if (!m) throw new Error(`vendored number not found: ${re}`);
      return Number(m[1]);
    };
    const sortset = (a: string[]): string[] => [...a].sort();
    // exact key sets (validator grades key sets order-independently via exact()).
    expect(sortset(asArr(RESOURCE_REPORT_KEYS))).toEqual(sortset(grabArr(/exact\(docs\.resources,(\[[^\]]*\])\)/)));
    expect(sortset(asArr(PERF_METRIC_KEYS))).toEqual(sortset(grabArr(/exact\(m,(\[[^\]]*\])\)/)));
    expect(sortset(asArr(RESOURCE_BUDGET_KEYS))).toEqual(sortset(grabArr(/exact\(b,(\[[^\]]*\])\)/)));
    expect(sortset(asArr(SOAK_KEYS))).toEqual(sortset(grabArr(/exact\(s,(\[[^\]]*\])\)/)));
    expect(sortset(asArr(HOST_SAFETY_KEYS))).toEqual(sortset(grabArr(/exact\(hs,(\[[^\]]*\])\)/)));
    // thresholds.
    expect(WARMUPS_MIN).toBe(grabNum(/m\.warmups<(\d+)/));
    expect(RAW_SAMPLES_MIN).toBe(grabNum(/m\.raw_samples<(\d+)/));
    expect(MAX_RELATIVE_CI_WIDTH_PERCENT).toBe(grabNum(/relative_ci_width_percent>(\d+)/));
    expect(LOCKED_METRIC_INSTANCE_COUNT).toBe(grabNum(/metricRows\.size!==(\d+)/));
    // soak minima {hub:72,ios:24,android:24}.
    const soakMatch = src.match(/soakNeed=\{([^}]*)\}/);
    if (!soakMatch) throw new Error("soakNeed not found in vendored validator");
    const soakNeed: Record<string, number> = {};
    for (const pair of soakMatch[1].split(",")) {
      const [k, v] = pair.split(":");
      soakNeed[k] = Number(v);
    }
    expect(SOAK_NEED_HOURS).toEqual(soakNeed);
  });
});

// ---------------------------------------------------------------------------
describe("perf-soak-authority (3) R7 recompute fidelity (deterministic + hand-verifiable)", () => {
  const evidence_refs = [{ path: "raw/x.json", sha256: "a".repeat(64), bytes: 1, kind: "stress_resource_sample" }];
  const goldenSamples = Array.from({ length: 50 }, (_v, i) => i + 1); // 1..50

  it("golden values: samples 1..50, budget 100 -> p95=47.55, p50=25.5, ci=[43,49.55], passed", () => {
    const out = recomputeMetric({ metric_instance_id: "perf:golden", samples: goldenSamples, warmups: 5, budget: 100, evidence_refs });
    // R7 quantile of 1..50 at .95: (n-1)*.95=46.55 -> 47 + .55*(48-47) = 47.55 (hand-derivable).
    expect(out.stats.p95).toBeCloseTo(47.55, 10);
    expect(out.stats.p95).toBe(linearR7Quantile([...goldenSamples].sort((a, b) => a - b), 0.95));
    expect(out.stats.p50).toBeCloseTo(25.5, 10);
    expect(out.stats.p95_ci_low).toBe(43);
    expect(out.stats.p95_ci_high).toBeCloseTo(49.55, 10);
    expect(out.row.relative_ci_width_percent).toBeCloseTo(((49.55 - 43) / 47.55) * 100, 6);
    expect(out.row.p95_ci_upper_pass).toBe(true);
    expect(out.row.result).toBe("passed");
    expect(out.row.warmups).toBe(5);
    expect(out.row.raw_samples).toBe(50);
  });

  it("is deterministic: identical samples+seed produce byte-identical statistics", () => {
    const a = recomputeMetric({ metric_instance_id: "perf:d", samples: goldenSamples, warmups: 5, budget: 100, evidence_refs });
    const b = recomputeMetric({ metric_instance_id: "perf:d", samples: goldenSamples, warmups: 5, budget: 100, evidence_refs });
    expect(b.stats).toEqual(a.stats);
    expect(b.row.relative_ci_width_percent).toBe(a.row.relative_ci_width_percent);
  });

  it("relative_ci_width_percent is exactly the recomputed (ci_high-ci_low)/p95*100", () => {
    const out = recomputeMetric({ metric_instance_id: "perf:c", samples: goldenSamples, warmups: 5, budget: 100, evidence_refs });
    expect(out.row.relative_ci_width_percent).toBe(((out.stats.p95_ci_high - out.stats.p95_ci_low) / out.stats.p95) * 100);
  });

  it("RED-FIRST: a weakened input flips the row to failed (fabricated green is caught)", () => {
    // budget below the recomputed CI upper -> p95_ci_upper_pass false -> failed.
    const lowBudget = recomputeMetric({ metric_instance_id: "perf:w", samples: goldenSamples, warmups: 5, budget: 40, evidence_refs });
    expect(lowBudget.row.p95_ci_upper_pass).toBe(false);
    expect(lowBudget.row.result).toBe("failed");
    // fewer than 5 warmups -> failed.
    expect(recomputeMetric({ metric_instance_id: "perf:w", samples: goldenSamples, warmups: 4, budget: 100, evidence_refs }).row.result).toBe("failed");
    // fewer than 50 raw samples -> failed.
    expect(recomputeMetric({ metric_instance_id: "perf:w", samples: goldenSamples.slice(0, 49), warmups: 5, budget: 100, evidence_refs }).row.result).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
describe("perf-soak-authority (4) RED-first sensitivity detectors (MANDATORY)", () => {
  it("the un-mutated reference is GREEN and EVERY detector turns it RED", () => {
    const result = runSensitivity();
    expect(result.reference_green).toBe(true);
    expect(result.all_fired).toBe(true);
    for (const d of result.detectors) expect(d.turned_red, `detector ${d.detector_id} must fire RED`).toBe(true);
  });

  it("each required detector family fires with the expected validator code", () => {
    const ref = buildSensitivityReferenceReport();
    const tuple = ref.final_release_candidate_tuple_sha256;
    // baseline must be GREEN (red-first: mutations, not the baseline, cause RED).
    expect(validateResourceReport(ref, { tuple }).result).toBe("GREEN");
    const codeOf = (name: keyof typeof SENSITIVITY_DETECTORS): string =>
      validateResourceReport((SENSITIVITY_DETECTORS as any)[name](ref), { tuple }).code as string;
    expect(codeOf("short_hub_soak")).toBe("SOAK_INVALID");
    expect(codeOf("short_ios_soak")).toBe("SOAK_INVALID");
    expect(codeOf("short_android_soak")).toBe("SOAK_INVALID");
    expect(codeOf("metric_weakening_ci_width")).toBe("PERFORMANCE_METRIC_INVALID");
    expect(codeOf("metric_weakening_p95_ci_upper")).toBe("PERFORMANCE_METRIC_INVALID");
    expect(codeOf("metric_weakening_result")).toBe("PERFORMANCE_METRIC_INVALID");
    expect(codeOf("non_canonical_timestamp")).toBe("SOAK_TIMESTAMP_INVALID");
    expect(codeOf("metric_count_below_96")).toBe("PERFORMANCE_DENOMINATOR");
  });

  it("covers the six mandated sensitivity families", () => {
    const ids = Object.keys(SENSITIVITY_DETECTORS);
    expect(ids).toEqual(expect.arrayContaining([
      "short_hub_soak",
      "short_ios_soak",
      "short_android_soak",
      "metric_weakening_ci_width",
      "non_canonical_timestamp",
      "metric_count_below_96",
    ]));
  });
});

// ---------------------------------------------------------------------------
describe("perf-soak-authority (5) boundary honesty (never synthesises soak/device proof)", () => {
  it("emitted report: 96 recomputed metrics over synthetic samples, ids == locked set", () => {
    const pm = EMITTED.report.performance_metrics;
    expect(pm).toHaveLength(96);
    expect(new Set(pm.map((m: any) => m.metric_id))).toEqual(new Set(lockedMetricInstanceIds()));
    expect(pm.every((m: any) => m.result === "passed")).toBe(true);
  });

  it("emitted soaks are HONEST provisional placeholders: never uninterrupted, never passed", () => {
    for (const s of EMITTED.report.soaks) {
      expect(s.uninterrupted).toBe(false);
      expect(s.result).not.toBe("passed");
      expect(s.result).toBe("operator_physical_gated");
      // no synthesised canonical soak timestamps.
      expect(Number.isFinite(Date.parse(s.started_at))).toBe(false);
    }
    expect(EMITTED.report.soaks.map((s: any) => s.platform_id).sort()).toEqual(["android", "hub", "ios"]);
  });

  it("the fast in-process mirror (a NON-authoritative subset) REDs at the soak gate; the AUTHORITY is the real validator (FIX 4)", () => {
    // The mirror is only a tripwire; the authoritative SOAK_INVALID / HOST_SAFETY_INVALID
    // claims are proven by EXECUTING the vendored validator in describe (FIX 4) below.
    const verdict = validateResourceReport(EMITTED.report, { tuple: EMITTED.tuple });
    expect(verdict.result).toBe("RED");
    expect(verdict.code).toBe("SOAK_INVALID");
  });

  it("seal sidecar is PROVISIONAL_UNSEALED and discloses gated soak/device bases", () => {
    const ss = EMITTED.sealStatus;
    expect(ss.seal_status).toBe("PROVISIONAL_UNSEALED");
    expect(ss.final_authority).toBe(false);
    expect(ss.can_ever_self_seal_agent_side).toBe(false);
    expect(ss.component_basis.soaks.sealed).toBe(false);
    expect(ss.component_basis.device_identity.sealed).toBe(false);
    expect(ss.component_basis.performance_metrics.sealed).toBe(false);
    expect(ss.metric_denominator_self_authenticated).toBe(true);
    expect(ss.locked_metric_instance_set_sha256).toBe(LOCKED_METRIC_INSTANCE_SET_SHA256);
    expect(ss.sensitivity_self_check.all_fired).toBe(true);
    expect(typeof ss.does_not_prove).toBe("string");
  });
});

// ---------------------------------------------------------------------------
describe("perf-soak-authority (FIX 1) locked R7 statistics policy is NOT caller-weakenable", () => {
  // Advisor P0 false-green: a probe with iterations=1, confidence=0.01, seed=1 emitted
  // all 96 metrics `passed` with relative_ci_width_percent=0 (a degenerate zero-width CI).
  // The report-producing path MUST use ONLY the locked statistics policy; any drifting
  // statsOpts is a would-be false green and MUST throw BEFORE a report is produced.
  it("RED-FIRST: the Advisor's exact probe (iterations=1, confidence=0.01, seed=1) throws before emitting a report", () => {
    expect.hasAssertions();
    let threw = false;
    let code: string | undefined;
    try {
      buildResourceReport({ statsOpts: { seed: 1, iterations: 1, confidence: 0.01 } });
    } catch (e: any) {
      threw = true;
      code = e.code;
    }
    expect(threw, "the Advisor's zero-width-CI probe must NOT emit an all-passed report").toBe(true);
    expect(code).toBe("LOCKED_STATS_POLICY_DRIFT");
  });

  it("RED-FIRST: every single-field weakening (iterations / confidence / seed / omitted / extra) throws LOCKED_STATS_POLICY_DRIFT before emit", () => {
    expect.hasAssertions();
    const probes: Array<Record<string, unknown>> = [
      { seed: 20260711, iterations: 1, confidence: 0.95 }, // (a) fewer iterations -> degenerate CI
      { seed: 20260711, iterations: 10000, confidence: 0.01 }, // (b) looser confidence
      { seed: 1, iterations: 10000, confidence: 0.95 }, // (c) different seed
      { seed: 20260711, iterations: 10000 }, // (d) omitted required field (confidence)
      { seed: 20260711, iterations: 10000, confidence: 0.95, extra: true }, // extra field
      {}, // empty
    ];
    for (const statsOpts of probes) {
      let threw = false;
      let code: string | undefined;
      try {
        buildResourceReport({ statsOpts });
      } catch (e: any) {
        threw = true;
        code = e.code;
      }
      expect(threw, `statsOpts ${JSON.stringify(statsOpts)} must throw before emitting a report`).toBe(true);
      expect(code, `statsOpts ${JSON.stringify(statsOpts)}`).toBe("LOCKED_STATS_POLICY_DRIFT");
    }
  });

  // --- TOCTOU recurrence (Advisor P0): the guard must not validate the CALLER object and
  // then reuse it for the 96 recomputes. A getter/proxy that returns the locked values
  // during validation and weakened values during the bootstrap reads, or an object mutated
  // after validation, must NEVER yield a zero-width-CI all-passed report. ---
  const NEVER_FALSE_GREEN = (built: any): void => {
    // full-iteration locked estimator => non-degenerate CI widths, and byte-identical to default.
    expect(built.report.performance_metrics.every((m: any) => m.relative_ci_width_percent > 0)).toBe(true);
    expect(built.report.performance_metrics.some((m: any) => m.relative_ci_width_percent === 0)).toBe(false);
    expect(built.report.performance_metrics).toEqual(EMITTED.report.performance_metrics);
  };

  it("RED-FIRST: an ENUMERABLE-GETTER statsOpts (locked on read 1, weakened after) can NEVER produce a zero-width-CI all-passed report", () => {
    const reads: Record<string, number> = { seed: 0, iterations: 0, confidence: 0 };
    const evil: any = {};
    for (const [k, locked, weak] of [["seed", 20260711, 1], ["iterations", 10000, 1], ["confidence", 0.95, 0.01]] as Array<[string, number, number]>) {
      Object.defineProperty(evil, k, { get() { reads[k] += 1; return reads[k] === 1 ? locked : weak; }, enumerable: true, configurable: true });
    }
    let built: any = null;
    let threw = false;
    let code: string | undefined;
    try {
      built = buildResourceReport({ statsOpts: evil });
    } catch (e: any) {
      threw = true;
      code = e.code;
    }
    // EITHER it threw before emitting, OR it emitted a full-iteration locked report — never a false green.
    if (threw) expect(code).toBe("LOCKED_STATS_POLICY_DRIFT");
    else NEVER_FALSE_GREEN(built);
    // each caller field was read at most ONCE (not 1 validate + 96 recompute = 97).
    expect(reads.seed).toBeLessThanOrEqual(1);
    expect(reads.iterations).toBeLessThanOrEqual(1);
    expect(reads.confidence).toBeLessThanOrEqual(1);
  });

  it("RED-FIRST: a PROXY statsOpts whose get-trap flips values after the first read can NEVER produce a false green", () => {
    const reads: Record<string, number> = { seed: 0, iterations: 0, confidence: 0 };
    const locked: Record<string, number> = { seed: 20260711, iterations: 10000, confidence: 0.95 };
    const weak: Record<string, number> = { seed: 1, iterations: 1, confidence: 0.01 };
    const evil = new Proxy(locked, {
      get(target, prop: string | symbol) {
        if (typeof prop === "string" && prop in reads) {
          reads[prop] += 1;
          return reads[prop] <= 1 ? locked[prop] : weak[prop];
        }
        return (target as any)[prop];
      },
      ownKeys() { return ["seed", "iterations", "confidence"]; },
      getOwnPropertyDescriptor() { return { enumerable: true, configurable: true, value: 0 }; },
    });
    let built: any = null;
    let threw = false;
    let code: string | undefined;
    try {
      built = buildResourceReport({ statsOpts: evil as any });
    } catch (e: any) {
      threw = true;
      code = e.code;
    }
    if (threw) expect(code).toBe("LOCKED_STATS_POLICY_DRIFT");
    else NEVER_FALSE_GREEN(built);
    expect(reads.seed).toBeLessThanOrEqual(1);
    expect(reads.iterations).toBeLessThanOrEqual(1);
    expect(reads.confidence).toBeLessThanOrEqual(1);
  });

  it("RED-FIRST: buildResourceReport reads each caller statsOpts field EXACTLY ONCE (validate-then-discard; the 96 recomputes use the internal frozen snapshot)", () => {
    const reads: Record<string, number> = { seed: 0, iterations: 0, confidence: 0 };
    const counting: any = {};
    for (const [k, v] of [["seed", 20260711], ["iterations", 10000], ["confidence", 0.95]] as Array<[string, number]>) {
      Object.defineProperty(counting, k, { get() { reads[k] += 1; return v; }, enumerable: true, configurable: true });
    }
    const built = buildResourceReport({ statsOpts: counting });
    // the invariant: the caller object is read at most once per field (not 1 + 96 = 97 times).
    expect(reads).toEqual({ seed: 1, iterations: 1, confidence: 1 });
    // and the emitted numbers come from the internal locked snapshot => identical to the default.
    expect(built.report.performance_metrics).toEqual(EMITTED.report.performance_metrics);
  });

  it("INVARIANT: mutating a plain statsOpts to weakened values AFTER validation does not change the emitted report (recompute used the internal snapshot)", () => {
    const o: any = { seed: 20260711, iterations: 10000, confidence: 0.95 };
    const built = buildResourceReport({ statsOpts: o }); // validates + eagerly computes all 96 rows
    o.seed = 1; // then weaken every field — the finished report must be unaffected.
    o.iterations = 1;
    o.confidence = 0.01;
    NEVER_FALSE_GREEN(built);
  });

  it("accepts statsOpts byte-for-byte equal to the locked policy (any key order) and emits the SAME numbers as the default", () => {
    // Only ONE fresh build here (the locked-statsOpts one under test); the default is the
    // already-built EMITTED report (buildResourceReport({})), reused to stay within timeout.
    const withLocked = buildResourceReport({ statsOpts: { confidence: 0.95, iterations: 10000, seed: 20260711 } });
    // Identical estimator params => byte-identical rows (this is the ONLY accepted statsOpts).
    expect(withLocked.report.performance_metrics).toEqual(EMITTED.report.performance_metrics);
    expect(withLocked.report.performance_metrics.every((m: any) => m.result === "passed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("perf-soak-authority (FIX 2) honest gated host-safety (no fabricated preflight)", () => {
  // Advisor P0 evidence-truth: hostSafetyPreflight hardcoded all 8 host-safety fields to
  // true + preflight_passed=true with NO observation. An agent CANNOT truthfully attest
  // host isolation/quota/keychain, so this must be an HONEST NON-PASSING placeholder.
  it("RED-FIRST: the emitted host_safety is a non-passing gated placeholder (all 8 booleans false, preflight_passed false)", () => {
    const hs = EMITTED.report.host_safety;
    expect(hs.preflight_passed).toBe(false);
    for (const k of HOST_SAFETY_KEYS) {
      if (k === "evidence_refs") continue;
      expect(hs[k], `host_safety.${k} must be an honest false (not a fabricated true)`).toBe(false);
    }
    // shape is still the validator's exact key set (the honesty is in the VALUES).
    expect(new Set(Object.keys(hs))).toEqual(new Set(HOST_SAFETY_KEYS));
  });

  it("the emitted host_safety makes the mirror RED at HOST_SAFETY_INVALID once soaks are structurally passing (isolates the gate)", () => {
    // The generator NEVER emits passing soaks; here a COPY is patched to structurally-passing
    // soaks ONLY to advance the mirror past the soak gate and expose the host_safety verdict.
    const patched = structuredClone(EMITTED.report);
    const startIso = "2026-07-01T00:00:00.000Z";
    patched.soaks = (Object.entries(SOAK_NEED_HOURS) as Array<[string, number]>).map(([platform, hours]) => ({
      campaign_id: `soak:${platform}:probe`,
      platform_id: platform,
      started_at: startIso,
      completed_at: new Date(Date.parse(startIso) + (hours + 1) * 3600000).toISOString(),
      uninterrupted: true,
      final_release_candidate_tuple_sha256: EMITTED.tuple,
      result: "passed",
      evidence_refs: [{ path: `raw/probe-${platform}.json`, sha256: "b".repeat(64), bytes: 1, kind: "probe" }],
    }));
    const v = validateResourceReport(patched, { tuple: EMITTED.tuple });
    expect(v.result).toBe("RED");
    expect(v.code).toBe("HOST_SAFETY_INVALID");
  });

  it("absent-quota / non-scratch-keychain / non-isolated probes do NOT yield a passing host_safety", () => {
    // Flipping ANY single host-safety boolean true (a partial fabrication) still cannot pass:
    // the emitted placeholder is uniformly non-passing and each field is independently gated.
    const patched = structuredClone(EMITTED.report);
    const startIso = "2026-07-01T00:00:00.000Z";
    patched.soaks = (Object.entries(SOAK_NEED_HOURS) as Array<[string, number]>).map(([platform, hours]) => ({
      campaign_id: `soak:${platform}:probe`,
      platform_id: platform,
      started_at: startIso,
      completed_at: new Date(Date.parse(startIso) + (hours + 1) * 3600000).toISOString(),
      uninterrupted: true,
      final_release_candidate_tuple_sha256: EMITTED.tuple,
      result: "passed",
      evidence_refs: [{ path: `raw/probe-${platform}.json`, sha256: "b".repeat(64), bytes: 1, kind: "probe" }],
    }));
    patched.host_safety = { ...patched.host_safety, isolated_non_prod: true }; // only one field faked true
    const v = validateResourceReport(patched, { tuple: EMITTED.tuple });
    expect(v.result).toBe("RED");
    expect(v.code).toBe("HOST_SAFETY_INVALID"); // still fails (hard_quotas etc. remain false)
  });

  it("the sidecar discloses host_safety as operator/physically gated OUTSIDE the authoritative fields", () => {
    const ss = EMITTED.sealStatus;
    expect(ss.host_safety_status).toBe("operator_physical_gated");
    expect(ss.component_basis.host_safety.sealed).toBe(false);
    // the disclosure lives in the sidecar, never inside the authoritative host_safety object.
    expect("host_safety_status" in EMITTED.report.host_safety).toBe(false);
    expect("host_safety_status" in EMITTED.report).toBe(false);
  });
});

// ---------------------------------------------------------------------------
const cliCreated: string[] = [];
afterAll(() => {
  for (const d of cliCreated) fs.rmSync(d, { recursive: true, force: true });
});
describe("perf-soak-authority (6) CLI: honest provisional emit + no arbitrary write", () => {
  const mkdir = (p: string): string => {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
    cliCreated.push(d);
    return d;
  };
  const runCli = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [GEN, ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 120000 });

  it("emits an honest PROVISIONAL bundle (exit 0) that REDs at the independent soak gate", () => {
    const dir = mkdir("psa-out-");
    const out = path.join(dir, "FRIDAY_STRESS_RESOURCE_REPORT.json");
    const r = runCli(["--out", out]);
    expect(r.status, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.seal_status).toBe("PROVISIONAL_UNSEALED");
    expect(j.independent_mirror_verdict).toMatchObject({ result: "RED", code: "SOAK_INVALID" });
    expect(j.sensitivity_all_detectors_fired).toBe(true);
    expect(j.locked_metric_instance_set_sha256).toBe(LOCKED_METRIC_INSTANCE_SET_SHA256);
    expect(r.stderr).toContain("PROVISIONAL_UNSEALED");
    // report + sidecar + raw/ all present and only under the out dir.
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.existsSync(path.join(dir, "FRIDAY_STRESS_RESOURCE_REPORT.SEAL_STATUS.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "raw"))).toBe(true);
    const report = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(report.performance_metrics).toHaveLength(96);
    expect(report.soaks.every((s: any) => s.uninterrupted === false)).toBe(true);
  }, 120000);

  it("--strict fails closed (exit 4) because agent-side it is never SEALED", () => {
    const r = runCli(["--strict"]);
    expect(r.status).toBe(4);
  }, 120000);

  it("NO ARBITRARY WRITE: without --out nothing is written; env cannot redirect the destination", () => {
    // no --out: exit 0, prints result, writes NO file anywhere we can name.
    const probe = mkdir("psa-probe-");
    const sentinel = path.join(probe, "SHOULD_NOT_EXIST.json");
    const r = runCli([], { FRIDAY_OUT: sentinel, FRIDAY_OUT_DIR: probe, OUT: sentinel });
    expect(r.status).toBe(0);
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(fs.readdirSync(probe)).toHaveLength(0); // env vars did NOT create any write
    // the module source exposes no env-driven fs write path.
    const src = fs.readFileSync(GEN, "utf8");
    expect(src).not.toMatch(/writeFileSync\([^)]*process\.env/);
    expect(src).not.toMatch(/process\.env\.[A-Z_]+[^\n]*writeFileSync/);
  }, 120000);

  it("writes ONLY under the --out directory (no escape)", () => {
    const dir = mkdir("psa-scope-");
    const sub = path.join(dir, "nested");
    fs.mkdirSync(sub);
    const out = path.join(sub, "FRIDAY_STRESS_RESOURCE_REPORT.json");
    const before = new Set(fs.readdirSync(dir));
    const r = runCli(["--out", out]);
    expect(r.status, r.stderr).toBe(0);
    // dir gained only the "nested" entry we created (all writes are inside sub).
    expect(fs.readdirSync(dir).filter((e) => !before.has(e))).toEqual([]);
    const entries = fs.readdirSync(sub).sort();
    expect(entries).toEqual(["FRIDAY_STRESS_RESOURCE_REPORT.SEAL_STATUS.json", "FRIDAY_STRESS_RESOURCE_REPORT.json", "raw"]);
  }, 120000);

  // FIX 3 (P1 filesystem boundary): reproduce the Advisor's probe — a pre-existing `raw`
  // symlink to a SIBLING dir caused 101 files to be written OUTSIDE the declared output
  // dir with CLI exit 0. The hardened writer MUST fail closed (non-zero exit) and write
  // ZERO files outside the resolved output root.
  it("RED-FIRST: a pre-existing raw/ symlink to a sibling dir => non-zero exit, ZERO files leaked outside", () => {
    const dir = mkdir("psa-symlink-out-");
    const sibling = mkdir("psa-symlink-sibling-");
    fs.symlinkSync(sibling, path.join(dir, "raw")); // attacker indirection
    const out = path.join(dir, "FRIDAY_STRESS_RESOURCE_REPORT.json");
    const r = runCli(["--out", out]);
    expect(r.status, r.stderr).not.toBe(0);
    // the Advisor's exact failure: NO files written into the sibling target.
    expect(fs.readdirSync(sibling)).toHaveLength(0);
  }, 120000);

  it("RED-FIRST: a pre-existing symlink at the report FILE target fails the no-follow open (zero leak)", () => {
    const dir = mkdir("psa-symlink-file-");
    const sibling = mkdir("psa-symlink-file-sib-");
    const decoy = path.join(sibling, "pwned.json");
    const out = path.join(dir, "FRIDAY_STRESS_RESOURCE_REPORT.json");
    fs.symlinkSync(decoy, out); // report path is a symlink to a sibling file
    const r = runCli(["--out", out]);
    expect(r.status, r.stderr).not.toBe(0);
    expect(fs.existsSync(decoy)).toBe(false); // O_NOFOLLOW|O_EXCL prevented the write-through
    expect(fs.readdirSync(sibling)).toHaveLength(0);
  }, 120000);

  it("RED-FIRST: a symlinked INTERMEDIATE raw component (raw -> sibling containing raw/) is rejected, no leak", () => {
    const dir = mkdir("psa-symlink-mid-");
    const sibling = mkdir("psa-symlink-mid-sib-");
    fs.symlinkSync(sibling, path.join(dir, "raw")); // intermediate component is a symlink
    const out = path.join(dir, "FRIDAY_STRESS_RESOURCE_REPORT.json");
    const r = runCli(["--out", out]);
    expect(r.status, r.stderr).not.toBe(0);
    const j = r.stderr ? r.stderr : r.stdout;
    // fail-closed token, no files anywhere in the sibling.
    expect(j).toMatch(/SYMLINK_REJECTED|RAW_PATH_ESCAPE/);
    expect(fs.readdirSync(sibling)).toHaveLength(0);
  }, 120000);
});

// ---------------------------------------------------------------------------
// (FIX 4) P1 oracle independence: EXECUTE the real vendored R13 validator on a COMPLETE,
// structurally-valid fixture that embeds the emitted resource report, and assert the
// AUTHORITATIVE failure boundary (its real non-zero exit code + the specific token). The
// prior tests only hashed/regex-inspected the vendored validator or relied on the fast
// in-process mirror (validateResourceReport); this test makes the REAL validator the
// authoritative oracle for the SOAK_INVALID (and, once soaks are structurally passing,
// HOST_SAFETY_INVALID) claims.
// ---------------------------------------------------------------------------
describe("perf-soak-authority (FIX 4) authoritative oracle: execute the REAL vendored R13 validator", () => {
  const REV = "ENDBAR-20260713-R13-EXHAUSTIVE-STRESS";
  const PRODUCER = "producer:friday-stress-fixture";
  const REVIEWER = "reviewer:independent-fixture";
  const hex = (label: string): string => sha(Buffer.from(`fixture-digest:${label}`));
  const COVERAGE_CLASSES = ["http", "websocket_sse", "cli_ipc_ffi", "database_storage", "desktop_ui", "ios_ui", "android_ui", "ipad_ui", "share", "voice", "approval", "auth_owner", "data_lifecycle", "install_release", "provider", "telegram", "plugin_skill_mcp", "exec_sandbox", "notification_deeplink", "remote_network", "job_timer_os_event"];
  const ALL_DIMENSIONS = ["steady_sustained", "burst_ramp_to_limit", "concurrency_race_toctou", "duplicate_replay_idempotency", "scale_data_volume", "latency_partition_half_open_reconnect", "cancel_timeout_process_death_restart", "fault_before_during_after_effect", "resource_pressure_and_bounds", "malformed_oversized_deep_unicode_clock", "backpressure_load_shed_retry_ceiling", "recovery_rto_readback_exactly_once", "cleanup_leak_secret_absence", "security_owner_tenant_capability_under_load", "ui_interaction_a11y_visual_state_storm", "install_update_rollback_backup_restore_export_delete_uninstall", "version_skew_and_migration_compatibility"];
  const AUTHORITY_KINDS = ["S_static", "D_runtime", "A_artifact", "L_ledger", "S_ui", "R_ui", "C_ui"];

  // Build a COMPLETE 10-doc R13 bundle whose subjects/ledger/mechanisms/ui/devices/census/
  // perf-metrics/budgets all validate, so the real validator reaches the line-60 resource
  // gate and dies EXACTLY at soak (or host-safety, when soaks are structurally patched).
  function buildFixture({ passingSoaks = false }: { passingSoaks?: boolean } = {}): { docs: Record<string, unknown>; rawFiles: Array<{ path: string; content: string }> } {
    const rawFiles: Array<{ path: string; content: string }> = [];
    const pushRaw = (p: string, content: string): { path: string; sha256: string; bytes: number; kind: string } => {
      rawFiles.push({ path: p, content });
      return { path: p, sha256: sha(Buffer.from(content)), bytes: Buffer.byteLength(content), kind: "stress_fixture_evidence" };
    };
    const sharedRef = pushRaw("raw/shared-sample.json", `${JSON.stringify({ synthetic_fixture: true, note: "shared structural evidence sample (fixture only)" }, null, 2)}\n`);

    const subjects = COVERAGE_CLASSES.map((cc) => ({
      subject_id: `${cc}::subject`,
      subject_kind: "node",
      coverage_class: cc,
      requirement_ids: ["req:x"],
      mechanism_ids: [] as string[],
      control_ids: [] as string[],
      platform_ids: ["p-host"],
      profile_ids: ["prof:x"],
      artifact_role_ids: ["role:x"],
      reachable_state_ids: ["state:x"],
      applicable_dimensions: [...ALL_DIMENSIONS],
      risk: "low",
      release_required: true,
      applicability_rule_id: "rule:x",
      discovery_refs: [sharedRef],
    }));
    const subjectIds = subjects.map((s) => s.subject_id);
    const subjectSetSha = digestOf([...subjects].sort((a, b) => a.subject_id.localeCompare(b.subject_id)));
    const metricIds = lockedMetricInstanceIds();

    const obligation = {
      stress_obligation_id: "oblig:all",
      requirement_ids: ["req:x"],
      subject_kind: "node",
      subject_ids: [...subjectIds],
      mechanism_ids: [] as string[],
      control_ids: [] as string[],
      risk: "low",
      stress_dimensions: [...ALL_DIMENSIONS],
      applicability_rule_ids: ["rule:x"],
      reachable_state_ids: ["state:x"],
      platform_ids: ["p-host"],
      profile_ids: ["prof:x"],
      artifact_role_ids: ["role:x"],
      load_profile_id: "load-bounded",
      concurrency_profile_id: "deterministic-plus-seeded",
      fault_schedule_id: "before-during-after",
      network_profile_id: "partition-reconnect",
      data_scale_profile_id: "large-bounded",
      resource_budget_ids: ["budget:hub-rss-mib"],
      performance_metric_instance_ids: [...metricIds],
      minimum_operations: 100,
      minimum_duration_ms: 60000,
      stopping_rule: "fixed-budget",
      seed_set: [1, 2],
      production_seam: "production_adapter",
      authoritative_oracles: ["oracle:x"],
      security_invariants: ["sec:x"],
      zero_effect_invariants: ["zero:x"],
      backpressure_oracle: "bp:x",
      recovery_oracle: "rec:x",
      cleanup_oracle: "clean:x",
      negative_fixture_ids: ["neg:x"],
      expected_execution_keys: ["exec:1"],
      operator_leaf_refs: [] as string[],
      retest_triggers: ["trigger:x"],
      disposition: "required",
      not_applicable_proof: null,
    };
    const obligations = [obligation];
    const obligationSetSha = digestOf([...obligations].sort((a, b) => a.stress_obligation_id.localeCompare(b.stress_obligation_id)));

    const components = {
      source_sha: hex("source"),
      cross_platform_artifact_set_sha256: hex("artifact-set"),
      runtime_profile_digest: hex("runtime-profile"),
      obligation_set_sha256: obligationSetSha,
      verification_policy_set_sha256: hex("verification-policy"),
    };
    const tuple = digestOf(components);

    // The report under test, tuple-bound. Its raw evidence files are emitted by the harness.
    const built = buildResourceReport({ tuple });
    for (const f of built.rawFiles) rawFiles.push(f);
    let resourceReport: any = built.report;

    const authorityInputs = AUTHORITY_KINDS.map((kind, i) => {
      const auth = { source_kind: kind, final_release_candidate_tuple_sha256: tuple, subject_ids: i === 0 ? [...subjectIds] : [], generator_sha256: hex(`gen-${kind}`), reviewer_id: REVIEWER, producer_id: PRODUCER, verdict: "PASS" };
      return { ...pushRaw(`raw/authority-${kind}.json`, `${JSON.stringify(auth, null, 2)}\n`), kind: "discovery_authority" };
    });
    const reviewRef = { ...pushRaw("raw/review.json", `${JSON.stringify({ verdict: "PASS", final_release_candidate_tuple_sha256: tuple, reviewer_id: REVIEWER }, null, 2)}\n`), kind: "independent_review" };

    if (passingSoaks) {
      // The generator NEVER emits passing soaks; this COPY is patched to structurally-passing
      // soaks ONLY to advance the real validator PAST the soak gate and expose the AUTHORITATIVE
      // host-safety verdict on the emitted (all-false) host_safety.
      const startIso = "2026-07-01T00:00:00.000Z";
      const need: Record<string, number> = { hub: 72, ios: 24, android: 24 };
      resourceReport = {
        ...resourceReport,
        soaks: Object.entries(need).map(([platform, hours]) => ({
          campaign_id: `soak:${platform}:probe`,
          platform_id: platform,
          started_at: startIso,
          completed_at: new Date(Date.parse(startIso) + (hours + 1) * 3600000).toISOString(),
          uninterrupted: true,
          final_release_candidate_tuple_sha256: tuple,
          result: "passed",
          evidence_refs: [sharedRef],
        })),
      };
    }

    const docs: Record<string, unknown> = {
      "FRIDAY_STRESS_SUBJECT_INVENTORY.json": { schema_version: "friday.endbar.stress-subject-inventory.r13.v1", contract_revision: REV, producer_id: PRODUCER, final_release_candidate_components: components, final_release_candidate_tuple_sha256: tuple, subject_set_sha256: subjectSetSha, authority_inputs: authorityInputs, subjects, unknown_ids: [], ghost_ids: [] },
      "FRIDAY_STRESS_OBLIGATION_LEDGER.json": { schema_version: "friday.endbar.stress-obligation-ledger.r13.v1", contract_revision: REV, final_release_candidate_tuple_sha256: tuple, obligation_set_sha256: obligationSetSha, subjects_sha256: subjectSetSha, obligations },
      "FRIDAY_STRESS_MECHANISM_MATRIX.json": { schema_version: "friday.endbar.stress-mechanism-matrix.r13.v1", contract_revision: REV, final_release_candidate_tuple_sha256: tuple, subjects_sha256: subjectSetSha, rows: subjects.map((s) => ({ subject_id: s.subject_id, mechanism_ids: [], obligation_ids: ["oblig:all"] })) },
      "FRIDAY_STRESS_UI_CONTROL_MATRIX.json": { schema_version: "friday.endbar.stress-ui-control-matrix.r13.v1", contract_revision: REV, final_release_candidate_tuple_sha256: tuple, static_control_ids: [], runtime_control_ids: [], contract_control_ids: [], rows: [] },
      "FRIDAY_STRESS_DEVICE_MATRIX.json": { schema_version: "friday.endbar.stress-device-matrix.r13.v1", contract_revision: REV, final_release_candidate_tuple_sha256: tuple, rows: ["macos", "ios", "android", "ipad"].map((p) => ({ platform_id: p, physical: true, signed_artifact: true, artifact_identity: `identity:${p}`, campaign_status: "passed", operator_leaf_ref: `leaf:${p}`, evidence_refs: [sharedRef] })) },
      "FRIDAY_STRESS_EXECUTION_CENSUS.json": { schema_version: "friday.endbar.stress-execution-census.r13.v1", contract_revision: REV, final_release_candidate_tuple_sha256: tuple, expected_execution_keys: ["exec:1"], executions: [{ execution_key: "exec:1", stress_obligation_id: "oblig:all", source_sha: components.source_sha, pr_candidate_head_sha: hex("pr-head"), final_release_candidate_tuple_sha256: tuple, artifact_set_sha256: components.cross_platform_artifact_set_sha256, runtime_profile_digest: components.runtime_profile_digest, installed_runtime_identity: "runtime:fixture", test_binary_sha256: hex("test-binary"), runner_sha256: hex("runner"), harness_config_sha256: hex("harness-config"), verification_policy_set_sha256: components.verification_policy_set_sha256, seed: 1, started_at: "2026-07-01T00:00:00.000Z", completed_at: new Date(Date.parse("2026-07-01T00:00:00.000Z") + 60000).toISOString(), operations_attempted: 100, operations_completed: 100, outcome_counts: { passed: 100 }, faults_injected: [], resource_sample_refs: [sharedRef], oracle_refs: [sharedRef], effect_readback_refs: [sharedRef], cleanup_refs: [sharedRef], stress_dimensions: [...ALL_DIMENSIONS], platform_ids: ["p-host"], profile_ids: ["prof:x"], artifact_role_ids: ["role:x"], reachable_state_ids: ["state:x"], load_profile_id: "load-bounded", concurrency_profile_id: "deterministic-plus-seeded", fault_schedule_id: "before-during-after", network_profile_id: "partition-reconnect", data_scale_profile_id: "large-bounded", resource_budget_ids: ["budget:hub-rss-mib"], performance_metric_instance_ids: [...metricIds], producer_id: PRODUCER, mock_detected: false, test_only_path_detected: false, secret_canary_hits: 0, duplicate_effect_count: 0, unbounded_growth_detected: false, candidate_mismatch_detected: false, review_attestation_ref: reviewRef, result: "passed" }] },
      "FRIDAY_STRESS_RESOURCE_REPORT.json": resourceReport,
      "FRIDAY_STRESS_FAILURE_RECOVERY_REPORT.json": {},
      "FRIDAY_STRESS_SENSITIVITY_REPORT.json": {},
      "FRIDAY_STRESS_FINAL_RECEIPT.json": {},
    };
    return { docs, rawFiles };
  }

  const fixtureDirs: string[] = [];
  afterAll(() => {
    for (const d of fixtureDirs) fs.rmSync(d, { recursive: true, force: true });
  });
  function writeFixture(opts: { passingSoaks?: boolean } = {}): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "psa-real-validator-")));
    fixtureDirs.push(dir);
    const { docs, rawFiles } = buildFixture(opts);
    fs.mkdirSync(path.join(dir, "raw"), { recursive: true });
    const written = new Set<string>();
    for (const f of rawFiles) {
      if (written.has(f.path)) continue;
      written.add(f.path);
      fs.writeFileSync(path.join(dir, f.path), f.content);
    }
    for (const [name, doc] of Object.entries(docs)) fs.writeFileSync(path.join(dir, name), `${JSON.stringify(doc, null, 2)}\n`);
    return dir;
  }
  function runRealValidator(dir: string): { status: number | null; out: any } {
    const r = spawnSync(process.execPath, [VENDORED_VALIDATOR, dir, "--fixture"], { encoding: "utf8", env: { ...process.env, FRIDAY_R13_NEGATIVE_FIXTURE: "1" }, timeout: 120000 });
    let out: any = null;
    try {
      out = JSON.parse(r.stderr || r.stdout);
    } catch {
      out = { raw_stderr: r.stderr, raw_stdout: r.stdout };
    }
    return { status: r.status, out };
  }

  it("the executed oracle is byte-identical to the operator-attested vendored validator record", () => {
    expect(sha(fs.readFileSync(VENDORED_VALIDATOR))).toBe(VENDORED_VALIDATOR_SHA);
  });

  it("AUTHORITATIVE: the REAL validator REDs at SOAK_INVALID (exit 65) on the emitted (honest, non-passing) soaks", () => {
    // Sanity: the emitted report is genuinely embedded (its soaks are the honest placeholders).
    // Reuse the already-built EMITTED default so this test builds only the tuple-bound fixture report.
    expect(EMITTED.report.soaks.every((s: any) => s.uninterrupted === false && s.result !== "passed")).toBe(true);
    const dir = writeFixture({ passingSoaks: false });
    const { status, out } = runRealValidator(dir);
    expect(status, JSON.stringify(out)).toBe(65); // real validator die() exit code
    expect(out.result).toBe("RED");
    expect(out.code).toBe("SOAK_INVALID");
  }, 120000);

  it("AUTHORITATIVE: with soaks structurally patched (probe), the REAL validator REDs at HOST_SAFETY_INVALID (exit 65) on the emitted (all-false) host_safety", () => {
    // Reuse the already-built EMITTED default (host_safety is honest-false, FIX 2).
    expect(EMITTED.report.host_safety.preflight_passed).toBe(false);
    const dir = writeFixture({ passingSoaks: true });
    const { status, out } = runRealValidator(dir);
    expect(status, JSON.stringify(out)).toBe(65);
    expect(out.result).toBe("RED");
    expect(out.code).toBe("HOST_SAFETY_INVALID");
  }, 120000);

  it("the fixture genuinely reaches the resource gate: fabricating host_safety=true advances the real validator PAST it (boundary is authoritative, not the mirror)", () => {
    // Prove the HOST_SAFETY_INVALID token above is caused by the emitted all-false host_safety:
    // replacing it with an (illegitimate) all-true host_safety makes the real validator sail
    // past the host-safety gate to the NEXT unmet gate — a different token entirely.
    const dir = writeFixture({ passingSoaks: true });
    const reportPath = path.join(dir, "FRIDAY_STRESS_RESOURCE_REPORT.json");
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    report.host_safety = { isolated_non_prod: true, hard_quotas: true, scratch_keychain: true, owned_processes_only: true, prod_ports_untouched: true, prod_db_data_services_untouched: true, destructive_host_lifecycle_absent: true, preflight_passed: true, evidence_refs: report.host_safety.evidence_refs };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    const { status, out } = runRealValidator(dir);
    expect(status, JSON.stringify(out)).toBe(65);
    expect(out.code).not.toBe("HOST_SAFETY_INVALID"); // it advanced past the gate
    expect(out.code).not.toBe("SOAK_INVALID");
  }, 120000);
});

// ---------------------------------------------------------------------------
// (FIX 5) P0 evidence-integrity: EVERY caller-controlled input to buildResourceReport is
// materialized ONCE at the entry barrier into a plain, deep-frozen internal snapshot, and
// every downstream stage (raw-evidence serialization, sha256 hashing, p95/bootstrap
// recompute, per-metric row, aggregate) reads ONLY that snapshot. This closes the THIRD
// recurrence of the caller-controlled check/use class: `opts.samplesFor` sample arrays were
// serialized+hashed at one stage and re-read at recompute, so a two-stage accessor could
// persist over-budget raw evidence while the verdict reported "passed".
// ---------------------------------------------------------------------------
describe("perf-soak-authority (FIX 5) caller sample hooks are materialized once at the entry barrier", () => {
  // A malicious producer: each element getter returns an OVER-budget value on its FIRST read
  // (the stage that would serialize the persisted raw evidence) and a constant UNDER-budget
  // value on every later read (the stage that would recompute the verdict). Pre-fix this
  // splits evidence (over) from verdict (passed); post-fix the one-shot materialize captures
  // the first read, so evidence AND verdict are both bound to the same frozen over-budget snapshot.
  function twoStageProducer(_id: string, budget: number): { samples: number[]; warmupSamples: number[] } {
    const overFor = (i: number): number => budget * (1.2 + (i % 7) * 0.02); // varied, all > budget
    const underConst = budget * 0.4; // constant, < budget
    const makeArr = (n: number): number[] => {
      const arr: any[] = [];
      for (let i = 0; i < n; i += 1) {
        let read = 0;
        Object.defineProperty(arr, i, { get() { read += 1; return read === 1 ? overFor(i) : underConst; }, enumerable: true, configurable: true });
      }
      return arr as number[];
    };
    return { samples: makeArr(50), warmupSamples: makeArr(5) };
  }

  const findRaw = (built: any, refPath: string): any => built.rawFiles.find((f: any) => f.path === refPath);
  // Independently recompute p95/CI/result from the PERSISTED raw-evidence bytes with the locked
  // policy (statsOpts omitted => the estimator's internal locked defaults), returning the row.
  function recomputeFromEvidence(built: any, row: any): any {
    const ref = row.evidence_refs[0];
    const parsed = JSON.parse(findRaw(built, ref.path).content);
    return recomputeMetric({ metric_instance_id: parsed.metric_instance_id, samples: parsed.samples, warmups: (parsed.warmup_samples || []).length, budget: parsed.p95_budget, evidence_refs: row.evidence_refs }).row;
  }

  let TWO_STAGE: any;
  beforeAll(() => {
    TWO_STAGE = buildResourceReport({ samplesFor: twoStageProducer });
  }, 60000);

  it("RED-FIRST (a): a two-stage producer whose persisted raw evidence is OVER budget can NEVER emit a 'passed' row (no evidence/verdict split, no zero-width false green)", () => {
    // persisted raw evidence must be over budget (that is what serialization captured)...
    for (const m of TWO_STAGE.report.performance_metrics) {
      const parsed = JSON.parse(findRaw(TWO_STAGE, m.evidence_refs[0].path).content);
      expect(parsed.samples.every((s: number) => s > parsed.p95_budget)).toBe(true);
    }
    // ...so NO row may be "passed", and none may pass via a degenerate zero-width CI.
    expect(TWO_STAGE.report.performance_metrics.some((m: any) => m.result === "passed")).toBe(false);
    expect(TWO_STAGE.report.performance_metrics.every((m: any) => m.result === "failed")).toBe(true);
    expect(TWO_STAGE.report.performance_metrics.every((m: any) => m.relative_ci_width_percent > 0)).toBe(true);
  });

  it("RED-FIRST (d): recompute from the PERSISTED raw-evidence bytes EQUALS the emitted metric row for every metric (verdict is bound to the persisted evidence)", () => {
    for (const row of TWO_STAGE.report.performance_metrics) {
      expect(recomputeFromEvidence(TWO_STAGE, row)).toEqual(row);
    }
  });

  it("(d) the same binding holds for the DEFAULT honest producer (persisted evidence recomputes to the emitted row)", () => {
    for (const row of EMITTED.report.performance_metrics) {
      expect(recomputeFromEvidence(EMITTED, row)).toEqual(row);
    }
  });

  it("RED-FIRST (b): a getter/proxy sample array cannot yield an evidence/verdict split — persisted evidence and verdict agree", () => {
    // For every metric: the result recomputed from the persisted bytes agrees with the emitted
    // result (both derived from the one frozen snapshot). A split (evidence 'failed' vs verdict
    // 'passed') is impossible.
    for (const row of TWO_STAGE.report.performance_metrics) {
      const fromEvidence = recomputeFromEvidence(TWO_STAGE, row);
      expect(fromEvidence.result).toBe(row.result);
      expect(fromEvidence.p95_ci_upper_pass).toBe(row.p95_ci_upper_pass);
      expect(fromEvidence.relative_ci_width_percent).toBe(row.relative_ci_width_percent);
    }
  });

  it("INVARIANT (c): mutating the caller's returned sample arrays AFTER the call does not change the emitted report", () => {
    const held: number[][] = [];
    const producer = (_id: string, budget: number): { samples: number[]; warmupSamples: number[] } => {
      const samples = Array.from({ length: 50 }, () => budget * 0.4);
      const warmupSamples = Array.from({ length: 5 }, () => budget * 0.4);
      held.push(samples, warmupSamples);
      return { samples, warmupSamples };
    };
    const built = buildResourceReport({ samplesFor: producer });
    const before = JSON.stringify(built.report.performance_metrics);
    for (const arr of held) arr.fill(Number.NaN); // corrupt every caller array post-hoc
    expect(JSON.stringify(built.report.performance_metrics)).toBe(before); // report is bound to the frozen copy
  });

  it("RED-FIRST: fail CLOSED at the barrier on unsupported caller sample structures (non-array / sparse / non-finite / non-number getter)", () => {
    const barrierCodes = ["UNSUPPORTED_CALLER_STRUCTURE", "RAW_SAMPLE_INVALID"];
    const probe = (samplesFor: any): string | undefined => {
      try {
        buildResourceReport({ samplesFor });
        return undefined;
      } catch (e: any) {
        return e.code;
      }
    };
    // non-array samples
    expect(probe(() => ({ samples: "not-an-array", warmupSamples: [1, 2, 3, 4, 5] }))).toBe("UNSUPPORTED_CALLER_STRUCTURE");
    // sparse / holey array
    const sparse: any[] = new Array(50);
    sparse[0] = 1;
    expect(barrierCodes).toContain(probe(() => ({ samples: sparse, warmupSamples: [1, 2, 3, 4, 5] })));
    // non-finite element (Infinity)
    const inf = Array.from({ length: 50 }, () => 1);
    inf[3] = Number.POSITIVE_INFINITY;
    expect(probe(() => ({ samples: inf, warmupSamples: [1, 2, 3, 4, 5] }))).toBe("RAW_SAMPLE_INVALID");
    // getter that yields a non-number
    const bad: any[] = [];
    for (let i = 0; i < 50; i += 1) Object.defineProperty(bad, i, { get: () => "big", enumerable: true, configurable: true });
    expect(probe(() => ({ samples: bad, warmupSamples: [1, 2, 3, 4, 5] }))).toBe("RAW_SAMPLE_INVALID");
  });
});

// ---------------------------------------------------------------------------
// (FIX 6) P1 fail-open CLI parsing: the OLD parseArgs silently ignored unknown options and
// swallowed a following option as the value of --out/--tuple. WORST: `--out --strict` treated
// `--strict` as the output FILENAME -> suppressed strict mode, wrote the provisional report +
// sidecar + raw/ files, and exited 0 (a false-green around the only fail-closed gate). The
// closed grammar must FAIL FAST (exit 2) on any malformed control input BEFORE any evidence is
// produced: no report, no sidecar, no raw dir, zero filesystem output.
// ---------------------------------------------------------------------------
describe("perf-soak-authority (FIX 6) closed, fail-fast CLI grammar (no fail-open, no evidence on malformed input)", () => {
  const cli6Dirs: string[] = [];
  afterAll(() => {
    for (const d of cli6Dirs) fs.rmSync(d, { recursive: true, force: true });
  });
  const freshDir = (): string => {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "psa-cli6-")));
    cli6Dirs.push(d);
    return d;
  };
  // Spawn the REAL CLI with cwd = a fresh empty temp dir so any (erroneous) relative write lands
  // there and can be detected. Returns the exit status, stderr, and the dir contents afterwards.
  const runInDir = (args: string[]): { status: number | null; stderr: string; entries: string[]; dir: string } => {
    const dir = freshDir();
    const r = spawnSync(process.execPath, [GEN, ...args], { encoding: "utf8", cwd: dir, env: { ...process.env }, timeout: 120000 });
    return { status: r.status, stderr: r.stderr, entries: fs.readdirSync(dir), dir };
  };

  // --- RED-FIRST negative matrix: each must exit 2 (USAGE) AND write ZERO files anywhere. ---
  const NEGATIVE: Array<[string, string[]]> = [
    ["unknown option --foo", ["--foo"]],
    ["misspelled --strcit", ["--strcit"]],
    ["bare --out (no value, end of argv)", ["--out"]],
    ["bare --tuple (no value, end of argv)", ["--tuple"]],
    ["--out --strict (option-like value must NOT be swallowed)", ["--out", "--strict"]],
    ["--tuple --strict (option-like value must NOT be swallowed)", ["--tuple", "--strict"]],
    ["duplicate --out a --out b", ["--out", "a.json", "--out", "b.json"]],
    ["duplicate --strict --strict", ["--strict", "--strict"]],
    ["unexpected positional foo", ["foo"]],
    ["trailing positional after --out x extra", ["--out", "x.json", "extra"]],
  ];
  for (const [name, args] of NEGATIVE) {
    it(`RED-FIRST: ${name} -> exit 2 (USAGE) and ZERO filesystem output`, () => {
      const { status, stderr, entries, dir } = runInDir(args);
      expect(status, `stderr=${stderr}`).toBe(2); // fail-fast usage exit (nonzero, distinct from 0/3/4)
      expect(stderr).toMatch(/USAGE_ERROR/);
      // zero evidence: no report, no sidecar, no raw dir — nothing written anywhere under cwd.
      expect(entries, `wrote files into ${dir}: ${entries.join(", ")}`).toHaveLength(0);
    }, 120000);
  }

  // --- POSITIVE regressions: valid invocations behave EXACTLY as before. ---
  it("valid --out <path> writes the bundle and exits 0", () => {
    const dir = freshDir();
    const out = path.join(dir, "FRIDAY_STRESS_RESOURCE_REPORT.json");
    const r = spawnSync(process.execPath, [GEN, "--out", out], { encoding: "utf8", timeout: 120000 });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.existsSync(path.join(dir, "FRIDAY_STRESS_RESOURCE_REPORT.SEAL_STATUS.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "raw"))).toBe(true);
    expect(JSON.parse(r.stdout).independent_mirror_verdict).toMatchObject({ result: "RED", code: "SOAK_INVALID" });
  }, 120000);

  it("valid --tuple <64hex> --out <path> --strict writes the bundle then exits 4 (strict RED)", () => {
    const dir = freshDir();
    const out = path.join(dir, "FRIDAY_STRESS_RESOURCE_REPORT.json");
    const tuple = "a".repeat(64);
    const r = spawnSync(process.execPath, [GEN, "--tuple", tuple, "--out", out, "--strict"], { encoding: "utf8", timeout: 120000 });
    expect(r.status).toBe(4); // strict still fails closed
    expect(fs.existsSync(out)).toBe(true);
  }, 120000);

  it("--strict with no --out exits 4 and writes nothing", () => {
    const { status, entries } = runInDir(["--strict"]);
    expect(status).toBe(4);
    expect(entries).toHaveLength(0);
  }, 120000);

  it("no args exits 0 with the PROVISIONAL_UNSEALED banner and writes nothing", () => {
    const { status, stderr, entries } = runInDir([]);
    expect(status).toBe(0);
    expect(stderr).toContain("PROVISIONAL_UNSEALED");
    expect(entries).toHaveLength(0);
  }, 120000);

  // --- fast in-process grammar unit checks (no spawn) ---
  it("parseArgs: closed grammar accepts only the exact option set; malformed throws UsageError", () => {
    expect(parseArgs([])).toEqual({ out: null, tuple: null, strict: false });
    expect(parseArgs(["--out", "x.json"])).toEqual({ out: "x.json", tuple: null, strict: false });
    expect(parseArgs(["--tuple", "b".repeat(64), "--strict"])).toEqual({ out: null, tuple: "b".repeat(64), strict: true });
    for (const bad of [["--foo"], ["--strcit"], ["--out"], ["--tuple"], ["--out", "--strict"], ["--tuple", "--strict"], ["--out", "a", "--out", "b"], ["--strict", "--strict"], ["foo"], ["--out", "x", "extra"]]) {
      expect(() => parseArgs(bad), `expected ${JSON.stringify(bad)} to throw`).toThrow(UsageError);
    }
  });
});
