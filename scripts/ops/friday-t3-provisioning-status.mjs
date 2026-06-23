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
    operatorAction: false,
    requireReady: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--operator-action") {
      options.operatorAction = true;
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
  node scripts/ops/friday-t3-provisioning-status.mjs [--db <hub.sqlite>] [--json] [--operator-action] [--require-ready]

This verifier only reads T3 provision tables. It never mints trust grants, context
passports, device rows, signatures, or fake organic evidence.`;
}

function quoteShell(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

const DEFAULT_CONTEXT_PASSPORT_ITEMS_PATH = "/tmp/friday-t3-passport-items-reviewed.json";

function buildContextPassportItemsTemplateCommand(
  outputPath = DEFAULT_CONTEXT_PASSPORT_ITEMS_PATH,
) {
  return [
    `/usr/bin/printf '%s\\n' \\`,
    "  '[' \\",
    "  '  {\"kind\":\"summary\",\"label\":\"Operator reviewed T3 context passport items.\",\"included\":true,\"sensitive\":false},' \\",
    "  '  {\"kind\":\"summary\",\"label\":\"Scope: current governed Friday mission only.\",\"included\":true,\"sensitive\":false},' \\",
    "  '  {\"kind\":\"summary\",\"label\":\"No signing-key custody or irreversible auto-approval granted.\",\"included\":true,\"sensitive\":false}' \\",
    `  ']' > ${quoteShell(outputPath)} && \\`,
    `node -e 'JSON.parse(require("fs").readFileSync(${JSON.stringify(outputPath)},"utf8")); console.log("context passport items JSON OK")'`,
  ].join("\n");
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

function countActiveTrustedDevices(dbPath) {
  if (!tableExists(dbPath, "trusted_device")) {
    return null;
  }
  return Number(queryScalar(dbPath, "SELECT count(*) FROM trusted_device WHERE revoked_at IS NULL"));
}

export function buildT3ProvisioningStatus(dbPath, nowMs = Date.now()) {
  const counts = Object.fromEntries(
    T3_TABLES.map((tableName) => [tableName, countTable(dbPath, tableName)]),
  );
  const activeTrustGrants = countActiveTrustGrants(dbPath, nowMs);
  const activeTrustedDevices = countActiveTrustedDevices(dbPath);
  const latest_device = latestTrustedDevice(dbPath);
  const checks = {
    device_identity: (counts.device_identity ?? 0) > 0,
    trusted_device: (counts.trusted_device ?? 0) > 0,
    active_trusted_device: (activeTrustedDevices ?? 0) > 0,
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
    active_trusted_devices: activeTrustedDevices,
    active_trust_grants: activeTrustGrants,
    checks,
    status: missing.length === 0 ? "ready" : "incomplete",
    t3_provisioned: missing.length === 0,
    missing,
    caveat:
      "ready means the governed T3 rows exist; it does not claim END-BAR, GO-LIVE, adoption, release, or operator signature completion.",
  };
}

export function buildT3OperatorAction(status) {
  const missingDevice =
    status.missing.includes("device_identity") ||
    status.missing.includes("trusted_device") ||
    status.missing.includes("active_trusted_device");
  const missingGrant =
    status.missing.includes("trust_grant") || status.missing.includes("active_trust_grant");
  const missingPassport =
    status.missing.includes("context_passport") || status.missing.includes("context_passport_item");
  const action = {
    truth_label: "t3_operator_action_hint_read_only_no_mint_no_signature",
    status: "ready",
    latest_device_id: status.latest_device?.device_id ?? null,
    missing: status.missing,
    command: null,
    items_json_template_command: null,
    notes: [
      "This is a read-only hint. It never mints rows, reads operator signing keys, flips flags, or creates organic evidence.",
      "Run the suggested command only from an operator-controlled shell with real values for every placeholder.",
    ],
  };

  if (missingDevice) {
    action.status = "pairing_required";
    action.command = [
      "FRIDAY_T3_PAIRING_PROOF_ACK=operator-runs-t3-pairing-proof \\",
      "  scripts/ops/friday-t3-pairing-proof.sh --pair --device-id '<real-device-id>'",
    ].join("\n");
    action.notes.push(
      "Pairing writes device_identity/trusted_device only after a real PairAck; it does not mint trust_grant or context_passport rows.",
    );
    return action;
  }

  if (missingGrant || missingPassport) {
    const step = missingGrant && missingPassport ? "both" : missingGrant ? "grant" : "passport";
    action.status = "operator_provision_required";
    if (missingPassport) {
      action.items_json_template_command = buildContextPassportItemsTemplateCommand();
    }
    const commandLines = [
      "FRIDAY_T3_OPERATOR_PROVISION_ACK=operator-runs-t3-provisioning \\",
      `FRIDAY_T3_DB_PATH=${quoteShell(status.dbPath)} \\`,
      `FRIDAY_T3_STEP=${step} \\`,
    ];
    if (missingGrant) {
      commandLines.push(
      "FRIDAY_T3_GRANT_ID='<operator-chosen-grant-id>' \\",
      "FRIDAY_T3_AGENT_ID='<agent-or-lane-id>' \\",
      "FRIDAY_T3_RISK_CEILING='<explicit-risk-ceiling>' \\",
      "FRIDAY_T3_EXPIRES_AT='<unix-ms-or-empty>' \\",
      "FRIDAY_T3_WORKSPACE='<canonical-workspace-or-empty>' \\",
      "FRIDAY_T3_TOKEN_CEILING='<token-ceiling-or-empty>' \\",
      "FRIDAY_T3_MAX_RUNS='<max-runs-or-empty>' \\",
      "FRIDAY_T3_AUTO_ALLOW_REVERSIBLE_CEILING='<ceiling-or-empty>' \\",
      "FRIDAY_T3_TOOLS='<comma-separated-tools-or-empty>' \\",
      "FRIDAY_T3_PROVIDERS='<comma-separated-providers-or-empty>' \\",
      "FRIDAY_T3_CHANNELS='<comma-separated-channels-or-empty>' \\",
      "FRIDAY_T3_WORKFLOW_FAMILIES='<comma-separated-workflows-or-empty>' \\",
      "FRIDAY_T3_SKILL_FAMILIES='<comma-separated-skills-or-empty>' \\",
      );
    }
    if (missingPassport) {
      commandLines.push(
      "FRIDAY_T3_PASSPORT_ID='<operator-chosen-passport-id>' \\",
      "FRIDAY_T3_MISSION_ID='<real-mission-id>' \\",
      "FRIDAY_T3_WORK_ITEM_ID='<real-work-item-id-or-empty>' \\",
      "FRIDAY_T3_DESTINATION_LANE='<destination-lane>' \\",
      "FRIDAY_T3_DESTINATION_TARGET='<destination-target-or-empty>' \\",
      `FRIDAY_T3_ITEMS_JSON=${quoteShell(DEFAULT_CONTEXT_PASSPORT_ITEMS_PATH)} \\`,
      );
    }
    commandLines.push(
      "scripts/ops/friday-t3-operator-provision.sh",
    );
    action.command = commandLines.join("\n");
    action.notes.push(
      `Latest paired device observed: ${status.latest_device.device_id}. This only proves a paired-device preflight exists; it does not approve grant/passport contents.`,
    );
    if (missingPassport) {
      action.notes.push("Prepare and review the context-passport items JSON file before running passport or both.");
    }
    if (missingGrant) {
      action.notes.push("At least one explicit grant boundary is required by the wrapper.");
    }
    return action;
  }

  action.notes.push("No missing T3 provision row family was observed. This still does not claim END-BAR, GO-LIVE, adoption, or release.");
  return action;
}

export function renderOperatorAction(action) {
  const lines = [
    "Friday T3 operator action hint",
    `truth_label=${action.truth_label}`,
    `status=${action.status}`,
    `latest_device_id=${action.latest_device_id ?? "<none>"}`,
  ];
  if (action.missing.length > 0) {
    lines.push(`missing=${action.missing.join(",")}`);
  }
  if (action.command) {
    lines.push("", "suggested_command:", action.command);
  }
  if (action.items_json_template_command) {
    lines.push("", "prepare_items_json:", action.items_json_template_command);
  }
  lines.push("", "notes:");
  for (const note of action.notes) {
    lines.push(`  - ${note}`);
  }
  return `${lines.join("\n")}\n`;
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
  lines.push(`  active_trusted_devices=${status.active_trusted_devices ?? "missing-table"}`);
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
  const operatorAction = options.operatorAction ? buildT3OperatorAction(status) : null;
  if (options.json) {
    const payload = operatorAction ? { ...status, operator_action: operatorAction } : status;
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(renderText(status));
    if (operatorAction) {
      process.stdout.write("\n");
      process.stdout.write(renderOperatorAction(operatorAction));
    }
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
