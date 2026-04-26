import type { FridaySqliteLayer } from "#state";
import type { FridayRuntimeCapabilityRisk } from "#providers";
import { FridayDomainError } from "#errors";
import type {
  FridayAutonomyBudgetPolicy,
  FridayAutonomyMode,
  FridayAutonomyPolicy,
  FridayAutonomyRiskCategory,
  FridayAutonomyRiskDecision,
} from "../model/friday-controlled-autonomy.types.js";

export interface CreateFridayAutonomyPolicyServiceDeps {
  db: FridaySqliteLayer;
  nowIso: () => string;
}

export interface FridayUpdateAutonomyPolicyInput {
  mode?: FridayAutonomyMode;
  paused?: boolean;
  riskSwitches?: Partial<Record<FridayAutonomyRiskCategory, boolean>>;
  budget?: FridayAutonomyBudgetPolicy;
  evidenceRetentionDays?: number;
}

export interface FridayAutonomyPolicyService {
  getPolicy(): FridayAutonomyPolicy;
  updatePolicy(input: FridayUpdateAutonomyPolicyInput): FridayAutonomyPolicy;
  evaluateRisks(risks: readonly FridayAutonomyRiskCategory[]): FridayAutonomyRiskDecision;
}

interface PolicyRow {
  id: string;
  mode: string;
  paused: number;
  risk_switches_json: string;
  budget_json: string;
  evidence_retention_days: number;
  updated_at: string;
}

export const FRIDAY_AUTONOMY_RISK_CATEGORIES: readonly FridayAutonomyRiskCategory[] = [
  "external_download",
  "npm_github_install",
  "mcp_install",
  "write_config",
  "shell",
  "local_file_write",
  "network_call",
  "paid_api",
  "oauth",
  "api_key",
  "login",
  "captcha",
  "payment",
  "sensitive_permission",
  "production_operation",
];

const RISK_CATEGORY_SET = new Set<string>(FRIDAY_AUTONOMY_RISK_CATEGORIES);

const HARD_HUMAN_GATE_RISKS = new Set<FridayAutonomyRiskCategory>([
  "oauth",
  "api_key",
  "login",
  "captcha",
  "payment",
  "sensitive_permission",
]);

const DEFAULT_BUDGET: FridayAutonomyBudgetPolicy = {
  maxUsdPerRun: 0,
  maxMinutesPerRun: 20,
  maxNetworkCallsPerRun: 20,
  maxExternalDownloadsPerRun: 0,
};

const LOW_RISK_SWITCHES: Record<FridayAutonomyRiskCategory, boolean> = {
  external_download: false,
  npm_github_install: false,
  mcp_install: false,
  write_config: false,
  shell: false,
  local_file_write: true,
  network_call: true,
  paid_api: false,
  oauth: false,
  api_key: false,
  login: false,
  captcha: false,
  payment: false,
  sensitive_permission: false,
  production_operation: false,
};

const MAX_AUTONOMY_SWITCHES: Record<FridayAutonomyRiskCategory, boolean> = {
  external_download: true,
  npm_github_install: true,
  mcp_install: true,
  write_config: true,
  shell: true,
  local_file_write: true,
  network_call: true,
  paid_api: true,
  oauth: false,
  api_key: false,
  login: false,
  captcha: false,
  payment: false,
  sensitive_permission: false,
  production_operation: false,
};

export function createDefaultFridayAutonomyPolicy(nowIso: string): FridayAutonomyPolicy {
  return {
    id: "default",
    mode: "low_risk_auto",
    paused: false,
    riskSwitches: { ...LOW_RISK_SWITCHES },
    budget: { ...DEFAULT_BUDGET },
    evidenceRetentionDays: 90,
    updatedAt: nowIso,
  };
}

export function mapFridayRuntimeRisksToAutonomyRisks(
  risks: readonly FridayRuntimeCapabilityRisk[],
): FridayAutonomyRiskCategory[] {
  const mapped = new Set<FridayAutonomyRiskCategory>();
  for (const risk of risks) {
    switch (risk) {
      case "auth":
        mapped.add("api_key");
        break;
      case "paid_api":
        mapped.add("paid_api");
        break;
      case "network":
        mapped.add("network_call");
        break;
      case "local_execution":
        mapped.add("shell");
        break;
      case "third_party_install":
        mapped.add("external_download");
        mapped.add("npm_github_install");
        break;
      case "writes_config":
        mapped.add("write_config");
        break;
    }
  }
  return [...mapped];
}

export function normalizeFridayAutonomyRisks(
  risks: readonly string[],
): FridayAutonomyRiskCategory[] {
  const normalized = new Set<FridayAutonomyRiskCategory>();
  for (const risk of risks) {
    if (RISK_CATEGORY_SET.has(risk)) {
      normalized.add(risk as FridayAutonomyRiskCategory);
    }
  }
  return [...normalized];
}

export function evaluateFridayAutonomyRisks(
  policy: FridayAutonomyPolicy,
  risks: readonly FridayAutonomyRiskCategory[],
): FridayAutonomyRiskDecision {
  const normalized = normalizeFridayAutonomyRisks(risks);
  const hardHumanBlockers = normalized
    .filter((risk) => HARD_HUMAN_GATE_RISKS.has(risk))
    .map((risk) => describeHardHumanGate(risk));
  const policyBlockers = normalized
    .filter((risk) => !policy.riskSwitches[risk] && !HARD_HUMAN_GATE_RISKS.has(risk))
    .map((risk) => `Policy blocks ${risk}; user approval or policy change is required.`);
  if (policy.paused) {
    policyBlockers.push("Autonomy is paused; resume autonomy before automatic action.");
  }
  return {
    risks: normalized,
    allowed: hardHumanBlockers.length === 0 && policyBlockers.length === 0,
    approvalRequired: hardHumanBlockers.length > 0 || policyBlockers.length > 0,
    hardHumanBlockers,
    policyBlockers,
  };
}

export function createFridayAutonomyPolicyService(
  deps: CreateFridayAutonomyPolicyServiceDeps,
): FridayAutonomyPolicyService {
  const { db, nowIso } = deps;

  function persist(policy: FridayAutonomyPolicy): FridayAutonomyPolicy {
    db.withWriteTransaction((conn) => {
      conn.prepare(
        `INSERT INTO friday_autonomy_policy (
          id,
          mode,
          paused,
          risk_switches_json,
          budget_json,
          evidence_retention_days,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          mode = excluded.mode,
          paused = excluded.paused,
          risk_switches_json = excluded.risk_switches_json,
          budget_json = excluded.budget_json,
          evidence_retention_days = excluded.evidence_retention_days,
          updated_at = excluded.updated_at`,
      ).run(
        policy.id,
        policy.mode,
        policy.paused ? 1 : 0,
        JSON.stringify(policy.riskSwitches),
        JSON.stringify(policy.budget),
        policy.evidenceRetentionDays,
        policy.updatedAt,
      );
    });
    return policy;
  }

  function getPolicy(): FridayAutonomyPolicy {
    const row = db.withReadConnection((conn) =>
      conn.prepare("SELECT * FROM friday_autonomy_policy WHERE id = 'default'").get() as PolicyRow | undefined,
    );
    if (!row) {
      return persist(createDefaultFridayAutonomyPolicy(nowIso()));
    }
    return rowToPolicy(row, nowIso());
  }

  function updatePolicy(input: FridayUpdateAutonomyPolicyInput): FridayAutonomyPolicy {
    const current = getPolicy();
    const nextMode = input.mode ?? current.mode;
    const modeSwitches = input.mode === "max_autonomy"
      ? MAX_AUTONOMY_SWITCHES
      : input.mode === "low_risk_auto"
        ? LOW_RISK_SWITCHES
        : current.riskSwitches;
    const riskSwitches = {
      ...modeSwitches,
      ...(input.riskSwitches ?? {}),
    };
    for (const key of Object.keys(riskSwitches)) {
      if (!RISK_CATEGORY_SET.has(key)) {
        delete (riskSwitches as Record<string, boolean>)[key];
      }
    }
    const evidenceRetentionDays = input.evidenceRetentionDays ?? current.evidenceRetentionDays;
    if (!Number.isFinite(evidenceRetentionDays) || evidenceRetentionDays < 1) {
      throw new FridayDomainError("VALIDATION_ERROR", "evidenceRetentionDays must be a positive number", {
        httpStatus: 400,
      });
    }
    return persist({
      id: "default",
      mode: nextMode,
      paused: input.paused ?? current.paused,
      riskSwitches: normalizeSwitches(riskSwitches),
      budget: {
        ...current.budget,
        ...(input.budget ?? {}),
      },
      evidenceRetentionDays: Math.floor(evidenceRetentionDays),
      updatedAt: nowIso(),
    });
  }

  return {
    getPolicy,
    updatePolicy,
    evaluateRisks(risks) {
      return evaluateFridayAutonomyRisks(getPolicy(), risks);
    },
  };
}

function rowToPolicy(row: PolicyRow, fallbackNow: string): FridayAutonomyPolicy {
  return {
    id: "default",
    mode: row.mode === "max_autonomy" ? "max_autonomy" : "low_risk_auto",
    paused: row.paused === 1,
    riskSwitches: normalizeSwitches(readJson(row.risk_switches_json, LOW_RISK_SWITCHES)),
    budget: readJson(row.budget_json, DEFAULT_BUDGET),
    evidenceRetentionDays: Number.isFinite(row.evidence_retention_days)
      ? row.evidence_retention_days
      : 90,
    updatedAt: row.updated_at || fallbackNow,
  };
}

function normalizeSwitches(
  raw: Partial<Record<FridayAutonomyRiskCategory, boolean>>,
): Record<FridayAutonomyRiskCategory, boolean> {
  const switches: Record<FridayAutonomyRiskCategory, boolean> = { ...LOW_RISK_SWITCHES };
  for (const risk of FRIDAY_AUTONOMY_RISK_CATEGORIES) {
    if (typeof raw[risk] === "boolean") {
      switches[risk] = raw[risk];
    }
  }
  for (const risk of HARD_HUMAN_GATE_RISKS) {
    switches[risk] = false;
  }
  return switches;
}

function readJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function describeHardHumanGate(risk: FridayAutonomyRiskCategory): string {
  switch (risk) {
    case "api_key":
      return "API key or provider credential is required; user must provide or authorize it.";
    case "oauth":
      return "OAuth login is required; user must complete the browser authorization.";
    case "login":
      return "External account login is required; user must authenticate.";
    case "captcha":
      return "CAPTCHA is required; user must solve it.";
    case "payment":
      return "Payment or billing setup is required; user must approve it outside automation.";
    case "sensitive_permission":
      return "Sensitive permission is required; user must grant it explicitly.";
    default:
      return `Human action is required for ${risk}.`;
  }
}
