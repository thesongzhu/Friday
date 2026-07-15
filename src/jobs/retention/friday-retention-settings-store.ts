import type { FridaySqliteLayer } from "#state";

import type { CategoryRetention, FridayRetentionContentPolicy } from "./friday-retention.types.js";
import { FRIDAY_RETENTION_CONTENT_CATEGORIES } from "./friday-retention.types.js";
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
   * positive-integer window. Returns the fresh effective policy.
   */
  applyOwnerContentPolicy(input: {
    principalId: string;
    updates: Record<string, CategoryRetention>;
  }): FridayRetentionContentPolicy;
}

const CONTENT_CATEGORY_SET: ReadonlySet<string> = new Set(FRIDAY_RETENTION_CONTENT_CATEGORIES);

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

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
  function readOwnerContentPolicy(input: { principalId: string }): FridayRetentionContentPolicy {
    const policy = allPermanentPolicy();
    const overrides = deps.db.withReadConnection((db) =>
      deps.repo.listByPrincipal(db, { principalId: input.principalId }),
    );
    for (const override of overrides) {
      // Defensive: only surface a well-formed opt-in for a known content
      // category; anything else falls back to the permanent default
      // (fail-closed read — mirrors the reaper's resolveCutoff).
      if (
        CONTENT_CATEGORY_SET.has(override.contentCategory) &&
        isPositiveInteger(override.afterDays)
      ) {
        policy[override.contentCategory as keyof FridayRetentionContentPolicy] = {
          mode: "after_days",
          days: override.afterDays,
        };
      }
    }
    return policy;
  }

  return {
    readOwnerContentPolicy,

    applyOwnerContentPolicy(input) {
      const entries = Object.entries(input.updates);
      // Validate-then-apply, all inside ONE write transaction: any invalid entry
      // throws and rolls the whole apply back ⇒ nothing persisted.
      deps.db.withWriteTransaction((db) => {
        for (const [category, retention] of entries) {
          if (!CONTENT_CATEGORY_SET.has(category)) {
            throw new Error(`Unknown retention content category: ${category}`);
          }
          if (!retention || typeof retention !== "object") {
            throw new Error(`Invalid retention config for ${category}`);
          }
          if (retention.mode === "permanent") {
            // Clean "off": remove the override row (absence = permanent).
            deps.repo.deleteCategory(db, {
              principalId: input.principalId,
              contentCategory: category,
            });
            continue;
          }
          if (retention.mode === "after_days" && isPositiveInteger(retention.days)) {
            deps.repo.upsertAfterDays(db, {
              id: deps.idGenerator(),
              principalId: input.principalId,
              contentCategory: category,
              days: retention.days,
              nowIso: deps.nowIso(),
            });
            continue;
          }
          throw new Error(`Invalid retention config for ${category}`);
        }
      });
      return readOwnerContentPolicy({ principalId: input.principalId });
    },
  };
}
