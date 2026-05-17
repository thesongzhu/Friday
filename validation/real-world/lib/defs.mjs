/**
 * Shared definitions for the real-world validation framework.
 *
 * The framework intentionally lives outside `test/` so it can evolve as an
 * operator-facing validation program instead of a repo-local assertion suite.
 */

export const REAL_WORLD_RESULT_VALUES = Object.freeze([
  "passed",
  "failed",
  "blocked",
  "partial",
  "manual_review",
]);

export const REAL_WORLD_FAILURE_CLASSES = Object.freeze([
  "environment",
  "http_contract",
  "ui_loading",
  "ui_misroute",
  "llm_behavior",
  "llm_misroute",
  "provider_protocol",
  "tool_bridge",
  "workflow_runtime",
  "generator",
  "self_healing",
  "learning_evidence",
  "distributed_recovery",
  "unknown",
]);

export const REAL_WORLD_DEFECT_BUCKETS = Object.freeze([
  "intent/routing",
  "provider/protocol",
  "tool bridge",
  "UI/data loading",
  "self-healing/learning evidence",
  "distributed/channel recovery",
  "environment/setup",
]);

export const REAL_WORLD_EXECUTION_KINDS = Object.freeze([
  "env_truth",
  "http_probe",
  "ui_probe",
  "agent_run",
  "workflow_roundtrip",
  "skill_generator_loop",
  "workflow_generator_loop",
  "persona_learning",
  "discord_roundtrip",
  // Phase 14.5E module_28e Slice 6.6 — per-channel external roundtrip
  // execution kinds for Lark/Feishu and Telegram. Each executor checks
  // its own env tuple and emits `blocked` honestly when env is missing.
  "lark_roundtrip",
  "telegram_roundtrip",
  "skill_upgrade_lifecycle",
  "auto_fix_doctor_roundtrip",
  "workflow_evidence_fail_closed",
  "task_workflow_rollback_matrix",
  "manual_external",
  "ui_authoring",
]);

export const REAL_WORLD_PROVIDER_LANE_POLICIES = Object.freeze([
  "none",
  "default_only",
  "default_and_fallback",
]);

export const SUITE_PROFILES = Object.freeze({
  smoke: {
    key: "smoke",
    description: "Fast pre-change smoke run.",
    defaultRepetitions: 1,
    allowJudge: "auto",
    includeManualExternal: false,
  },
  daily: {
    key: "daily",
    description: "Daily stability regression.",
    defaultRepetitions: 3,
    allowJudge: "auto",
    includeManualExternal: false,
  },
  nightly: {
    key: "nightly",
    description: "Nightly deep regression.",
    defaultRepetitions: 10,
    allowJudge: "auto",
    includeManualExternal: false,
  },
  weekly: {
    key: "weekly",
    description: "Weekly endurance and external validation.",
    defaultRepetitions: 10,
    allowJudge: "auto",
    includeManualExternal: true,
  },
});

const EXECUTION_KIND_SET = new Set(REAL_WORLD_EXECUTION_KINDS);
const RESULT_VALUE_SET = new Set(REAL_WORLD_RESULT_VALUES);
const PROVIDER_LANE_POLICY_SET = new Set(REAL_WORLD_PROVIDER_LANE_POLICIES);
const SUITE_SET = new Set(Object.keys(SUITE_PROFILES));

/**
 * @typedef {{
 *   id: string;
 *   layer: string;
 *   productArea: string;
 *   entrySurface: string;
 *   routeFamily: string;
 *   providerLane: "none" | "default_only" | "default_and_fallback";
 *   riskTier: "low" | "medium" | "high";
 *   suites?: string[];
 *   severityOnFailure?: "P0" | "P1" | "P2" | "P3";
 *   preconditions?: string[];
 *   realWorldPrompt?: string;
 *   expectedEvidence: string[];
 *   oracles?: Record<string, unknown>;
 *   latencyBudget?: Record<string, number | undefined>;
 *   stabilityBudget?: Record<string, number | undefined>;
 *   costBudget?: Record<string, number | undefined>;
 *   cleanup?: string[];
 *   repeatProfile?: Record<string, number | undefined>;
 *   execution: Record<string, unknown> & { kind: string };
 *   tags?: string[];
 * }} RealWorldScenario
 */

/**
 * @typedef {{
 *   runId: string;
 *   scenarioId: string;
 *   suite: string;
 *   lane: string;
 *   surface: string;
 *   result: "passed" | "failed" | "blocked" | "partial" | "manual_review";
 *   failureClass?: string;
 *   misrouteClass?: string;
 *   defectBucket?: string;
 *   toolErrors?: string[];
 *   metrics?: Record<string, number | undefined>;
 *   expectedEvidence?: string[];
 *   observedEvidence?: string[];
 *   screenshots?: string[];
 *   eventLog?: string[];
 *   traceRefs?: string[];
 *   auditRefs?: string[];
 *   humanReviewRequired?: boolean;
 *   notes?: string[];
 *   severity?: string;
 *   raw?: Record<string, unknown>;
 * }} RealWorldRunArtifact
 */

export function uniqueStrings(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim().length > 0))];
}

export function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

export function safeJsonParse(value) {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function stripMarkdownFences(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  return trimmed
    .replace(/^```[a-zA-Z0-9_-]*\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
}

export function resolveJsonPath(source, path) {
  if (!path) return source;
  return String(path)
    .split(".")
    .filter(Boolean)
    .reduce((value, segment) => {
      if (value == null || typeof value !== "object") return undefined;
      return value[segment];
    }, source);
}

export function validateScenario(scenario) {
  const errors = [];
  if (!scenario || typeof scenario !== "object") {
    return { ok: false, errors: ["scenario must be an object"] };
  }

  if (typeof scenario.id !== "string" || scenario.id.trim().length === 0) {
    errors.push("id must be a non-empty string");
  }
  for (const key of ["layer", "productArea", "entrySurface", "routeFamily", "riskTier"]) {
    if (typeof scenario[key] !== "string" || scenario[key].trim().length === 0) {
      errors.push(`${key} must be a non-empty string`);
    }
  }

  if (!PROVIDER_LANE_POLICY_SET.has(scenario.providerLane)) {
    errors.push(`providerLane must be one of: ${REAL_WORLD_PROVIDER_LANE_POLICIES.join(", ")}`);
  }

  if (!Array.isArray(scenario.expectedEvidence) || scenario.expectedEvidence.length === 0) {
    errors.push("expectedEvidence must be a non-empty array");
  }

  if (!scenario.execution || typeof scenario.execution !== "object" || Array.isArray(scenario.execution)) {
    errors.push("execution must be an object");
  } else if (!EXECUTION_KIND_SET.has(scenario.execution.kind)) {
    errors.push(`execution.kind must be one of: ${REAL_WORLD_EXECUTION_KINDS.join(", ")}`);
  }

  if (scenario.suites !== undefined) {
    const invalidSuites = uniqueStrings(scenario.suites).filter((suite) => !SUITE_SET.has(suite));
    if (invalidSuites.length > 0) {
      errors.push(`invalid suites: ${invalidSuites.join(", ")}`);
    }
  }

  for (const key of ["preconditions", "cleanup", "tags"]) {
    if (scenario[key] !== undefined && !Array.isArray(scenario[key])) {
      errors.push(`${key} must be an array when provided`);
    }
  }

  if (scenario.providerLane !== "none" && typeof scenario.realWorldPrompt !== "string" && scenario.execution.kind === "agent_run") {
    errors.push("agent_run scenarios that use providers must define realWorldPrompt");
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function validateCatalog(scenarios) {
  const errors = [];
  const ids = new Set();
  for (const scenario of scenarios) {
    const result = validateScenario(scenario);
    if (!result.ok) {
      for (const error of result.errors) {
        errors.push(`${scenario?.id ?? "<unknown>"}: ${error}`);
      }
    }
    if (typeof scenario?.id === "string") {
      if (ids.has(scenario.id)) {
        errors.push(`${scenario.id}: duplicate scenario id`);
      }
      ids.add(scenario.id);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function scenarioSupportsSuite(scenario, suite) {
  if (!scenario.suites || scenario.suites.length === 0) {
    return SUITE_SET.has(suite);
  }
  return scenario.suites.includes(suite);
}

export function resolveScenarioRepetitions(scenario, suite, overrideRepetitions) {
  if (Number.isInteger(overrideRepetitions) && overrideRepetitions > 0) {
    return overrideRepetitions;
  }
  const fromScenario = Number(scenario.repeatProfile?.[suite]);
  if (Number.isInteger(fromScenario) && fromScenario > 0) {
    return fromScenario;
  }
  return SUITE_PROFILES[suite]?.defaultRepetitions ?? 1;
}

export function isResultValue(value) {
  return RESULT_VALUE_SET.has(value);
}

export function classifyDefectBucket({ failureClass, misrouteClass, toolErrors = [] }) {
  if (misrouteClass || failureClass === "llm_misroute" || failureClass === "llm_behavior" || failureClass === "ui_misroute") {
    return "intent/routing";
  }
  if (failureClass === "provider_protocol" || failureClass === "generator") {
    return "provider/protocol";
  }
  if (failureClass === "ui_loading" || failureClass === "http_contract") {
    return "UI/data loading";
  }
  if (failureClass === "tool_bridge" || toolErrors.length > 0) {
    return "tool bridge";
  }
  if (failureClass === "self_healing" || failureClass === "learning_evidence") {
    return "self-healing/learning evidence";
  }
  if (failureClass === "distributed_recovery") {
    return "distributed/channel recovery";
  }
  return "environment/setup";
}
