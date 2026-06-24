#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");

function usage() {
  console.log(`usage:
  scripts/ops/friday-ios-sim-read-seam-enroll.mjs --metadata <shot.metadata.json> [--store-dir <dir>] [--enroll]

truth:
  Validates iOS simulator live-loopback metadata and runs hub_read_seam_enroll.
  Default is dry-run and writes no SecureStore state. --enroll requires
  FRIDAY_IOS_SIM_READ_SEAM_ENROLL_ACK=operator-approves-ios-sim-read-seam-enroll.
  This enrolls only the simulator public read-seam peer; it does not restart services,
  grant write access, mint trust grants/context passports, sign, or claim END-BAR/GO-LIVE.`);
}

function fail(message, code = 2) {
  console.error(`FATAL: ${message}`);
  process.exit(code);
}

function takeArg(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  if (index === args.length - 1) fail(`${name} requires a value`);
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  usage();
  process.exit(0);
}

const metadataPath = takeArg(args, "--metadata");
const storeDir =
  takeArg(args, "--store-dir") ||
  process.env.FRIDAY_READ_SEAM_STORE_DIR ||
  resolve(homedir(), ".friday/agent-run-securestore");
const enroll = args.includes("--enroll");
if (enroll) args.splice(args.indexOf("--enroll"), 1);
if (args.length > 0) fail(`unknown argument(s): ${args.join(" ")}`);
if (!metadataPath) {
  usage();
  fail("--metadata is required");
}
if (
  enroll &&
  process.env.FRIDAY_IOS_SIM_READ_SEAM_ENROLL_ACK !==
    "operator-approves-ios-sim-read-seam-enroll"
) {
  fail("--enroll writes read-seam allowlist state; set FRIDAY_IOS_SIM_READ_SEAM_ENROLL_ACK=operator-approves-ios-sim-read-seam-enroll", 4);
}

const absoluteMetadata = resolve(metadataPath);
if (!existsSync(absoluteMetadata)) fail(`metadata file not found: ${absoluteMetadata}`);

let metadata;
try {
  metadata = JSON.parse(readFileSync(absoluteMetadata, "utf8"));
} catch (error) {
  fail(`invalid metadata JSON: ${error.message}`);
}

const expectedTruth = "friday_ios_simulator_live-loopback_proof";
if (metadata.truth_label !== expectedTruth) fail(`truth_label must be ${expectedTruth}`);
if (metadata.mode !== "live-loopback") fail("mode must be live-loopback");
for (const key of [
  "live_read_requested",
  "live_write_requested",
  "live_pairing_requested",
  "device_keypair_requested",
  "simulator_file_device_keypair_requested",
]) {
  if (metadata[key] !== true) fail(`${key} must be true`);
}

const pubkey = String(metadata.simulator_device_pubkey || "");
if (!/^[0-9a-f]{64}$/.test(pubkey)) {
  fail("simulator_device_pubkey must be a lowercase 64-hex X25519 public key");
}

const enrollBin = resolve(repoRoot, "rust-core/target/release/hub_read_seam_enroll");
if (!existsSync(enrollBin)) {
  console.error("hub_read_seam_enroll release binary missing; building only that bin...");
  const build = spawnSync(
    "cargo",
    ["build", "--release", "--manifest-path", "rust-core/Cargo.toml", "--bin", "hub_read_seam_enroll"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "inherit",
    },
  );
  if (build.status !== 0) {
    fail(`failed to build ${enrollBin}`, build.status || 5);
  }
}

const enrollArgs = ["--store-dir", storeDir, "--pubkey", pubkey, "--add"];
if (!enroll) enrollArgs.push("--dry-run");

const result = spawnSync(enrollBin, enrollArgs, {
  cwd: repoRoot,
  encoding: "utf8",
});

const stdout = (result.stdout || "").trim();
const stderr = (result.stderr || "").trim();
if (stdout) console.log(stdout);
if (stderr) console.error(stderr);
if (result.status !== 0) {
  fail(`hub_read_seam_enroll exited ${result.status ?? "without status"}`, result.status || 6);
}

const proof = {
  truth_label: enroll
    ? "friday_ios_simulator_live_loopback_read_seam_enrolled"
    : "friday_ios_simulator_live_loopback_read_seam_dry_run",
  status: "pass",
  mode: enroll ? "enroll" : "dry-run",
  metadata: absoluteMetadata,
  store_dir: storeDir,
  simulator_device_pubkey: pubkey,
  caveat:
    "Read-seam peer validation/enrollment only. The read-projection server loads the allowlist at boot, so an already-running :48751 process may need a separate safe reload before this peer is admitted. No service restart, no write-seam grant, no trust grant/context passport mint, no signing, no END-BAR/GO-LIVE/adoption claim.",
};
console.log(JSON.stringify(proof, null, 2));
