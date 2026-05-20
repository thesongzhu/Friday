import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { ensureDir } from "./io.mjs";
import { resolveJsonPath, safeJsonParse, slugify, stripMarkdownFences } from "./defs.mjs";
import {
  buildSkillImportStageApprovalRequest,
  buildSkillLifecycleApprovalRequest,
  buildSkillUpgradeDecideApprovalRequest,
  signCanonicalApprovalForRequest,
} from "./skill-upgrade-approval.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function preview(value, max = 400) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function normalizeHeadingText(value) {
  return String(value)
    .replace(/<[^>]+>/gu, " ")
    .replace(/^#+\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function extractTopWorkspaceHeading(markdownText) {
  if (typeof markdownText !== "string" || markdownText.trim().length === 0) {
    return null;
  }
  const htmlHeadingMatch = markdownText.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/iu);
  if (htmlHeadingMatch?.[1]) {
    return normalizeHeadingText(htmlHeadingMatch[1]);
  }
  const markdownHeading = markdownText
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => /^#\s+\S+/u.test(entry));
  return markdownHeading ? normalizeHeadingText(markdownHeading) : null;
}

async function readAgentToolCalls(runRecord) {
  const artifactDir = typeof runRecord?.artifactDir === "string" ? runRecord.artifactDir.trim() : "";
  if (!artifactDir) {
    return [];
  }
  const toolCallsPath = path.join(artifactDir, "tool-calls.json");
  try {
    const raw = await fs.readFile(toolCallsPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function pathExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

const AWAITING_HUMAN_STATUSES = new Set(["awaiting_clarification", "awaiting_plan_approval"]);

function isExpectedAwaitingHumanStatus({ scenario, runRecord }) {
  if (scenario.oracles?.behavior?.requireAwaitingHumanState !== true) {
    return false;
  }
  return AWAITING_HUMAN_STATUSES.has(runRecord?.status)
    || AWAITING_HUMAN_STATUSES.has(runRecord?.planReview?.gate?.state);
}

function outputShapeForToolResult(content) {
  if (typeof content !== "string") {
    return typeof content;
  }
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return "empty";
  }
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return "json-like";
  }
  if (trimmed.includes("\n")) {
    return "multiline-text";
  }
  return "text";
}

function sanitizeToolEvidence({ toolCalls, expectedHeading, expectedPath }) {
  const expectedPathLower = typeof expectedPath === "string" ? expectedPath.toLowerCase() : "";
  return toolCalls.map((call, index) => {
    const argKeys = call?.args && typeof call.args === "object" ? Object.keys(call.args).sort() : [];
    const rawPath = typeof call?.args?.path === "string" ? call.args.path : undefined;
    const relativePath = call?.toolName === "read" && rawPath
      ? rawPath.replace(/\\/g, "/").replace(/^\/+/, "")
      : undefined;
    const content = typeof call?.result?.content === "string" ? call.result.content : "";
    const resultLengthChars = content.length;
    const expectedHeadingHit = Boolean(
      call?.toolName === "read"
      && !call?.result?.isError
      && expectedHeading
      && content.includes(expectedHeading),
    );
    return {
      index,
      toolName: String(call?.toolName ?? "unknown"),
      isError: Boolean(call?.result?.isError),
      argKeys,
      relativePath,
      resultLengthChars,
      outputShape: outputShapeForToolResult(content),
      matchesExpectedPath: Boolean(
        relativePath
        && expectedPathLower
        && (
          relativePath.toLowerCase() === expectedPathLower
          || relativePath.toLowerCase().endsWith(`/${expectedPathLower}`)
        ),
      ),
      matchesExpectedHeading: expectedHeadingHit,
    };
  });
}

function getUrlPath(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  try {
    return new URL(value).pathname;
  } catch {
    return value;
  }
}

function parseUiRequestFailure(message) {
  if (typeof message !== "string" || message.length === 0) return null;
  const match = message.match(/^([A-Z]+)\s+(\S+)\s+::\s+(.+)$/u);
  if (!match) {
    return null;
  }
  const [, method, url, errorText] = match;
  return {
    method,
    url,
    errorText,
    pathname: getUrlPath(url),
  };
}

function isIgnorableUiRequestFailure(message) {
  if (typeof message !== "string" || message.length === 0) return false;
  if (/fonts\.(gstatic|googleapis)\.com/i.test(message) && /ERR_ABORTED/i.test(message)) {
    return true;
  }
  const parsed = parseUiRequestFailure(message);
  if (!parsed) {
    return false;
  }
  if (!/ERR_ABORTED/i.test(parsed.errorText)) {
    return false;
  }
  return parsed.method === "GET" && parsed.pathname.startsWith("/v1/");
}

function parseUiResponseError(message) {
  if (typeof message !== "string" || message.length === 0) return null;
  const match = message.match(/^(\d{3})\s+(\S+)$/u);
  if (!match) {
    return null;
  }
  return {
    status: Number.parseInt(match[1], 10),
    url: match[2],
    pathname: getUrlPath(match[2]),
  };
}

function isIgnorableUiResponseError(message) {
  const parsed = parseUiResponseError(message);
  if (!parsed) {
    return false;
  }
  return parsed.status === 400 && parsed.pathname === "/v1/providers/routing/explain";
}

function isIgnorableUiConsoleError(message, responseErrors = []) {
  if (typeof message !== "string" || message.length === 0) return false;
  if (/status of 401 \(Unauthorized\)/i.test(message)) {
    return true;
  }
  if (/status of 400 \(Bad Request\)/i.test(message)) {
    const hasResponseErrors = responseErrors.length > 0;
    const allResponseErrorsIgnorable = responseErrors.every((entry) => isIgnorableUiResponseError(entry));
    return hasResponseErrors && allResponseErrorsIgnorable;
  }
  return false;
}

function isRetryableUiProbeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /this operation was aborted/i.test(message);
}

function isLoginPath(value) {
  return getUrlPath(value) === "/login";
}

function scenarioTimeout(scenario, fallback) {
  return Number(scenario.execution?.timeoutMs) || fallback;
}

let sharedUiProbeSession = null;

async function getSharedUiProbeSession(uiBaseUrl) {
  if (sharedUiProbeSession?.uiBaseUrl === uiBaseUrl) {
    const context = await sharedUiProbeSession.browser.newContext({
      baseURL: uiBaseUrl,
      viewport: { width: 1440, height: 960 },
    });
    return {
      ...sharedUiProbeSession,
      context,
    };
  }
  if (sharedUiProbeSession?.browser) {
    await sharedUiProbeSession.browser.close().catch(() => undefined);
  }
  const browser = await chromium.launch({ headless: true });
  sharedUiProbeSession = {
    uiBaseUrl,
    browser,
  };
  const context = await browser.newContext({
    baseURL: uiBaseUrl,
    viewport: { width: 1440, height: 960 },
  });
  return {
    ...sharedUiProbeSession,
    context,
  };
}

export async function closeSharedUiProbeSession() {
  if (!sharedUiProbeSession?.browser) {
    return;
  }
  await sharedUiProbeSession.browser.close().catch(() => undefined);
  sharedUiProbeSession = null;
}

async function completeUiLoginIfNeeded({ page, client, execution, artifact, timeoutMs }) {
  if (!isLoginPath(page.url())) {
    return;
  }
  const requestedPath = getUrlPath(execution.path);
  if (typeof client?.localPassphrase === "string" && client.localPassphrase.trim().length > 0) {
    await page.locator("#login-local-passphrase").fill(client.localPassphrase.trim());
    await Promise.all([
      page.waitForURL((url) => !isLoginPath(url.toString()), { timeout: timeoutMs }),
      page.getByRole("button", { name: /continue locally/i }).click(),
    ]);
    artifact.observedEvidence.push(`completed real browser local-passphrase login for ${requestedPath}`);
    return;
  }
  if (
    typeof client?.email === "string" && client.email.trim().length > 0
    && typeof client?.password === "string" && client.password.trim().length > 0 // pragma: allowlist secret
  ) {
    await page.locator("#login-email").fill(client.email.trim());
    await page.locator("#login-password").fill(client.password.trim());
    await Promise.all([
      page.waitForURL((url) => !isLoginPath(url.toString()), { timeout: timeoutMs }),
      page.getByRole("button", { name: /sign in/i }).click(),
    ]);
    artifact.observedEvidence.push(`completed real browser email/password login for ${requestedPath}`);
    return;
  }
  throw new Error(
    "UI probe landed on /login but no real browser login credential was available. Provide localPassphrase or email/password for proof runs.",
  );
}

async function seedUiAuthStorageIfAvailable({ context, client, artifact }) {
  const accessToken = typeof client?.accessToken === "string" ? client.accessToken.trim() : "";
  const refreshToken = typeof client?.refreshToken === "string" ? client.refreshToken.trim() : "";
  if (accessToken.length === 0) {
    return false;
  }
  await context.addInitScript(
    ({ accessToken: seededAccessToken, refreshToken: seededRefreshToken, user }) => {
      window.localStorage.setItem("friday.auth.accessToken", seededAccessToken);
      if (seededRefreshToken) {
        window.localStorage.setItem("friday.auth.refreshToken", seededRefreshToken);
      }
      if (user) {
        window.localStorage.setItem("friday.auth.user", JSON.stringify(user));
      }
    },
    {
      accessToken,
      refreshToken,
      user: client.user ?? null,
    },
  );
  artifact.observedEvidence.push("seeded browser auth storage from validation login session");
  return true;
}

async function settleAndCompleteUiLoginIfNeeded({ page, client, execution, artifact, timeoutMs }) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.waitForTimeout(Math.min(750, Math.max(150, Math.floor(timeoutMs / 20))));
    if (!isLoginPath(page.url())) {
      continue;
    }
    await completeUiLoginIfNeeded({ page, client, execution, artifact, timeoutMs });
    return;
  }
}

function interpolateTemplateString(value, context) {
  const exactMatch = value.match(/^\{\{\s*([^}]+?)\s*\}\}$/u);
  if (exactMatch) {
    return resolveJsonPath(context, exactMatch[1]);
  }
  return value.replace(/\{\{\s*([^}]+?)\s*\}\}/gu, (_, templatePath) => {
    const resolved = resolveJsonPath(context, templatePath);
    if (resolved === undefined || resolved === null) {
      return "";
    }
    return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
  });
}

function interpolateTemplateValue(value, context) {
  if (typeof value === "string") {
    return interpolateTemplateString(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => interpolateTemplateValue(entry, context));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, interpolateTemplateValue(entry, context)]),
    );
  }
  return value;
}

function buildValidationSessionKey({ scenario, execution, attemptIndex }) {
  const channel = slugify(execution.sessionChannel ?? "validation") || "validation";
  const accountId = slugify(execution.sessionAccountId ?? "real-world") || "real-world";
  const sessionBase = slugify(execution.sessionKeyPrefix ?? scenario.id) || "session";
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const chatId = slugify(`${sessionBase}-${attemptIndex ?? 1}-${suffix}`).slice(0, 128) || "session";
  return `${channel}:${accountId}:${chatId}`;
}

function buildArtifactBase({ runId, suite, scenario, lane }) {
  return {
    runId,
    scenarioId: scenario.id,
    suite,
    lane: lane.laneKey,
    surface: scenario.entrySurface,
    result: "failed",
    expectedEvidence: scenario.expectedEvidence,
    observedEvidence: [],
    metrics: {},
    screenshots: [],
    eventLog: [],
    traceRefs: [],
    auditRefs: [],
    humanReviewRequired: false,
    severity: scenario.severityOnFailure ?? "P2",
    raw: {
      lane,
    },
  };
}

function applyJsonExpectations({ artifact, response, execution }) {
  const reasons = [];
  let passed = true;
  const json = response.json;
  if (Number.isInteger(execution.expectStatus) && response.status !== execution.expectStatus) {
    passed = false;
    reasons.push(`expected HTTP ${String(execution.expectStatus)} but received ${String(response.status)}`);
  }
  if (execution.expectOkEnvelope && json?.ok !== true) {
    passed = false;
    reasons.push("expected ok=true envelope");
  }
  for (const path of execution.jsonPathsPresent ?? []) {
    if (resolveJsonPath(json, path) === undefined) {
      passed = false;
      reasons.push(`missing JSON path: ${path}`);
    }
  }
  for (const [jsonPath, expected] of Object.entries(execution.jsonPathsEqual ?? {})) {
    const actual = resolveJsonPath(json, jsonPath);
    if (actual !== expected) {
      passed = false;
      reasons.push(`JSON path ${jsonPath} expected ${JSON.stringify(expected)} but received ${JSON.stringify(actual)}`);
    }
  }
  artifact.observedEvidence.push(
    `HTTP ${String(response.status)} ${execution.method ?? "GET"} ${execution.path}`,
    `duration ${String(response.durationMs)}ms`,
  );
  artifact.metrics = {
    ...(artifact.metrics ?? {}),
    durationMs: response.durationMs,
    responseBytes: response.text?.length ?? 0,
  };
  artifact.raw = {
    ...(artifact.raw ?? {}),
    response,
    bodyText: response.text,
  };
  if (!passed) {
    artifact.result = "failed";
    artifact.failureClass = "http_contract";
    artifact.notes = [...(artifact.notes ?? []), ...reasons];
  } else {
    artifact.result = "passed";
  }
}

async function executeEnvTruth({ artifact, scenario, envTruth }) {
  const checks = scenario.execution.checks ?? [];
  const notes = [];
  let passed = true;
  for (const check of checks) {
    const value = resolveJsonPath(envTruth, check.path);
    const hasEquals = Object.prototype.hasOwnProperty.call(check, "equals");
    const hasNotEquals = Object.prototype.hasOwnProperty.call(check, "notEquals");
    const hasExists = Object.prototype.hasOwnProperty.call(check, "exists");
    const hasAbsent = Object.prototype.hasOwnProperty.call(check, "absent");
    let ok;
    let expectationLabel;
    if (hasEquals) {
      ok = value === check.equals;
      expectationLabel = JSON.stringify(check.equals);
    } else if (hasNotEquals) {
      ok = value !== check.notEquals;
      expectationLabel = `not ${JSON.stringify(check.notEquals)}`;
    } else if (hasExists) {
      ok = check.exists === true ? value !== undefined : value === undefined;
      expectationLabel = check.exists === true ? "present" : "absent";
    } else if (hasAbsent) {
      ok = check.absent === true ? value === undefined || value === null : value !== undefined && value !== null;
      expectationLabel = check.absent === true ? "absent/null" : "present";
    } else {
      ok = value !== undefined;
      expectationLabel = "present";
    }
    artifact.observedEvidence.push(`${check.label ?? check.path}: ${JSON.stringify(value)}`);
    if (!ok) {
      passed = false;
      notes.push(`${check.label ?? check.path} expected ${expectationLabel} but received ${JSON.stringify(value)}`);
    }
  }
  artifact.raw = { ...(artifact.raw ?? {}), envTruth };
  const failureResult = scenario.execution.failureResult ?? "blocked";
  artifact.result = passed ? "passed" : failureResult;
  artifact.failureClass = passed
    ? undefined
    : (scenario.execution.failureClass ?? (failureResult === "blocked" ? "environment" : "ui_misroute"));
  artifact.notes = [...(artifact.notes ?? []), ...notes];
  return artifact;
}

function resolveAgentTurnPrompt({ scenario, execution, suite, attemptIndex, turn, turnIndex, templateContext }) {
  const applyPromptVariables = (value) => {
    if (typeof value !== "string" || value.length === 0) {
      return value;
    }
    const expanded = value
      .replaceAll("{{repoRoot}}", process.cwd())
      .replaceAll("{{workspaceRoot}}", process.cwd());
    return templateContext
      ? interpolateTemplateString(expanded, templateContext)
      : expanded;
  };
  if (typeof turn?.prompt === "string" && turn.prompt.trim().length > 0) {
    return applyPromptVariables(turn.prompt);
  }
  const bySuite = execution.promptVariantsBySuite?.[suite];
  if (Array.isArray(bySuite) && bySuite.length > 0) {
    const index = Math.max(0, ((attemptIndex ?? 1) - 1 + turnIndex) % bySuite.length);
    return applyPromptVariables(bySuite[index]);
  }
  if (Array.isArray(execution.promptVariants) && execution.promptVariants.length > 0) {
    const index = Math.max(0, ((attemptIndex ?? 1) - 1 + turnIndex) % execution.promptVariants.length);
    return applyPromptVariables(execution.promptVariants[index]);
  }
  return applyPromptVariables(scenario.realWorldPrompt);
}

async function executeHttpProbe({ artifact, client, scenario }) {
  const execution = scenario.execution;
  const templateContext = {
    scenario: {
      id: scenario.id,
      entrySurface: scenario.entrySurface,
    },
    timestamp: String(Date.now()),
    nowIso: nowIso(),
  };
  const requestPath = interpolateTemplateValue(execution.path, templateContext);
  const query = execution.query
    ? `?${new URLSearchParams(
      Object.entries(execution.query).reduce((acc, [key, value]) => {
        acc[key] = String(value);
        return acc;
      }, {}),
    ).toString()}`
    : "";
  const requestBody = execution.body === undefined
    ? undefined
    : interpolateTemplateValue(execution.body, templateContext);
  const response = await client.request(execution.method ?? "GET", `${requestPath}${query}`, {
    timeoutMs: scenarioTimeout(scenario, 60_000),
    headers: execution.headers,
    body: requestBody,
  });
  applyJsonExpectations({ artifact, response, execution });
  artifact.raw = {
    ...(artifact.raw ?? {}),
    request: {
      method: execution.method ?? "GET",
      path: requestPath,
      query: execution.query ?? null,
      body: requestBody ?? null,
    },
  };
  if (response.ok && Array.isArray(execution.cleanupRequests) && execution.cleanupRequests.length > 0) {
    const cleanupContext = {
      ...templateContext,
      response: response.json ?? response.text ?? null,
    };
    const cleanupResults = [];
    for (const cleanup of execution.cleanupRequests) {
      const cleanupPath = interpolateTemplateValue(cleanup.path, cleanupContext);
      const cleanupBody = cleanup.body === undefined
        ? undefined
        : interpolateTemplateValue(cleanup.body, cleanupContext);
      const cleanupResponse = await client.request(cleanup.method ?? "GET", cleanupPath, {
        timeoutMs: scenarioTimeout(scenario, 30_000),
        headers: cleanup.headers,
        body: cleanupBody,
      });
      cleanupResults.push({
        method: cleanup.method ?? "GET",
        path: cleanupPath,
        status: cleanupResponse.status,
        ok: cleanupResponse.ok,
      });
      artifact.observedEvidence.push(
        `cleanup ${cleanup.method ?? "GET"} ${cleanupPath} -> ${String(cleanupResponse.status)}`,
      );
    }
    artifact.raw = {
      ...(artifact.raw ?? {}),
      cleanupResults,
    };
  }
  const statusAsExpected = Number.isInteger(execution.expectStatus) && response.status === execution.expectStatus;
  if (!response.ok && !statusAsExpected && artifact.result !== "failed") {
    artifact.result = "failed";
    artifact.failureClass = "http_contract";
  }
  return artifact;
}

async function executeTemplatedRequests({
  artifact,
  client,
  scenario,
  requests,
  templateContext,
  label,
  throwOnExpectationFailure = true,
}) {
  if (!Array.isArray(requests) || requests.length === 0) {
    return [];
  }
  const responses = [];
  for (const [index, request] of requests.entries()) {
    const requestContext = {
      ...templateContext,
      responses,
    };
    const requestPath = interpolateTemplateValue(request.path, requestContext);
    const query = request.query
      ? `?${new URLSearchParams(
        Object.entries(request.query).reduce((acc, [key, value]) => {
          acc[key] = String(interpolateTemplateValue(value, requestContext));
          return acc;
        }, {}),
      ).toString()}`
      : "";
    const requestBody = request.body === undefined
      ? undefined
      : interpolateTemplateValue(request.body, requestContext);
    const response = await client.request(request.method ?? "GET", `${requestPath}${query}`, {
      timeoutMs: scenarioTimeout(scenario, 60_000),
      headers: request.headers,
      body: requestBody,
    });
    const record = {
      method: request.method ?? "GET",
      path: requestPath,
      status: response.status,
      ok: response.ok,
      json: response.json ?? null,
      text: response.text ?? null,
      durationMs: response.durationMs,
    };
    artifact.observedEvidence.push(
      `${label} ${String(index + 1)} ${record.method} ${requestPath} -> ${String(response.status)}`,
    );

    const reasons = [];
    if (Number.isInteger(request.expectStatus) && response.status !== request.expectStatus) {
      reasons.push(`expected HTTP ${String(request.expectStatus)} but received ${String(response.status)}`);
    }
    if (request.expectOkEnvelope && response.json?.ok !== true) {
      reasons.push("expected ok=true envelope");
    }
    for (const path of request.jsonPathsPresent ?? []) {
      if (resolveJsonPath(response.json, path) === undefined) {
        reasons.push(`missing JSON path: ${path}`);
      }
    }
    if (reasons.length > 0) {
      record.expectationFailures = reasons;
    }
    responses.push(record);
    if (reasons.length > 0) {
      const message = `${label} request ${String(index + 1)} failed expectations: ${reasons.join("; ")}`;
      if (throwOnExpectationFailure) {
        throw new Error(message);
      }
      artifact.notes = [...(artifact.notes ?? []), message];
    }
  }
  return responses;
}

// Phase 14.5B module_28b: live-HTTP RGG proof that all five /v1/auto-fix
// mutating routes refuse the synthetic public principal with HTTP 401 and
// the OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED error code. This executor
// makes real network calls against the hub HTTP layer without injecting an
// Authorization header (skipAuth: true), so the server resolves to the
// synthetic public principal and the bound-principal gate fires inside the
// real route handlers — no mocks. Service-layer no-patch repair-claim
// refusal and channel/session-text preview-only behavior are proven by the
// integration acceptance test and the deterministic-dispatch unit test
// respectively; that explicit scope split is recorded in the scenario
// expectedEvidence so reviewers can verify there is no proof overclaim.
export const AUTO_FIX_DOCTOR_PROBE_ACTION_ID = "rgg-phase-14-5b-doctor-probe-action";
export const AUTO_FIX_DOCTOR_BOUND_PRINCIPAL_ERROR_CODE = "OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED";

export const AUTO_FIX_DOCTOR_ROUTES = Object.freeze([
  Object.freeze({
    operationId: "autofix.actions.run.ready",
    method: "POST",
    path: "/v1/auto-fix/actions/run-ready",
    body: {},
  }),
  Object.freeze({
    operationId: "autofix.actions.approve",
    method: "POST",
    path: `/v1/auto-fix/actions/${AUTO_FIX_DOCTOR_PROBE_ACTION_ID}/approve`,
    body: {},
  }),
  Object.freeze({
    operationId: "autofix.actions.deny",
    method: "POST",
    path: `/v1/auto-fix/actions/${AUTO_FIX_DOCTOR_PROBE_ACTION_ID}/deny`,
    body: {},
  }),
  Object.freeze({
    operationId: "autofix.actions.execute",
    method: "POST",
    path: `/v1/auto-fix/actions/${AUTO_FIX_DOCTOR_PROBE_ACTION_ID}/execute`,
    body: {},
  }),
  Object.freeze({
    operationId: "autofix.actions.rollback",
    method: "POST",
    path: `/v1/auto-fix/actions/${AUTO_FIX_DOCTOR_PROBE_ACTION_ID}/rollback`,
    body: { reason: "rgg-phase-14-5b-doctor-probe" },
  }),
]);

// Phase 14.5C module_28c: same-SHA RGG vehicle for the workflow evidence
// fail-closed contract. The executor stages an isolated in-memory SQLite
// database (created fresh per run), applies the canonical Friday migration
// stack including v086, drops the `workflow_run_pipeline_events` table to
// simulate live evidence-store unreachability, then drives the real workflow
// runtime and the real task-workflow service in-process — with no mocks of
// the workflow runtime, evidence repository, task-workflow repository, or
// task-workflow service — and asserts the four behaviors named by the Stage
// 2 scope reconciliation matrix:
//   * proof-required run fails closed (run-level evidence status flips off
//     of "available" once the first pipeline-event write would have hit the
//     missing table);
//   * ordinary run continues but its evidence status honestly resolves to
//     "degraded"/"unavailable", so the receipt cannot claim proof;
//   * verifyClaim refuses any `workflow_run_evidence` ref whose source run
//     reports non-available status with HTTP 409
//     TASK_WORKFLOW_CLAIM_WORKFLOW_RUN_EVIDENCE_UNAVAILABLE;
//   * closeout receipt populates `evidenceDurability` + `proofClaimable`
//     and the new `workflow_run_evidence_durable` required gate passes on
//     the healthy path.
// The runtime, state, errors, and task-workflows modules are loaded lazily
// from the compiled dist/ tree so other RGG scenarios are unaffected when
// this executor is not in play; a missing build is reported as blocked
// (failureClass=environment) rather than silently degrading the proof.
const WORKFLOW_EVIDENCE_FAIL_CLOSED_DROPPED_TABLE = "workflow_run_pipeline_events";
const WORKFLOW_EVIDENCE_FAIL_CLOSED_NOW = "2026-05-17T00:00:00.000Z";
const WORKFLOW_EVIDENCE_FAIL_CLOSED_WAIT_MS = 150;
const WORKFLOW_EVIDENCE_FAIL_CLOSED_SETTLE_POLL_MS = 20;
const WORKFLOW_EVIDENCE_FAIL_CLOSED_SETTLE_MAX_TRIES = 250;

async function waitForWorkflowRunSettled(runtime, runId) {
  const terminal = new Set(["completed", "failed", "cancelled"]);
  for (let i = 0; i < WORKFLOW_EVIDENCE_FAIL_CLOSED_SETTLE_MAX_TRIES; i += 1) {
    const run = runtime.execution.getRun(runId);
    if (run && terminal.has(run.status)) {
      return run;
    }
    await sleep(WORKFLOW_EVIDENCE_FAIL_CLOSED_SETTLE_POLL_MS);
  }
  return null;
}

async function loadWorkflowEvidenceFailClosedModules() {
  // Lazy import so the executors module does not require a built dist/
  // tree for unrelated scenarios; a missing build surfaces as a single
  // honest blocker on this scenario instead of breaking the catalog load.
  const repoRoot = process.cwd();
  const taskWorkflowsUrl = new URL(
    `file://${repoRoot}/dist/task-workflows/index.js`,
  ).href;
  const [
    betterSqlite3Module,
    workflowsModule,
    stateModule,
    errorsModule,
    taskWorkflowsModule,
  ] = await Promise.all([
    import("better-sqlite3"),
    import("#workflows"),
    import("#state"),
    import("#errors"),
    import(taskWorkflowsUrl),
  ]);
  return {
    Database: betterSqlite3Module.default,
    createFridayWorkflowRuntime: workflowsModule.createFridayWorkflowRuntime,
    runFridayMigrations: stateModule.runFridayMigrations,
    FRIDAY_SQLITE_MIGRATIONS: stateModule.FRIDAY_SQLITE_MIGRATIONS,
    FridayDomainError: errorsModule.FridayDomainError,
    createFridayTaskWorkflowRepository:
      taskWorkflowsModule.createFridayTaskWorkflowRepository,
    createFridayTaskWorkflowService:
      taskWorkflowsModule.createFridayTaskWorkflowService,
  };
}

function createWorkflowEvidenceFailClosedDb({ Database, runFridayMigrations, FRIDAY_SQLITE_MIGRATIONS }) {
  const writer = new Database(":memory:");
  runFridayMigrations({ db: writer, migrations: FRIDAY_SQLITE_MIGRATIONS });
  writer
    .prepare(
      `INSERT OR IGNORE INTO users (id, display_name, role, is_local_only, created_at, updated_at)
       VALUES ('rgg-evidence-fail-closed', 'RGG Evidence Fail Closed', 'admin', 1, ?, ?)`,
    )
    .run(WORKFLOW_EVIDENCE_FAIL_CLOSED_NOW, WORKFLOW_EVIDENCE_FAIL_CLOSED_NOW);
  return {
    dbPath: ":memory:",
    writer,
    reads: {
      size: 1,
      withReadConnection(fn) {
        return fn(writer);
      },
      close() {},
    },
    withWriteTransaction(fn) {
      return writer.transaction(() => fn(writer))();
    },
    withReadConnection(fn) {
      return fn(writer);
    },
    checkpoint() {},
    optimize() {},
    close() {
      writer.close();
    },
  };
}

function makeWorkflowEvidenceFailClosedGraph(workflowId, versionId) {
  return {
    schemaVersion: "2.0",
    workflowId,
    workflowVersionId: versionId,
    sourceSpecSchemaVersion: "1.0",
    graph: {
      nodes: [
        { id: "trigger", type: "trigger", label: "Trigger", config: {} },
        {
          id: "action-success",
          type: "action",
          label: "Action Success",
          config: { skillId: "rgg-evidence-fail-closed-skill" },
        },
      ],
      edges: [
        { id: "edge-1", sourceNodeId: "trigger", targetNodeId: "action-success" },
      ],
    },
    failurePolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [],
    checksum: "rgg-phase-14-5c-evidence-fail-closed",
  };
}

async function executeWorkflowEvidenceFailClosed({ artifact, scenario }) {
  const observationLog = [];
  function record(event) {
    observationLog.push(event);
    artifact.observedEvidence.push(event);
  }

  let modules;
  try {
    modules = await loadWorkflowEvidenceFailClosedModules();
  } catch (importError) {
    artifact.result = "blocked";
    artifact.failureClass = "environment";
    artifact.notes = [
      ...(artifact.notes ?? []),
      `workflow_evidence_fail_closed requires the compiled Friday dist/ tree (npm run build) for in-process bootstrap. Lazy import failed: ${importError instanceof Error ? importError.message : String(importError)}`,
    ];
    return artifact;
  }

  const {
    Database,
    createFridayWorkflowRuntime,
    runFridayMigrations,
    FRIDAY_SQLITE_MIGRATIONS,
    FridayDomainError,
    createFridayTaskWorkflowRepository,
    createFridayTaskWorkflowService,
  } = modules;

  const originalPipelineEnable = process.env.FRIDAY_PIPELINE_ENABLE;
  const originalPipelineMode = process.env.FRIDAY_PIPELINE_MODE;
  process.env.FRIDAY_PIPELINE_ENABLE = "true";
  process.env.FRIDAY_PIPELINE_MODE = "enforce";

  const db = createWorkflowEvidenceFailClosedDb({
    Database,
    runFridayMigrations,
    FRIDAY_SQLITE_MIGRATIONS,
  });
  let idCounter = 0;
  const idGenerator = () => `rgg-evidence-fail-closed-${String(++idCounter).padStart(6, "0")}`;
  const runtime = createFridayWorkflowRuntime({
    db,
    idGenerator,
    nowIso: () => WORKFLOW_EVIDENCE_FAIL_CLOSED_NOW,
    computeChecksum: (content) => crypto.createHash("sha256").update(content).digest("hex"),
    resolveSkill: () => ({ id: "rgg-evidence-fail-closed-skill" }),
    invokeSkill: async () => ({ ok: true }),
  });
  const taskWorkflowRepository = createFridayTaskWorkflowRepository();
  let taskWorkflowIdCounter = 0;
  const taskWorkflowService = createFridayTaskWorkflowService({
    db,
    repository: taskWorkflowRepository,
    idGenerator: () => `rgg-tw-${String(++taskWorkflowIdCounter).padStart(6, "0")}`,
    nowIso: () => WORKFLOW_EVIDENCE_FAIL_CLOSED_NOW,
    getWorkflowRunEvidenceStatus: (runId) => runtime.evidence.getRunEvidenceStatus(runId),
  });

  const failures = [];
  const subSummary = { total: 0, passed: 0 };
  function assert(label, condition, detail) {
    subSummary.total += 1;
    if (condition) {
      subSummary.passed += 1;
      record(`PASS ${label}: ${detail}`);
    } else {
      failures.push(`${label}: ${detail}`);
      record(`FAIL ${label}: ${detail}`);
    }
  }

  try {
    // Publish a baseline workflow used by every run below.
    const workflow = runtime.crud.createWorkflow({
      slug: "rgg-phase-14-5c-evidence-fail-closed",
      name: "RGG phase 14.5C evidence fail closed",
    });
    const version = runtime.crud.createVersion(
      workflow.id,
      makeWorkflowEvidenceFailClosedGraph(workflow.id, "placeholder"),
    );
    runtime.crud.publishVersion(workflow.id, version.versionNumber);

    // (a) Healthy ordinary run while the evidence table is present.
    const healthyRun = await runtime.execution.startRun({
      workflowId: workflow.id,
      workflowVersionId: version.id,
      triggerType: "manual",
      proofRequired: false,
    });
    await sleep(WORKFLOW_EVIDENCE_FAIL_CLOSED_WAIT_MS);
    const healthyStatus = runtime.evidence.getRunEvidenceStatus(healthyRun.id);
    assert(
      "(a) healthy ordinary run evidenceStatus",
      healthyStatus === "available",
      `runId=${healthyRun.id} status=${healthyStatus}`,
    );
    const healthyEvidence = runtime.evidence.getRunEvidence(healthyRun.id);
    assert(
      "(a) healthy run getRunEvidence reports available",
      healthyEvidence.evidenceStatus === "available",
      `getRunEvidence.evidenceStatus=${healthyEvidence.evidenceStatus}`,
    );

    // Drop the evidence persistence table — simulates live store unreach.
    db.withWriteTransaction((conn) => {
      conn.exec(`DROP TABLE IF EXISTS ${WORKFLOW_EVIDENCE_FAIL_CLOSED_DROPPED_TABLE}`);
    });
    record(
      `staged isolated SQLite degrade by DROP TABLE ${WORKFLOW_EVIDENCE_FAIL_CLOSED_DROPPED_TABLE}`,
    );

    // (b) Proof-required run after table drop — fails closed. The
    // load-bearing assertion is the terminal run record: status === "failed"
    // and failure.code === "WORKFLOW_EVIDENCE_UNAVAILABLE". A flip in
    // evidenceStatus alone would not prove the run was refused; it could
    // remain queued or paused. We wait for terminal state before asserting.
    const proofRequiredRun = await runtime.execution.startRun({
      workflowId: workflow.id,
      workflowVersionId: version.id,
      triggerType: "manual",
      proofRequired: true,
    });
    const proofRequiredSettled = await waitForWorkflowRunSettled(
      runtime,
      proofRequiredRun.id,
    );
    assert(
      "(b) proof-required run settles in terminal state",
      proofRequiredSettled !== null,
      `runId=${proofRequiredRun.id} did not settle within ${WORKFLOW_EVIDENCE_FAIL_CLOSED_SETTLE_POLL_MS * WORKFLOW_EVIDENCE_FAIL_CLOSED_SETTLE_MAX_TRIES}ms`,
    );
    assert(
      "(b) proof-required run terminal status is failed",
      proofRequiredSettled?.status === "failed",
      `runId=${proofRequiredRun.id} status=${proofRequiredSettled?.status ?? "missing"}`,
    );
    assert(
      "(b) proof-required run failure code is WORKFLOW_EVIDENCE_UNAVAILABLE",
      proofRequiredSettled?.failure?.code === "WORKFLOW_EVIDENCE_UNAVAILABLE",
      `failure.code=${proofRequiredSettled?.failure?.code ?? "missing"}`,
    );
    assert(
      "(b) proof-required run failure message names durable-evidence-persistence loss",
      typeof proofRequiredSettled?.failure?.message === "string"
        && /durable evidence persistence/i.test(proofRequiredSettled.failure.message),
      `failure.message=${proofRequiredSettled?.failure?.message ?? "missing"}`,
    );
    const proofRequiredStatus = runtime.evidence.getRunEvidenceStatus(proofRequiredRun.id);
    assert(
      "(b) proof-required run evidenceStatus is non-available",
      proofRequiredStatus === "unavailable" || proofRequiredStatus === "degraded",
      `runId=${proofRequiredRun.id} status=${proofRequiredStatus}`,
    );

    // (c) Ordinary run after table drop — continues. It must NOT be
    // terminal-failed for evidence reasons; receipts may still call out
    // degraded persistence so no proof claim can be made.
    const ordinaryDegradedRun = await runtime.execution.startRun({
      workflowId: workflow.id,
      workflowVersionId: version.id,
      triggerType: "manual",
      proofRequired: false,
    });
    const ordinaryDegradedSettled = await waitForWorkflowRunSettled(
      runtime,
      ordinaryDegradedRun.id,
    );
    assert(
      "(c) ordinary run settles in terminal state",
      ordinaryDegradedSettled !== null,
      `runId=${ordinaryDegradedRun.id} did not settle within ${WORKFLOW_EVIDENCE_FAIL_CLOSED_SETTLE_POLL_MS * WORKFLOW_EVIDENCE_FAIL_CLOSED_SETTLE_MAX_TRIES}ms`,
    );
    assert(
      "(c) ordinary run terminal status is completed (not failed for evidence)",
      ordinaryDegradedSettled?.status === "completed",
      `runId=${ordinaryDegradedRun.id} status=${ordinaryDegradedSettled?.status ?? "missing"}`,
    );
    assert(
      "(c) ordinary run failure code is not WORKFLOW_EVIDENCE_UNAVAILABLE",
      ordinaryDegradedSettled?.failure?.code !== "WORKFLOW_EVIDENCE_UNAVAILABLE",
      `failure.code=${ordinaryDegradedSettled?.failure?.code ?? "none"}`,
    );
    const ordinaryStatus = runtime.evidence.getRunEvidenceStatus(ordinaryDegradedRun.id);
    assert(
      "(c) ordinary run reports degraded/unavailable (no proof claim)",
      ordinaryStatus === "degraded" || ordinaryStatus === "unavailable",
      `runId=${ordinaryDegradedRun.id} status=${ordinaryStatus}`,
    );
    const ordinaryEvidence = runtime.evidence.getRunEvidence(ordinaryDegradedRun.id);
    assert(
      "(c) ordinary run getRunEvidence not-available",
      ordinaryEvidence.evidenceStatus !== "available",
      `getRunEvidence.evidenceStatus=${ordinaryEvidence.evidenceStatus}`,
    );

    // (d) verifyClaim refuses a workflow_run_evidence ref from the degraded run.
    const degradedTw = taskWorkflowService.create({
      charter: "rgg phase 14.5C module_28c degraded path",
      taskKind: "general",
      contextPackage: {
        allowedFiles: ["src/x.ts"],
        allowedTools: [],
        allowedApis: [],
        boundaryIds: ["api.task_workflows.core"],
      },
    });
    const degradedClaim = taskWorkflowService.draftClaim(degradedTw.id, {
      claimText: "claim backed by degraded run",
      claimKind: "runtime_evidence",
    });
    taskWorkflowService.attachEvidenceRef(degradedTw.id, degradedClaim.id, {
      refKind: "workflow_run_evidence",
      refId: ordinaryDegradedRun.id,
      refSource: "workflow_run_evidence",
    });
    let verifyError = null;
    try {
      taskWorkflowService.verifyClaim(degradedTw.id, degradedClaim.id, {
        verifierVerdict: "fresh-read",
      });
    } catch (caught) {
      verifyError = caught;
    }
    const verifyDomainErrorObserved = verifyError instanceof FridayDomainError;
    assert(
      "(d) verifyClaim refuses degraded run ref",
      verifyDomainErrorObserved
        && verifyError.code === "TASK_WORKFLOW_CLAIM_WORKFLOW_RUN_EVIDENCE_UNAVAILABLE"
        && verifyError.httpStatus === 409,
      verifyDomainErrorObserved
        ? `code=${verifyError.code} httpStatus=${String(verifyError.httpStatus)}`
        : `error=${verifyError ? (verifyError.message ?? String(verifyError)) : "no error thrown"}`,
    );

    // (e) Closeout on the degraded task workflow — claim stays unverified
    // because (d) refused promotion. Receipt status is "partial"; the
    // proofClaimable signal is read alongside the partial status surface.
    const degradedReceipt = taskWorkflowService.closeout(degradedTw.id);
    assert(
      "(e) degraded path closeout reports partial",
      degradedReceipt.status === "partial",
      `receipt.status=${degradedReceipt.status}`,
    );
    assert(
      "(e) degraded receipt carries evidenceDurability field",
      typeof degradedReceipt.evidenceDurability === "string",
      `evidenceDurability=${String(degradedReceipt.evidenceDurability)}`,
    );

    // (f) Healthy path — new task workflow, ref to the healthy run, verify
    // succeeds, closeout=complete + proofClaimable=true + gate pass.
    const happyTw = taskWorkflowService.create({
      charter: "rgg phase 14.5C module_28c happy path",
      taskKind: "general",
      contextPackage: {
        allowedFiles: ["src/x.ts"],
        allowedTools: [],
        allowedApis: [],
        boundaryIds: ["api.task_workflows.core"],
      },
    });
    const happyClaim = taskWorkflowService.draftClaim(happyTw.id, {
      claimText: "claim backed by healthy run",
      claimKind: "runtime_evidence",
    });
    taskWorkflowService.attachEvidenceRef(happyTw.id, happyClaim.id, {
      refKind: "workflow_run_evidence",
      refId: healthyRun.id,
      refSource: "workflow_run_evidence",
    });
    const verifiedHappyClaim = taskWorkflowService.verifyClaim(
      happyTw.id,
      happyClaim.id,
      { verifierVerdict: "fresh-read" },
    );
    assert(
      "(f) verifyClaim succeeds on healthy ref",
      verifiedHappyClaim.status === "verified",
      `claim.status=${verifiedHappyClaim.status}`,
    );
    const happyReceipt = taskWorkflowService.closeout(happyTw.id);
    assert(
      "(f) healthy closeout is complete",
      happyReceipt.status === "complete",
      `receipt.status=${happyReceipt.status}`,
    );
    assert(
      "(f) healthy receipt evidenceDurability is available",
      happyReceipt.evidenceDurability === "available",
      `evidenceDurability=${happyReceipt.evidenceDurability}`,
    );
    assert(
      "(f) healthy receipt proofClaimable is true",
      happyReceipt.proofClaimable === true,
      `proofClaimable=${String(happyReceipt.proofClaimable)}`,
    );
    const durableGate = happyReceipt.gateOutcomes.find(
      (entry) => entry.gateId === "workflow_run_evidence_durable",
    );
    assert(
      "(f) workflow_run_evidence_durable gate passed on healthy path",
      durableGate?.status === "pass",
      `gate=${durableGate ? `${durableGate.gateId}:${durableGate.status}` : "missing"}`,
    );

    artifact.metrics = {
      ...(artifact.metrics ?? {}),
      assertionsTotal: subSummary.total,
      assertionsPassed: subSummary.passed,
      droppedTable: WORKFLOW_EVIDENCE_FAIL_CLOSED_DROPPED_TABLE,
    };
    artifact.raw = {
      ...(artifact.raw ?? {}),
      observations: observationLog,
      runIds: {
        healthy: healthyRun.id,
        proofRequired: proofRequiredRun.id,
        ordinaryDegraded: ordinaryDegradedRun.id,
      },
      taskWorkflowIds: {
        degraded: degradedTw.id,
        happy: happyTw.id,
      },
    };

    if (failures.length === 0) {
      artifact.result = "passed";
    } else {
      artifact.result = "failed";
      artifact.failureClass = "workflow_runtime";
      artifact.notes = [
        ...(artifact.notes ?? []),
        ...failures,
      ];
    }
  } catch (executionError) {
    artifact.result = "failed";
    artifact.failureClass = artifact.failureClass ?? "workflow_runtime";
    artifact.notes = [
      ...(artifact.notes ?? []),
      executionError instanceof Error ? executionError.message : String(executionError),
    ];
  } finally {
    try {
      db.close();
    } catch {
      // best-effort
    }
    if (originalPipelineEnable === undefined) {
      delete process.env.FRIDAY_PIPELINE_ENABLE;
    } else {
      process.env.FRIDAY_PIPELINE_ENABLE = originalPipelineEnable;
    }
    if (originalPipelineMode === undefined) {
      delete process.env.FRIDAY_PIPELINE_MODE;
    } else {
      process.env.FRIDAY_PIPELINE_MODE = originalPipelineMode;
    }
  }
  return artifact;
}

const TASK_WORKFLOW_ROLLBACK_MATRIX_NOW = "2026-05-17T05:30:00.000Z";
const TASK_WORKFLOW_ROLLBACK_MATRIX_WAIT_MS = 120;

async function executeTaskWorkflowRollbackMatrix({ artifact, scenario }) {
  void scenario;
  const observationLog = [];
  function record(event) {
    observationLog.push(event);
    artifact.observedEvidence.push(event);
  }

  let modules;
  try {
    modules = await loadWorkflowEvidenceFailClosedModules();
  } catch (importError) {
    artifact.result = "blocked";
    artifact.failureClass = "environment";
    artifact.notes = [
      ...(artifact.notes ?? []),
      `task_workflow_rollback_matrix requires the compiled Friday dist/ tree (npm run build) for in-process bootstrap. Lazy import failed: ${importError instanceof Error ? importError.message : String(importError)}`,
    ];
    return artifact;
  }

  const {
    Database,
    createFridayWorkflowRuntime,
    runFridayMigrations,
    FRIDAY_SQLITE_MIGRATIONS,
    createFridayTaskWorkflowRepository,
    createFridayTaskWorkflowService,
  } = modules;

  const originalPipelineEnable = process.env.FRIDAY_PIPELINE_ENABLE;
  const originalPipelineMode = process.env.FRIDAY_PIPELINE_MODE;
  process.env.FRIDAY_PIPELINE_ENABLE = "true";
  process.env.FRIDAY_PIPELINE_MODE = "enforce";

  const db = createWorkflowEvidenceFailClosedDb({
    Database,
    runFridayMigrations,
    FRIDAY_SQLITE_MIGRATIONS,
  });
  let idCounter = 0;
  const idGenerator = () => `rgg-rollback-matrix-${String(++idCounter).padStart(6, "0")}`;
  const runtime = createFridayWorkflowRuntime({
    db,
    idGenerator,
    nowIso: () => TASK_WORKFLOW_ROLLBACK_MATRIX_NOW,
    computeChecksum: (content) => crypto.createHash("sha256").update(content).digest("hex"),
    resolveSkill: () => ({ id: "rgg-rollback-matrix-skill" }),
    invokeSkill: async () => ({ ok: true }),
  });
  const taskWorkflowRepository = createFridayTaskWorkflowRepository();
  let taskWorkflowIdCounter = 0;
  const taskWorkflowService = createFridayTaskWorkflowService({
    db,
    repository: taskWorkflowRepository,
    idGenerator: () => `rgg-tw-rb-${String(++taskWorkflowIdCounter).padStart(6, "0")}`,
    nowIso: () => TASK_WORKFLOW_ROLLBACK_MATRIX_NOW,
    getWorkflowRunEvidenceStatus: (runId) => runtime.evidence.getRunEvidenceStatus(runId),
  });

  const failures = [];
  const subSummary = { total: 0, passed: 0 };
  function assert(label, condition, detail) {
    subSummary.total += 1;
    if (condition) {
      subSummary.passed += 1;
      record(`PASS ${label}: ${detail}`);
    } else {
      failures.push(`${label}: ${detail}`);
      record(`FAIL ${label}: ${detail}`);
    }
  }

  function makeContextPackage() {
    return {
      allowedFiles: ["src/x.ts"],
      allowedTools: [],
      allowedApis: [],
      boundaryIds: ["api.task_workflows.core"],
    };
  }

  try {
    // (a) not_applicable — workflow with no verified/blocked claims.
    const naTw = taskWorkflowService.create({
      charter: "rgg phase 14.5D rollback matrix not_applicable",
      taskKind: "general",
      contextPackage: makeContextPackage(),
    });
    const naReceipt = taskWorkflowService.closeout(naTw.id);
    assert(
      "(a) closeout reports rollbackClass=not_applicable when no verified/blocked claims",
      naReceipt.rollbackClass === "not_applicable",
      `rollbackClass=${naReceipt.rollbackClass}`,
    );
    assert(
      "(a) compensatingAction is null on not_applicable",
      naReceipt.compensatingAction === null,
      `compensatingAction=${String(naReceipt.compensatingAction)}`,
    );
    assert(
      "(a) nonReversibleReason is null on not_applicable",
      naReceipt.nonReversibleReason === null,
      `nonReversibleReason=${String(naReceipt.nonReversibleReason)}`,
    );
    const naGate = naReceipt.gateOutcomes.find(
      (g) => g.gateId === "rollback_class_disclosure_required",
    );
    assert(
      "(a) rollback_class_disclosure_required gate passes on not_applicable",
      naGate?.status === "pass",
      `gate=${naGate ? `${naGate.gateId}:${naGate.status}` : "missing"}`,
    );

    // (b) reversible_local — verified claim backed by agent_run_event ref.
    const localTw = taskWorkflowService.create({
      charter: "rgg phase 14.5D rollback matrix reversible_local",
      taskKind: "general",
      contextPackage: makeContextPackage(),
    });
    const localClaim = taskWorkflowService.draftClaim(localTw.id, {
      claimText: "verified by local agent run event",
      claimKind: "runtime_evidence",
    });
    taskWorkflowService.attachEvidenceRef(localTw.id, localClaim.id, {
      refKind: "agent_run.event",
      refId: "agent-evt-rgg-rb-1",
      refSource: "agent_run_event",
    });
    taskWorkflowService.verifyClaim(localTw.id, localClaim.id, {
      verifierVerdict: "fresh-read local agent_run_event",
    });
    const localReceipt = taskWorkflowService.closeout(localTw.id);
    assert(
      "(b) closeout reports rollbackClass=reversible_local with agent_run_event-backed verified claim",
      localReceipt.rollbackClass === "reversible_local",
      `rollbackClass=${localReceipt.rollbackClass}`,
    );
    const localGate = localReceipt.gateOutcomes.find(
      (g) => g.gateId === "rollback_class_disclosure_required",
    );
    assert(
      "(b) rollback_class_disclosure_required gate passes on reversible_local",
      localGate?.status === "pass",
      `gate=${localGate ? `${localGate.gateId}:${localGate.status}` : "missing"}`,
    );

    // (c) compensating_action_required — workflow_run_evidence ref to a healthy run.
    const compWorkflow = runtime.crud.createWorkflow({
      slug: "rgg-rollback-matrix-comp",
      name: "RGG rollback matrix compensating",
    });
    const compVersion = runtime.crud.createVersion(
      compWorkflow.id,
      makeWorkflowEvidenceFailClosedGraph(compWorkflow.id, "placeholder"),
    );
    runtime.crud.publishVersion(compWorkflow.id, compVersion.versionNumber);
    const healthyRun = await runtime.execution.startRun({
      workflowId: compWorkflow.id,
      workflowVersionId: compVersion.id,
      triggerType: "manual",
      proofRequired: false,
    });
    await sleep(TASK_WORKFLOW_ROLLBACK_MATRIX_WAIT_MS);
    const compTw = taskWorkflowService.create({
      charter: "rgg phase 14.5D rollback matrix compensating",
      taskKind: "general",
      contextPackage: makeContextPackage(),
    });
    const compClaim = taskWorkflowService.draftClaim(compTw.id, {
      claimText: "verified by workflow_run_evidence",
      claimKind: "runtime_evidence",
    });
    taskWorkflowService.attachEvidenceRef(compTw.id, compClaim.id, {
      refKind: "workflow_run_evidence",
      refId: healthyRun.id,
      refSource: "workflow_run_evidence",
    });
    taskWorkflowService.verifyClaim(compTw.id, compClaim.id, {
      verifierVerdict: "fresh-read healthy workflow_run",
    });
    const compReceipt = taskWorkflowService.closeout(compTw.id);
    assert(
      "(c) closeout reports rollbackClass=compensating_action_required with workflow_run_evidence-backed verified claim",
      compReceipt.rollbackClass === "compensating_action_required",
      `rollbackClass=${compReceipt.rollbackClass}`,
    );
    assert(
      "(c) compensatingAction is a non-empty string naming workflow_run_evidence",
      typeof compReceipt.compensatingAction === "string"
        && compReceipt.compensatingAction.length > 0
        && /workflow_run_evidence/.test(compReceipt.compensatingAction),
      `compensatingAction=${String(compReceipt.compensatingAction)}`,
    );
    const compGate = compReceipt.gateOutcomes.find(
      (g) => g.gateId === "rollback_class_disclosure_required",
    );
    assert(
      "(c) rollback_class_disclosure_required gate passes on compensating_action_required with action populated",
      compGate?.status === "pass",
      `gate=${compGate ? `${compGate.gateId}:${compGate.status}` : "missing"}`,
    );

    // (d) non_reversible_external — verified claim with manual_external ref
    // planted through the repository. This models the closeout disclosure
    // surface; the verify path keeps the evidence-bearing-claim invariant.
    const extTw = taskWorkflowService.create({
      charter: "rgg phase 14.5D rollback matrix non_reversible_external",
      taskKind: "general",
      contextPackage: makeContextPackage(),
    });
    const extClaim = taskWorkflowService.draftClaim(extTw.id, {
      claimText: "verified by local pre-external, with external side effect",
      claimKind: "runtime_evidence",
    });
    taskWorkflowService.attachEvidenceRef(extTw.id, extClaim.id, {
      refKind: "agent_run.event",
      refId: "agent-evt-rgg-rb-pre-ext",
      refSource: "agent_run_event",
    });
    taskWorkflowService.verifyClaim(extTw.id, extClaim.id, {
      verifierVerdict: "fresh-read pre-external evidence",
    });
    db.withWriteTransaction((conn) => {
      taskWorkflowRepository.insertEvidenceRef(conn, {
        id: "rgg-plant-ext-1",
        workflowId: extTw.id,
        claimId: extClaim.id,
        refKind: "external.message",
        refId: "rgg-ext-msg-1",
        refHash: null,
        refSource: "manual_external",
        createdAt: TASK_WORKFLOW_ROLLBACK_MATRIX_NOW,
      });
      taskWorkflowRepository.incrementEvidenceRefCount(
        conn,
        extClaim.id,
        TASK_WORKFLOW_ROLLBACK_MATRIX_NOW,
      );
    });
    const extReceipt = taskWorkflowService.closeout(extTw.id);
    assert(
      "(d) closeout reports rollbackClass=non_reversible_external when manual_external ref is present",
      extReceipt.rollbackClass === "non_reversible_external",
      `rollbackClass=${extReceipt.rollbackClass}`,
    );
    assert(
      "(d) nonReversibleReason is a non-empty string naming manual_external",
      typeof extReceipt.nonReversibleReason === "string"
        && extReceipt.nonReversibleReason.length > 0
        && /manual_external/.test(extReceipt.nonReversibleReason),
      `nonReversibleReason=${String(extReceipt.nonReversibleReason)}`,
    );
    const extGate = extReceipt.gateOutcomes.find(
      (g) => g.gateId === "rollback_class_disclosure_required",
    );
    assert(
      "(d) rollback_class_disclosure_required gate passes on non_reversible_external with reason populated",
      extGate?.status === "pass",
      `gate=${extGate ? `${extGate.gateId}:${extGate.status}` : "missing"}`,
    );

    // (e) Persistence round-trip — read back via repository.
    const reloaded = db.withReadConnection((conn) =>
      taskWorkflowRepository.getLatestCloseoutReceipt(conn, extTw.id),
    );
    assert(
      "(e) persisted rollbackClass round-trips through repository",
      reloaded !== null && reloaded.rollbackClass === extReceipt.rollbackClass,
      `reloaded.rollbackClass=${reloaded ? reloaded.rollbackClass : "missing"}`,
    );
    assert(
      "(e) persisted nonReversibleReason round-trips through repository",
      reloaded !== null && reloaded.nonReversibleReason === extReceipt.nonReversibleReason,
      `reloaded.nonReversibleReason=${reloaded ? String(reloaded.nonReversibleReason) : "missing"}`,
    );

    artifact.metrics = {
      ...(artifact.metrics ?? {}),
      assertionsTotal: subSummary.total,
      assertionsPassed: subSummary.passed,
    };
    artifact.raw = {
      ...(artifact.raw ?? {}),
      observations: observationLog,
      receipts: {
        not_applicable: { id: naReceipt.id, rollbackClass: naReceipt.rollbackClass },
        reversible_local: { id: localReceipt.id, rollbackClass: localReceipt.rollbackClass },
        compensating_action_required: { id: compReceipt.id, rollbackClass: compReceipt.rollbackClass },
        non_reversible_external: { id: extReceipt.id, rollbackClass: extReceipt.rollbackClass },
      },
    };

    if (failures.length === 0) {
      artifact.result = "passed";
    } else {
      artifact.result = "failed";
      artifact.failureClass = "task_workflow_runtime";
      artifact.notes = [
        ...(artifact.notes ?? []),
        ...failures,
      ];
    }
  } catch (executionError) {
    artifact.result = "failed";
    artifact.failureClass = artifact.failureClass ?? "task_workflow_runtime";
    artifact.notes = [
      ...(artifact.notes ?? []),
      executionError instanceof Error ? executionError.message : String(executionError),
    ];
  } finally {
    try {
      db.close();
    } catch {
      // best-effort
    }
    if (originalPipelineEnable === undefined) {
      delete process.env.FRIDAY_PIPELINE_ENABLE;
    } else {
      process.env.FRIDAY_PIPELINE_ENABLE = originalPipelineEnable;
    }
    if (originalPipelineMode === undefined) {
      delete process.env.FRIDAY_PIPELINE_MODE;
    } else {
      process.env.FRIDAY_PIPELINE_MODE = originalPipelineMode;
    }
  }
  return artifact;
}

async function executeAutoFixDoctorRoundtrip({ artifact, client, scenario }) {
  const checks = [];
  let allRefused = true;
  for (const route of AUTO_FIX_DOCTOR_ROUTES) {
    const response = await client.request(route.method, route.path, {
      skipAuth: true,
      timeoutMs: scenarioTimeout(scenario, 30_000),
      body: route.body,
    });
    const errorCode = response.json?.error?.code;
    const refused = response.status === 401
      && errorCode === AUTO_FIX_DOCTOR_BOUND_PRINCIPAL_ERROR_CODE;
    checks.push({
      operationId: route.operationId,
      method: route.method,
      path: route.path,
      status: response.status,
      errorCode: errorCode ?? null,
      refused,
      durationMs: response.durationMs,
    });
    artifact.observedEvidence.push(
      `${route.method} ${route.path} (skipAuth) -> ${String(response.status)} `
      + `${errorCode ?? "no-error-code"} ${refused ? "refused" : "did-not-refuse"}`,
    );
    if (!refused) {
      allRefused = false;
    }
  }
  artifact.metrics = {
    ...(artifact.metrics ?? {}),
    routesProbed: checks.length,
    routesRefused: checks.filter((check) => check.refused).length,
  };
  artifact.raw = {
    ...(artifact.raw ?? {}),
    checks,
  };
  if (allRefused) {
    artifact.result = "passed";
  } else {
    artifact.result = "failed";
    artifact.failureClass = "http_contract";
    const failed = checks.filter((check) => !check.refused);
    artifact.notes = [
      ...(artifact.notes ?? []),
      `Expected all 5 /v1/auto-fix mutating routes to refuse the synthetic public principal with HTTP 401 ${AUTO_FIX_DOCTOR_BOUND_PRINCIPAL_ERROR_CODE}.`,
      ...failed.map((check) => `${check.operationId} (${check.method} ${check.path}): status=${String(check.status)} errorCode=${String(check.errorCode)}`),
    ];
  }
  return artifact;
}

async function executeUiProbe({ artifact, client, scenario, reportRoot, uiBaseUrl, envTruth }) {
  const execution = scenario.execution;
  const requestUrls = [];
  const requestFailures = [];
  const reloadAbortedRequestFailures = [];
  const consoleErrors = [];
  const responseErrors = [];
  const requestOrder = new WeakMap();
  let requestSequence = 0;
  let reloadAbortCutoff = null;
  const startedAt = Date.now();
  let context;
  let page;

  try {
    const bootstrapResponse = await client.request("GET", "/v1/auth/bootstrap/status", {
      timeoutMs: Math.min(30_000, scenarioTimeout(scenario, 30_000)),
    });
    const bootstrapStatus = bootstrapResponse.json?.data ?? bootstrapResponse.json ?? null;
    const authCapabilities = bootstrapStatus ?? {};
    const hasBrowserAuthToken =
      typeof client?.accessToken === "string" && client.accessToken.trim().length > 0;
    const hasBrowserLoginCredential =
      hasBrowserAuthToken
      || (typeof client?.localPassphrase === "string" && client.localPassphrase.trim().length > 0)
      || (
        typeof client?.email === "string" && client.email.trim().length > 0
        && typeof client?.password === "string" && client.password.trim().length > 0 // pragma: allowlist secret
      );
    if (!hasBrowserLoginCredential) {
      artifact.result = "blocked";
      artifact.failureClass = "environment";
      artifact.notes = [
        ...(artifact.notes ?? []),
        "Real browser probe requires localPassphrase or email/password browser credentials.",
      ];
      artifact.observedEvidence.push(
        "browser auth credential missing",
      );
      artifact.raw = {
        ...(artifact.raw ?? {}),
        bootstrapStatus,
        authCapabilities,
      };
      return artifact;
    }

    ({ context } = await getSharedUiProbeSession(uiBaseUrl));
    await seedUiAuthStorageIfAvailable({ context, client, artifact });
    page = await context.newPage();
    page.on("request", (request) => {
      requestUrls.push(request.url());
      requestSequence += 1;
      requestOrder.set(request, requestSequence);
    });
    page.on("requestfailed", (request) => {
      const message = `${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? "failed"}`;
      const errorText = request.failure()?.errorText ?? "failed";
      const startedBeforeIntentionalReload = reloadAbortCutoff != null
        && (requestOrder.get(request) ?? Number.POSITIVE_INFINITY) <= reloadAbortCutoff;
      if (startedBeforeIntentionalReload && /ERR_ABORTED/i.test(errorText)) {
        reloadAbortedRequestFailures.push(message);
        return;
      }
      requestFailures.push(message);
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        responseErrors.push(`${String(response.status())} ${response.url()}`);
      }
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => {
      consoleErrors.push(error.message);
    });

    const gotoResponse = await page.goto(execution.path, {
      waitUntil: "domcontentloaded",
      timeout: scenarioTimeout(scenario, 90_000),
    });
    await settleAndCompleteUiLoginIfNeeded({
      page,
      client,
      execution,
      artifact,
      timeoutMs: execution.readyTimeoutMs ?? 30_000,
    });

    const waitForReady = async () => {
      if (execution.readySelector) {
        await page.locator(execution.readySelector).first().waitFor({ timeout: execution.readyTimeoutMs ?? 30_000 });
        return;
      }
      if (execution.readyText) {
        await page.getByText(execution.readyText, { exact: false }).first().waitFor({ timeout: execution.readyTimeoutMs ?? 30_000 });
        return;
      }
      await page.waitForFunction(
        () => Boolean(document.body) && (document.body.innerText || "").trim().length > 0,
        undefined,
        { timeout: execution.readyTimeoutMs ?? 30_000 },
      );
    };

    const idleWindowMs = execution.idleWindowMs ?? 1_500;
    await waitForReady();
    const firstVisibleSignalMs = Date.now() - startedAt;
    await page.waitForTimeout(idleWindowMs);
    if (execution.reloadCheck) {
      reloadAbortCutoff = requestSequence;
      await page.reload({ waitUntil: "domcontentloaded", timeout: scenarioTimeout(scenario, 90_000) });
      await settleAndCompleteUiLoginIfNeeded({
        page,
        client,
        execution,
        artifact,
        timeoutMs: execution.readyTimeoutMs ?? 30_000,
      });
      await waitForReady();
      await page.waitForTimeout(idleWindowMs);
    }

    const screenshotPath = path.join(
      reportRoot,
      "screenshots",
      `${slugify(`${scenario.id}-${artifact.lane}-${Date.now()}`)}.png`,
    );
    ensureDir(path.dirname(screenshotPath));
    await page.screenshot({ path: screenshotPath, fullPage: true });

    artifact.result = "passed";
    artifact.screenshots.push(screenshotPath);
    const finalUrl = page.url();
    const finalPath = getUrlPath(finalUrl);
    const requestedPath = getUrlPath(execution.path);
    const allowedFinalPathPrefixes = execution.allowedFinalPathPrefixes ?? [requestedPath];
    const significantRequestFailures = requestFailures.filter((message) => !isIgnorableUiRequestFailure(message));
    const significantResponseErrors = responseErrors.filter((message) => !isIgnorableUiResponseError(message));
    const significantConsoleErrors = consoleErrors.filter((message) => !isIgnorableUiConsoleError(message, responseErrors));
    artifact.toolErrors = [
      ...significantRequestFailures,
      ...significantConsoleErrors,
      ...significantResponseErrors,
    ];
    artifact.observedEvidence.push(
      `loaded ${execution.path}`,
      `final url ${finalUrl}`,
      `title ${await page.title()}`,
    );
    artifact.metrics = {
      ...(artifact.metrics ?? {}),
      timeToFirstVisibleSignalMs: firstVisibleSignalMs,
      uiRequestCount: requestUrls.length,
      uiRequestFailureCount: significantRequestFailures.length,
      uiConsoleErrorCount: significantConsoleErrors.length,
      statusCode: gotoResponse?.status() ?? 0,
    };
    artifact.raw = {
      ...(artifact.raw ?? {}),
      finalUrl,
      finalPath,
      requestedPath,
      allowedFinalPathPrefixes,
      consoleErrors,
      significantConsoleErrors,
      responseErrors,
      significantResponseErrors,
      requestFailures,
      reloadAbortedRequestFailures,
      significantRequestFailures,
      requestUrls,
      statusCode: gotoResponse?.status() ?? 0,
    };

    const landedOnUnexpectedSurface = !allowedFinalPathPrefixes.some((prefix) =>
      typeof prefix === "string" && prefix.length > 0 && finalPath.startsWith(prefix),
    );
    if (landedOnUnexpectedSurface) {
      artifact.result = "failed";
      artifact.failureClass = "ui_misroute";
      artifact.misrouteClass = `unexpected_surface:${finalPath || "unknown"}`;
      artifact.humanReviewRequired = true;
      artifact.notes = [
        ...(artifact.notes ?? []),
        `expected final path within ${allowedFinalPathPrefixes.join(", ")} but landed on ${finalPath || "unknown"}`,
      ];
      if (finalPath === "/onboarding" && envTruth?.setupStatus?.needsSetup === false) {
        artifact.notes.push("setup.status reports needsSetup=false but the UI redirected this authenticated session to /onboarding");
      }
      if (envTruth?.userProfile) {
        artifact.notes.push(`uix.user-profile onboardedAt=${envTruth.userProfile.onboardedAt ?? "null"} profileType=${envTruth.userProfile.profileType ?? "null"}`);
      }
      return artifact;
    }

    if (significantRequestFailures.length > 0 || significantConsoleErrors.length > 0 || significantResponseErrors.length > 0) {
      artifact.result = "partial";
      artifact.failureClass = "ui_loading";
      artifact.notes = [
        ...(artifact.notes ?? []),
        significantRequestFailures.length > 0 ? `${String(significantRequestFailures.length)} failed UI requests` : "",
        significantConsoleErrors.length > 0 ? `${String(significantConsoleErrors.length)} console errors` : "",
        significantResponseErrors.length > 0 ? `${String(significantResponseErrors.length)} HTTP error responses` : "",
      ].filter(Boolean);
    }
    return artifact;
  } catch (error) {
    const retryCount = Number(artifact.raw?.uiProbeRetryCount ?? 0);
    if (isRetryableUiProbeError(error) && retryCount < 2) {
      artifact.raw = {
        ...(artifact.raw ?? {}),
        uiProbeRetryCount: retryCount + 1,
        uiProbeRetryReason: error instanceof Error ? error.message : String(error),
      };
      artifact.notes = [
        ...(artifact.notes ?? []),
        `retrying transient UI probe abort (${String(retryCount + 1)}/2)`,
      ];
      return executeUiProbe({ artifact, client, scenario, reportRoot, uiBaseUrl, envTruth });
    }
    artifact.result = "failed";
    artifact.failureClass = "ui_loading";
    artifact.notes = [...(artifact.notes ?? []), error instanceof Error ? error.message : String(error)];
    return artifact;
  } finally {
    await page?.close().catch(() => undefined);
    await context?.close().catch(() => undefined);
  }
}

async function executeUiAuthoring({ artifact, client, scenario, reportRoot, uiBaseUrl }) {
  const execution = scenario.execution;
  const startedAt = Date.now();
  let context;
  let page;

  try {
    const hasBrowserAuthToken =
      typeof client?.accessToken === "string" && client.accessToken.trim().length > 0;
    const hasBrowserLoginCredential =
      hasBrowserAuthToken
      || (typeof client?.localPassphrase === "string" && client.localPassphrase.trim().length > 0)
      || (
        typeof client?.email === "string" && client.email.trim().length > 0
        && typeof client?.password === "string" && client.password.trim().length > 0 // pragma: allowlist secret
      );
    if (!hasBrowserLoginCredential) {
      artifact.result = "blocked";
      artifact.failureClass = "environment";
      artifact.notes = [
        ...(artifact.notes ?? []),
        "Browser authoring requires localPassphrase or email/password credentials.",
      ];
      return artifact;
    }

    ({ context } = await getSharedUiProbeSession(uiBaseUrl));
    await seedUiAuthStorageIfAvailable({ context, client, artifact });
    page = await context.newPage();

    await page.goto(execution.path, {
      waitUntil: "domcontentloaded",
      timeout: scenarioTimeout(scenario, 90_000),
    });
    await settleAndCompleteUiLoginIfNeeded({
      page,
      client,
      execution,
      artifact,
      timeoutMs: execution.readyTimeoutMs ?? 30_000,
    });

    const readySelector = execution.readySelector ?? "[data-testid='workflow-builder-node-library']";
    await page.locator(readySelector).waitFor({ timeout: scenarioTimeout(scenario, 30_000) });
    const firstVisibleSignalMs = Date.now() - startedAt;
    artifact.observedEvidence.push("workflow builder loaded and interactive");

    const draftTitle = execution.draftTitle ?? `RGG-authoring-${Date.now().toString(36)}`;
    await page.locator("input[placeholder=\"Workflow title\"]").fill(draftTitle);
    artifact.observedEvidence.push(`draft title set via UI: ${draftTitle}`);

    await page.getByRole("button", { name: "Blank draft" }).click();
    artifact.observedEvidence.push("blank draft creation requested via UI click");

    await page.locator("[data-testid='workflow-builder-canvas']").waitFor({
      timeout: scenarioTimeout(scenario, 30_000),
    });
    await page.locator("[data-testid^='workflow-builder-node-']").first().waitFor({
      timeout: scenarioTimeout(scenario, 30_000),
    });
    artifact.observedEvidence.push("canvas rendered with trigger node after UI creation");

    let compileSucceeded = false;
    try {
      await page.getByRole("button", { name: "Compile" }).click();
      await page.waitForTimeout(3_000);
      if (await page.locator("[data-testid='workflow-builder-compile-summary']").isVisible()) {
        artifact.observedEvidence.push("compile executed via UI, summary visible");
        compileSucceeded = true;
      }
    } catch {
      artifact.observedEvidence.push("compile attempted via UI (non-blocking)");
    }

    let published = false;
    try {
      const publishBtn = page.getByRole("button", { name: "Publish" });
      if (await publishBtn.isVisible({ timeout: 3_000 })) {
        await publishBtn.click();
        await page.getByText("Publish result").waitFor({ timeout: 15_000 });
        artifact.observedEvidence.push("workflow published via browser UI");
        published = true;
      }
    } catch {
      artifact.observedEvidence.push("publish attempted via UI (trigger-only graph may require additional nodes)");
    }

    const screenshotPath = path.join(
      reportRoot,
      "screenshots",
      `${slugify(`${scenario.id}-${artifact.lane}-${Date.now()}`)}.png`,
    );
    ensureDir(path.dirname(screenshotPath));
    await page.screenshot({ path: screenshotPath, fullPage: true });
    artifact.screenshots.push(screenshotPath);

    artifact.metrics = {
      ...(artifact.metrics ?? {}),
      timeToFirstVisibleSignalMs: firstVisibleSignalMs,
      compileSucceeded,
      published,
    };

    artifact.result = "passed";
    return artifact;
  } catch (error) {
    artifact.result = "failed";
    artifact.failureClass = "ui_loading";
    artifact.notes = [...(artifact.notes ?? []), error instanceof Error ? error.message : String(error)];
    return artifact;
  } finally {
    await page?.close().catch(() => undefined);
    await context?.close().catch(() => undefined);
  }
}

function detectMisroute({ scenario, outputText, run }) {
  const behavior = scenario.oracles?.behavior ?? {};
  for (const snippet of behavior.misrouteTriggers ?? []) {
    if (outputText.includes(snippet)) {
      return `matched:${snippet}`;
    }
  }
  if (behavior.disallowPlanGate && run?.planReview?.gate?.state === "awaiting_plan_approval") {
    return "awaiting_plan_approval";
  }
  if (behavior.disallowClarification && run?.status === "awaiting_clarification") {
    return "awaiting_clarification";
  }
  return undefined;
}

async function executeAgentRun({ artifact, client, scenario, lane, suite, attemptIndex }) {
  const execution = scenario.execution;
  const turns = Array.isArray(execution.turns) && execution.turns.length > 0
    ? execution.turns
    : [{ prompt: scenario.realWorldPrompt }];
  const sharedSessionKey = execution.sessionKeyPrefix
    ? buildValidationSessionKey({ scenario, execution, attemptIndex })
    : turns.length > 1
      ? buildValidationSessionKey({ scenario, execution, attemptIndex })
      : undefined;
  const runTurns = [];
  let totalDurationMs = 0;
  let totalUsageInput = 0;
  let totalUsageOutput = 0;
  let totalCostUsd = 0;
  let totalToolCalls = 0;
  let totalContextEstimatedInputTokens = 0;
  let lastRunRecord = null;
  let lastData = null;
  let outputText = "";
  const templateContext = {
    scenario: {
      id: scenario.id,
      entrySurface: scenario.entrySurface,
    },
    timestamp: String(Date.now()),
    nowIso: nowIso(),
    attemptIndex: attemptIndex ?? 1,
    lane: {
      id: lane.id,
      providerId: lane.providerId,
      model: lane.model,
    },
  };
  const setupResponses = await executeTemplatedRequests({
    artifact,
    client,
    scenario,
    requests: execution.setupRequests,
    templateContext,
    label: "setup",
  });
  const agentTemplateContext = {
    ...templateContext,
    setupResponses,
  };
  let cleanupCompleted = false;
  const cleanupAgentRun = async () => {
    if (cleanupCompleted) {
      return;
    }
    cleanupCompleted = true;
    try {
      const cleanupResponses = await executeTemplatedRequests({
        artifact,
        client,
        scenario,
        requests: execution.cleanupRequests,
        templateContext: {
          ...agentTemplateContext,
          turns: runTurns,
          lastRun: lastRunRecord,
        },
        label: "cleanup",
        throwOnExpectationFailure: false,
      });
      if (cleanupResponses.length > 0) {
        artifact.raw = {
          ...(artifact.raw ?? {}),
          cleanupResponses,
        };
      }
      const cleanupFailures = cleanupResponses.flatMap((response) =>
        Array.isArray(response.expectationFailures)
          ? response.expectationFailures
          : [],
      );
      if (execution.cleanupFailureIsFailure === true && cleanupFailures.length > 0) {
        if (!artifact.result || artifact.result === "passed") {
          artifact.result = "failed";
        }
        artifact.failureClass = artifact.failureClass ?? "cleanup";
      }
    } catch (error) {
      const message = `cleanup request failed: ${error instanceof Error ? error.message : String(error)}`;
      artifact.notes = [...(artifact.notes ?? []), message];
      if (execution.cleanupFailureIsFailure === true) {
        if (!artifact.result || artifact.result === "passed") {
          artifact.result = "failed";
        }
        artifact.failureClass = artifact.failureClass ?? "cleanup";
        return;
      }
      throw error;
    }
  };
  if (setupResponses.length > 0) {
    artifact.raw = {
      ...(artifact.raw ?? {}),
      setupResponses,
    };
  }

  for (const [index, turn] of turns.entries()) {
    const prompt = resolveAgentTurnPrompt({
      scenario,
      execution,
      suite,
      attemptIndex,
      turn,
      turnIndex: index,
      templateContext: agentTemplateContext,
    });
    let data;
    let runRecord;
    try {
      ({ data } = await client.startAgentRun({
        task: prompt,
        providerId: lane.providerId,
        model: lane.model,
        timeoutMs: scenarioTimeout(scenario, 180_000),
        constraints: turn.constraints ?? execution.constraints ?? { readOnly: true },
        taskProfile: turn.taskProfile ?? execution.taskProfile ?? { id: "deterministic" },
        sessionKey: turn.sessionKey ?? sharedSessionKey,
        executionContext: turn.executionContext ?? execution.executionContext,
      }));
      runRecord = (await client.getAgentRun(data.runId)).data.run;
    } catch (error) {
      await cleanupAgentRun();
      throw error;
    }
    outputText = runRecord.responseText ?? runRecord.summary ?? data.finalResponse ?? data.response ?? "";
    const misrouteClass = detectMisroute({ scenario, outputText, run: runRecord });

    artifact.traceRefs.push(`/v1/agent/runs/${encodeURIComponent(data.runId)}`);
    artifact.observedEvidence.push(
      `turn ${String(index + 1)} run ${data.runId}`,
      `turn ${String(index + 1)} status ${runRecord.status}`,
    );
    runTurns.push({
      prompt,
      runId: data.runId,
      runStatus: runRecord.status,
      outputText,
      runRecord,
    });
    totalDurationMs += runRecord.durationMs ?? data.durationMs ?? 0;
    totalUsageInput += runRecord.usageInput ?? data.usageInput ?? 0;
    totalUsageOutput += runRecord.usageOutput ?? data.usageOutput ?? 0;
    totalCostUsd += runRecord.costUsd ?? runRecord.actualExecution?.totalCostUsd ?? 0;
    totalToolCalls += data.toolCallCount ?? 0;
    totalContextEstimatedInputTokens += runRecord.contextCostSummary?.totalEstimatedInputTokens ?? 0;
    lastRunRecord = runRecord;
    lastData = data;

    if (misrouteClass) {
      artifact.raw = {
        ...(artifact.raw ?? {}),
        runId: data.runId,
        runStatus: runRecord.status,
        outputText,
        runRecord,
        turns: runTurns,
        sessionKey: sharedSessionKey ?? turn.sessionKey ?? null,
      };
      artifact.metrics = {
        ...(artifact.metrics ?? {}),
        timeToFinalAnswerMs: totalDurationMs,
        usageInput: totalUsageInput,
        usageOutput: totalUsageOutput,
        costUsd: totalCostUsd,
        toolCallCount: totalToolCalls,
        contextEstimatedInputTokens: totalContextEstimatedInputTokens,
      };
      artifact.result = "failed";
      artifact.failureClass = "llm_misroute";
      artifact.misrouteClass = misrouteClass;
      await cleanupAgentRun();
      return artifact;
    }

    if (runRecord.status !== "completed") {
      artifact.raw = {
        ...(artifact.raw ?? {}),
        runId: data.runId,
        runStatus: runRecord.status,
        outputText,
        runRecord,
        turns: runTurns,
        sessionKey: sharedSessionKey ?? turn.sessionKey ?? null,
      };
      artifact.metrics = {
        ...(artifact.metrics ?? {}),
        timeToFinalAnswerMs: totalDurationMs,
        usageInput: totalUsageInput,
        usageOutput: totalUsageOutput,
        costUsd: totalCostUsd,
        toolCallCount: totalToolCalls,
        contextEstimatedInputTokens: totalContextEstimatedInputTokens,
      };
      if (isExpectedAwaitingHumanStatus({ scenario, runRecord })) {
        break;
      }
      artifact.result = ["awaiting_clarification", "awaiting_plan_approval"].includes(runRecord.status) ? "failed" : "partial";
      artifact.failureClass = runRecord.status === "failed" ? "provider_protocol" : "llm_behavior";
      artifact.notes = [...(artifact.notes ?? []), runRecord.errorMessage ?? `terminal status ${runRecord.status}`];
      await cleanupAgentRun();
      return artifact;
    }
  }

  const agentToolCalls = await readAgentToolCalls(lastRunRecord);

  artifact.raw = {
    ...(artifact.raw ?? {}),
    runId: lastData?.runId ?? null,
    runStatus: lastRunRecord?.status ?? null,
    outputText,
    runRecord: lastRunRecord,
    turns: runTurns,
    sessionKey: sharedSessionKey ?? null,
    ...(
      (execution.expectedToolResultSubstrings ?? []).length > 0
      || (execution.expectedToolNames ?? []).length > 0
        ? { agentToolCalls }
        : {}
    ),
  };
  artifact.observedEvidence.push(
    `provider ${lastRunRecord?.actualExecution?.actualProviderId ?? lane.providerId}`,
    `model ${lastRunRecord?.actualExecution?.actualModel ?? lane.model}`,
  );
  artifact.metrics = {
    ...(artifact.metrics ?? {}),
    timeToFinalAnswerMs: totalDurationMs,
    usageInput: totalUsageInput,
    usageOutput: totalUsageOutput,
    costUsd: totalCostUsd,
    toolCallCount: totalToolCalls,
    contextEstimatedInputTokens: totalContextEstimatedInputTokens,
  };
  artifact.result = "passed";

  for (const expected of execution.expectedOutputSubstrings ?? []) {
    const snippet = interpolateTemplateString(String(expected), agentTemplateContext);
    if (!outputText.includes(snippet)) {
      artifact.result = "failed";
      artifact.failureClass = "llm_behavior";
      artifact.notes = [
        ...(artifact.notes ?? []),
        `expected response to include ${JSON.stringify(snippet)}`,
      ];
    }
  }

  for (const expected of execution.expectedToolResultSubstrings ?? []) {
    const snippet = interpolateTemplateString(String(expected), agentTemplateContext);
    const toolEvidenceText = JSON.stringify(agentToolCalls);
    if (!toolEvidenceText.includes(snippet)) {
      artifact.result = "failed";
      artifact.failureClass = "tool_bridge";
      artifact.notes = [
        ...(artifact.notes ?? []),
        `expected tool evidence to include ${JSON.stringify(snippet)}`,
      ];
    }
  }

  for (const expectedToolName of execution.expectedToolNames ?? []) {
    const found = agentToolCalls.some((call) => call?.toolName === expectedToolName || call?.name === expectedToolName);
    if (!found) {
      artifact.result = "failed";
      artifact.failureClass = "tool_bridge";
      artifact.notes = [
        ...(artifact.notes ?? []),
        `expected tool evidence for ${JSON.stringify(expectedToolName)}`,
      ];
    }
  }

  if (typeof execution.expectWorkspaceFileTopH1 === "string" && execution.expectWorkspaceFileTopH1.trim().length > 0) {
    const relativeFilePath = execution.expectWorkspaceFileTopH1.trim();
    const absoluteFilePath = path.resolve(process.cwd(), relativeFilePath);
    try {
      const markdownText = await fs.readFile(absoluteFilePath, "utf8");
      const expectedHeading = extractTopWorkspaceHeading(markdownText);
      artifact.observedEvidence.push(
        `workspace file ${relativeFilePath}`,
        `workspace top heading ${expectedHeading ?? "missing"}`,
      );
      const toolEvidence = sanitizeToolEvidence({
        toolCalls: agentToolCalls,
        expectedHeading,
        expectedPath: relativeFilePath,
      });
      const hasExpectedReadToolEvidence = toolEvidence.some((entry) =>
        entry.toolName === "read"
        && entry.isError === false
        && entry.matchesExpectedPath === true
        && entry.matchesExpectedHeading === true
      );
      artifact.raw = {
        ...(artifact.raw ?? {}),
        workspaceFileOracle: {
          path: relativeFilePath,
          expectedHeading,
        },
        toolEvidence,
      };
      if (!hasExpectedReadToolEvidence) {
        artifact.result = "failed";
        artifact.failureClass = "tool_bridge";
        artifact.notes = [
          ...(artifact.notes ?? []),
          `expected successful read tool evidence for ${relativeFilePath} containing workspace top heading ${JSON.stringify(expectedHeading)}`,
        ];
      }
      if (!expectedHeading || !normalizeHeadingText(outputText).includes(expectedHeading)) {
        artifact.result = "failed";
        artifact.failureClass = "tool_bridge";
        artifact.notes = [
          ...(artifact.notes ?? []),
          `expected response to include workspace top heading ${JSON.stringify(expectedHeading)}`,
        ];
      }
    } catch (error) {
      artifact.result = "failed";
      artifact.failureClass = "environment";
      artifact.notes = [
        ...(artifact.notes ?? []),
        `failed to read oracle file ${relativeFilePath}: ${error instanceof Error ? error.message : String(error)}`,
      ];
    }
  }

  if (typeof execution.expectMissingWorkspaceFile === "string" && execution.expectMissingWorkspaceFile.trim().length > 0) {
    const relativeFilePath = execution.expectMissingWorkspaceFile.trim();
    const absoluteFilePath = path.resolve(process.cwd(), relativeFilePath);
    const exists = await pathExists(absoluteFilePath);
    const toolEvidence = sanitizeToolEvidence({
      toolCalls: agentToolCalls,
      expectedHeading: null,
      expectedPath: relativeFilePath,
    });
    const hasExpectedMissingReadEvidence = toolEvidence.some((entry) =>
      entry.toolName === "read"
      && entry.isError === true
      && entry.matchesExpectedPath === true
    );
    artifact.observedEvidence.push(
      `workspace missing file oracle ${relativeFilePath}`,
      `workspace file exists ${String(exists)}`,
    );
    artifact.raw = {
      ...(artifact.raw ?? {}),
      missingWorkspaceFileOracle: {
        path: relativeFilePath,
        exists,
      },
      toolEvidence,
    };
    if (exists) {
      artifact.result = "failed";
      artifact.failureClass = "environment";
      artifact.notes = [
        ...(artifact.notes ?? []),
        `expected workspace file ${relativeFilePath} to be missing`,
      ];
    }
    if (!hasExpectedMissingReadEvidence) {
      artifact.result = "failed";
      artifact.failureClass = "tool_bridge";
      artifact.notes = [
        ...(artifact.notes ?? []),
        `expected failed read tool evidence for missing workspace file ${relativeFilePath}`,
      ];
    }
  }

  if (typeof execution.expectToolCallCountMin === "number" && totalToolCalls < execution.expectToolCallCountMin) {
    artifact.result = "failed";
    artifact.failureClass = "tool_bridge";
    artifact.notes = [...(artifact.notes ?? []), `expected at least ${String(execution.expectToolCallCountMin)} tool calls`];
  }
  await cleanupAgentRun();
  return artifact;
}

function buildApprovalGraph({ workflowId, workflowVersionId }) {
  const graph = {
    schemaVersion: "2.0",
    workflowId,
    workflowVersionId,
    sourceSpecSchemaVersion: "1.0",
    graph: {
      nodes: [
        {
          id: "trigger-1",
          type: "trigger",
          label: "Manual Trigger",
          config: { triggerType: "manual" },
        },
        {
          id: "approval-1",
          type: "approval",
          label: "Approve Step",
          config: {
            approverRole: "admin",
            timeoutMs: 60_000,
            requestPayload: {
              source: "real-world-validation",
              workflowId,
              workflowVersionId,
            },
          },
        },
        {
          id: "ai-1",
          type: "ai",
          label: "After Approval Summary",
          config: {
            prompt: "Approval received. Return a single short sentence that confirms the workflow resumed after approval.",
          },
        },
      ],
      edges: [
        { id: "e1", sourceNodeId: "trigger-1", targetNodeId: "approval-1" },
        { id: "e2", sourceNodeId: "approval-1", targetNodeId: "ai-1" },
      ],
    },
    failurePolicy: {
      onFailure: "fail_fast",
      notifyUser: false,
    },
    tests: [],
  };
  const checksum = crypto.createHash("sha256").update(JSON.stringify(graph)).digest("hex");
  return {
    ...graph,
    checksum,
  };
}

async function executeWorkflowRoundtrip({ artifact, client, scenario }) {
  const prefix = `${scenario.execution.slugPrefix ?? "real-world-validation"}-${Date.now().toString(36)}`;
  const name = scenario.execution.workflowName ?? "Real World Validation Approval Workflow";
  const graph = buildApprovalGraph({ workflowId: prefix, workflowVersionId: `${prefix}-v1` });
  const createResult = await client.api("POST", "/v1/workflows", {
    slug: prefix,
    name,
    graph,
  });
  const workflowId = createResult.data.workflow.id;
  const versionNumber = createResult.data.version.versionNumber ?? 1;
  await client.api("POST", `/v1/workflows/${encodeURIComponent(workflowId)}/publish`, { versionNumber });
  const startRun = await client.api("POST", "/v1/workflow-runs", {
    workflowId,
    triggerType: "manual",
    triggerPayload: {},
  });
  const runId = startRun.data.run.id;
  const approvals = await client.waitFor(
    async () => (await client.api("GET", "/v1/workflow-approvals")).data.items,
    (items) => items.some((item) => item.runId === runId),
    { maxMs: scenarioTimeout(scenario, 90_000), intervalMs: 1_000 },
  );
  const approval = approvals.find((item) => item.runId === runId);
  await client.api(
    "POST",
    `/v1/workflow-approvals/${encodeURIComponent(approval.id)}/approve`,
    { comment: "approved by real-world validation harness" },
  );
  const runRecord = await client.waitFor(
    async () => (await client.api("GET", `/v1/workflow-runs/${encodeURIComponent(runId)}`)).data.run,
    (run) => ["completed", "failed", "cancelled", "paused"].includes(run.status),
    { maxMs: scenarioTimeout(scenario, 120_000), intervalMs: 1_500 },
  );
  const evidence = await client.request("GET", `/v1/workflow-runs/${encodeURIComponent(runId)}/evidence`);

  artifact.traceRefs.push(`/v1/workflow-runs/${encodeURIComponent(runId)}`);
  artifact.auditRefs.push(`/v1/workflow-approvals/${encodeURIComponent(approval.id)}`);
  artifact.metrics = {
    ...(artifact.metrics ?? {}),
    timeToFinalAnswerMs: Date.parse(runRecord.finishedAt ?? nowIso()) - Date.parse(runRecord.startedAt ?? nowIso()),
  };
  artifact.observedEvidence.push(
    `workflow ${workflowId} created`,
    `approval ${approval.id} approved`,
    `workflow run ${runId} -> ${runRecord.status}`,
    evidence.ok ? "run evidence endpoint reachable" : "run evidence endpoint unavailable",
  );
  artifact.raw = {
    ...(artifact.raw ?? {}),
    workflowId,
    runId,
    approvalId: approval.id,
    runRecord,
    evidence: evidence.json?.data ?? null,
  };
  artifact.result = runRecord.status === "completed" ? "passed" : "failed";
  artifact.failureClass = runRecord.status === "completed" ? undefined : "workflow_runtime";
  return artifact;
}

async function executeSkillGeneratorLoop({ artifact, client, scenario }) {
  const requestedModel = scenario.execution.requestedModel;
  const start = await client.api("POST", "/v1/skills/generator/sessions", {
    goal: scenario.realWorldPrompt,
    requestedModel,
    userId: client.user?.id ?? "operator",
    channel: "real-world-validation",
  });
  const sessionId = start.data.session.sessionId ?? start.data.session.id;
  if (scenario.execution.message) {
    await client.api("POST", `/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}/messages`, {
      message: scenario.execution.message,
      requestedModel,
    });
  }
  const generate = await client.api("POST", `/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}/generate`, {
    requestedModel,
  });
  const testResult = await client.api("POST", `/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}/test`, {});
  const evidence = await client.api("GET", `/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}/evidence`);
  let approve = null;
  let savedSkill = null;
  let runResult = null;
  const approvalReady = evidence.data.evidence?.approvalReadiness?.ready === true;
  if (scenario.execution.approve === true && approvalReady) {
    approve = await client.api("POST", `/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}/approve`, {});
    const skillId = approve.data.skillId;
    savedSkill = await client.api("GET", `/v1/skills/${encodeURIComponent(skillId)}`);
    runResult = await client.api("POST", `/v1/skills/${encodeURIComponent(skillId)}/run`, {
      input: {
        task: "Return the generated proof output.",
      },
    });
  } else if (scenario.execution.approve === true && !approvalReady) {
    artifact.notes = [...(artifact.notes ?? []), "approval skipped because evidence.approvalReadiness.ready is false"];
  }
  artifact.observedEvidence.push(
    `skill generator session ${sessionId}`,
    `draft validation ${generate.data.draft?.validation?.ok === true ? "ok" : "failed"}`,
    `self-test ${testResult.data.test?.ok === true ? "ok" : "failed"}`,
    `approval readiness ${evidence.data.evidence?.approvalReadiness?.ready === true ? "ready" : "not-ready"}`,
    ...(approve ? [`approved skill ${approve.data.skillId}`] : []),
    ...(runResult ? [`saved skill run ${runResult.data?.status === "completed" ? "completed" : "failed"}`] : []),
  );
  artifact.metrics = {
    ...(artifact.metrics ?? {}),
    repairAttempts: evidence.data.evidence?.repairSummary?.attempts ?? 0,
    validationIssueCount: evidence.data.evidence?.validationSummary?.issueCount ?? 0,
    approvalReady: approvalReady ? 1 : 0,
  };
  artifact.raw = {
    ...(artifact.raw ?? {}),
    sessionId,
    draft: generate.data.draft,
    test: testResult.data.test,
    evidence: evidence.data.evidence,
    approve: approve?.data ?? null,
    savedSkill: savedSkill?.data ?? null,
    runResult: runResult?.data ?? null,
  };
  artifact.result =
    testResult.data.test?.ok === true &&
    (scenario.execution.approve !== true || runResult?.data?.status === "completed")
      ? "passed"
      : "failed";
  artifact.failureClass = artifact.result === "passed" ? undefined : "generator";
  return artifact;
}

async function executeWorkflowGeneratorLoop({ artifact, client, scenario }) {
  const requestedModel = scenario.execution.requestedModel;
  const start = await client.api("POST", "/v1/workflows/generator/sessions", {
    goal: scenario.realWorldPrompt,
    requestedModel,
    userId: client.user?.id ?? "operator",
    channel: "real-world-validation",
  });
  const sessionId = start.data.session.sessionId ?? start.data.session.id;
  if (scenario.execution.message) {
    await client.api("POST", `/v1/workflows/generator/sessions/${encodeURIComponent(sessionId)}/messages`, {
      message: scenario.execution.message,
      requestedModel,
    });
  }
  const generate = await client.api("POST", `/v1/workflows/generator/sessions/${encodeURIComponent(sessionId)}/generate`, {
    requestedModel,
  });
  const evidence = await client.api("GET", `/v1/workflows/generator/sessions/${encodeURIComponent(sessionId)}/evidence`);
  let approve = null;
  const approvalReady = evidence.data.evidence?.approvalReadiness?.ready === true;
  if (scenario.execution.approve === true && approvalReady) {
    approve = await client.api("POST", `/v1/workflows/generator/sessions/${encodeURIComponent(sessionId)}/approve`, {});
  } else if (scenario.execution.approve === true && !approvalReady) {
    artifact.notes = [...(artifact.notes ?? []), "approval skipped because evidence.approvalReadiness.ready is false"];
  }
  artifact.observedEvidence.push(
    `workflow generator session ${sessionId}`,
    `draft validation ${generate.data.draft?.validation?.ok === true ? "ok" : "failed"}`,
    `approval readiness ${evidence.data.evidence?.approvalReadiness?.ready === true ? "ready" : "not-ready"}`,
  );
  artifact.metrics = {
    ...(artifact.metrics ?? {}),
    repairAttempts: evidence.data.evidence?.validationSummary?.repairAttempts ?? 0,
    validationIssueCount: evidence.data.evidence?.validationSummary?.issueCount ?? 0,
    approvalReady: approvalReady ? 1 : 0,
  };
  artifact.raw = {
    ...(artifact.raw ?? {}),
    sessionId,
    draft: generate.data.draft,
    evidence: evidence.data.evidence,
    approve: approve?.data ?? null,
  };
  artifact.result = generate.data.draft?.validation?.ok === true ? "passed" : "failed";
  artifact.failureClass = artifact.result === "passed" ? undefined : "generator";
  return artifact;
}

async function executePersonaLearning({ artifact, client, scenario }) {
  const before = await client.api("GET", "/v1/uix/persona");
  const update = await client.api("PUT", "/v1/uix/preferences", {
    preferences: scenario.execution.preferences,
  });
  const after = await client.api("GET", "/v1/uix/persona");
  for (const preference of update.data.preferences ?? []) {
    await client.request("DELETE", `/v1/uix/preferences/${encodeURIComponent(preference.id)}`, {
      timeoutMs: 30_000,
    }).catch(() => undefined);
  }
  artifact.observedEvidence.push(
    `persona before ${before.data.persona?.settings?.directness ?? "n/a"}`,
    `persona after ${after.data.persona?.settings?.directness ?? "n/a"}`,
    `updated ${String(update.data.updated ?? 0)} preferences`,
  );
  artifact.raw = {
    ...(artifact.raw ?? {}),
    before: before.data.persona,
    after: after.data.persona,
    update: update.data,
  };
  const expectedChecks = scenario.execution.expectPersonaChecks ?? [];
  const failures = expectedChecks.filter((check) => resolveJsonPath(after.data.persona, check.path) !== check.equals);
  artifact.result = failures.length === 0 ? "passed" : "failed";
  artifact.failureClass = artifact.result === "passed" ? undefined : "learning_evidence";
  artifact.notes = failures.map((check) => `${check.path} expected ${JSON.stringify(check.equals)}`);
  return artifact;
}

const DISCORD_API_BASE = "https://discord.com/api/v10";

function readRequiredEnv(name) {
  const value = process.env[name]?.trim() ?? "";
  if (!value) {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
}

function idTail(value) {
  const raw = String(value ?? "");
  return raw.length > 6 ? raw.slice(-6) : raw;
}

function redactDiscordPathname(pathname) {
  return String(pathname).replace(/\d{12,}/gu, (value) => `<id:${idTail(value)}>`);
}

function redactDiscordErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\d{12,}/gu, (value) => `<id:${idTail(value)}>`);
}

function discordDiagnosticText(value, max = 320) {
  const redacted = redactDiscordErrorMessage(String(value ?? ""));
  return redacted.length > max ? `${redacted.slice(0, max)}...` : redacted;
}

function summarizeDiscordSetupVerification(data) {
  const source = data && typeof data === "object" ? data : {};
  const warnings = Array.isArray(source.warnings)
    ? source.warnings.map((warning) => discordDiagnosticText(warning)).slice(0, 5)
    : [];
  return {
    status: typeof source.status === "string" ? source.status : "unknown",
    dmVerified: source.dmVerified === true,
    ...(typeof source.guildVerified === "boolean" ? { guildVerified: source.guildVerified } : {}),
    ...(typeof source.message === "string" && source.message.trim()
      ? { message: discordDiagnosticText(source.message) }
      : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function formatDiscordSetupVerificationSummary(summary) {
  return [
    `status=${summary.status}`,
    `dmVerified=${String(summary.dmVerified)}`,
    ...(typeof summary.guildVerified === "boolean" ? [`guildVerified=${String(summary.guildVerified)}`] : []),
    ...(summary.message ? [`message=${summary.message}`] : []),
    ...(summary.warnings?.length ? [`warnings=${summary.warnings.join(" | ")}`] : []),
  ].join("; ");
}

function buildDiscordDirectDmPreflightSummary({
  setupUserId,
  guildId,
  channelId,
  dmChannelId,
  directDmPreflight,
  error,
}) {
  return {
    directDmPreflight,
    setupUserIdTail: idTail(setupUserId),
    guildIdTail: idTail(guildId),
    channelIdTail: idTail(channelId),
    dmChannelIdTail: idTail(dmChannelId),
    ...(error ? { error: discordDiagnosticText(error) } : {}),
  };
}

function formatDiscordDirectDmPreflightSummary(summary) {
  return [
    `directDmPreflight=${String(summary.directDmPreflight)}`,
    `setupUserIdTail=${summary.setupUserIdTail}`,
    `guildIdTail=${summary.guildIdTail}`,
    `channelIdTail=${summary.channelIdTail}`,
    ...(summary.error ? [`error=${summary.error}`] : []),
  ].join("; ");
}

async function discordApiJson({ token, method = "GET", pathname, body }) {
  const response = await fetch(`${DISCORD_API_BASE}${pathname}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const code = json && typeof json === "object" && "code" in json ? String(json.code) : "unknown";
    throw new Error(`Discord ${method} ${redactDiscordPathname(pathname)} failed with HTTP ${String(response.status)} code=${code}`);
  }
  return { status: response.status, json };
}

async function cleanupDiscordMessages({ artifact, token, messages }) {
  for (const { channelId, messageId } of messages.toReversed()) {
    try {
      await discordApiJson({
        token,
        method: "DELETE",
        pathname: `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
      });
    } catch (error) {
      artifact.notes = [
        ...(artifact.notes ?? []),
        `best-effort Discord cleanup failed for message <id:${idTail(messageId)}>: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ];
    }
  }
}

async function executeDiscordRoundtrip({ artifact, scenario, client }) {
  const tokenEnv = scenario.execution.tokenEnv ?? "FRIDAY_DISCORD_BOT_TOKEN";
  const setupUserIdEnv = scenario.execution.setupUserIdEnv ?? "FRIDAY_DISCORD_SETUP_USER_ID";
  const guildIdEnv = scenario.execution.guildIdEnv ?? "FRIDAY_DISCORD_GUILD_ID";
  const channelIdEnv = scenario.execution.channelIdEnv ?? "FRIDAY_DISCORD_CHANNEL_ID";

  const token = readRequiredEnv(tokenEnv);
  const setupUserId = readRequiredEnv(setupUserIdEnv);
  const guildId = readRequiredEnv(guildIdEnv);
  const channelId = readRequiredEnv(channelIdEnv);
  const proofNonce = `${artifact.runId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
  const baseMessage = `Friday F-008 live Discord proof ${proofNonce}`;
  const replyMessage = `Friday F-008 live Discord reply ${proofNonce}`;
  const sentMessages = [];

  try {
    const me = (await discordApiJson({ token, pathname: "/users/@me" })).json ?? {};
    if (me.bot !== true || typeof me.id !== "string") {
      throw new Error("Discord token did not resolve to a bot user.");
    }

    const guild = (await discordApiJson({ token, pathname: `/guilds/${encodeURIComponent(guildId)}` })).json ?? {};
    if (guild.id !== guildId) {
      throw new Error("Discord guild lookup did not return the expected guild id.");
    }

    const channel = (await discordApiJson({ token, pathname: `/channels/${encodeURIComponent(channelId)}` })).json ?? {};
    if (channel.id !== channelId) {
      throw new Error("Discord channel lookup did not return the expected channel id.");
    }
    if (channel.guild_id !== guildId) {
      throw new Error("Discord channel is not in the expected sandbox guild.");
    }

    const dmChannel = (await discordApiJson({
      token,
      method: "POST",
      pathname: "/users/@me/channels",
      body: { recipient_id: setupUserId },
    })).json ?? {};
    if (typeof dmChannel.id !== "string") {
      throw new Error("Discord did not return a setup-user DM channel id.");
    }

    try {
      const directDmPreflight = (await discordApiJson({
        token,
        method: "POST",
        pathname: `/channels/${encodeURIComponent(dmChannel.id)}/messages`,
        body: { content: `Friday F-008 setup DM preflight ${proofNonce}` },
      })).json ?? {};
      if (typeof directDmPreflight.id !== "string") {
        throw new Error("Discord setup-user DM preflight did not return a message id.");
      }
      sentMessages.push({ channelId: dmChannel.id, messageId: directDmPreflight.id });
      artifact.raw = {
        ...(artifact.raw ?? {}),
        discordDirectDmPreflight: buildDiscordDirectDmPreflightSummary({
          setupUserId,
          guildId,
          channelId,
          dmChannelId: dmChannel.id,
          directDmPreflight: true,
        }),
      };
    } catch (error) {
      const preflight = buildDiscordDirectDmPreflightSummary({
        setupUserId,
        guildId,
        channelId,
        dmChannelId: dmChannel.id,
        directDmPreflight: false,
        error,
      });
      artifact.raw = {
        ...(artifact.raw ?? {}),
        discordDirectDmPreflight: preflight,
      };
      throw new Error(`Discord setup-user DM preflight failed (${formatDiscordDirectDmPreflightSummary(preflight)}).`);
    }

    const verificationBegin = await client.api("POST", "/v1/setup/channels/discord/verification/begin", {
      token,
      guildId,
    });
    const setupVerificationId = verificationBegin.data?.verificationId;
    if (typeof setupVerificationId !== "string") {
      throw new Error("Friday Discord setup did not return a verification id.");
    }
    const verificationComplete = await client.api("POST", "/v1/setup/channels/discord/verification/complete", {
      verificationId: setupVerificationId,
      userId: setupUserId,
      guildId,
    });
    if (verificationComplete.data?.status !== "success" || verificationComplete.data?.dmVerified !== true) {
      const setupVerification = summarizeDiscordSetupVerification(verificationComplete.data);
      artifact.raw = {
        ...(artifact.raw ?? {}),
        discordSetupVerification: setupVerification,
      };
      throw new Error(
        `Friday Discord setup verification did not complete successfully (${formatDiscordSetupVerificationSummary(
          setupVerification,
        )}).`,
      );
    }
    if (typeof verificationComplete.data?.welcomeMessageId === "string") {
      sentMessages.push({ channelId: dmChannel.id, messageId: verificationComplete.data.welcomeMessageId });
    }
    await client.api("POST", "/v1/setup/channels", {
      controlConfirmed: true,
      channels: [{
        kind: "discord",
        enabled: true,
        config: {
          token,
          intents: 0,
          botUserId: me.id,
          allowedChannels: [channelId],
          setupVerificationId,
          setupUserId,
        },
      }],
    });

    const session = await client.api("POST", "/v1/sessions", {
      channel: "discord",
      chatId: channelId,
      accountId: "real-world-validation",
      chatKind: "group",
      metadata: {
        scenarioId: scenario.id,
        proof: "f008-discord-roundtrip",
      },
    });
    const sessionKey = session.data?.session?.key;
    if (typeof sessionKey !== "string") {
      throw new Error("Friday session create did not return a session key.");
    }

    const outbound = await client.api("POST", `/v1/sessions/${encodeURIComponent(sessionKey)}/outbound`, {
      text: baseMessage,
      metadata: { proof: "f008-discord-roundtrip" },
    });
    const sentMessageId = outbound.data?.delivery?.messageId;
    if (typeof sentMessageId !== "string") {
      throw new Error("Friday channel outbound did not return a Discord message id.");
    }
    sentMessages.push({ channelId, messageId: sentMessageId });

    const readBack = (await discordApiJson({
      token,
      pathname: `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(sentMessageId)}`,
    })).json ?? {};
    if (readBack.content !== baseMessage) {
      throw new Error("Discord channel message readback did not match Friday outbound content.");
    }

    const replyOutbound = await client.api("POST", `/v1/sessions/${encodeURIComponent(sessionKey)}/outbound`, {
      text: replyMessage,
      replyToMessageId: sentMessageId,
      metadata: { proof: "f008-discord-roundtrip" },
    });
    const replyMessageId = replyOutbound.data?.delivery?.messageId;
    if (typeof replyMessageId !== "string") {
      throw new Error("Friday channel outbound did not return a Discord reply message id.");
    }
    sentMessages.push({ channelId, messageId: replyMessageId });

    const replyReadBack = (await discordApiJson({
      token,
      pathname: `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(replyMessageId)}`,
    })).json ?? {};
    if (replyReadBack.content !== replyMessage) {
      throw new Error("Discord reply readback did not match Friday outbound content.");
    }

    artifact.result = "passed";
    artifact.observedEvidence.push(
      "Discord bot identity resolved",
      "sandbox guild/channel resolved",
      "Friday Discord setup verification completed",
      "Friday session outbound channel message sent and read back",
      "Friday session outbound reply sent and read back",
      "setup user DM channel resolved",
    );
    artifact.metrics = {
      ...(artifact.metrics ?? {}),
      discordMessagesReadBack: 2,
    };
    artifact.raw = {
      ...(artifact.raw ?? {}),
      discordEvidence: {
        botUserIdTail: idTail(me.id),
        guildIdTail: idTail(guildId),
        channelIdTail: idTail(channelId),
        setupUserIdTail: idTail(setupUserId),
        dmChannelIdTail: idTail(dmChannel.id),
        sessionKeyTail: idTail(sessionKey),
        outboundMessageIdTail: idTail(sentMessageId),
        replyMessageIdTail: idTail(replyMessageId),
        channelGuildMatched: true,
        fridaySetupVerified: true,
        readBackMatched: true,
        replyReadBackMatched: true,
        contentLengths: {
          outbound: baseMessage.length,
          reply: replyMessage.length,
        },
      },
    };
    return artifact;
  } catch (error) {
    throw new Error(redactDiscordErrorMessage(error));
  } finally {
    await cleanupDiscordMessages({ artifact, token, messages: sentMessages });
  }
}

function buildRggSkillManifest({ skillId, version, withFormatInput }) {
  return {
    schemaVersion: "2.0",
    id: skillId,
    name: `RGG Phase 14 Skill v${version}`,
    description: "RGG Phase 14 release-proof self-staged skill",
    version,
    kind: "conversation",
    category: "utility",
    author: { name: "rgg-phase14" },
    tags: ["phase-14", "release-proof", "rgg-self-staged"],
    runtime: {
      kind: "shell",
      entrypoint: "run.sh",
      minHubVersion: "1.0.0",
      apiVersion: "1",
      timeoutMsDefault: 5_000,
    },
    triggers: { intents: [], phrases: [], channels: ["*"] },
    invocation: {
      userInvocable: true,
      modelInvocable: true,
      priority: 50,
      modes: ["intent", "workflow"],
    },
    requirements: { bins: [], env: [], config: [], os: ["darwin", "linux", "win32"] },
    inputs: withFormatInput
      ? [
        { key: "query", type: "string", required: false, label: "Query input" },
        { key: "format", type: "string", required: false, label: "Output format" },
      ]
      : [
        { key: "query", type: "string", required: false, label: "Query input" },
      ],
    outputs: [{ key: "result", type: "string", description: "Run result" }],
    permissions: withFormatInput
      ? {
        grants: [
          {
            id: "rgg-phase14-network-read",
            resource: "network",
            action: "read",
            required: true,
            reason: "RGG Phase 14 lifecycle proof skill reads remote feed",
          },
        ],
        promptOn: [],
      }
      : { grants: [], promptOn: [] },
    schemas: { input: null, state: null, output: null },
    flow: null,
    executionTargets: {
      allowedSatelliteTypes: ["phone", "desktop", "rpi", "cloud-vm"],
      requiredCapabilities: [],
    },
    telemetry: { events: [] },
  };
}

function buildRggSkillUiSchema(manifest) {
  return {
    schemaVersion: "1.0",
    title: manifest.name,
    sections: [],
    fields: [],
    outputs: [],
    actions: [],
  };
}

async function writeRggSkillCandidateDir({ skillId, version, dir, withFormatInput }) {
  await fs.mkdir(dir, { recursive: true });
  const manifest = buildRggSkillManifest({ skillId, version, withFormatInput });
  await fs.writeFile(
    path.join(dir, "skill.manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  await fs.writeFile(path.join(dir, "SKILL.md"), `# ${manifest.name}\n`, "utf8");
  await fs.writeFile(
    path.join(dir, "skill.ui.json"),
    JSON.stringify(buildRggSkillUiSchema(manifest), null, 2),
    "utf8",
  );
  const entryPath = path.join(dir, manifest.runtime.entrypoint);
  await fs.writeFile(
    entryPath,
    `#!/usr/bin/env bash\necho '{"result":"rgg-phase14-${manifest.version}"}'\n`,
    "utf8",
  );
  await fs.chmod(entryPath, 0o755);
  return manifest;
}

async function stageRggSkillCandidate({
  client,
  skillId,
  version,
  dir,
  withFormatInput,
  actor,
  tokenSecret,
  expiresAt,
  approvalIdSuffix,
}) {
  await writeRggSkillCandidateDir({ skillId, version, dir, withFormatInput });
  const source = { uri: dir, formatHint: "friday-package" };
  const target = "managed";
  const stageRequest = buildSkillImportStageApprovalRequest({
    source,
    formatHint: "friday-package",
    target,
    actor,
    surface: "api:/v1/skills/import",
  });
  const canonicalApproval = signCanonicalApprovalForRequest({
    request: stageRequest,
    tokenSecret,
    approvalId: `rgg-phase14-stage-${approvalIdSuffix}`,
    decidedByPrincipalId: actor.principalId,
    expiresAt,
  });
  const response = await client.api(
    "POST",
    "/v1/skills/import",
    {
      source,
      formatHint: "friday-package",
      target,
      canonicalApproval,
    },
  );
  const candidates = Array.isArray(response?.data?.candidates) ? response.data.candidates : [];
  const candidate = candidates.find((entry) => entry?.skillId === skillId) ?? candidates[0];
  const candidateId = candidate?.candidateId;
  if (typeof candidateId !== "string" || candidateId.trim().length === 0) {
    throw new Error(
      `POST /v1/skills/import for ${skillId} v${version} returned no candidateId; response: ${JSON.stringify(response?.data).slice(0, 600)}`,
    );
  }
  return { candidateId };
}

async function executeSkillUpgradeLifecycle({ artifact, client, scenario, runId }) {
  const runtimeVersion = String(scenario.execution?.runtimeVersion ?? "rgg-runtime");
  const providerModel = scenario.execution?.providerModel;
  const planDigest = String(scenario.execution?.planDigest ?? "rgg-phase14-plan-digest");
  const tokenSecret = process.env.FRIDAY_TOKEN_SECRET
    ?? process.env.FRIDAY_REAL_WORLD_MINT_TOKEN_SECRET;
  if (!tokenSecret) {
    artifact.result = "blocked";
    artifact.failureClass = "environment";
    artifact.notes = [
      ...(artifact.notes ?? []),
      "skill_upgrade_lifecycle scenario requires FRIDAY_TOKEN_SECRET to sign canonical approvals (auto-generated in standard self-hosted / mint-local-admin RGG runs)",
    ];
    return artifact;
  }
  const runSuffix = (typeof runId === "string" && runId.length > 0
    ? runId
    : crypto.randomBytes(6).toString("hex")
  ).replace(/[^a-z0-9-]/giu, "").slice(0, 24).toLowerCase() || "rgg";
  const skillId = `rgg-phase14-skill-${runSuffix}`;
  const actor = {
    kind: typeof client.user?.role === "string" ? "user" : "api",
    id: client.user?.id ?? "rgg-skill-upgrade-actor",
    principalId: client.user?.id ?? "rgg-skill-upgrade-actor",
  };
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const candidateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "rgg-phase14-skill-candidates-"),
  );
  const v1Dir = path.join(candidateRoot, "v1");
  const v2Dir = path.join(candidateRoot, "v2");

  function signLifecycle(action, candidateId, opts) {
    const request = buildSkillLifecycleApprovalRequest({
      action,
      skillId,
      candidateId,
      runtimeVersion,
      providerModel,
      actor,
      planDigest: action === "shadow" || action === "canary" ? undefined : planDigest,
      canaryInput: opts?.canaryInput,
    });
    return signCanonicalApprovalForRequest({
      request,
      tokenSecret,
      approvalId: `rgg-phase14-${action}-${candidateId}`,
      decidedByPrincipalId: actor.principalId,
      expiresAt,
    });
  }

  async function postAutonomy(action, candidateId, body) {
    const response = await client.api(
      "POST",
      `/v1/autonomy/skills/${encodeURIComponent(skillId)}/${action}`,
      {
        ...body,
        candidateId,
        runtimeVersion,
        providerModel,
        canonicalApproval: signLifecycle(action, candidateId, body),
      },
    );
    return response.data;
  }

  let v1CandidateId = "";
  let v2CandidateId = "";
  try {
    const v1Stage = await stageRggSkillCandidate({
      client,
      skillId,
      version: "1.0.0",
      dir: v1Dir,
      withFormatInput: false,
      actor,
      tokenSecret,
      expiresAt,
      approvalIdSuffix: `${skillId}-v1`,
    });
    v1CandidateId = v1Stage.candidateId;

    await postAutonomy("shadow", v1CandidateId, { shadowVersionId: v1CandidateId });
    await postAutonomy("canary", v1CandidateId, {});
    await postAutonomy("promote", v1CandidateId, { planDigest });

    const v2Stage = await stageRggSkillCandidate({
      client,
      skillId,
      version: "2.0.0",
      dir: v2Dir,
      withFormatInput: true,
      actor,
      tokenSecret,
      expiresAt,
      approvalIdSuffix: `${skillId}-v2`,
    });
    v2CandidateId = v2Stage.candidateId;

    await postAutonomy("shadow", v2CandidateId, { shadowVersionId: v2CandidateId });
    const analyzeResponse = await client.api(
      "POST",
      `/v1/skills/${encodeURIComponent(skillId)}/upgrade/analyze`,
      { candidateId: v2CandidateId },
    );
    const analysis = analyzeResponse.data.analysis;
    const decideRequest = buildSkillUpgradeDecideApprovalRequest({
      skillId,
      candidateId: v2CandidateId,
      decision: "replace",
      analysisDigest: analysis.analysisDigest,
      recommendation: analysis.recommendation,
      regressionVerdict: analysis.regressionProof?.overallVerdict ?? "no_affected_workflows",
      actor,
    });
    const decideApproval = signCanonicalApprovalForRequest({
      request: decideRequest,
      tokenSecret,
      approvalId: `rgg-phase14-decide-${v2CandidateId}`,
      decidedByPrincipalId: actor.principalId,
      expiresAt,
    });
    await client.api(
      "POST",
      `/v1/skills/${encodeURIComponent(skillId)}/upgrade/decide`,
      {
        candidateId: v2CandidateId,
        decision: "replace",
        canonicalApproval: decideApproval,
      },
    );
    await postAutonomy("canary", v2CandidateId, {});
    await postAutonomy("promote", v2CandidateId, { planDigest });
    const rollbackResponse = await postAutonomy("rollback", v2CandidateId, { planDigest });
    if (rollbackResponse?.evidence?.stage !== "rolled_back") {
      throw new Error(`rollback evidence stage was ${String(rollbackResponse?.evidence?.stage)}; expected rolled_back`);
    }
    artifact.result = "passed";
    artifact.observedEvidence.push(
      `v1 candidate self-staged via /v1/skills/import (candidateId=${v1CandidateId})`,
      "v1 autonomy shadow→canary→promote completed",
      `v2 candidate self-staged via /v1/skills/import (candidateId=${v2CandidateId})`,
      "upgrade analyze + decide(replace) executed",
      "v2 autonomy shadow→canary→promote completed",
      `rollback evidence.stage=${rollbackResponse.evidence.stage}`,
    );
    artifact.raw = {
      ...(artifact.raw ?? {}),
      skillId,
      v1CandidateId,
      v2CandidateId,
      rollback: rollbackResponse?.evidence,
    };
  } catch (error) {
    artifact.result = "failed";
    artifact.failureClass = artifact.failureClass ?? "lifecycle_runtime";
    artifact.notes = [
      ...(artifact.notes ?? []),
      error instanceof Error ? error.message : String(error),
    ];
  } finally {
    try {
      await fs.rm(candidateRoot, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; do not mask the lifecycle outcome.
    }
  }
  return artifact;
}

async function executeManualExternal({ artifact, scenario, blockers }) {
  const manualEvidenceTemplate = [
    `surface=${scenario.entrySurface}`,
    "capture inbound timestamp and payload",
    "capture outbound timestamp, text, and attachment state",
    "record retry/dedupe/backlog observations",
    "record trace/audit ids or state why unavailable",
  ];
  artifact.result = blockers.length > 0 ? "blocked" : "manual_review";
  artifact.failureClass = blockers.length > 0 ? "environment" : undefined;
  artifact.notes = [
    ...(artifact.notes ?? []),
    blockers.length > 0
      ? `manual external scenario blocked: ${blockers.join("; ")}`
      : scenario.execution.manualChecklist?.join(" | ") ?? "manual external validation required",
  ];
  artifact.raw = {
    ...(artifact.raw ?? {}),
    manualEvidenceTemplate,
  };
  artifact.humanReviewRequired = true;
  return artifact;
}

export async function executeScenario({
  runId,
  suite,
  scenario,
  lane,
  client,
  envTruth,
  reportRoot,
  uiBaseUrl,
  blockers = [],
  attemptIndex,
  soakWorkerIndex,
}) {
  const artifact = buildArtifactBase({ runId, suite, scenario, lane });
  artifact.eventLog.push(`started ${nowIso()}`);

  if (lane.blockedReason) {
    artifact.result = "blocked";
    artifact.failureClass = "environment";
    artifact.notes = [...(artifact.notes ?? []), lane.blockedReason];
    artifact.eventLog.push(`blocked ${nowIso()}`);
    return artifact;
  }

  if (blockers.length > 0 && scenario.execution.kind !== "manual_external") {
    artifact.result = "blocked";
    artifact.failureClass = "environment";
    artifact.notes = [...(artifact.notes ?? []), ...blockers];
    artifact.eventLog.push(`blocked ${nowIso()}`);
    return artifact;
  }

  try {
    switch (scenario.execution.kind) {
      case "env_truth":
        await executeEnvTruth({ artifact, scenario, envTruth });
        break;
      case "http_probe":
        await executeHttpProbe({ artifact, client, scenario });
        break;
      case "ui_probe":
        await executeUiProbe({ artifact, client, scenario, reportRoot, uiBaseUrl, envTruth });
        break;
      case "agent_run":
        await executeAgentRun({ artifact, client, scenario, lane, suite, attemptIndex, soakWorkerIndex });
        break;
      case "workflow_roundtrip":
        await executeWorkflowRoundtrip({ artifact, client, scenario });
        break;
      case "skill_generator_loop":
        await executeSkillGeneratorLoop({ artifact, client, scenario });
        break;
      case "workflow_generator_loop":
        await executeWorkflowGeneratorLoop({ artifact, client, scenario });
        break;
      case "persona_learning":
        await executePersonaLearning({ artifact, client, scenario });
        break;
      case "discord_roundtrip":
        await executeDiscordRoundtrip({ artifact, scenario, client });
        break;
      case "skill_upgrade_lifecycle":
        await executeSkillUpgradeLifecycle({ artifact, client, scenario, runId });
        break;
      case "auto_fix_doctor_roundtrip":
        await executeAutoFixDoctorRoundtrip({ artifact, client, scenario });
        break;
      case "workflow_evidence_fail_closed":
        await executeWorkflowEvidenceFailClosed({ artifact, client, scenario });
        break;
      case "task_workflow_rollback_matrix":
        await executeTaskWorkflowRollbackMatrix({ artifact, client, scenario });
        break;
      case "manual_external":
        await executeManualExternal({ artifact, scenario, blockers });
        break;
      case "ui_authoring":
        await executeUiAuthoring({ artifact, client, scenario, reportRoot, uiBaseUrl, envTruth });
        break;
      default:
        artifact.result = "failed";
        artifact.failureClass = "unknown";
        artifact.notes = [...(artifact.notes ?? []), `unsupported execution kind ${scenario.execution.kind}`];
        break;
    }
  } catch (error) {
    artifact.result = "failed";
    artifact.failureClass = artifact.failureClass ?? "unknown";
    artifact.notes = [...(artifact.notes ?? []), error instanceof Error ? error.message : String(error)];
  }

  artifact.eventLog.push(`finished ${nowIso()}`);
  return artifact;
}
