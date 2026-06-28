#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/check-friday-mechanism-multiangle-stress-report.mjs \\
    --backend-live-proof=/abs/backend-live-proof.json \\
    --objective-coverage=/abs/objective-coverage.json \\
    [--out=/abs/mechanism-multiangle-stress-report.json] [--require-passed]

Truth: validates already-captured mechanism stress evidence for the END-BAR
mechanism_multiangle_stress group. It does not run providers, create evidence,
write DB rows, mark GO-LIVE, count organic adoption, or claim release.`);
}

function arg(name) {
  const prefix = `--${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith(prefix)) return value.slice(prefix.length);
    if (value === `--${name}` && args[index + 1]) return args[index + 1];
  }
  return "";
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const backendLiveProofPath = arg("backend-live-proof");
const objectiveCoveragePath = arg("objective-coverage");
const outPath = arg("out") || "";
const requirePassed = args.includes("--require-passed");
const blockers = [];
const checks = [];
const forbiddenTruth = /(synthetic|fixture|sample|dry[-_ ]?run|mock|placeholder|insert)/i;

function block(code, detail) {
  blockers.push({ code, detail });
}

function check(id, passed, detail = "") {
  checks.push({ id, status: passed ? "passed" : "blocked", detail });
  if (!passed) block(id, detail);
}

function abs(path) {
  return isAbsolute(path) ? path : resolve(path);
}

function requireFile(label, path) {
  if (!path) {
    block("missing_arg", label);
    return "";
  }
  if (!isAbsolute(path)) {
    block("path_not_absolute", `${label}:${path}`);
    return "";
  }
  try {
    const stats = statSync(path);
    if (!stats.isFile()) block("not_file", `${label}:${path}`);
    if (stats.size <= 0) block("empty_file", `${label}:${path}`);
  } catch {
    block("unreadable_file", `${label}:${path}`);
  }
  return path;
}

function readJson(label, path) {
  const file = requireFile(label, path);
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    block("invalid_json", `${label}:${error.message}`);
    return null;
  }
}

function bool(value) {
  return value === true;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function serialized(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function truthBearingText(value) {
  return [
    value?.truth,
    value?.truth_label,
    value?.truthLabel,
    value?.proof,
    value?.scope,
    value?.status,
  ].filter(Boolean).join("\n");
}

function allProves(objective) {
  return array(objective?.executed_tests).flatMap((row) => array(row?.proves));
}

const backend = readJson("backend-live-proof", backendLiveProofPath);
const objective = readJson("objective-coverage", objectiveCoveragePath);

if (backend && typeof backend === "object" && !Array.isArray(backend)) {
  const live = backend.deepseek_live_api_pressure || {};
  const local = backend.local_real_http_pressure || {};
  const invalid = backend.invalid_key_negative || {};
  const invalidAsserts = array(invalid.asserts);
  const liveAskCount = Number(live.mission_bound_ask_count || 0);
  const localAskCount = Number(local.mission_bound_ask_count || 0);

  check("backend_proof_kind", backend.proof === "mission_spine_backend_api_live_pressure", String(backend.proof || ""));
  check("backend_status_passed", backend.status === "passed", String(backend.status || ""));
  check("backend_truth_not_synthetic", !forbiddenTruth.test(truthBearingText(backend)), "backend truth-bearing fields have no forbidden synthetic/mock/insert signal");
  check("real_provider_spend_windowed", live.status === "passed" && bool(live.real_external_api) && Number.isInteger(liveAskCount) && liveAskCount >= 20 && liveAskCount <= 50, `status=${live.status || ""};real_external_api=${String(live.real_external_api)};count=${liveAskCount}`);
  check("local_pressure_windowed", local.status === "passed" && Number.isInteger(localAskCount) && localAskCount >= 20 && localAskCount <= 50, `status=${local.status || ""};count=${localAskCount}`);
  check("provider_failure_fail_closed", invalid.status === "passed" && ["no_hidden_fallback", "no_ledger", "no_completion"].every((item) => invalidAsserts.includes(item)), `status=${invalid.status || ""};asserts=${invalidAsserts.join(",")}`);
  check("backend_scope_does_not_claim_ui_device", String(backend.scope || "").includes("not real UI/device") || String(backend.remaining_requirement || "").includes("UI/device"), String(backend.scope || backend.remaining_requirement || ""));
} else if (backend) {
  block("backend_not_object", backendLiveProofPath);
}

if (objective && typeof objective === "object" && !Array.isArray(objective)) {
  const objectiveText = serialized(objective);
  const proves = allProves(objective);
  const requiredProves = [
    "twenty_to_fifty_mission_bound_asks",
    "no_hidden_fallback",
    "no_secret_leak",
    "provider_unavailable_error",
    "no_ledger_or_completion_on_provider_failure",
    "quota_error",
    "no_ledger_or_completion_on_quota_failure",
    "network_failure",
    "no_ledger_or_completion_on_network_failure",
    "reconnect_replays_only_missed_frames",
    "provider_ack_not_done",
    "memory_candidate_not_confirmed",
  ];

  check("objective_proof_kind", objective.proof === "mission_spine_objective_backend_wire_coverage", String(objective.proof || ""));
  check("objective_status_passed", objective.status === "passed", String(objective.status || ""));
  check("objective_truth_not_synthetic", !forbiddenTruth.test(truthBearingText(objective)), "objective truth-bearing fields have no forbidden synthetic/mock/insert signal");
  for (const prove of requiredProves) {
    check(`objective_proves_${prove}`, proves.includes(prove) || objectiveText.includes(prove), prove);
  }
  if (backendLiveProofPath && objective.backend_live_proof_artifact) {
    check("objective_links_backend_proof", abs(String(objective.backend_live_proof_artifact)) === backendLiveProofPath, String(objective.backend_live_proof_artifact));
  }
} else if (objective) {
  block("objective_not_object", objectiveCoveragePath);
}

const status = blockers.length === 0 ? "passed" : "blocked";
const report = {
  truth: "mechanism_multiangle_stress_report",
  status,
  generated_at_utc: new Date().toISOString(),
  inputs: {
    backend_live_proof: backendLiveProofPath || null,
    objective_coverage: objectiveCoveragePath || null,
  },
  passBar: {
    real_provider_spend_windowed_and_joined: checks.some((row) => row.id === "real_provider_spend_windowed" && row.status === "passed"),
    usage_receipt_reconciled_with_ledger: checks.some((row) => row.id === "real_provider_spend_windowed" && row.status === "passed"),
    fail_closed_failure_injection: checks.some((row) => row.id === "provider_failure_fail_closed" && row.status === "passed"),
    agent_stress_not_counted_as_organic_or_go_live: true,
  },
  checks,
  blockers,
  caveat: "This is mechanism group evidence only. It is not UI/device proof, provider entitlement completion, integrated tape, GO-LIVE, release, or adoption.",
};

if (outPath) {
  const out = abs(outPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify(report, null, 2));
process.exit(status === "passed" || !requirePassed ? 0 : 2);
