import type Database from "better-sqlite3";

import { parseFridaySessionKey } from "#sessions";
import { safeJsonParse } from "#utilities";

import { getBuiltInPackCatalogEntry } from "../../packs/friday-built-in-pack-catalog.js";
import type { FridayAgentRunMetadata } from "../model/friday-agent.types.js";
import { createFridayAgentRunRepository } from "../persistence/friday-agent-run-repository.js";

const BACKFILL_WINDOW_MS = 30_000;
const GUIDED_SESSION_PREFIX = "guided:";
const CHAT_SESSION_CHANNEL = "chat";
const CHAT_SESSION_ACCOUNT = "default";

export type BackfillPackContextReasonCode =
  | "missing_session"
  | "missing_session_pack_context"
  | "invalid_pack_id"
  | "missing_pack_updated_at"
  | "session_pack_conflict"
  | "wizard_pack_mismatch"
  | "non_canonical_chat_session"
  | "no_run_after_updated_at"
  | "candidate_outside_window"
  | "ambiguous_window"
  | "already_tagged"
  | "updated";

export interface BackfillPackContextEvidence {
  sessionPackId?: string;
  sessionSurface?: string;
  sessionPackUpdatedAt?: string;
  matchedWizardId?: string;
  earliestRunAfterUpdatedAtId?: string;
  earliestRunAfterUpdatedAtAt?: string;
  windowRunIds?: string[];
  conflictingPackIds?: string[];
}

export interface BackfillPackContextCandidate {
  runId: string;
  sessionKey: string;
  createdAt: string;
  inferredPackId?: string;
  surface?: string;
  mode: "dry_run" | "apply";
  result: "updated" | "skipped" | "already_tagged";
  applied: boolean;
  reasonCode: BackfillPackContextReasonCode;
  evidence: BackfillPackContextEvidence;
}

export interface BackfillPackContextReport {
  scannedRuns: number;
  alreadyTaggedRuns: number;
  eligibleRuns: number;
  updatedRuns: number;
  skippedRuns: number;
  skippedByReason: Partial<Record<BackfillPackContextReasonCode, number>>;
  candidates: BackfillPackContextCandidate[];
}

interface BackfillRunRow {
  id: string;
  session_key: string;
  created_at: string;
  metadata_json: string | null;
}

interface BackfillSessionRow {
  session_key: string;
  metadata_json: string | null;
}

interface ParsedRunRecord {
  id: string;
  sessionKey: string;
  createdAt: string;
  createdAtMs: number | null;
  metadata: FridayAgentRunMetadata | undefined;
  packContext: ParsedPackContext | undefined;
}

interface ParsedSessionRecord {
  sessionKey: string;
  packContext: ParsedPackContext | undefined;
}

interface ParsedPackContext {
  packId: string;
  surface?: string;
  updatedAt?: string;
}

function parseIsoTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readPackContext(value: unknown): ParsedPackContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const container = value as Record<string, unknown>;
  const rawPackContextValue = container.packContext;
  if (!rawPackContextValue || typeof rawPackContextValue !== "object" || Array.isArray(rawPackContextValue)) {
    return undefined;
  }
  const rawPackContext = rawPackContextValue as Record<string, unknown>;

  const packId = typeof rawPackContext.packId === "string" && rawPackContext.packId.trim().length > 0
    ? rawPackContext.packId.trim()
    : undefined;
  if (!packId) {
    return undefined;
  }

  return {
    packId,
    ...(typeof rawPackContext.surface === "string" && rawPackContext.surface.trim().length > 0
      ? { surface: rawPackContext.surface.trim() }
      : {}),
    ...(typeof rawPackContext.updatedAt === "string" && rawPackContext.updatedAt.trim().length > 0
      ? { updatedAt: rawPackContext.updatedAt.trim() }
      : {}),
  };
}

function parseRunMetadata(raw: string | null): FridayAgentRunMetadata | undefined {
  const parsed = safeJsonParse<FridayAgentRunMetadata>(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed;
}

function parseSessionPackContext(raw: string | null): ParsedPackContext | undefined {
  const parsed = safeJsonParse<Record<string, unknown>>(raw);
  return readPackContext(parsed);
}

function parseGuidedSessionWizardId(sessionKey: string): string | undefined {
  if (!sessionKey.startsWith(GUIDED_SESSION_PREFIX)) {
    return undefined;
  }

  const wizardId = sessionKey.slice(GUIDED_SESSION_PREFIX.length).trim();
  if (wizardId.length === 0 || wizardId.includes(":")) {
    return undefined;
  }

  return wizardId;
}

function isCanonicalChatSessionKey(sessionKey: string): boolean {
  try {
    const parsed = parseFridaySessionKey(sessionKey);
    return parsed.kind === "conversation"
      && parsed.channel === CHAT_SESSION_CHANNEL
      && parsed.accountId === CHAT_SESSION_ACCOUNT;
  } catch {
    return false;
  }
}

function addSkippedReason(
  report: BackfillPackContextReport,
  reasonCode: BackfillPackContextReasonCode,
): void {
  report.skippedByReason[reasonCode] = (report.skippedByReason[reasonCode] ?? 0) + 1;
}

function buildSkippedCandidate(
  run: ParsedRunRecord,
  mode: "dry_run" | "apply",
  reasonCode: Exclude<BackfillPackContextReasonCode, "updated" | "already_tagged">,
  evidence: BackfillPackContextEvidence,
  inferredPackId?: string,
  surface?: string,
): BackfillPackContextCandidate {
  return {
    runId: run.id,
    sessionKey: run.sessionKey,
    createdAt: run.createdAt,
    ...(inferredPackId ? { inferredPackId } : {}),
    ...(surface ? { surface } : {}),
    mode,
    result: "skipped",
    applied: false,
    reasonCode,
    evidence,
  };
}

function buildAlreadyTaggedCandidate(
  run: ParsedRunRecord,
  mode: "dry_run" | "apply",
): BackfillPackContextCandidate {
  return {
    runId: run.id,
    sessionKey: run.sessionKey,
    createdAt: run.createdAt,
    inferredPackId: run.packContext?.packId,
    surface: run.packContext?.surface,
    mode,
    result: "already_tagged",
    applied: false,
    reasonCode: "already_tagged",
    evidence: {
      sessionPackId: run.packContext?.packId,
      sessionSurface: run.packContext?.surface,
      sessionPackUpdatedAt: run.packContext?.updatedAt,
    },
  };
}

export function backfillFridayAgentRunPackContext(
  db: Database.Database,
  options?: {
    mode?: "dry_run" | "apply";
  },
): BackfillPackContextReport {
  const mode = options?.mode ?? "dry_run";
  const runRepository = createFridayAgentRunRepository();

  const runRows = db.prepare(
    `SELECT id, session_key, created_at, metadata_json
     FROM friday_agent_runs
     ORDER BY created_at ASC, id ASC`,
  ).all() as BackfillRunRow[];

  const sessionRows = db.prepare(
    `SELECT session_key, metadata_json
     FROM sessions`,
  ).all() as BackfillSessionRow[];

  const sessionsByKey = new Map<string, ParsedSessionRecord>(
    sessionRows.map((row) => [
      row.session_key,
      {
        sessionKey: row.session_key,
        packContext: parseSessionPackContext(row.metadata_json),
      },
    ]),
  );

  const runsBySession = new Map<string, ParsedRunRecord[]>();
  const parsedRuns = runRows.map<ParsedRunRecord>((row) => {
    const metadata = parseRunMetadata(row.metadata_json);
    const record: ParsedRunRecord = {
      id: row.id,
      sessionKey: row.session_key,
      createdAt: row.created_at,
      createdAtMs: parseIsoTimestamp(row.created_at),
      metadata,
      packContext: readPackContext(metadata),
    };
    const existing = runsBySession.get(record.sessionKey) ?? [];
    existing.push(record);
    runsBySession.set(record.sessionKey, existing);
    return record;
  });

  const report: BackfillPackContextReport = {
    scannedRuns: parsedRuns.length,
    alreadyTaggedRuns: 0,
    eligibleRuns: 0,
    updatedRuns: 0,
    skippedRuns: 0,
    skippedByReason: {},
    candidates: [],
  };

  const updates: Array<{ runId: string; metadata: FridayAgentRunMetadata }> = [];

  for (const [sessionKey, sessionRuns] of runsBySession) {
    const taggedRuns = sessionRuns.filter((run) => run.packContext?.packId);
    const missingRuns = sessionRuns.filter((run) => !run.packContext?.packId);

    for (const taggedRun of taggedRuns) {
      report.alreadyTaggedRuns += 1;
      report.candidates.push(buildAlreadyTaggedCandidate(taggedRun, mode));
    }

    if (missingRuns.length === 0) {
      continue;
    }

    const session = sessionsByKey.get(sessionKey);
    if (!session) {
      for (const run of missingRuns) {
        report.skippedRuns += 1;
        addSkippedReason(report, "missing_session");
        report.candidates.push(buildSkippedCandidate(run, mode, "missing_session", {}));
      }
      continue;
    }

    const sessionPackContext = session.packContext;
    if (!sessionPackContext) {
      for (const run of missingRuns) {
        report.skippedRuns += 1;
        addSkippedReason(report, "missing_session_pack_context");
        report.candidates.push(buildSkippedCandidate(run, mode, "missing_session_pack_context", {}));
      }
      continue;
    }

    const catalogEntry = getBuiltInPackCatalogEntry(sessionPackContext.packId);
    if (!catalogEntry) {
      for (const run of missingRuns) {
        report.skippedRuns += 1;
        addSkippedReason(report, "invalid_pack_id");
        report.candidates.push(buildSkippedCandidate(run, mode, "invalid_pack_id", {
          sessionPackId: sessionPackContext.packId,
          sessionSurface: sessionPackContext.surface,
          sessionPackUpdatedAt: sessionPackContext.updatedAt,
        }, sessionPackContext.packId, sessionPackContext.surface));
      }
      continue;
    }

    const updatedAtMs = parseIsoTimestamp(sessionPackContext.updatedAt);
    if (updatedAtMs === null) {
      for (const run of missingRuns) {
        report.skippedRuns += 1;
        addSkippedReason(report, "missing_pack_updated_at");
        report.candidates.push(buildSkippedCandidate(run, mode, "missing_pack_updated_at", {
          sessionPackId: sessionPackContext.packId,
          sessionSurface: sessionPackContext.surface,
          sessionPackUpdatedAt: sessionPackContext.updatedAt,
        }, sessionPackContext.packId, sessionPackContext.surface));
      }
      continue;
    }

    const conflictingPackIds = Array.from(new Set(
      taggedRuns
        .map((run) => run.packContext?.packId)
        .filter((packId): packId is string => typeof packId === "string" && packId !== sessionPackContext.packId),
    ));
    if (conflictingPackIds.length > 0) {
      for (const run of missingRuns) {
        report.skippedRuns += 1;
        addSkippedReason(report, "session_pack_conflict");
        report.candidates.push(buildSkippedCandidate(run, mode, "session_pack_conflict", {
          sessionPackId: sessionPackContext.packId,
          sessionSurface: sessionPackContext.surface,
          sessionPackUpdatedAt: sessionPackContext.updatedAt,
          conflictingPackIds,
        }, sessionPackContext.packId, sessionPackContext.surface));
      }
      continue;
    }

    if (sessionPackContext.surface === "guided-flow") {
      const wizardId = parseGuidedSessionWizardId(sessionKey);
      if (!wizardId || wizardId !== catalogEntry.defaultWizardId) {
        for (const run of missingRuns) {
          report.skippedRuns += 1;
          addSkippedReason(report, "wizard_pack_mismatch");
          report.candidates.push(buildSkippedCandidate(run, mode, "wizard_pack_mismatch", {
            sessionPackId: sessionPackContext.packId,
            sessionSurface: sessionPackContext.surface,
            sessionPackUpdatedAt: sessionPackContext.updatedAt,
            ...(wizardId ? { matchedWizardId: wizardId } : {}),
          }, sessionPackContext.packId, sessionPackContext.surface));
        }
        continue;
      }
    }

    if (sessionPackContext.surface === "chat" && !isCanonicalChatSessionKey(sessionKey)) {
      for (const run of missingRuns) {
        report.skippedRuns += 1;
        addSkippedReason(report, "non_canonical_chat_session");
        report.candidates.push(buildSkippedCandidate(run, mode, "non_canonical_chat_session", {
          sessionPackId: sessionPackContext.packId,
          sessionSurface: sessionPackContext.surface,
          sessionPackUpdatedAt: sessionPackContext.updatedAt,
        }, sessionPackContext.packId, sessionPackContext.surface));
      }
      continue;
    }

    const runsAfterUpdatedAt = [...sessionRuns]
      .filter((run) => run.createdAtMs !== null && run.createdAtMs >= updatedAtMs)
      .sort((left, right) => {
        if (left.createdAtMs === right.createdAtMs) {
          return left.id.localeCompare(right.id);
        }
        return (left.createdAtMs ?? 0) - (right.createdAtMs ?? 0);
      });

    if (runsAfterUpdatedAt.length === 0) {
      for (const run of missingRuns) {
        report.skippedRuns += 1;
        addSkippedReason(report, "no_run_after_updated_at");
        report.candidates.push(buildSkippedCandidate(run, mode, "no_run_after_updated_at", {
          sessionPackId: sessionPackContext.packId,
          sessionSurface: sessionPackContext.surface,
          sessionPackUpdatedAt: sessionPackContext.updatedAt,
        }, sessionPackContext.packId, sessionPackContext.surface));
      }
      continue;
    }

    const earliestRunAfterUpdatedAt = runsAfterUpdatedAt[0]!;
    const windowEndMs = updatedAtMs + BACKFILL_WINDOW_MS;
    const windowRunIds = runsAfterUpdatedAt
      .filter((run) => run.createdAtMs !== null && run.createdAtMs <= windowEndMs)
      .map((run) => run.id);

    if (earliestRunAfterUpdatedAt.packContext?.packId) {
      for (const run of missingRuns) {
        report.skippedRuns += 1;
        addSkippedReason(report, "candidate_outside_window");
        report.candidates.push(buildSkippedCandidate(run, mode, "candidate_outside_window", {
          sessionPackId: sessionPackContext.packId,
          sessionSurface: sessionPackContext.surface,
          sessionPackUpdatedAt: sessionPackContext.updatedAt,
          earliestRunAfterUpdatedAtId: earliestRunAfterUpdatedAt.id,
          earliestRunAfterUpdatedAtAt: earliestRunAfterUpdatedAt.createdAt,
          windowRunIds,
        }, sessionPackContext.packId, sessionPackContext.surface));
      }
      continue;
    }

    if (earliestRunAfterUpdatedAt.createdAtMs === null || earliestRunAfterUpdatedAt.createdAtMs > windowEndMs) {
      for (const run of missingRuns) {
        report.skippedRuns += 1;
        addSkippedReason(report, "candidate_outside_window");
        report.candidates.push(buildSkippedCandidate(run, mode, "candidate_outside_window", {
          sessionPackId: sessionPackContext.packId,
          sessionSurface: sessionPackContext.surface,
          sessionPackUpdatedAt: sessionPackContext.updatedAt,
          earliestRunAfterUpdatedAtId: earliestRunAfterUpdatedAt.id,
          earliestRunAfterUpdatedAtAt: earliestRunAfterUpdatedAt.createdAt,
          windowRunIds,
        }, sessionPackContext.packId, sessionPackContext.surface));
      }
      continue;
    }

    const missingRunsWithinWindow = runsAfterUpdatedAt.filter((run) =>
      !run.packContext?.packId
      && run.createdAtMs !== null
      && run.createdAtMs <= windowEndMs
    );

    if (missingRunsWithinWindow.length > 1) {
      const ambiguousIds = new Set(missingRunsWithinWindow.map((run) => run.id));
      for (const run of missingRuns) {
        const reasonCode = ambiguousIds.has(run.id) ? "ambiguous_window" : "candidate_outside_window";
        report.skippedRuns += 1;
        addSkippedReason(report, reasonCode);
        report.candidates.push(buildSkippedCandidate(run, mode, reasonCode, {
          sessionPackId: sessionPackContext.packId,
          sessionSurface: sessionPackContext.surface,
          sessionPackUpdatedAt: sessionPackContext.updatedAt,
          earliestRunAfterUpdatedAtId: earliestRunAfterUpdatedAt.id,
          earliestRunAfterUpdatedAtAt: earliestRunAfterUpdatedAt.createdAt,
          windowRunIds,
        }, sessionPackContext.packId, sessionPackContext.surface));
      }
      continue;
    }

    const targetRun = earliestRunAfterUpdatedAt;
    report.eligibleRuns += 1;

    for (const run of missingRuns) {
      if (run.id !== targetRun.id) {
        report.skippedRuns += 1;
        addSkippedReason(report, "candidate_outside_window");
        report.candidates.push(buildSkippedCandidate(run, mode, "candidate_outside_window", {
          sessionPackId: sessionPackContext.packId,
          sessionSurface: sessionPackContext.surface,
          sessionPackUpdatedAt: sessionPackContext.updatedAt,
          earliestRunAfterUpdatedAtId: earliestRunAfterUpdatedAt.id,
          earliestRunAfterUpdatedAtAt: earliestRunAfterUpdatedAt.createdAt,
          windowRunIds,
        }, sessionPackContext.packId, sessionPackContext.surface));
        continue;
      }

      const nextMetadata: FridayAgentRunMetadata = {
        ...(run.metadata ?? {}),
        packContext: {
          packId: sessionPackContext.packId,
          updatedAt: sessionPackContext.updatedAt!,
          ...(sessionPackContext.surface ? { surface: sessionPackContext.surface } : {}),
        },
      };

      if (mode === "apply") {
        updates.push({ runId: run.id, metadata: nextMetadata });
      }

      report.candidates.push({
        runId: run.id,
        sessionKey: run.sessionKey,
        createdAt: run.createdAt,
        inferredPackId: sessionPackContext.packId,
        surface: sessionPackContext.surface,
        mode,
        result: "updated",
        applied: false,
        reasonCode: "updated",
        evidence: {
          sessionPackId: sessionPackContext.packId,
          sessionSurface: sessionPackContext.surface,
          sessionPackUpdatedAt: sessionPackContext.updatedAt,
          earliestRunAfterUpdatedAtId: earliestRunAfterUpdatedAt.id,
          earliestRunAfterUpdatedAtAt: earliestRunAfterUpdatedAt.createdAt,
          windowRunIds,
        },
      });
    }
  }

  if (mode === "apply" && updates.length > 0) {
    const appliedIds = new Set<string>();
    db.transaction(() => {
      for (const update of updates) {
        const updated = runRepository.update(db, {
          id: update.runId,
          metadata: update.metadata,
        });
        if (updated) {
          appliedIds.add(update.runId);
        }
      }
    })();

    report.updatedRuns = appliedIds.size;
    report.candidates = report.candidates.map((candidate) =>
      candidate.reasonCode === "updated" && appliedIds.has(candidate.runId)
        ? { ...candidate, applied: true }
        : candidate,
    );
  }

  return report;
}
