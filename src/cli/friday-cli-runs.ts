import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadFridayConfig } from "#config";
import { createFridaySqliteLayer, resolveFridayDbPath } from "#state";

import {
  backfillFridayAgentRunPackContext,
  type BackfillPackContextReport,
} from "../agent/maintenance/friday-agent-pack-context-backfill.js";

export interface FridayCliRunsCommandInput {
  runsSubcommand?: "backfill-pack-context";
  dryRun: boolean;
  apply: boolean;
  json: boolean;
}

function printBackfillUsage(): void {
  console.error("Usage: friday runs backfill-pack-context [--dry-run|--apply] [--json]");
}

function printPlainReport(report: BackfillPackContextReport, mode: "dry_run" | "apply", dbPath: string): void {
  console.log(`Friday packContext backfill (${mode === "apply" ? "apply" : "dry-run"})`);
  console.log(`DB: ${dbPath}`);
  console.log("");
  console.log(`Scanned runs:      ${String(report.scannedRuns)}`);
  console.log(`Already tagged:    ${String(report.alreadyTaggedRuns)}`);
  console.log(`Eligible updates:  ${String(report.eligibleRuns)}`);
  console.log(`Updated runs:      ${String(report.updatedRuns)}`);
  console.log(`Skipped runs:      ${String(report.skippedRuns)}`);

  const skippedReasons = Object.entries(report.skippedByReason)
    .sort((left, right) => right[1] - left[1]);
  if (skippedReasons.length > 0) {
    console.log("");
    console.log("Skipped by reason:");
    for (const [reasonCode, count] of skippedReasons) {
      console.log(`- ${reasonCode}: ${String(count)}`);
    }
  }

  const updateCandidates = report.candidates.filter((candidate) => candidate.reasonCode === "updated");
  if (updateCandidates.length > 0) {
    console.log("");
    console.log(mode === "apply" ? "Updated runs:" : "Eligible updates:");
    for (const candidate of updateCandidates) {
      console.log(`- ${candidate.runId} -> ${candidate.inferredPackId ?? "unknown"} (${candidate.surface ?? "unknown-surface"})`);
    }
  }
}

function copyStateDbToTemp(dbPath: string): string {
  const tempDir = mkdtempSync(join(tmpdir(), "friday-pack-backfill-"));
  const tempDbPath = join(tempDir, "friday.db");
  copyFileSync(dbPath, tempDbPath);

  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  if (existsSync(walPath)) {
    copyFileSync(walPath, `${tempDbPath}-wal`);
  }
  if (existsSync(shmPath)) {
    copyFileSync(shmPath, `${tempDbPath}-shm`);
  }

  return tempDir;
}

export async function cmdRuns(input: FridayCliRunsCommandInput): Promise<void> {
  if (input.runsSubcommand !== "backfill-pack-context") {
    printBackfillUsage();
    process.exitCode = 1;
    return;
  }

  if (input.apply && input.dryRun) {
    console.error("Error: --dry-run and --apply cannot be used together.");
    process.exitCode = 1;
    return;
  }

  const mode = input.apply ? "apply" : "dry_run";
  const dbPath = resolveFridayDbPath({ env: process.env });
  if (!existsSync(dbPath)) {
    console.error(`Error: Friday database not found at ${dbPath}`);
    process.exitCode = 1;
    return;
  }

  const loadedConfig = loadFridayConfig({ env: process.env });
  const databaseConfig = loadedConfig.config.database;
  const tempDir = mode === "dry_run" ? copyStateDbToTemp(dbPath) : undefined;
  const targetDbPath = tempDir ? join(tempDir, "friday.db") : dbPath;
  const sqlite = createFridaySqliteLayer({
    dbPath: targetDbPath,
    readPoolSize: databaseConfig.readPoolSize,
    pragmas: {
      busyTimeoutMs: databaseConfig.busyTimeoutMs,
      synchronous: databaseConfig.synchronous,
    },
  });

  try {
    const report = backfillFridayAgentRunPackContext(sqlite.writer, { mode });
    if (input.json) {
      console.log(JSON.stringify({ dbPath, mode, report }, null, 2));
      return;
    }
    printPlainReport(report, mode, dbPath);
  } finally {
    sqlite.close();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
