import * as fs from "node:fs";
import * as path from "node:path";

import type { FridaySqliteLayer } from "#state";

import type { FridayBriefDeliveryPayload } from "./delivery/friday-brief-delivery.types.js";
import type { FridayBriefConfigRepository } from "./friday-brief-config-repository.js";
import type { FridayBriefConfig } from "./friday-brief-config.types.js";
import {
  FRIDAY_BRIEF_SECRET_SLOTS,
  type FridayBriefSecretSlot,
  readSlotRefKey,
  writeSlotRefKey,
} from "./friday-brief-secret-slots.js";
import type { FridayBriefCollector } from "./collectors/friday-brief-collector.types.js";
import type { FridayBriefDeliverer } from "./friday-brief-deliverer.js";
import type { FridayBriefHistoryRepository } from "./friday-brief-history-repository.js";
import type { FridayBriefSummarizer } from "./friday-brief-summarizer.js";
import type { FridayBriefTtsRegistry } from "./tts/friday-brief-tts.types.js";
import type {
  FridayBriefEvent,
  FridayBriefRunRecord,
  FridayBriefRunSourceResult,
  FridayBriefRunTrigger,
} from "./friday-brief.types.js";

export interface FridayBriefServiceDeps {
  db: FridaySqliteLayer;
  configRepo: FridayBriefConfigRepository;
  historyRepo: FridayBriefHistoryRepository;
  collectors: readonly FridayBriefCollector[];
  summarizer: FridayBriefSummarizer;
  ttsRegistry: FridayBriefTtsRegistry;
  deliverer: FridayBriefDeliverer;
  idGenerator: () => string;
  nowIso: () => string;
  /** Absolute directory to place temporary audio artifacts. Created lazily. */
  audioWorkDir: string;
  /** Logger — optional, defaults to console. */
  logger?: { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void; error: (msg: string, meta?: unknown) => void };
  /** User id used for Friday history queries (single-user system). */
  userId: string;
  /**
   * Encrypt + store a secret, and delete it, under the `brief` scope.
   *
   * Injected so the service doesn't depend on the providers crypto layer
   * directly. Bootstrap wires this with `encryptSecret` + the secret repo.
   */
  secretStore: {
    upsert: (refKey: string, plaintext: string) => void;
    remove: (refKey: string) => void;
  };
  /**
   * Optional hook called after a successful `updateConfig`.
   *
   * Bootstrap uses this to keep the scheduler's cron in sync when the user
   * changes the brief schedule via the web UI or API. The service itself
   * doesn't know about the scheduler — it just surfaces the new config.
   */
  onConfigUpdated?: (next: FridayBriefConfig) => void;
}

export interface FridayBriefRunRequest {
  triggeredBy: FridayBriefRunTrigger;
  /** Optional override — defaults to [now-24h, now]. */
  windowStartIso?: string;
  windowEndIso?: string;
  signal?: AbortSignal;
}

export interface FridayBriefService {
  getConfig(): FridayBriefConfig;
  updateConfig(next: FridayBriefConfig): FridayBriefConfig;
  /**
   * Encrypt `value`, store it under scope=`brief` with refKey=slot, and set
   * the corresponding `*RefKey` field in the config. Returns the updated
   * config. Atomic — config mutation only happens after the secret is stored.
   */
  setSecret(slot: FridayBriefSecretSlot, value: string): FridayBriefConfig;
  /**
   * Delete the stored secret for `slot` and clear the corresponding refKey in
   * the config. Returns the updated config.
   */
  clearSecret(slot: FridayBriefSecretSlot): FridayBriefConfig;
  /**
   * List slots with their current state — `configured` is true when the
   * config references a refKey for that slot. Does not reveal the secret
   * value itself.
   */
  listSecretSlots(): Array<{ slot: FridayBriefSecretSlot; configured: boolean; refKey?: string }>;
  runOnce(request: FridayBriefRunRequest): Promise<FridayBriefRunRecord>;
  listHistory(input?: { limit?: number; beforeId?: string }): FridayBriefRunRecord[];
  getRun(id: string): FridayBriefRunRecord | null;
  /**
   * Delete old run rows (and their audio artifacts) per retention policy.
   * Returns count of pruned rows. Safe to call from a scheduled job.
   */
  pruneHistory(options?: { keepLatestCount?: number; maxAgeDays?: number }): { deletedCount: number };
  /**
   * Remove audio files in the work dir that don't correspond to any current
   * run row. Safe to call at startup to recover from crashes during synthesis.
   */
  cleanupOrphanedAudio(): { removedCount: number };
}

function defaultLogger(): NonNullable<FridayBriefServiceDeps["logger"]> {
  return {
    info: (msg, meta) => console.info(`[friday-brief] ${msg}`, meta ?? ""),
    warn: (msg, meta) => console.warn(`[friday-brief] ${msg}`, meta ?? ""),
    error: (msg, meta) => console.error(`[friday-brief] ${msg}`, meta ?? ""),
  };
}

function deriveWindow(nowIso: string, request: FridayBriefRunRequest): { fromIso: string; toIso: string } {
  const toIso = request.windowEndIso ?? nowIso;
  if (request.windowStartIso) {
    return { fromIso: request.windowStartIso, toIso };
  }
  const to = new Date(toIso);
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
  return { fromIso: from.toISOString(), toIso };
}

function summarizeSourceResults(
  results: ReturnType<FridayBriefCollector["collect"]> extends Promise<infer R> ? R[] : never,
): { aggregated: FridayBriefEvent[]; sourceRecords: FridayBriefRunSourceResult[]; totalEnabled: number; } {
  const aggregated: FridayBriefEvent[] = [];
  const sourceRecords: FridayBriefRunSourceResult[] = [];
  let totalEnabled = 0;
  for (const result of results) {
    if (!result.skipped) totalEnabled += 1;
    sourceRecords.push({
      source: result.source,
      eventCount: result.events.length,
      durationMs: result.durationMs,
      skipped: result.skipped,
      skipReason: result.skipReason,
      error: result.error,
    });
    aggregated.push(...result.events);
  }
  aggregated.sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1));
  return { aggregated, sourceRecords, totalEnabled };
}

export function createFridayBriefService(deps: FridayBriefServiceDeps): FridayBriefService {
  const logger = deps.logger ?? defaultLogger();
  // In-flight guard: a brief is single-tenant, so refuse to start a second
  // pipeline while one is running. Avoids duplicate LLM/TTS spend and
  // duplicate delivery from double-clicks or scheduled-vs-manual races.
  let runInFlight: Promise<FridayBriefRunRecord> | null = null;

  function getConfig(): FridayBriefConfig {
    return deps.db.withReadConnection((db) => deps.configRepo.get(db));
  }

  return {
    getConfig,

    updateConfig(next) {
      const saved = deps.db.withWriteTransaction((db) =>
        deps.configRepo.upsert(db, next, deps.nowIso()),
      );
      if (deps.onConfigUpdated) {
        try {
          deps.onConfigUpdated(saved);
        } catch (err) {
          logger.warn("brief onConfigUpdated hook threw", err);
        }
      }
      return saved;
    },

    setSecret(slot, value) {
      deps.secretStore.upsert(slot, value);
      const current = getConfig();
      const next = writeSlotRefKey(current, slot, slot);
      return deps.db.withWriteTransaction((db) =>
        deps.configRepo.upsert(db, next, deps.nowIso()),
      );
    },

    clearSecret(slot) {
      const current = getConfig();
      const existing = readSlotRefKey(current, slot);
      if (existing) deps.secretStore.remove(existing);
      const next = writeSlotRefKey(current, slot, undefined);
      return deps.db.withWriteTransaction((db) =>
        deps.configRepo.upsert(db, next, deps.nowIso()),
      );
    },

    listSecretSlots() {
      const config = getConfig();
      return FRIDAY_BRIEF_SECRET_SLOTS.map((slot) => {
        const refKey = readSlotRefKey(config, slot);
        return { slot, configured: typeof refKey === "string" && refKey.length > 0, refKey };
      });
    },

    listHistory(input) {
      return deps.db.withReadConnection((db) => deps.historyRepo.list(db, input));
    },

    getRun(id) {
      return deps.db.withReadConnection((db) => deps.historyRepo.get(db, id));
    },

    pruneHistory(options) {
      const keepLatestCount = options?.keepLatestCount ?? 200;
      const maxAgeDays = options?.maxAgeDays ?? 90;
      const result = deps.db.withWriteTransaction((db) =>
        deps.historyRepo.prune(db, {
          keepLatestCount,
          maxAgeDays,
          nowMs: Date.now(),
        }),
      );
      if (result.deletedIds.length === 0) return { deletedCount: 0 };
      for (const runId of result.deletedIds) {
        try {
          if (!fs.existsSync(deps.audioWorkDir)) continue;
          for (const entry of fs.readdirSync(deps.audioWorkDir)) {
            if (entry.startsWith(`brief-${runId}.`)) {
              fs.rmSync(path.join(deps.audioWorkDir, entry), { force: true });
            }
          }
        } catch (err) {
          logger.warn(`brief pruneHistory: failed to remove audio for ${runId}`, err);
        }
      }
      logger.info(`brief pruneHistory removed ${result.deletedIds.length} run(s)`);
      return { deletedCount: result.deletedIds.length };
    },

    cleanupOrphanedAudio() {
      if (!fs.existsSync(deps.audioWorkDir)) return { removedCount: 0 };
      let removed = 0;
      let entries: string[];
      try {
        entries = fs.readdirSync(deps.audioWorkDir);
      } catch (err) {
        logger.warn("brief cleanupOrphanedAudio: cannot read audio dir", err);
        return { removedCount: 0 };
      }
      for (const entry of entries) {
        const match = /^brief-(.+?)\.[^.]+$/.exec(entry);
        if (!match) continue;
        const runId = match[1];
        try {
          const exists = deps.db.withReadConnection((db) => deps.historyRepo.get(db, runId));
          if (exists) continue;
          fs.rmSync(path.join(deps.audioWorkDir, entry), { force: true });
          removed += 1;
        } catch (err) {
          logger.warn(`brief cleanupOrphanedAudio: failed for ${entry}`, err);
        }
      }
      if (removed > 0) logger.info(`brief cleanupOrphanedAudio removed ${removed} orphan(s)`);
      return { removedCount: removed };
    },

    async runOnce(request) {
      if (runInFlight) {
        logger.info("brief runOnce: a run is already in flight; reusing it");
        return runInFlight;
      }
      const promise = (async () => {
        return executeRun(request);
      })();
      runInFlight = promise;
      try {
        return await promise;
      } finally {
        runInFlight = null;
      }
    },
  };

  async function executeRun(request: FridayBriefRunRequest): Promise<FridayBriefRunRecord> {
      const signal = request.signal ?? new AbortController().signal;
      const nowIso = deps.nowIso();
      const window = deriveWindow(nowIso, request);
      const runId = deps.idGenerator();
      const config = getConfig();

      // 1. Persist pending run row.
      const initial = deps.db.withWriteTransaction((db) =>
        deps.historyRepo.create(db, {
          id: runId,
          triggeredBy: request.triggeredBy,
          windowStartAt: window.fromIso,
          windowEndAt: window.toIso,
          nowIso,
        }),
      );

      if (!config.enabled && request.triggeredBy === "scheduled") {
        logger.info(`brief disabled — skipping scheduled run ${runId}`);
        return (
          deps.db.withWriteTransaction((db) =>
            deps.historyRepo.update(
              db,
              runId,
              { status: "skipped", skipReason: "all_sources_disabled" },
              deps.nowIso(),
            ),
          ) ?? initial
        );
      }

      const anyChannelEnabled =
        config.channels.wecom.enabled ||
        config.channels.telegram.enabled ||
        config.channels.email.enabled;
      if (!anyChannelEnabled) {
        logger.info(`brief: no channels enabled — skipping run ${runId}`);
        return (
          deps.db.withWriteTransaction((db) =>
            deps.historyRepo.update(
              db,
              runId,
              { status: "skipped", skipReason: "all_channels_disabled" },
              deps.nowIso(),
            ),
          ) ?? initial
        );
      }

      // 2. Collect.
      deps.db.withWriteTransaction((db) =>
        deps.historyRepo.update(db, runId, { status: "collecting" }, deps.nowIso()),
      );
      const collectResults = await Promise.all(
        deps.collectors.map((c) =>
          c.collect({
            fromIso: window.fromIso,
            toIso: window.toIso,
            config,
            signal,
            userId: deps.userId,
          }),
        ),
      );
      const { aggregated, sourceRecords, totalEnabled } = summarizeSourceResults(collectResults);

      if (totalEnabled === 0) {
        return (
          deps.db.withWriteTransaction((db) =>
            deps.historyRepo.update(
              db,
              runId,
              {
                status: "skipped",
                skipReason: "all_sources_disabled",
                sourceResults: sourceRecords,
              },
              deps.nowIso(),
            ),
          ) ?? initial
        );
      }

      if (aggregated.length === 0) {
        return (
          deps.db.withWriteTransaction((db) =>
            deps.historyRepo.update(
              db,
              runId,
              {
                status: "skipped",
                skipReason: "no_events",
                sourceResults: sourceRecords,
              },
              deps.nowIso(),
            ),
          ) ?? initial
        );
      }

      // 3. Summarize.
      deps.db.withWriteTransaction((db) =>
        deps.historyRepo.update(
          db,
          runId,
          { status: "summarizing", sourceResults: sourceRecords },
          deps.nowIso(),
        ),
      );
      const summary = await deps.summarizer.summarize({
        events: aggregated,
        languageOverride: config.languageOverride,
        length: config.length,
        signal,
      });

      deps.db.withWriteTransaction((db) =>
        deps.historyRepo.update(
          db,
          runId,
          { transcript: summary.fullText, language: summary.language },
          deps.nowIso(),
        ),
      );

      // 4. Synthesize audio.
      deps.db.withWriteTransaction((db) =>
        deps.historyRepo.update(db, runId, { status: "synthesizing" }, deps.nowIso()),
      );
      const provider = deps.ttsRegistry.select(config.tts.provider);
      if (!provider) {
        return (
          deps.db.withWriteTransaction((db) =>
            deps.historyRepo.update(
              db,
              runId,
              {
                status: "failed",
                error: { code: "TTS_NOT_CONFIGURED", message: "no TTS provider has resolvable credentials" },
              },
              deps.nowIso(),
            ),
          ) ?? initial
        );
      }

      let audioFilePath = "";
      let audioMimeType = "audio/mpeg";
      let audioFormat = "mp3";
      let audioBytes = 0;
      let audioDurationSec: number | undefined;
      let audioVoice = "";
      let audioProvider = provider.kind;

      try {
        const ttsOutput = await provider.synthesize(
          { text: summary.fullText, language: summary.language },
          signal,
        );
        fs.mkdirSync(deps.audioWorkDir, { recursive: true });
        audioFilePath = path.join(deps.audioWorkDir, `brief-${runId}.${ttsOutput.format}`);
        fs.writeFileSync(audioFilePath, ttsOutput.data);
        audioMimeType = ttsOutput.mimeType;
        audioFormat = ttsOutput.format;
        audioBytes = ttsOutput.data.byteLength;
        audioVoice = ttsOutput.voice;
        audioProvider = ttsOutput.provider;
        audioDurationSec = ttsOutput.durationSec;
      } catch (err) {
        const error = err as Error;
        logger.error(`TTS synthesis failed for ${runId}`, error);
        return (
          deps.db.withWriteTransaction((db) =>
            deps.historyRepo.update(
              db,
              runId,
              {
                status: "failed",
                error: { code: "TTS_FAILED", message: error.message ?? String(err) },
              },
              deps.nowIso(),
            ),
          ) ?? initial
        );
      }

      deps.db.withWriteTransaction((db) =>
        deps.historyRepo.update(
          db,
          runId,
          {
            status: "delivering",
            audio: {
              provider: audioProvider,
              voice: audioVoice,
              bytes: audioBytes,
              durationSec: audioDurationSec,
            },
          },
          deps.nowIso(),
        ),
      );

      // 5. Deliver.
      const payload: FridayBriefDeliveryPayload = {
        runId,
        transcript: summary.fullText,
        language: summary.language,
        audio: {
          filePath: audioFilePath,
          mimeType: audioMimeType,
          format: audioFormat,
          bytes: audioBytes,
          durationSec: audioDurationSec,
        },
        includeTranscript: config.includeTranscript,
      };

      const delivery = await deps.deliverer.deliver({
        fallbackOrder: config.fallbackOrder,
        payload,
        signal,
      });

      // 6. Delete on-disk audio (retention: text-only).
      try {
        if (audioFilePath) fs.rmSync(audioFilePath, { force: true });
      } catch (err) {
        logger.warn(`audio cleanup failed for ${runId}`, err);
      }

      const finalStatus = delivery.deliveredVia ? "delivered" : "failed";
      const skipReason = finalStatus === "failed" ? "all_channels_failed" : undefined;
      const topError =
        finalStatus === "failed"
          ? {
              code: "ALL_CHANNELS_FAILED",
              message: delivery.attempts
                .map((a) => `${a.channel}:${a.error?.message ?? "ok"}`)
                .join(" | "),
            }
          : null;

      return (
        deps.db.withWriteTransaction((db) =>
          deps.historyRepo.update(
            db,
            runId,
            {
              status: finalStatus,
              skipReason: finalStatus === "failed" ? skipReason ?? null : null,
              deliveryAttempts: delivery.attempts,
              error: topError,
            },
            deps.nowIso(),
          ),
        ) ?? initial
      );
  }
}
