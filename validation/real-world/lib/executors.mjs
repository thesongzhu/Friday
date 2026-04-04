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

function getUrlPath(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  try {
    return new URL(value).pathname;
  } catch {
    return value;
  }
}

function isIgnorableUiRequestFailure(message) {
  if (typeof message !== "string" || message.length === 0) return false;
  return /fonts\.(gstatic|googleapis)\.com/i.test(message) && /ERR_ABORTED/i.test(message);
}

function scenarioTimeout(scenario, fallback) {
  return Number(scenario.execution?.timeoutMs) || fallback;
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
  if (typeof turn?.prompt === "string" && turn.prompt.trim().length > 0) {
    return turn.prompt;
  }
  const bySuite = execution.promptVariantsBySuite?.[suite];
  if (Array.isArray(bySuite) && bySuite.length > 0) {
    const index = Math.max(0, ((attemptIndex ?? 1) - 1 + turnIndex) % bySuite.length);
    return bySuite[index];
  }
  if (Array.isArray(execution.promptVariants) && execution.promptVariants.length > 0) {
    const index = Math.max(0, ((attemptIndex ?? 1) - 1 + turnIndex) % execution.promptVariants.length);
    return execution.promptVariants[index];
  }
  return scenario.realWorldPrompt;
}

async function executeHttpProbe({ artifact, client, scenario }) {
  const execution = scenario.execution;
  const query = execution.query
    ? `?${new URLSearchParams(
      Object.entries(execution.query).reduce((acc, [key, value]) => {
        acc[key] = String(value);
        return acc;
      }, {}),
    ).toString()}`
    : "";
  const response = await client.request(execution.method ?? "GET", `${execution.path}${query}`, {
    timeoutMs: scenarioTimeout(scenario, 60_000),
  });
  applyJsonExpectations({ artifact, response, execution });
  if (!response.ok && artifact.result !== "failed") {
    artifact.result = "failed";
    artifact.failureClass = "http_contract";
  }
  return artifact;
}

async function executeUiProbe({ artifact, client, scenario, reportRoot, uiBaseUrl, envTruth }) {
  const execution = scenario.execution;
  const browser = await chromium.launch({ headless: true });
  const requestUrls = [];
  const requestFailures = [];
  const reloadAbortedRequestFailures = [];
  const consoleErrors = [];
  const requestOrder = new WeakMap();
  let requestSequence = 0;
  let reloadAbortCutoff = null;
  const startedAt = Date.now();

  try {
    const context = await browser.newContext({
      baseURL: uiBaseUrl,
      viewport: { width: 1440, height: 960 },
    });
    const session = client.session();
    const storageSeed = {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      user: session.user,
    };
    await context.addInitScript((seed) => {
      if (!seed?.accessToken || !seed?.user) return;
      try {
        localStorage.setItem("friday.auth.accessToken", seed.accessToken);
        if (seed.refreshToken) {
          localStorage.setItem("friday.auth.refreshToken", seed.refreshToken);
        }
        localStorage.setItem("friday.auth.user", JSON.stringify(seed.user));
      } catch {
        // Ignore localStorage failures in browser probes.
      }
    }, storageSeed);

    const page = await context.newPage();
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
    artifact.toolErrors = [...significantRequestFailures, ...consoleErrors];
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
      uiConsoleErrorCount: consoleErrors.length,
      statusCode: gotoResponse?.status() ?? 0,
    };
    artifact.raw = {
      ...(artifact.raw ?? {}),
      finalUrl,
      finalPath,
      requestedPath,
      allowedFinalPathPrefixes,
      consoleErrors,
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

    if (significantRequestFailures.length > 0 || consoleErrors.length > 0) {
      artifact.result = "partial";
      artifact.failureClass = "ui_loading";
      artifact.notes = [
        ...(artifact.notes ?? []),
        significantRequestFailures.length > 0 ? `${String(significantRequestFailures.length)} failed UI requests` : "",
        consoleErrors.length > 0 ? `${String(consoleErrors.length)} console errors` : "",
      ].filter(Boolean);
    }
    return artifact;
  } catch (error) {
    artifact.result = "failed";
    artifact.failureClass = "ui_loading";
    artifact.notes = [...(artifact.notes ?? []), error instanceof Error ? error.message : String(error)];
    return artifact;
  } finally {
    await browser.close();
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
  const approvalReady = evidence.data.evidence?.approvalReadiness?.ready === true;
  if (scenario.execution.approve === true && approvalReady) {
    approve = await client.api("POST", `/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}/approve`, {});
  } else if (scenario.execution.approve === true && !approvalReady) {
    artifact.notes = [...(artifact.notes ?? []), "approval skipped because evidence.approvalReadiness.ready is false"];
  }
  artifact.observedEvidence.push(
    `skill generator session ${sessionId}`,
    `draft validation ${generate.data.draft?.validation?.ok === true ? "ok" : "failed"}`,
    `self-test ${testResult.data.test?.ok === true ? "ok" : "failed"}`,
    `approval readiness ${evidence.data.evidence?.approvalReadiness?.ready === true ? "ready" : "not-ready"}`,
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
  };
  artifact.result = testResult.data.test?.ok === true ? "passed" : "failed";
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
