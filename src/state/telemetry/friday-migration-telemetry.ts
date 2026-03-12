import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

export type FridayMigrationEventType =
  | "sqlite-migration"
  | "compatibility-mirror-write"
  | "consistency-check";

export type FridayMigrationStatus = "ok" | "skipped" | "mismatch" | "error";

export interface FridayMigrationTelemetryEvent {
  runId: string;
  at: string;
  type: FridayMigrationEventType;
  status: FridayMigrationStatus;
  entityType?: string;
  entityKey?: string;
  sourceCount?: number;
  targetCount?: number;
  sourceChecksum?: string;
  targetChecksum?: string;
  message?: string;
  details?: Record<string, unknown>;
}

export interface FridayMigrationTelemetrySummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  appliedMigrations: number[];
  mirrorWrites: { ok: number; mismatch: number; error: number };
  consistencyChecks: { ok: number; mismatch: number; error: number };
}

export interface CreateFridayMigrationTelemetryOptions {
  stateDir: string;
  fileName: string;
  summaryFileName: string;
  now?: () => Date;
}

export interface FridayMigrationTelemetryWriter {
  runId: string;
  startedAt: string;
  /** Appends one JSONL event record. */
  record(event: Omit<FridayMigrationTelemetryEvent, "runId" | "at">): void;
  /** Writes summary JSON for the run. */
  finalize(summary: Omit<FridayMigrationTelemetrySummary, "runId" | "startedAt">): void;
}

/** Creates telemetry writer backed by `${stateDir}/telemetry/*.jsonl` and summary JSON. */
export function createFridayMigrationTelemetryWriter(
  options: CreateFridayMigrationTelemetryOptions,
): FridayMigrationTelemetryWriter {
  const { stateDir, fileName, summaryFileName, now = () => new Date() } = options;

  const telemetryDir = path.join(stateDir, "telemetry");
  fs.mkdirSync(telemetryDir, { recursive: true });

  const jsonlPath = path.join(telemetryDir, fileName);
  const summaryPath = path.join(telemetryDir, summaryFileName);

  const runId = crypto.randomUUID();
  const startedAt = now().toISOString();

  return {
    runId,
    startedAt,

    record(event: Omit<FridayMigrationTelemetryEvent, "runId" | "at">): void {
      const fullEvent: FridayMigrationTelemetryEvent = {
        runId,
        at: now().toISOString(),
        ...event,
      };
      fs.appendFileSync(jsonlPath, JSON.stringify(fullEvent) + "\n");
    },

    finalize(summary: Omit<FridayMigrationTelemetrySummary, "runId" | "startedAt">): void {
      const fullSummary: FridayMigrationTelemetrySummary = {
        runId,
        startedAt,
        ...summary,
      };
      fs.writeFileSync(summaryPath, JSON.stringify(fullSummary, null, 2) + "\n");
    },
  };
}
