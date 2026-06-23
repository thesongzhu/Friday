#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const DEFAULT_DB = path.join(
  os.homedir(),
  "Library/Application Support/Friday/state/rust-hub.sqlite",
);

const T3_TABLES = [
  "device_identity",
  "trusted_device",
  "trust_grant",
  "context_passport",
  "context_passport_item",
];

export function parseArgs(argv) {
  const options = {
    dbPath: process.env.FRIDAY_T3_DB_PATH || DEFAULT_DB,
    json: false,
    requireReady: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--require-ready") {
      options.requireReady = true;
    } else if (arg === "--db") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--db requires a path");
      }
      options.dbPath = value;
      i += 1;
    } else if (arg.startsWith("--db=")) {
      options.dbPath = arg.slice("--db=".length);
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

export function usage() {
  return `Friday T3 provisioning status (read-only)

USAGE:
  node scripts/ops/friday-t3-provisioning-status.mjs [--db <hub.sqlite>] [--json] [--require-ready]

This verifier only reads T3 provision tables. It never mints trust grants, context
passports, device rows, signatures, or fake organic evidence.`;
}

function quoteSqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function queryScalar(dbPath, sql) {
  const result = spawnSync("sqlite3", ["-readonly", dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `sqlite3 exited ${result.status}`);
  }
  return result.stdout.trim();
}

function queryRowFields(dbPath, sql) {
  const result = spawnSync("sqlite3", ["-readonly", "-separator", "\u001f", dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `sqlite3 exited ${result.status}`);
  }
  const row = result.stdout.trim();
  return row ? row.split("\u001f") : null;
}

function tableExists(dbPath, tableName) {
  const present = queryScalar(
    dbPath,
    `SELECT count(*) FROM sqlite_master WHERE type='table' AND name=${quoteSqlString(tableName)}`,
  );
  return Number(present) > 0;
}

function latestTrustedDevice(dbPath) {
  if (!tableExists(dbPath, "trusted_device") || !tableExists(dbPath, "device_identity")) {
    return null;
  }
  const row = queryRowFields(
    dbPath,
    `SELECT
       td.device_id,
       COALESCE(di.role, ''),
       COALESCE(NULLIF(td.label, ''), NULLIF(di.display_name, ''), ''),
       td.paired_at,
       COALESCE(td.revoked_at, ''),
       COALESCE(td.key_rotated_at, ''),
       lower(hex(substr(td.public_key, 1, 4))) || ':' || lower(hex(substr(td.public_key, -4)))
     FROM trusted_device AS td
     LEFT JOIN device_identity AS di ON di.device_id = td.device_id
     ORDER BY td.paired_at DESC, td.device_id
     LIMIT 1`,
  );
  if (!row) {
    return null;
  }
  const [deviceId, role, label, pairedAt, revokedAt, keyRotatedAt, pubkeyFingerprint] = row;
  return {
    device_id: deviceId,
    role: role || "unknown",
    label: label || "",
    paired_at: Number(pairedAt),
    revoked_at: revokedAt === "" ? null : Number(revokedAt),
    key_rotated_at: keyRotatedAt === "" ? null : Number(keyRotatedAt),
    pubkey_fingerprint: pubkeyFingerprint,
  };
}

function countTable(dbPath, tableName) {
  if (!tableExists(dbPath, tableName)) {
    return null;
  }
  const quoted = `"${tableName.replaceAll('"', '""')}"`;
  return Number(queryScalar(dbPath, `SELECT count(*) FROM ${quoted}`));
}

function countActiveTrustGrants(dbPath, nowMs) {
  if (!tableExists(dbPath, "trust_grant")) {
    return null;
  }
  return Number(
    queryScalar(
      dbPath,
      `SELECT count(*) FROM trust_grant WHERE revoked = 0 AND (expires_at IS NULL OR expires_at > ${Number(nowMs)})`,
    ),
  );
}

export function buildT3ProvisioningStatus(dbPath, nowMs = Date.now()) {
  const counts = Object.fromEntries(
    T3_TABLES.map((tableName) => [tableName, countTable(dbPath, tableName)]),
  );
  const activeTrustGrants = countActiveTrustGrants(dbPath, nowMs);
  const latest_device = latestTrustedDevice(dbPath);
  const checks = {
    device_identity: (counts.device_identity ?? 0) > 0,
    trusted_device: (counts.trusted_device ?? 0) > 0,
    trust_grant: (counts.trust_grant ?? 0) > 0,
    active_trust_grant: (activeTrustGrants ?? 0) > 0,
    context_passport: (counts.context_passport ?? 0) > 0,
    context_passport_item: (counts.context_passport_item ?? 0) > 0,
  };
  const missing = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  return {
    dbPath,
    truth_label: "t3_provisioning_status_read_only_no_mint_no_signature",
    generated_at_utc: new Date(nowMs).toISOString(),
    counts,
    latest_device,
    active_trust_grants: activeTrustGrants,
    checks,
    status: missing.length === 0 ? "ready" : "incomplete",
    t3_provisioned: missing.length === 0,
    missing,
    caveat:
      "ready means the governed T3 rows exist; it does not claim END-BAR, GO-LIVE, adoption, release, or operator signature completion.",
  };
}

export function renderText(status) {
  const lines = [
    "Friday T3 provisioning status",
    `truth_label=${status.truth_label}`,
    `db=${status.dbPath}`,
    `status=${status.status}`,
    `t3_provisioned=${status.t3_provisioned ? "true" : "false"}`,
    "",
    "counts:",
  ];
  for (const tableName of T3_TABLES) {
    lines.push(`  ${tableName}=${status.counts[tableName] ?? "missing-table"}`);
  }
  lines.push(`  active_trust_grants=${status.active_trust_grants ?? "missing-table"}`);
  if (status.latest_device) {
    lines.push(
      "",
      "latest_device:",
      `  device_id=${status.latest_device.device_id}`,
      `  role=${status.latest_device.role}`,
      `  label=${status.latest_device.label || "<empty>"}`,
      `  paired_at=${status.latest_device.paired_at}`,
      `  revoked_at=${status.latest_device.revoked_at ?? "<active>"}`,
      `  key_rotated_at=${status.latest_device.key_rotated_at ?? "<never>"}`,
      `  pubkey_fingerprint=${status.latest_device.pubkey_fingerprint}`,
    );
  }
  if (status.missing.length > 0) {
    lines.push("", `missing=${status.missing.join(",")}`);
  }
  lines.push("", `caveat=${status.caveat}`);
  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const status = buildT3ProvisioningStatus(options.dbPath);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  } else {
    process.stdout.write(renderText(status));
  }
  if (options.requireReady && !status.t3_provisioned) {
    process.exitCode = 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`friday-t3-provisioning-status: ${error.message}\n`);
    process.exitCode = 1;
  });
}
