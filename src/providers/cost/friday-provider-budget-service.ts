import type { FridaySqliteLayer } from "#state";
import { safeJsonParse } from "#utilities";
import type {
  FridayBudgetState,
  FridayLlmBudgetConfig,
  FridayLlmBudgetStatus,
} from "../model/friday-provider-cost.types.js";
import type { FridayProviderUsageRepository } from "../persistence/friday-provider-usage-repository.js";

// ─── Constants ───

const BUDGET_SETTINGS_KEY = "llm.budget.v1";
const NEAR_LIMIT_RATIO = 0.80;

// ─── Interface ───

export interface FridayProviderBudgetService {
  getBudgetConfig(): Promise<FridayLlmBudgetConfig | null>;
  setBudgetConfig(input: FridayLlmBudgetConfig): Promise<FridayLlmBudgetConfig>;
  getBudgetStatus(nowIso?: string): Promise<FridayLlmBudgetStatus>;
}

// ─── Factory ───

export function createFridayProviderBudgetService(deps: {
  db: FridaySqliteLayer;
  usageRepo: FridayProviderUsageRepository;
  nowIso: () => string;
}): FridayProviderBudgetService {
  const { db, usageRepo, nowIso } = deps;

  function loadConfig(): FridayLlmBudgetConfig | null {
    const row = db.withReadConnection((conn) =>
      conn
        .prepare("SELECT value_json FROM hub_settings WHERE key = ?")
        .get(BUDGET_SETTINGS_KEY) as { value_json: string } | undefined,
    );
    if (!row) return null;
    return safeJsonParse<FridayLlmBudgetConfig>(row.value_json) ?? null;
  }

  function saveConfig(config: FridayLlmBudgetConfig): void {
    const json = JSON.stringify(config);
    const now = nowIso();
    db.withWriteTransaction((conn) => {
      const existing = conn
        .prepare("SELECT key FROM hub_settings WHERE key = ?")
        .get(BUDGET_SETTINGS_KEY) as { key: string } | undefined;

      if (existing) {
        conn.prepare(
          `UPDATE hub_settings SET value_json = ?, revision = revision + 1, updated_at = ?
           WHERE key = ?`,
        ).run(json, now, BUDGET_SETTINGS_KEY);
      } else {
        conn.prepare(
          `INSERT INTO hub_settings (key, value_json, revision, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?)`,
        ).run(BUDGET_SETTINGS_KEY, json, now, now);
      }
    });
  }

  return {
    async getBudgetConfig() {
      return loadConfig();
    },

    async setBudgetConfig(input) {
      saveConfig(input);
      return input;
    },

    async getBudgetStatus(overrideNow?) {
      const now = overrideNow ?? nowIso();
      // Extract YYYY-MM from ISO date
      const month = now.slice(0, 7);
      const config = loadConfig();
      const spentUsd = db.withReadConnection((conn) =>
        usageRepo.sumCostForMonth(conn, month),
      );

      let state: FridayBudgetState = "ok";
      let remainingUsd: number | null = null;

      if (config) {
        remainingUsd = Math.max(0, config.monthlyLimitUsd - spentUsd);
        const ratio = spentUsd / config.monthlyLimitUsd;
        if (ratio >= 1.0) {
          state = "over_limit";
        } else if (ratio >= NEAR_LIMIT_RATIO) {
          state = "near_limit";
        }
      }

      return {
        month,
        config,
        spentUsd,
        remainingUsd,
        state,
      };
    },
  };
}
