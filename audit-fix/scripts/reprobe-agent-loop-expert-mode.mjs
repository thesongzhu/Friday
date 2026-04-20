import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3241";
const dbPath = process.env.DB_PATH;
const outDir = process.env.OUT_DIR;

if (!dbPath) {
  throw new Error("DB_PATH is required");
}

if (!outDir) {
  throw new Error("OUT_DIR is required");
}

const db = new Database(dbPath, { readonly: true });

async function resetDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

async function writeJson(name, value) {
  await fs.writeFile(path.join(outDir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function redactHeaders(headers = {}) {
  return {
    ...headers,
    authorization: headers.authorization ? "Bearer <redacted>" : undefined,
  };
}

function redactTokens(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redactTokens(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        if (key === "accessToken" || key === "refreshToken") {
          return [key, "<redacted>"];
        }
        return [key, redactTokens(entry)];
      }),
    );
  }
  return value;
}

async function apiRequest(method, pathname, body, token) {
  const url = `${baseUrl}${pathname}`;
  const headers = {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
  });
  const responseBody = await response.json().catch(() => null);
  return {
    rawBody: responseBody,
    request: {
      method,
      url,
      headers: redactHeaders(headers),
      body: body ?? null,
    },
    response: {
      status: response.status,
      body: redactTokens(responseBody),
    },
  };
}

function dbGet(sql, ...params) {
  return db.prepare(sql).get(...params) ?? null;
}

function normalizePolicyRow(row) {
  if (!row) {
    return null;
  }
  const { updated_at, ...rest } = row;
  return rest;
}

function expertModePatchFromSummary(summary) {
  return {
    enabled: summary.enabled,
    allowedUserIds: summary.allowedUserIds,
    allowedWorkspaceIds: summary.allowedWorkspaceIds,
    allowedEnvironments: summary.allowedEnvironments,
    contextInferenceAllowed: summary.contextInferenceAllowed,
    multiStepHypothesisSearchAllowed: summary.multiStepHypothesisSearchAllowed,
    safeProbeExecutionAllowed: summary.safeProbeExecutionAllowed,
    crossSurfaceOrchestrationAllowed: summary.crossSurfaceOrchestrationAllowed,
    highRiskFinalApprovalRequired: summary.highRiskFinalApprovalRequired,
    productionDestructiveActionApprovalRequired: summary.productionDestructiveActionApprovalRequired,
    probeBudget: summary.probeBudget,
    timeBudgetMinutes: summary.timeBudgetMinutes,
  };
}

await resetDir(outDir);

const login = await apiRequest("POST", "/v1/auth/login", { local: true }, null);
await writeJson("login.json", login);

const token = login.rawBody?.data?.accessToken;
if (typeof token !== "string" || token.length === 0) {
  throw new Error("Failed to obtain access token from /v1/auth/login");
}

const initialGet = await apiRequest("GET", "/v1/agent-loop/expert-mode", null, token);
await writeJson("expert-mode-initial.json", initialGet);

const initialDb = dbGet(
  `SELECT id, expert_mode_enabled, expert_mode_user_ids_json, expert_mode_workspace_ids_json,
          expert_mode_environments_json, context_inference_allowed,
          multi_step_hypothesis_search_allowed, safe_probe_execution_allowed,
          cross_surface_orchestration_allowed, high_risk_final_approval_required,
          production_destructive_action_approval_required, probe_budget, time_budget_minutes,
          updated_at
   FROM friday_agent_loop_policy
   WHERE id = 'default'`,
);
await writeJson("expert-mode-initial-db.json", initialDb);

const invalidUpdate = await apiRequest(
  "PUT",
  "/v1/agent-loop/expert-mode",
  {
    enabled: true,
    probeBudget: 0,
  },
  token,
);
await writeJson("expert-mode-invalid-update.json", invalidUpdate);

const afterInvalidGet = await apiRequest("GET", "/v1/agent-loop/expert-mode", null, token);
await writeJson("expert-mode-after-invalid.json", afterInvalidGet);

const afterInvalidDb = dbGet(
  `SELECT id, expert_mode_enabled, expert_mode_user_ids_json, expert_mode_workspace_ids_json,
          expert_mode_environments_json, context_inference_allowed,
          multi_step_hypothesis_search_allowed, safe_probe_execution_allowed,
          cross_surface_orchestration_allowed, high_risk_final_approval_required,
          production_destructive_action_approval_required, probe_budget, time_budget_minutes,
          updated_at
   FROM friday_agent_loop_policy
   WHERE id = 'default'`,
);
await writeJson("expert-mode-after-invalid-db.json", afterInvalidDb);

const validUpdate = await apiRequest(
  "PUT",
  "/v1/agent-loop/expert-mode",
  {
    enabled: true,
    probeBudget: 6,
    timeBudgetMinutes: 25,
  },
  token,
);
await writeJson("expert-mode-valid-update.json", validUpdate);

const afterValidGet = await apiRequest("GET", "/v1/agent-loop/expert-mode", null, token);
await writeJson("expert-mode-after-valid.json", afterValidGet);

const afterValidDb = dbGet(
  `SELECT id, expert_mode_enabled, expert_mode_user_ids_json, expert_mode_workspace_ids_json,
          expert_mode_environments_json, context_inference_allowed,
          multi_step_hypothesis_search_allowed, safe_probe_execution_allowed,
          cross_surface_orchestration_allowed, high_risk_final_approval_required,
          production_destructive_action_approval_required, probe_budget, time_budget_minutes,
          updated_at
   FROM friday_agent_loop_policy
   WHERE id = 'default'`,
);
await writeJson("expert-mode-after-valid-db.json", afterValidDb);

const initialSummary = initialGet.rawBody?.data?.expertMode;
if (!initialSummary) {
  throw new Error("Failed to read initial expert mode summary");
}

const revertUpdate = await apiRequest(
  "PUT",
  "/v1/agent-loop/expert-mode",
  expertModePatchFromSummary(initialSummary),
  token,
);
await writeJson("expert-mode-revert-update.json", revertUpdate);

const finalGet = await apiRequest("GET", "/v1/agent-loop/expert-mode", null, token);
await writeJson("expert-mode-final.json", finalGet);

const finalDb = dbGet(
  `SELECT id, expert_mode_enabled, expert_mode_user_ids_json, expert_mode_workspace_ids_json,
          expert_mode_environments_json, context_inference_allowed,
          multi_step_hypothesis_search_allowed, safe_probe_execution_allowed,
          cross_surface_orchestration_allowed, high_risk_final_approval_required,
          production_destructive_action_approval_required, probe_budget, time_budget_minutes,
          updated_at
   FROM friday_agent_loop_policy
   WHERE id = 'default'`,
);
await writeJson("expert-mode-final-db.json", finalDb);

await writeJson("agent-loop-expert-mode-summary.json", {
  invalidUpdateStatus: invalidUpdate.response.status,
  invalidUpdateErrorCode: invalidUpdate.response.body?.error?.code ?? null,
  invalidDbUnchanged:
    JSON.stringify(normalizePolicyRow(initialDb)) === JSON.stringify(normalizePolicyRow(afterInvalidDb)),
  invalidResponseUnchanged:
    JSON.stringify(initialGet.rawBody?.data?.expertMode ?? null)
    === JSON.stringify(afterInvalidGet.rawBody?.data?.expertMode ?? null),
  validUpdateStatus: validUpdate.response.status,
  validUpdatedProbeBudget: afterValidGet.rawBody?.data?.expertMode?.probeBudget ?? null,
  validUpdatedTimeBudgetMinutes: afterValidGet.rawBody?.data?.expertMode?.timeBudgetMinutes ?? null,
  revertedToInitial:
    JSON.stringify(initialGet.rawBody?.data?.expertMode ?? null)
    === JSON.stringify(finalGet.rawBody?.data?.expertMode ?? null)
    && JSON.stringify(normalizePolicyRow(initialDb)) !== JSON.stringify(normalizePolicyRow(afterValidDb))
    && JSON.stringify(normalizePolicyRow(initialDb)) === JSON.stringify(normalizePolicyRow(finalDb)),
});

db.close();
