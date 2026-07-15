import type { FridaySqliteLayer } from "#state";

import type { CategoryRetention, FridayRetentionPolicy } from "./friday-retention.types.js";
import {
  FRIDAY_DEFAULT_RETENTION_POLICY,
  FRIDAY_RETENTION_CONTENT_CATEGORIES,
} from "./friday-retention.types.js";
import type { FridayRetentionSettingsRepository } from "./friday-retention-settings-repository.js";

/**
 * RETENTION-R3a — reads the persisted OWNER retention policy at wiring/startup
 * and resolves it into a full `FridayRetentionPolicy` for the reaper.
 *
 * FAIL-CLOSED (DATA-RETENTION-001): the loader NEVER throws and NEVER widens the
 * deletion surface on uncertainty. On an unreadable store, a missing owner
 * policy, or a partial/invalid/unknown override row, the affected content
 * category resolves to `{mode:"permanent"}` (delete nothing). A total read
 * failure resolves to `FRIDAY_DEFAULT_RETENTION_POLICY` (all-permanent). The
 * user-configurable CONTENT categories are the only thing an owner opt-in can
 * ENABLE; the SECURITY-LIFECYCLE terminal TTLs (`pairingRequestsDays` /
 * `outboxTerminalDays` / `bootstrapNoncesConsumedDays`) are ALWAYS taken from
 * the default policy and can never be altered through this surface.
 */
export interface FridayRetentionPolicyLoader {
  /** Resolve the effective retention policy for the reaper (never throws). */
  load(): FridayRetentionPolicy;
}

export interface CreateFridayRetentionPolicyLoaderDeps {
  db: FridaySqliteLayer;
  repo: FridayRetentionSettingsRepository;
  /** The owner principal whose persisted policy governs the (single-owner) reaper. */
  principalId: string;
  /** Override for tests; defaults to the all-permanent production default. */
  defaultPolicy?: FridayRetentionPolicy;
}

const CONTENT_CATEGORY_SET: ReadonlySet<string> = new Set(FRIDAY_RETENTION_CONTENT_CATEGORIES);

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function createFridayRetentionPolicyLoader(
  deps: CreateFridayRetentionPolicyLoaderDeps,
): FridayRetentionPolicyLoader {
  const defaultPolicy = deps.defaultPolicy ?? FRIDAY_DEFAULT_RETENTION_POLICY;

  return {
    load(): FridayRetentionPolicy {
      // Start from the all-permanent content defaults + the (immutable-here)
      // security-lifecycle TTLs. Any override we cannot fully trust is left at
      // the permanent default.
      const content: Record<string, CategoryRetention> = {};
      for (const category of FRIDAY_RETENTION_CONTENT_CATEGORIES) {
        content[category] = { mode: "permanent" };
      }

      try {
        const overrides = deps.db.withReadConnection((db) =>
          deps.repo.listByPrincipal(db, { principalId: deps.principalId }),
        );
        for (const override of overrides) {
          if (
            CONTENT_CATEGORY_SET.has(override.contentCategory) &&
            isPositiveInteger(override.afterDays)
          ) {
            content[override.contentCategory] = {
              mode: "after_days",
              days: override.afterDays,
            };
          }
          // else: unknown category / malformed window ⇒ leave permanent (fail closed).
        }
      } catch {
        // Unreadable store ⇒ all-permanent (delete nothing).
        return { ...defaultPolicy };
      }

      return {
        learningEvents: content.learningEvents,
        heartbeats: content.heartbeats,
        skillRunTerminal: content.skillRunTerminal,
        auditLogs: content.auditLogs,
        agentRuns: content.agentRuns,
        llmUsageRecords: content.llmUsageRecords,
        errorIncidents: content.errorIncidents,
        // Security-lifecycle TTLs are NEVER owner-configurable via retention
        // Settings; always taken from the default policy.
        pairingRequestsDays: defaultPolicy.pairingRequestsDays,
        outboxTerminalDays: defaultPolicy.outboxTerminalDays,
        bootstrapNoncesConsumedDays: defaultPolicy.bootstrapNoncesConsumedDays,
      };
    },
  };
}
