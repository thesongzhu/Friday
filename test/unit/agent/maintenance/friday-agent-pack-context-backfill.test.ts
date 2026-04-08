import { afterEach, describe, expect, it } from "vitest";

import { createFridayAgentRunRepository } from "#agent";
import type { FridaySqliteLayer } from "#state";

import { backfillFridayAgentRunPackContext } from "../../../../src/agent/maintenance/friday-agent-pack-context-backfill.js";
import { createTestDb } from "../../../helpers/friday-test-db.helper.js";

function insertSession(
  db: FridaySqliteLayer,
  input: {
    id: string;
    sessionKey: string;
    metadata?: Record<string, unknown>;
    createdAt?: string;
    updatedAt?: string;
  },
): void {
  const createdAt = input.createdAt ?? "2026-04-07T12:00:00.000Z";
  const updatedAt = input.updatedAt ?? createdAt;
  db.writer.prepare(
    `INSERT INTO sessions (
      id, session_key, agent_id, channel, chat_kind, status, metadata_json, created_at, updated_at
    ) VALUES (?, ?, 'friday-agent', 'chat', 'direct', 'active', ?, ?, ?)`,
  ).run(
    input.id,
    input.sessionKey,
    JSON.stringify(input.metadata ?? {}),
    createdAt,
    updatedAt,
  );
}

function insertRun(
  db: FridaySqliteLayer,
  input: {
    id: string;
    sessionKey: string;
    createdAt: string;
    metadata?: Record<string, unknown>;
  },
): void {
  const repo = createFridayAgentRunRepository();
  repo.create(db.writer, {
    id: input.id,
    task: `Task for ${input.id}`,
    sessionKey: input.sessionKey,
    maxAttempts: 3,
    nowIso: input.createdAt,
    metadata: input.metadata,
  });
}

function readRunMetadata(db: FridaySqliteLayer, runId: string): string | null {
  const row = db.writer
    .prepare("SELECT metadata_json FROM friday_agent_runs WHERE id = ?")
    .get(runId) as { metadata_json: string | null } | undefined;
  return row?.metadata_json ?? null;
}

function readSessionMetadata(db: FridaySqliteLayer, sessionKey: string): string | null {
  const row = db.writer
    .prepare("SELECT metadata_json FROM sessions WHERE session_key = ?")
    .get(sessionKey) as { metadata_json: string | null } | undefined;
  return row?.metadata_json ?? null;
}

describe("FridayAgentPackContextBackfill", () => {
  let db: FridaySqliteLayer;

  afterEach(() => {
    db?.close();
  });

  it("identifies a single strict candidate in dry-run, applies it, and remains idempotent", () => {
    db = createTestDb();

    insertSession(db, {
      id: "sess-guided-1",
      sessionKey: "guided:content-social",
      metadata: {
        packContext: {
          packId: "industry-creator-media",
          surface: "guided-flow",
          updatedAt: "2026-04-07T12:00:00.000Z",
        },
      },
    });
    insertRun(db, {
      id: "run-guided-target",
      sessionKey: "guided:content-social",
      createdAt: "2026-04-07T12:00:10.000Z",
    });

    const sessionBefore = readSessionMetadata(db, "guided:content-social");
    const dryRunReport = backfillFridayAgentRunPackContext(db.writer, { mode: "dry_run" });

    expect(dryRunReport.scannedRuns).toBe(1);
    expect(dryRunReport.eligibleRuns).toBe(1);
    expect(dryRunReport.updatedRuns).toBe(0);
    expect(dryRunReport.skippedRuns).toBe(0);
    expect(dryRunReport.candidates).toContainEqual(expect.objectContaining({
      runId: "run-guided-target",
      inferredPackId: "industry-creator-media",
      surface: "guided-flow",
      result: "updated",
      reasonCode: "updated",
      applied: false,
    }));
    expect(readRunMetadata(db, "run-guided-target")).toBe("{}");

    const applyReport = backfillFridayAgentRunPackContext(db.writer, { mode: "apply" });
    expect(applyReport.eligibleRuns).toBe(1);
    expect(applyReport.updatedRuns).toBe(1);
    expect(applyReport.candidates).toContainEqual(expect.objectContaining({
      runId: "run-guided-target",
      result: "updated",
      reasonCode: "updated",
      applied: true,
    }));
    expect(JSON.parse(readRunMetadata(db, "run-guided-target") ?? "{}")).toMatchObject({
      packContext: {
        packId: "industry-creator-media",
        surface: "guided-flow",
        updatedAt: "2026-04-07T12:00:00.000Z",
      },
    });
    expect(readSessionMetadata(db, "guided:content-social")).toBe(sessionBefore);
    expect(
      db.writer.prepare("SELECT COUNT(*) AS count FROM session_messages").get() as { count: number },
    ).toEqual({ count: 0 });

    const secondApply = backfillFridayAgentRunPackContext(db.writer, { mode: "apply" });
    expect(secondApply.eligibleRuns).toBe(0);
    expect(secondApply.updatedRuns).toBe(0);
    expect(secondApply.alreadyTaggedRuns).toBe(1);
    expect(secondApply.candidates).toContainEqual(expect.objectContaining({
      runId: "run-guided-target",
      result: "already_tagged",
      reasonCode: "already_tagged",
      inferredPackId: "industry-creator-media",
    }));
  });

  it("skips runs when the session pack context is missing updatedAt", () => {
    db = createTestDb();

    insertSession(db, {
      id: "sess-missing-updated-at",
      sessionKey: "guided:content-social",
      metadata: {
        packContext: {
          packId: "industry-creator-media",
          surface: "guided-flow",
        },
      },
    });
    insertRun(db, {
      id: "run-missing-updated-at",
      sessionKey: "guided:content-social",
      createdAt: "2026-04-07T12:00:10.000Z",
    });

    const report = backfillFridayAgentRunPackContext(db.writer, { mode: "dry_run" });
    expect(report.skippedRuns).toBe(1);
    expect(report.skippedByReason.missing_pack_updated_at).toBe(1);
    expect(report.candidates).toContainEqual(expect.objectContaining({
      runId: "run-missing-updated-at",
      result: "skipped",
      reasonCode: "missing_pack_updated_at",
    }));
  });

  it("skips guided-flow sessions when the explicit pack does not match the guided wizard", () => {
    db = createTestDb();

    insertSession(db, {
      id: "sess-guided-mismatch",
      sessionKey: "guided:ecommerce",
      metadata: {
        packContext: {
          packId: "industry-creator-media",
          surface: "guided-flow",
          updatedAt: "2026-04-07T12:00:00.000Z",
        },
      },
    });
    insertRun(db, {
      id: "run-guided-mismatch",
      sessionKey: "guided:ecommerce",
      createdAt: "2026-04-07T12:00:05.000Z",
    });

    const report = backfillFridayAgentRunPackContext(db.writer, { mode: "dry_run" });
    expect(report.skippedByReason.wizard_pack_mismatch).toBe(1);
    expect(report.candidates).toContainEqual(expect.objectContaining({
      runId: "run-guided-mismatch",
      reasonCode: "wizard_pack_mismatch",
      inferredPackId: "industry-creator-media",
    }));
  });

  it("skips all missing runs in an ambiguous 30-second window", () => {
    db = createTestDb();

    insertSession(db, {
      id: "sess-ambiguous",
      sessionKey: "chat:default:chat-ambiguous",
      metadata: {
        packContext: {
          packId: "industry-creator-media",
          surface: "chat",
          updatedAt: "2026-04-07T12:00:00.000Z",
        },
      },
    });
    insertRun(db, {
      id: "run-ambiguous-1",
      sessionKey: "chat:default:chat-ambiguous",
      createdAt: "2026-04-07T12:00:05.000Z",
    });
    insertRun(db, {
      id: "run-ambiguous-2",
      sessionKey: "chat:default:chat-ambiguous",
      createdAt: "2026-04-07T12:00:10.000Z",
    });

    const report = backfillFridayAgentRunPackContext(db.writer, { mode: "dry_run" });
    expect(report.eligibleRuns).toBe(0);
    expect(report.skippedRuns).toBe(2);
    expect(report.skippedByReason.ambiguous_window).toBe(2);
    expect(report.candidates.filter((candidate) => candidate.reasonCode === "ambiguous_window")).toHaveLength(2);
  });

  it("skips a session when a different explicit packId already exists on another run", () => {
    db = createTestDb();

    insertSession(db, {
      id: "sess-conflict",
      sessionKey: "chat:default:chat-conflict",
      metadata: {
        packContext: {
          packId: "industry-creator-media",
          surface: "chat",
          updatedAt: "2026-04-07T12:00:00.000Z",
        },
      },
    });
    insertRun(db, {
      id: "run-conflict-tagged",
      sessionKey: "chat:default:chat-conflict",
      createdAt: "2026-04-07T12:00:05.000Z",
      metadata: {
        packContext: {
          packId: "industry-sales",
          surface: "chat",
          updatedAt: "2026-04-07T12:00:05.000Z",
        },
      },
    });
    insertRun(db, {
      id: "run-conflict-missing",
      sessionKey: "chat:default:chat-conflict",
      createdAt: "2026-04-07T12:00:10.000Z",
    });

    const report = backfillFridayAgentRunPackContext(db.writer, { mode: "dry_run" });
    expect(report.alreadyTaggedRuns).toBe(1);
    expect(report.skippedRuns).toBe(1);
    expect(report.skippedByReason.session_pack_conflict).toBe(1);
    expect(report.candidates).toContainEqual(expect.objectContaining({
      runId: "run-conflict-missing",
      reasonCode: "session_pack_conflict",
    }));
  });

  it("skips orphaned runs whose session record is missing", () => {
    db = createTestDb();

    insertRun(db, {
      id: "run-orphaned",
      sessionKey: "chat:default:chat-orphaned",
      createdAt: "2026-04-07T12:00:10.000Z",
    });

    const report = backfillFridayAgentRunPackContext(db.writer, { mode: "dry_run" });
    expect(report.skippedRuns).toBe(1);
    expect(report.skippedByReason.missing_session).toBe(1);
    expect(report.candidates).toContainEqual(expect.objectContaining({
      runId: "run-orphaned",
      reasonCode: "missing_session",
    }));
  });
});
