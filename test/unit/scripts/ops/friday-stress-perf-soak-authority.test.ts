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
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

  it("the INDEPENDENT mirror verdict REDs at the soak gate (no agent-side false green)", () => {
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
});
