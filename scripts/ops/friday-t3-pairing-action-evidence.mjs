#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/friday-t3-pairing-action-evidence.mjs \\
    --reconcile=/abs/db-reconcile.txt \\
    --client-output=/abs/friday-pairing-proof.json \\
    [--out=/abs/action-runtime-evidence.json] [--require-ready]

Truth: converts one real T3 PairAck/status proof artifact into explicit
mobile:firstLaunch action runtime evidence. It does not mint trust grants or
context passports, does not read signing keys, and does not claim END-BAR.`);
}

function arg(name) {
  const prefix = `--${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length) || "";
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const reconcilePath = arg("reconcile");
const clientOutputPath = arg("client-output");
const outPath = arg("out");
const requireReady = args.includes("--require-ready");
const blockers = [];

function block(code, detail) {
  blockers.push({ code, detail });
}

function abs(path) {
  return isAbsolute(path) ? path : resolve(path);
}

function readText(path, label) {
  if (!path) {
    block("missing_arg", label);
    return "";
  }
  try {
    return readFileSync(abs(path), "utf8");
  } catch {
    block("unreadable_file", `${label}:${path}`);
    return "";
  }
}

function readJson(path, label) {
  const body = readText(path, label);
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    block("invalid_json", `${label}:${path}`);
    return null;
  }
}

function parseKeyValue(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    map.set(line.slice(0, index), line.slice(index + 1));
  }
  return map;
}

function field(map, key) {
  const value = map.get(key) || "";
  if (!value) block("missing_reconcile_field", key);
  return value;
}

function numberField(map, key) {
  const value = field(map, key);
  if (!/^[0-9]+$/.test(value)) {
    block("reconcile_field_not_numeric", `${key}:${value || "<missing>"}`);
    return null;
  }
  return Number(value);
}

function stringJson(value, key) {
  if (value && typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  block("client_missing_string", key);
  return "";
}

const reconcileText = readText(reconcilePath, "reconcile");
const reconcile = parseKeyValue(reconcileText);
const client = readJson(clientOutputPath, "client-output");

const truth = field(reconcile, "truth");
if (truth && truth !== "friday_t3_pairing_proof_no_operator_key_no_grant_no_passport") {
  block("reconcile_truth_unexpected", truth);
}
const mode = field(reconcile, "mode");
if (mode && mode !== "status-only" && mode !== "pair") block("mode_unexpected", mode);
const pairingId = field(reconcile, "pairing_id");
const deviceId = field(reconcile, "device_id");
const beforeDevice = numberField(reconcile, "trusted_device_count_before");
const afterDevice = numberField(reconcile, "trusted_device_count_after");
const beforeGrants = numberField(reconcile, "trust_grant_count_before");
const afterGrants = numberField(reconcile, "trust_grant_count_after");
const beforePassports = numberField(reconcile, "context_passport_count_before");
const afterPassports = numberField(reconcile, "context_passport_count_after");

if (beforeGrants !== null && afterGrants !== null && beforeGrants !== afterGrants) {
  block("trust_grant_changed", `${beforeGrants}->${afterGrants}`);
}
if (beforePassports !== null && afterPassports !== null && beforePassports !== afterPassports) {
  block("context_passport_changed", `${beforePassports}->${afterPassports}`);
}

let clientTruth = "";
if (client) {
  clientTruth = stringJson(client, "truth");
  const clientPairingId = stringJson(client, "pairing_id");
  if (pairingId && clientPairingId && clientPairingId !== pairingId) {
    block("pairing_id_mismatch", `${pairingId}:${clientPairingId}`);
  }
}

if (mode === "status-only") {
  if (clientTruth && clientTruth !== "pairing_status_only_no_trusted_device_write") {
    block("client_truth_unexpected", clientTruth);
  }
  const hubOnline = client ? stringJson(client, "hub_online") : "";
  if (hubOnline && hubOnline !== "true") block("hub_not_online", hubOnline);
  if (beforeDevice !== null && afterDevice !== null && beforeDevice !== afterDevice) {
    block("trusted_device_changed_in_status_only", `${beforeDevice}->${afterDevice}`);
  }
}

if (mode === "pair") {
  if (clientTruth && clientTruth !== "pairing_pairack_real_sealed_ws_no_grant_no_passport_no_operator_key") {
    block("client_truth_unexpected", clientTruth);
  }
  const ackAccepted = client ? stringJson(client, "ack_accepted") : "";
  if (ackAccepted && ackAccepted !== "true") block("pairack_not_accepted", ackAccepted);
  if (beforeDevice !== null && afterDevice !== null && afterDevice <= beforeDevice) {
    block("trusted_device_not_created", `${beforeDevice}->${afterDevice}`);
  }
}

const evidenceRef = clientOutputPath ? abs(clientOutputPath) : "";
const common = {
  surface: "mobile",
  screen: "firstLaunch",
  status: "pass",
  evidence_ref: evidenceRef,
  pairing_id: pairingId || null,
  device_id: deviceId || null,
  source: "t3_pairing_proof_explicit_mobile_firstlaunch_action",
  truth_label: "pairing_action_runtime_evidence_not_grant_not_passport_not_endbar",
};

const actions = blockers.length === 0
  ? [
      {
        ...common,
        action_id: "firstlaunch_scan",
      },
      ...(mode === "pair" ? [{
        ...common,
        action_id: "firstlaunch_pairnow",
      }] : []),
    ]
  : [];

const output = {
  truth: "t3_pairing_action_runtime_evidence_not_endbar",
  status: blockers.length === 0 ? "ready" : "blocked",
  mode: mode || null,
  reconcile: reconcilePath ? abs(reconcilePath) : null,
  clientOutput: clientOutputPath ? abs(clientOutputPath) : null,
  actionCount: actions.length,
  actions,
  blockers,
  caveat: "This proves explicit firstLaunch QR/PairAck actions only. It does not prove approval UX, memory confirmation, voice, cross-device continuation, adoption, END-BAR, or operator signing.",
};

if (outPath && blockers.length === 0) {
  const out = abs(outPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(output, null, 2)}\n`);
}

console.log(JSON.stringify(output, null, 2));
process.exit((blockers.length === 0 || !requireReady) ? 0 : 2);
