import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { chromium } from "playwright";
import { ensureDir } from "./io.mjs";
import { resolveJsonPath, safeJsonParse, slugify, stripMarkdownFences } from "./defs.mjs";

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

function resolveAgentTurnPrompt({ scenario, execution, suite, attemptIndex, turn, turnIndex }) {
  const applyPromptVariables = (value) => {
    if (typeof value !== "string" || value.length === 0) {
      return value;
    }
    return value
      .replaceAll("{{repoRoot}}", process.cwd())
      .replaceAll("{{workspaceRoot}}", process.cwd());
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
  if (!response.ok && artifact.result !== "failed") {
    artifact.result = "failed";
    artifact.failureClass = "http_contract";
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

  for (const [index, turn] of turns.entries()) {
    const prompt = resolveAgentTurnPrompt({
      scenario,
      execution,
      suite,
      attemptIndex,
      turn,
      turnIndex: index,
    });
    const { data } = await client.startAgentRun({
      task: prompt,
      providerId: lane.providerId,
      model: lane.model,
      timeoutMs: scenarioTimeout(scenario, 180_000),
      constraints: turn.constraints ?? execution.constraints ?? { readOnly: true },
      taskProfile: turn.taskProfile ?? execution.taskProfile ?? { id: "deterministic" },
      sessionKey: turn.sessionKey ?? sharedSessionKey,
      executionContext: turn.executionContext ?? execution.executionContext,
    });
    const runRecord = (await client.getAgentRun(data.runId)).data.run;
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
      artifact.result = ["awaiting_clarification", "awaiting_plan_approval"].includes(runRecord.status) ? "failed" : "partial";
      artifact.failureClass = runRecord.status === "failed" ? "provider_protocol" : "llm_behavior";
      artifact.notes = [...(artifact.notes ?? []), runRecord.errorMessage ?? `terminal status ${runRecord.status}`];
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

  if (typeof execution.expectToolCallCountMin === "number" && totalToolCalls < execution.expectToolCallCountMin) {
    artifact.result = "failed";
    artifact.failureClass = "tool_bridge";
    artifact.notes = [...(artifact.notes ?? []), `expected at least ${String(execution.expectToolCallCountMin)} tool calls`];
  }
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
      case "manual_external":
        await executeManualExternal({ artifact, scenario, blockers });
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
