#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const DEFAULT_DB = path.join(
  os.homedir(),
  "Library/Application Support/Friday/state/rust-hub.sqlite",
);
const DEFAULT_PLIST = path.join(
  os.homedir(),
  "Library/LaunchAgents/com.friday.read-projection-server.plist",
);

function usage() {
  return `Friday read-projection runtime freshness check (read-only)

USAGE:
  node scripts/ops/check-read-projection-runtime-freshness.mjs [options]

Options:
  --repo-dir <path>          Repo root. Default: current working directory.
  --db <path>                Hub SQLite DB. Default: macOS Friday rust-hub.sqlite.
  --plist <path>             read-projection LaunchAgent plist.
  --require-current-schema   Exit non-zero if DB schema != repo code_max.
  --json                     Print JSON only.
  -h, --help                 Show this help.

This check never starts, stops, migrates, signs, enrolls, or writes anything.`;
}

function parseArgs(argv) {
  const options = {
    repoDir: process.env.FRIDAY_REPO_DIR || process.cwd(),
    dbPath: process.env.FRIDAY_RUST_HUB_DB || DEFAULT_DB,
    plistPath: process.env.FRIDAY_READ_PROJECTION_PLIST || DEFAULT_PLIST,
    json: false,
    requireCurrentSchema: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo-dir") {
      options.repoDir = argv[++i] || "";
    } else if (arg.startsWith("--repo-dir=")) {
      options.repoDir = arg.slice("--repo-dir=".length);
    } else if (arg === "--db") {
      options.dbPath = argv[++i] || "";
    } else if (arg.startsWith("--db=")) {
      options.dbPath = arg.slice("--db=".length);
    } else if (arg === "--plist") {
      options.plistPath = argv[++i] || "";
    } else if (arg.startsWith("--plist=")) {
      options.plistPath = arg.slice("--plist=".length);
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--require-current-schema") {
      options.requireCurrentSchema = true;
    } else if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    ...opts,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${command} exited ${result.status}`);
  }
  return result.stdout;
}

function readHubCodeMax(repoDir) {
  const schemaPath = path.join(repoDir, "rust-core/crates/friday-storage/src/schema.rs");
  const source = fs.readFileSync(schemaPath, "utf8");
  const hubStart = source.indexOf("pub fn hub_migrations()");
  const hubEnd = source.indexOf("pub fn hub_code_max()", hubStart);
  if (hubStart < 0 || hubEnd < 0) {
    throw new Error(`could not isolate hub_migrations() in ${schemaPath}`);
  }
  const hubSource = source.slice(hubStart, hubEnd);
  const versions = [...hubSource.matchAll(/Migration\s*\{\s*version:\s*(\d+),/g)].map((match) =>
    Number(match[1])
  );
  if (versions.length === 0) {
    throw new Error(`no Hub migration versions found in ${schemaPath}`);
  }
  return Math.max(...versions);
}

function readDbSchemaVersion(dbPath) {
  const sql = "SELECT version FROM schema_version WHERE id = 1";
  const raw = run("sqlite3", ["-readonly", dbPath, sql]).trim();
  const version = Number(raw);
  if (!Number.isFinite(version)) {
    throw new Error(`schema_version did not return a number: ${raw}`);
  }
  return version;
}

function readPlistProgramArguments(plistPath) {
  if (!fs.existsSync(plistPath)) {
    return null;
  }
  const raw = run("plutil", ["-extract", "ProgramArguments", "json", "-o", "-", plistPath]);
  return JSON.parse(raw);
}

function classifySchema(diskSchemaVersion, repoCodeMax) {
  if (diskSchemaVersion === repoCodeMax) {
    return {
      status: "schema_current",
      ok: true,
      reason: "Hub DB schema matches this repo build.",
    };
  }
  if (diskSchemaVersion < repoCodeMax) {
    return {
      status: "schema_behind_current_code",
      ok: false,
      reason:
        "Hub DB schema is older than this repo build; run the writable migration/deploy leg before restarting the read-only projection server.",
    };
  }
  return {
    status: "schema_ahead_of_current_code",
    ok: false,
    reason:
      "Hub DB schema is newer than this repo build; this checkout is stale and read-only bins must fail closed.",
  };
}

export function buildReport(options) {
  const repoDir = path.resolve(options.repoDir);
  const dbPath = path.resolve(options.dbPath);
  const plistPath = path.resolve(options.plistPath);
  const repoCodeMax = readHubCodeMax(repoDir);
  const diskSchemaVersion = readDbSchemaVersion(dbPath);
  const schema = classifySchema(diskSchemaVersion, repoCodeMax);
  const programArguments = readPlistProgramArguments(plistPath);
  const plistProgram = Array.isArray(programArguments) ? programArguments[0] : null;
  const plistDbArgIndex = Array.isArray(programArguments) ? programArguments.indexOf("--db") : -1;
  const plistDbPath = plistDbArgIndex >= 0 ? programArguments[plistDbArgIndex + 1] : null;
  const plistPortArgIndex = Array.isArray(programArguments) ? programArguments.indexOf("--port") : -1;
  const plistPort = plistPortArgIndex >= 0 ? programArguments[plistPortArgIndex + 1] : null;

  return {
    truth_label: "read_projection_runtime_freshness_read_only_no_restart_no_migration",
    generated_at_utc: new Date().toISOString(),
    repoDir,
    dbPath,
    plistPath,
    repoCodeMax,
    diskSchemaVersion,
    schemaStatus: schema.status,
    ok: schema.ok,
    reason: schema.reason,
    launchd: {
      plistPresent: fs.existsSync(plistPath),
      program: plistProgram,
      dbPath: plistDbPath,
      port: plistPort,
      pointsAtCheckedDb: plistDbPath ? path.resolve(plistDbPath) === dbPath : null,
    },
    caveat:
      "This is a read-only cutover sanity check. It does not prove the LaunchAgent was restarted, does not migrate the DB, and does not claim END-BAR, GO-LIVE, or adoption.",
  };
}

function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const report = buildReport(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`status=${report.schemaStatus}`);
    console.log(`db_schema=${report.diskSchemaVersion} repo_code_max=${report.repoCodeMax}`);
    console.log(`plist_present=${report.launchd.plistPresent} port=${report.launchd.port ?? "unknown"}`);
    console.log(`reason=${report.reason}`);
    console.log(`truth_label=${report.truth_label}`);
  }
  if (options.requireCurrentSchema && !report.ok) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(`check-read-projection-runtime-freshness failed: ${error.message}`);
  process.exitCode = 2;
}
