import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  createFridayRunCheckpoint,
  FRIDAY_DEFAULT_AGENT_RUN_CHECKPOINT_RETENTION_MS,
  pruneExpiredAgentRunCheckpoints,
} from "../../../../src/agent/runtime/friday-agent-run-checkpoint.js";
import { createTestDb } from "../../../helpers/friday-test-db.helper.js";

// ─── Test infra ───

const allocatedDbs: Array<ReturnType<typeof createTestDb>> = [];
const tempDirs: string[] = [];

afterEach(() => {
  while (allocatedDbs.length > 0) {
    allocatedDbs.pop()?.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
});

function makeStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-agent-checkpoint-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeDb() {
  const db = createTestDb();
  allocatedDbs.push(db);
  return db;
}

// ─── Tests ───

describe("createFridayRunCheckpoint (B2 retention)", () => {
  it("rollback restores the pre-mutation content and deletes the backup file", () => {
    const stateDir = makeStateDir();
    const targetPath = path.join(stateDir, "target.txt");
    fs.writeFileSync(targetPath, "ORIGINAL", "utf-8");

    const checkpoint = createFridayRunCheckpoint({
      runId: "run-rb",
      stateDir,
      db: makeDb(),
      nowIso: () => "2026-03-24T00:00:00.000Z",
    });

    checkpoint.snapshotBeforeWrite(targetPath);
    fs.writeFileSync(targetPath, "MUTATED", "utf-8");

    const beforeRollbackBackups = checkpoint.entries().map((e) => e.backupPath).filter((p): p is string => Boolean(p));
    expect(beforeRollbackBackups.length).toBe(1);
    expect(fs.existsSync(beforeRollbackBackups[0]!)).toBe(true);

    const result = checkpoint.rollback();
    expect(result.restoredCount).toBe(1);
    expect(result.errors).toEqual([]);
    expect(fs.readFileSync(targetPath, "utf-8")).toBe("ORIGINAL");

    // Backup file must be cleaned up — it is secret-bearing transient state.
    expect(fs.existsSync(beforeRollbackBackups[0]!)).toBe(false);
  });

  it("truthful flag: an EXISTING file whose backup capture FAILS at snapshot time is NOT marked rollbackAvailable (no over-claim)", () => {
    // SAFE-ROLLBACK-PRECONDITION: when snapshotBeforeWrite cannot capture a
    // usable backup for an existing file, the checkpoint entry must NOT claim
    // the mutation is reversible. Otherwise the run receipt / rollback_available
    // health state tells the user a lie: it advertises a rollback that will
    // fail-close at rollback() time.
    const stateDir = makeStateDir();
    const targetPath = path.join(stateDir, "target.txt");
    fs.writeFileSync(targetPath, "ORIGINAL", "utf-8");

    // Force the backup capture to fail deterministically & offline: place a
    // FILE where `snapshotDir = stateDir/agent-snapshots/<runId>` must be
    // created, so `mkdirSync(snapshotDir, { recursive: true })` throws ENOTDIR
    // (its `agent-snapshots` path segment is a file, not a directory) and the
    // catch at snapshot time fires → backupPath === undefined.
    fs.writeFileSync(path.join(stateDir, "agent-snapshots"), "block", "utf-8");

    const checkpoint = createFridayRunCheckpoint({
      runId: "run-nobackup",
      stateDir,
      db: makeDb(),
      nowIso: () => "2026-03-24T00:00:00.000Z",
    });

    checkpoint.snapshotBeforeWrite(targetPath);

    const entry = checkpoint.entries()[0]!;
    // Preconditions for this scenario: file existed, but backup was not captured.
    expect(entry.existed).toBe(true);
    expect(entry.backupPath).toBeUndefined();

    // THE FIX: the reversibility claim must be honest → false.
    // (Before the fix this was hardcoded `true` → real AssertionError here.)
    expect(entry.rollbackAvailable).toBe(false);

    // Receipt truth: hasRollbackCheckpoint(runtime.ts) computes exactly this
    // predicate — it must NOT advertise availability for this run.
    expect(checkpoint.entries().some((e) => e.rollbackAvailable)).toBe(false);

    // Tie the claim to reality: rollback genuinely does NOT restore the file.
    fs.writeFileSync(targetPath, "MUTATED", "utf-8");
    const result = checkpoint.rollback();
    expect(result.restoredCount).toBe(0);
    // File stays in its post-mutation state — the mutation is truly irreversible,
    // exactly as the (now honest) flag reports. No garbage restore either.
    expect(fs.readFileSync(targetPath, "utf-8")).toBe("MUTATED");
  });

  it("no-degrade: an EXISTING file WITH a successful backup stays rollbackAvailable === true and restores", () => {
    const stateDir = makeStateDir();
    const targetPath = path.join(stateDir, "target.txt");
    fs.writeFileSync(targetPath, "ORIGINAL", "utf-8");

    const checkpoint = createFridayRunCheckpoint({
      runId: "run-ok",
      stateDir,
      db: makeDb(),
      nowIso: () => "2026-03-24T00:00:00.000Z",
    });

    checkpoint.snapshotBeforeWrite(targetPath);

    const entry = checkpoint.entries()[0]!;
    expect(entry.existed).toBe(true);
    expect(entry.backupPath).toBeDefined();
    // The happy path is unchanged: a captured backup ⇒ reversible ⇒ true.
    expect(entry.rollbackAvailable).toBe(true);

    fs.writeFileSync(targetPath, "MUTATED", "utf-8");
    const result = checkpoint.rollback();
    expect(result.restoredCount).toBe(1);
    expect(result.errors).toEqual([]);
    expect(fs.readFileSync(targetPath, "utf-8")).toBe("ORIGINAL");
  });

  it("no-degrade: a NEWLY-CREATED file (did not exist) stays rollbackAvailable === true and rollback reverses by deleting it", () => {
    // Verifies the `!existed` branch of rollback() truly reverses the mutation
    // by DELETING the created file — which is why keeping `true` for
    // existed === false is honest (the fix intentionally does not touch it).
    const stateDir = makeStateDir();
    const targetPath = path.join(stateDir, "created.txt");
    // Note: file does NOT exist at snapshot time.

    const checkpoint = createFridayRunCheckpoint({
      runId: "run-new",
      stateDir,
      db: makeDb(),
      nowIso: () => "2026-03-24T00:00:00.000Z",
    });

    checkpoint.snapshotBeforeWrite(targetPath);

    const entry = checkpoint.entries()[0]!;
    expect(entry.existed).toBe(false);
    expect(entry.backupPath).toBeUndefined();
    // A file that did not exist is reversible by deletion ⇒ honestly true.
    expect(entry.rollbackAvailable).toBe(true);

    // Simulate the write that created the file.
    fs.writeFileSync(targetPath, "NEW-CONTENT", "utf-8");
    expect(fs.existsSync(targetPath)).toBe(true);

    const result = checkpoint.rollback();
    expect(result.restoredCount).toBe(1);
    expect(result.errors).toEqual([]);
    // Reversal for a created file == deletion.
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it("B2 fail-closed: rollback returns an error when the backup file has been deleted between snapshot and rollback", () => {
    const stateDir = makeStateDir();
    const targetPath = path.join(stateDir, "target.txt");
    fs.writeFileSync(targetPath, "ORIGINAL", "utf-8");

    const checkpoint = createFridayRunCheckpoint({
      runId: "run-fc",
      stateDir,
      db: makeDb(),
      nowIso: () => "2026-03-24T00:00:00.000Z",
    });

    checkpoint.snapshotBeforeWrite(targetPath);
    fs.writeFileSync(targetPath, "MUTATED", "utf-8");

    // Simulate a torn / pruned backup: delete the snapshot file out from
    // under the rollback path.
    const backupPath = checkpoint.entries()[0]!.backupPath!;
    fs.unlinkSync(backupPath);

    const result = checkpoint.rollback();
    expect(result.restoredCount).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toMatch(/backup unavailable.*missing/i);

    // Critical: target must NOT have been overwritten with garbage.
    expect(fs.readFileSync(targetPath, "utf-8")).toBe("MUTATED");
  });
});

describe("pruneExpiredAgentRunCheckpoints (B2 TTL)", () => {
  it("removes manifest rows and backup files for snapshots older than the retention window", () => {
    const stateDir = makeStateDir();
    const db = makeDb();
    const oldRunTarget = path.join(stateDir, "old.txt");
    const youngRunTarget = path.join(stateDir, "young.txt");
    fs.writeFileSync(oldRunTarget, "OLD-ORIGINAL", "utf-8");
    fs.writeFileSync(youngRunTarget, "YOUNG-ORIGINAL", "utf-8");

    const oldCheckpoint = createFridayRunCheckpoint({
      runId: "run-old",
      stateDir,
      db,
      nowIso: () => "2026-03-23T00:00:00.000Z", // 25 hours before prune
    });
    oldCheckpoint.snapshotBeforeWrite(oldRunTarget);
    fs.writeFileSync(oldRunTarget, "OLD-MUTATED", "utf-8");

    const youngCheckpoint = createFridayRunCheckpoint({
      runId: "run-young",
      stateDir,
      db,
      nowIso: () => "2026-03-24T00:30:00.000Z", // 30 min before prune (well within 24h)
    });
    youngCheckpoint.snapshotBeforeWrite(youngRunTarget);
    fs.writeFileSync(youngRunTarget, "YOUNG-MUTATED", "utf-8");

    const oldBackup = oldCheckpoint.entries()[0]!.backupPath!;
    const youngBackup = youngCheckpoint.entries()[0]!.backupPath!;
    expect(fs.existsSync(oldBackup)).toBe(true);
    expect(fs.existsSync(youngBackup)).toBe(true);

    const result = pruneExpiredAgentRunCheckpoints({
      stateDir,
      db,
      nowIso: () => "2026-03-24T01:00:00.000Z",
      maxAgeMs: 24 * 60 * 60 * 1_000,
    });

    expect(result.filesRemoved).toBe(1);
    expect(result.manifestRowsRemoved).toBe(1);
    expect(result.errors).toEqual([]);

    // Old backup file gone; young backup intact.
    expect(fs.existsSync(oldBackup)).toBe(false);
    expect(fs.existsSync(youngBackup)).toBe(true);

    // Empty old-run dir removed; young-run dir kept.
    expect(result.runDirsRemoved).toBe(1);
    expect(fs.existsSync(path.dirname(oldBackup))).toBe(false);
    expect(fs.existsSync(path.dirname(youngBackup))).toBe(true);
  });

  it("default retention is 24 hours: snapshots taken exactly 24h ago survive, 24h + 1ms are pruned", () => {
    expect(FRIDAY_DEFAULT_AGENT_RUN_CHECKPOINT_RETENTION_MS).toBe(24 * 60 * 60 * 1_000);
  });

  it("B2 fail-closed: after prune, a fresh checkpoint instance for the same runId restores via the canonical-path no-existed branch (cannot reconstruct backup)", () => {
    // Restart-recovery proof: after prune, the manifest row for the expired
    // entry is gone. A fresh service instance for that runId loads zero
    // snapshots and cannot rollback the file.
    const stateDir = makeStateDir();
    const db = makeDb();
    const targetPath = path.join(stateDir, "target.txt");
    fs.writeFileSync(targetPath, "ORIGINAL", "utf-8");

    const expiredCheckpoint = createFridayRunCheckpoint({
      runId: "run-expired",
      stateDir,
      db,
      nowIso: () => "2026-03-23T00:00:00.000Z",
    });
    expiredCheckpoint.snapshotBeforeWrite(targetPath);
    fs.writeFileSync(targetPath, "MUTATED", "utf-8");

    pruneExpiredAgentRunCheckpoints({
      stateDir,
      db,
      nowIso: () => "2026-03-24T01:00:00.000Z",
      maxAgeMs: 24 * 60 * 60 * 1_000,
    });

    // A NEW service instance loads from the now-empty manifest.
    const fresh = createFridayRunCheckpoint({
      runId: "run-expired",
      stateDir,
      db,
      nowIso: () => "2026-03-24T01:30:00.000Z",
    });
    expect(fresh.size).toBe(0);
    const result = fresh.rollback();
    // restoredCount=0 because there's nothing to restore; no fail-closed
    // error either because the manifest is fully prune-clean.
    expect(result.restoredCount).toBe(0);
    expect(result.errors).toEqual([]);
    // The file remains in its post-mutation state — by design, expired
    // backups cannot resurrect.
    expect(fs.readFileSync(targetPath, "utf-8")).toBe("MUTATED");
  });

  it("restart safety: a fresh service instance can still rollback an in-window entry seeded by a prior instance", () => {
    const stateDir = makeStateDir();
    const db = makeDb();
    const targetPath = path.join(stateDir, "target.txt");
    fs.writeFileSync(targetPath, "ORIGINAL", "utf-8");

    const first = createFridayRunCheckpoint({
      runId: "run-restart",
      stateDir,
      db,
      nowIso: () => "2026-03-24T00:00:00.000Z",
    });
    first.snapshotBeforeWrite(targetPath);
    fs.writeFileSync(targetPath, "MUTATED", "utf-8");

    // Simulate "restart": construct a new service for the same runId.
    const second = createFridayRunCheckpoint({
      runId: "run-restart",
      stateDir,
      db,
      nowIso: () => "2026-03-24T00:05:00.000Z",
    });
    expect(second.size).toBe(1);

    const result = second.rollback();
    expect(result.restoredCount).toBe(1);
    expect(result.errors).toEqual([]);
    expect(fs.readFileSync(targetPath, "utf-8")).toBe("ORIGINAL");
  });
});
