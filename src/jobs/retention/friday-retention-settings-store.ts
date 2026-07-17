import type Database from "better-sqlite3";
import type { FridaySqliteLayer } from "#state";

import type { CategoryRetention, FridayRetentionContentPolicy } from "./friday-retention.types.js";
import { FRIDAY_RETENTION_CONTENT_CATEGORIES, isValidAfterDays } from "./friday-retention.types.js";
import type { FridayRetentionSettingsRepository } from "./friday-retention-settings-repository.js";

/**
 * Owner-bound per-content-category retention SETTINGS store (RETENTION-R3a).
 *
 * The single read/write authority behind `GET|PUT /v1/uix/retention-policy`.
 * Every method is scoped by the caller-owner's `principalId` (which the route
 * derives ONLY from the authenticated principal — never from the request body
 * or params). Persists "off" as the CLEAN disabled state (permanent = the
 * override row is removed); NEVER a sentinel number.
 */
export interface FridayRetentionSettingsStore {
  /**
   * The caller-owner's effective per-content-category policy. Defaults every
   * category to `{mode:"permanent"}`; a persisted opt-in surfaces as
   * `{mode:"after_days",days:N}`.
   */
  readOwnerContentPolicy(input: { principalId: string }): FridayRetentionContentPolicy;
  /**
   * Apply owner-supplied per-category updates transactionally (validate-then-
   * apply: on ANY invalid entry nothing is persisted). `{mode:"permanent"}`
   * removes the override (clean "off"); `{mode:"after_days",days:N}` upserts a
   * window inside the canonical `[FRIDAY_MIN_AFTER_DAYS, FRIDAY_MAX_AFTER_DAYS]`
   * domain (`isValidAfterDays`). Returns the fresh effective policy.
   */
  applyOwnerContentPolicy(input: {
    principalId: string;
    updates: Record<string, CategoryRetention>;
  }): FridayRetentionContentPolicy;
  /**
   * RETENTION-R3d (P0 — concurrent authoritative readback): read the effective
   * policy on a CALLER-SUPPLIED connection. When that connection is the writer
   * inside an open write transaction, this returns the AUTHORITATIVE state that
   * transaction will commit — it SEES this txn's own uncommitted apply AND any
   * write another connection committed before the txn opened — so the caller can
   * capture a truthful `before`/`after` without a racy pre-txn read-pool snapshot.
   */
  readOwnerContentPolicyOnConnection(
    db: Database.Database,
    input: { principalId: string },
  ): FridayRetentionContentPolicy;
  /**
   * RETENTION-R3d: apply per-category updates on a CALLER-SUPPLIED connection
   * (same validate-then-apply semantics as `applyOwnerContentPolicy`), WITHOUT
   * opening its own transaction — the caller's transaction provides atomicity, so
   * the apply, the authoritative `after` re-read, and the audit/receipt write all
   * commit or roll back together on ONE connection.
   */
  applyOwnerContentPolicyOnConnection(
    db: Database.Database,
    input: { principalId: string; updates: Record<string, CategoryRetention> },
  ): void;
}

const CONTENT_CATEGORY_SET: ReadonlySet<string> = new Set(FRIDAY_RETENTION_CONTENT_CATEGORIES);

function allPermanentPolicy(): FridayRetentionContentPolicy {
  const policy = {} as FridayRetentionContentPolicy;
  for (const category of FRIDAY_RETENTION_CONTENT_CATEGORIES) {
    policy[category] = { mode: "permanent" };
  }
  return policy;
}

export interface CreateFridayRetentionSettingsStoreDeps {
  db: FridaySqliteLayer;
  repo: FridayRetentionSettingsRepository;
  idGenerator: () => string;
  nowIso: () => string;
}

export function createFridayRetentionSettingsStore(
  deps: CreateFridayRetentionSettingsStoreDeps,
): FridayRetentionSettingsStore {
  // Shared read logic on a supplied connection (read pool OR the writer inside a
  // txn). The defensive filter only surfaces a well-formed opt-in for a known
  // content category whose window is inside the canonical honored domain; anything
  // else (unknown category, or an out-of-domain / legacy after_days the reaper
  // would silently treat as permanent) falls back to the permanent default —
  // fail-closed read, never report a policy production won't honor.
  function readOnConnection(
    db: Database.Database,
    principalId: string,
  ): FridayRetentionContentPolicy {
    const policy = allPermanentPolicy();
    const overrides = deps.repo.listByPrincipal(db, { principalId });
    for (const override of overrides) {
      if (
        CONTENT_CATEGORY_SET.has(override.contentCategory) &&
        isValidAfterDays(override.afterDays)
      ) {
        policy[override.contentCategory as keyof FridayRetentionContentPolicy] = {
          mode: "after_days",
          days: override.afterDays,
        };
      }
    }
    return policy;
  }

  // Shared apply logic on a supplied connection — NO transaction of its own; the
  // caller owns the transaction. Validate-then-apply: any invalid entry throws
  // (rolling back the caller's txn ⇒ nothing persisted).
  function applyOnConnection(
    db: Database.Database,
    principalId: string,
    updates: Record<string, CategoryRetention>,
  ): void {
    for (const [category, retention] of Object.entries(updates)) {
      if (!CONTENT_CATEGORY_SET.has(category)) {
        throw new Error(`Unknown retention content category: ${category}`);
      }
      if (!retention || typeof retention !== "object") {
        throw new Error(`Invalid retention config for ${category}`);
      }
      if (retention.mode === "permanent") {
        // Clean "off": remove the override row (absence = permanent).
        deps.repo.deleteCategory(db, { principalId, contentCategory: category });
        continue;
      }
      if (retention.mode === "after_days" && isValidAfterDays(retention.days)) {
        deps.repo.upsertAfterDays(db, {
          id: deps.idGenerator(),
          principalId,
          contentCategory: category,
          days: retention.days,
          nowIso: deps.nowIso(),
        });
        continue;
      }
      throw new Error(`Invalid retention config for ${category}`);
    }
  }

  function readOwnerContentPolicy(input: { principalId: string }): FridayRetentionContentPolicy {
    return deps.db.withReadConnection((db) => readOnConnection(db, input.principalId));
  }

  return {
    readOwnerContentPolicy,
    readOwnerContentPolicyOnConnection: (db, input) => readOnConnection(db, input.principalId),
    applyOwnerContentPolicyOnConnection: (db, input) =>
      applyOnConnection(db, input.principalId, input.updates),

    applyOwnerContentPolicy(input) {
      // Validate-then-apply, all inside ONE write transaction: any invalid entry
      // throws and rolls the whole apply back ⇒ nothing persisted.
      deps.db.withWriteTransaction((db) => applyOnConnection(db, input.principalId, input.updates));
      return readOwnerContentPolicy({ principalId: input.principalId });
    },
  };
}
