import fs from "node:fs";
import path from "node:path";

const BASE_URL = "http://127.0.0.1:3141";
const PROVIDER_ID = "11053bd1-a47b-4e07-a195-59a56a96c83c";
const MODEL = "claude-sonnet-4-20250514";
const ROOT_DIR = "/path/to/friday/artifacts/manual/friday-real-validation-2026-03-31";
const RESPONSES_DIR = path.join(ROOT_DIR, "responses");
const RAW_DIR = path.join(ROOT_DIR, "raw");
const SCREENSHOTS_DIR = path.join(ROOT_DIR, "screenshots");
const TEST_PREFIX = "manual-real-20260331";
const SANDBOX_DIR = "/Users/dev/Desktop/friday-real-test-2026-03-31";

fs.mkdirSync(RESPONSES_DIR, { recursive: true });
fs.mkdirSync(RAW_DIR, { recursive: true });
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
fs.mkdirSync(SANDBOX_DIR, { recursive: true });

const startedAt = new Date().toISOString();
const cases = [];

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function safeWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function normalizeText(text) {
  return typeof text === "string" ? text.trim() : "";
}

async function fetchJson(url, options = {}) {
  const started = Date.now();
  const response = await fetch(url, options);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return {
    status: response.status,
    elapsedMs: Date.now() - started,
    headers: Object.fromEntries(response.headers.entries()),
    text,
    json,
  };
}

async function login() {
  const res = await fetchJson(`${BASE_URL}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ local: true }),
  });
  if (!res.json?.ok) {
    throw new Error(`Login failed: ${res.text}`);
  }
  return res.json.data.accessToken;
}

function authHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

async function api(token, method, urlPath, body) {
  return fetchJson(`${BASE_URL}${urlPath}`, {
    method,
    headers: authHeaders(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function recordCase(name, run) {
  const caseId = slugify(name);
  const started = new Date().toISOString();
  const rawPath = path.join(RESPONSES_DIR, `${caseId}.json`);

  try {
    const result = await run();
    const finished = new Date().toISOString();
    const entry = {
      caseId,
      name,
      startedAt: started,
      finishedAt: finished,
      ...result,
    };
    safeWriteJson(rawPath, entry);
    cases.push(entry);
    return entry;
  } catch (error) {
    const finished = new Date().toISOString();
    const entry = {
      caseId,
      name,
      startedAt: started,
      finishedAt: finished,
      verdict: "FAIL",
      severity: "P1",
      error: error instanceof Error ? error.message : String(error),
    };
    safeWriteJson(rawPath, entry);
    cases.push(entry);
    return entry;
  }
}

function judgeClaudeQuiz(responseText, expects) {
  const response = normalizeText(responseText).toLowerCase();
  if (!response) {
    return { verdict: "FAIL", note: "empty response" };
  }

  const missing = expects.filter((item) => !response.includes(item.toLowerCase()));
  if (missing.length === 0) {
    return { verdict: "PASS", note: "all expected markers found" };
  }
  if (missing.length < expects.length) {
    return { verdict: "PARTIAL", note: `missing markers: ${missing.join(", ")}` };
  }
  return { verdict: "FAIL", note: `none of expected markers found: ${expects.join(", ")}` };
}

async function createSession(token, channel = "manual-real") {
  const sessionKey = `${TEST_PREFIX}-${Date.now().toString(36)}`;
  const createRes = await api(token, "POST", "/v1/sessions", {
    sessionKey,
    channel,
    title: sessionKey,
  });
  if (createRes.status !== 200 || !createRes.json?.ok) {
    throw new Error(`Create session failed: ${createRes.text}`);
  }
  return sessionKey;
}

async function addMessage(token, sessionKey, role, content) {
  const res = await api(
    token,
    "POST",
    `/v1/sessions/${encodeURIComponent(sessionKey)}/messages`,
    { role, content },
  );
  if (res.status !== 200 || !res.json?.ok) {
    throw new Error(`Add message failed: ${res.text}`);
  }
  return res.json;
}

async function runAgent(token, task, extra = {}) {
  const res = await api(token, "POST", "/v1/agent/runs", {
    task,
    providerId: PROVIDER_ID,
    model: MODEL,
    timeoutMs: 90_000,
    ...extra,
  });
  if (res.status !== 200 || !res.json?.ok) {
    throw new Error(`Agent run failed: ${res.text}`);
  }
  return res.json.data;
}

async function pollWorkflowRun(token, runId, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await api(token, "GET", `/v1/workflow-runs/${runId}`);
    if (res.status === 200 && res.json?.ok) {
      const status = res.json.data.run.status;
      if (["completed", "failed", "paused", "cancelled", "rejected"].includes(status)) {
        return res.json.data.run;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`Workflow run ${runId} did not reach terminal state in time`);
}

async function main() {
  const token = await login();

  await recordCase("provider-validate", async () => {
    const res = await api(token, "POST", `/v1/providers/${PROVIDER_ID}/validate`);
    return {
      verdict: res.status === 200 && res.json?.ok ? "PASS" : "FAIL",
      severity: "P0",
      observed: res.json ?? res.text,
      evidence: [`/v1/providers/${PROVIDER_ID}/validate`],
    };
  });

  const claudeQuestions = [
    {
      name: "claude-quiz-capital",
      task: "Answer with one word only: What is the capital of France?",
      expects: ["paris"],
    },
    {
      name: "claude-quiz-json",
      task: "Return strict JSON only with keys answer and confidence. Question: 2+2=?",
      expects: ["\"answer\"", "4"],
    },
    {
      name: "claude-quiz-extract",
      task: "Extract only the email from this text and answer with the email only: Contact Alice at alice@example.com for updates.",
      expects: ["alice@example.com"],
    },
    {
      name: "claude-quiz-format",
      task: "Reply with exactly three bullet points, each under six words, naming primary colors.",
      expects: ["red", "blue", "yellow"],
    },
    {
      name: "claude-quiz-summary",
      task: "Summarize this in exactly 12 words: Friday is a supervised automation platform with evidence, approval, rollback, and observability.",
      expects: ["friday", "approval", "rollback"],
    },
  ];

  for (const quiz of claudeQuestions) {
    await recordCase(quiz.name, async () => {
      const run = await runAgent(token, quiz.task);
      const judged = judgeClaudeQuiz(run.response ?? run.responseText ?? "", quiz.expects);
      return {
        verdict: judged.verdict,
        severity: judged.verdict === "FAIL" ? "P1" : "P2",
        observed: {
          status: run.status,
          durationMs: run.durationMs,
          toolCallCount: run.toolCallCount,
          response: run.response ?? run.responseText ?? "",
        },
        note: judged.note,
      };
    });
  }

  await recordCase("agent-browser-screenshot", async () => {
    const run = await runAgent(
      token,
      "Use the browser tool to open https://example.com and take a screenshot. Return a short confirmation.",
    );
    const images = Array.isArray(run.images) ? run.images : [];
    return {
      verdict:
        run.status === "completed" && images.length > 0 && fs.existsSync(images[0]) ? "PASS" : "FAIL",
      severity: "P1",
      observed: {
        status: run.status,
        toolCallCount: run.toolCallCount,
        response: run.response ?? run.responseText ?? "",
        images,
      },
    };
  });

  await recordCase("agent-desktop-session-info", async () => {
    const run = await runAgent(
      token,
      "Use the desktop tool with action session_info, then summarize whether the desktop session is usable right now.",
    );
    const text = normalizeText(run.response ?? run.responseText ?? "");
    const blocked =
      text.toLowerCase().includes("permission") ||
      text.toLowerCase().includes("automation") ||
      text.toLowerCase().includes("screen recording") ||
      text.toLowerCase().includes("input monitoring");
    return {
      verdict: run.status === "completed" ? (blocked ? "BLOCKED" : "PASS") : "FAIL",
      severity: blocked ? "P1" : "P0",
      observed: {
        status: run.status,
        toolCallCount: run.toolCallCount,
        response: text,
      },
    };
  });

  await recordCase("agent-write-read-sandbox-file", async () => {
    const targetFile = path.join(SANDBOX_DIR, `${TEST_PREFIX}-agent-note.txt`);
    const task = [
      `Use file tools only inside this directory: ${SANDBOX_DIR}.`,
      `Write the exact text "Friday real validation ${TEST_PREFIX}" to ${targetFile}.`,
      "Then read the file back and confirm the exact contents.",
    ].join(" ");
    const run = await runAgent(token, task);
    const exists = fs.existsSync(targetFile);
    const content = exists ? fs.readFileSync(targetFile, "utf8") : "";
    return {
      verdict:
        run.status === "completed" && exists && content.includes(`Friday real validation ${TEST_PREFIX}`)
          ? "PASS"
          : "FAIL",
      severity: "P0",
      observed: {
        status: run.status,
        toolCallCount: run.toolCallCount,
        response: run.response ?? run.responseText ?? "",
        targetFile,
        fileExists: exists,
        content,
      },
    };
  });

  await recordCase("sessions-memory-approval", async () => {
    const sessionKey = await createSession(token);
    await addMessage(token, sessionKey, "user", "Remember that my favorite editor is Neovim.");
    await addMessage(token, sessionKey, "assistant", "Noted: your favorite editor is Neovim.");

    const storeRes = await api(token, "POST", "/v1/memory/store", {
      namespace: `${TEST_PREFIX}.memory`,
      content: "favorite editor is Neovim",
      source: "manual-http-validation",
      tags: ["editor", "preference"],
    });
    const searchRes = await api(token, "POST", "/v1/memory/search", {
      namespace: `${TEST_PREFIX}.memory`,
      query: "favorite editor",
    });
    const forkRes = await api(
      token,
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionKey)}/fork`,
      { title: `${sessionKey}-fork` },
    );
    const forkKey = forkRes.json?.data?.fork?.sessionKey ?? forkRes.json?.data?.session?.sessionKey;
    let mergeRes = null;
    if (forkKey) {
      await addMessage(token, forkKey, "user", "Fork-specific work item.");
      mergeRes = await api(
        token,
        "POST",
        `/v1/sessions/${encodeURIComponent(sessionKey)}/merge`,
        { forkSessionKey: forkKey, summary: "Merged fork back into parent." },
      );
    }

    const verdict =
      storeRes.status === 200 &&
      searchRes.status === 200 &&
      (searchRes.json?.data?.items?.length ?? 0) > 0 &&
      forkRes.status === 200 &&
      mergeRes?.status === 200
        ? "PASS"
        : "FAIL";

    return {
      verdict,
      severity: "P1",
      observed: {
        sessionKey,
        forkKey,
        storeStatus: storeRes.status,
        searchStatus: searchRes.status,
        searchHits: searchRes.json?.data?.items?.length ?? 0,
        forkStatus: forkRes.status,
        mergeStatus: mergeRes?.status ?? null,
      },
    };
  });

  await recordCase("skill-generator-save", async () => {
    const startRes = await api(token, "POST", "/v1/skills/generator/sessions", {
      goal: `Create a shell skill named ${TEST_PREFIX}-date-skill that writes the current UTC date to stdout in ISO 8601 format.`,
      userId: "local-admin",
      channel: "assistant",
      requestedModel: MODEL,
    });
    if (startRes.status !== 200 || !startRes.json?.ok) {
      return {
        verdict: "FAIL",
        severity: "P1",
        observed: startRes.json ?? startRes.text,
      };
    }
    const sessionId = startRes.json.data.session.sessionId;
    const mode = startRes.json.data.mode;
    if (mode === "clarification_required") {
      await api(token, "POST", `/v1/skills/generator/sessions/${sessionId}/messages`, {
        message: "Use bash and the date command. No inputs. Output a single ISO 8601 UTC timestamp.",
        requestedModel: MODEL,
      });
    }
    const generateRes = await api(token, "POST", `/v1/skills/generator/sessions/${sessionId}/generate`, {
      requestedModel: MODEL,
    });
    if (generateRes.status !== 200 || !generateRes.json?.ok) {
      return {
        verdict: "FAIL",
        severity: "P1",
        observed: {
          sessionId,
          generateStatus: generateRes.status,
          body: generateRes.json ?? generateRes.text,
        },
      };
    }
    const approveRes = await api(token, "POST", `/v1/skills/generator/sessions/${sessionId}/approve`);
    const verdict = approveRes.status === 200 && approveRes.json?.ok ? "PASS" : "FAIL";
    return {
      verdict,
      severity: "P1",
      observed: {
        sessionId,
        draftManifestId: generateRes.json?.data?.draft?.manifest?.id ?? null,
        approveStatus: approveRes.status,
        approveBody: approveRes.json ?? approveRes.text,
      },
    };
  });

  await recordCase("workflow-generator-publish-run", async () => {
    const startRes = await api(token, "POST", "/v1/workflows/generator/sessions", {
      goal: `Create a manual trigger workflow named ${TEST_PREFIX}-hello-workflow with a single log or action node that outputs hello from Friday real validation.`,
      userId: "local-admin",
      channel: "assistant",
      requestedModel: MODEL,
    });
    if (startRes.status !== 200 || !startRes.json?.ok) {
      return { verdict: "FAIL", severity: "P1", observed: startRes.json ?? startRes.text };
    }
    const sessionId = startRes.json.data.session.sessionId;
    if (startRes.json.data.mode === "clarification_required") {
      await api(token, "POST", `/v1/workflows/generator/sessions/${sessionId}/messages`, {
        message: 'Manual trigger only. Keep it minimal and print "hello from Friday real validation".',
        requestedModel: MODEL,
      });
    }
    const generateRes = await api(token, "POST", `/v1/workflows/generator/sessions/${sessionId}/generate`, {
      requestedModel: MODEL,
    });
    if (generateRes.status !== 200 || !generateRes.json?.ok) {
      return {
        verdict: "FAIL",
        severity: "P1",
        observed: {
          sessionId,
          generateStatus: generateRes.status,
          body: generateRes.json ?? generateRes.text,
        },
      };
    }
    const approveRes = await api(token, "POST", `/v1/workflows/generator/sessions/${sessionId}/approve`);
    if (approveRes.status !== 200 || !approveRes.json?.ok) {
      return {
        verdict: "FAIL",
        severity: "P1",
        observed: { sessionId, approveStatus: approveRes.status, body: approveRes.json ?? approveRes.text },
      };
    }
    const workflowId = approveRes.json.data.workflowId;
    const runRes = await api(token, "POST", "/v1/workflow-runs", {
      workflowId,
      triggerType: "manual",
      triggerPayload: {},
    });
    if (runRes.status !== 200 || !runRes.json?.ok) {
      return {
        verdict: "FAIL",
        severity: "P1",
        observed: { workflowId, runStatus: runRes.status, body: runRes.json ?? runRes.text },
      };
    }
    const runId = runRes.json.data.run.id;
    const terminal = await pollWorkflowRun(token, runId);
    return {
      verdict: terminal.status === "completed" ? "PASS" : "FAIL",
      severity: "P1",
      observed: { sessionId, workflowId, runId, terminal },
    };
  });

  await recordCase("approval-workflow", async () => {
    const graph = {
      schemaVersion: "2.0",
      workflowId: `${TEST_PREFIX}-approval`,
      workflowVersionId: `${TEST_PREFIX}-approval-v1`,
      sourceSpecSchemaVersion: "1.0",
      graph: {
        nodes: [
          { id: "trigger-1", type: "trigger", label: "Manual Trigger", config: { triggerType: "manual" } },
          { id: "approval-1", type: "approval", label: "Approve Step", config: { approverRole: "admin", timeoutMs: 60000 } },
          { id: "action-1", type: "action", label: "After Approval", config: { message: "approved path" } },
        ],
        edges: [
          { id: "e1", sourceNodeId: "trigger-1", targetNodeId: "approval-1" },
          { id: "e2", sourceNodeId: "approval-1", targetNodeId: "action-1" },
        ],
      },
      failurePolicy: { onFailure: "fail_fast" },
      tests: [],
    };
    const createRes = await api(token, "POST", "/v1/workflows", {
      slug: `${TEST_PREFIX}-approval-${Date.now().toString(36)}`,
      title: `${TEST_PREFIX} approval workflow`,
      graph,
    });
    if (createRes.status !== 200 || !createRes.json?.ok) {
      return { verdict: "FAIL", severity: "P1", observed: createRes.json ?? createRes.text };
    }
    const workflowId = createRes.json.data.workflow.id;
    await api(token, "POST", `/v1/workflows/${workflowId}/publish`, { versionNumber: 1 });
    const runRes = await api(token, "POST", "/v1/workflow-runs", {
      workflowId,
      triggerType: "manual",
      triggerPayload: {},
    });
    const runId = runRes.json?.data?.run?.id;
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const approvalsRes = await api(token, "GET", "/v1/workflow-approvals");
    const approval = approvalsRes.json?.data?.items?.find((item) => item.runId === runId || item.workflowId === workflowId);
    if (!approval) {
      return {
        verdict: "FAIL",
        severity: "P1",
        observed: { workflowId, runId, approvals: approvalsRes.json?.data?.items ?? [] },
      };
    }
    const approveRes = await api(token, "POST", `/v1/workflow-approvals/${approval.id}/approve`, {
      comment: "manual validation approval",
    });
    const terminal = await pollWorkflowRun(token, runId);
    return {
      verdict: approveRes.status === 200 && terminal.status === "completed" ? "PASS" : "FAIL",
      severity: "P1",
      observed: { workflowId, runId, approvalId: approval.id, approveStatus: approveRes.status, terminal },
    };
  });

  await recordCase("self-healing-read-surfaces", async () => {
    const [incidentsRes, actionsRes] = await Promise.all([
      api(token, "GET", "/v1/diagnosis/incidents"),
      api(token, "GET", "/v1/auto-fix/actions"),
    ]);
    const incidentCount = incidentsRes.json?.data?.items?.length ?? 0;
    const actionCount = actionsRes.json?.data?.items?.length ?? 0;
    const verdict = incidentsRes.status === 200 && actionsRes.status === 200 ? (incidentCount + actionCount > 0 ? "PASS" : "PARTIAL") : "FAIL";
    return {
      verdict,
      severity: verdict === "FAIL" ? "P1" : "P2",
      observed: {
        incidentCount,
        actionCount,
        incidentsStatus: incidentsRes.status,
        actionsStatus: actionsRes.status,
      },
    };
  });

  await recordCase("persona-preferences-learned-facts", async () => {
    const putRes = await api(token, "PUT", "/v1/uix/preferences", {
      category: "communication",
      key: "verbosity",
      value: "concise",
    });
    const [personaRes, prefsRes, learnedFactsRes, correctionRun] = await Promise.all([
      api(token, "GET", "/v1/uix/persona"),
      api(token, "GET", "/v1/uix/preferences?category=communication"),
      api(token, "GET", "/v1/uix/learned-facts"),
      runAgent(
        token,
        "From now on, keep responses concise and structured. Acknowledge in one sentence.",
      ),
    ]);
    const deletePreferenceId = prefsRes.json?.data?.items?.find((item) => item.key === "verbosity")?.id;
    if (deletePreferenceId) {
      await api(token, "DELETE", `/v1/uix/preferences/${deletePreferenceId}`);
    }
    const persona = personaRes.json?.data?.persona ?? personaRes.json?.data ?? null;
    return {
      verdict:
        putRes.status === 200 &&
        personaRes.status === 200 &&
        prefsRes.status === 200 &&
        learnedFactsRes.status === 200
          ? "PARTIAL"
          : "FAIL",
      severity: "P2",
      observed: {
        putStatus: putRes.status,
        persona,
        preferenceCount: prefsRes.json?.data?.items?.length ?? 0,
        learnedFacts: learnedFactsRes.json?.items ?? learnedFactsRes.json?.data?.items ?? [],
        correctionRun: {
          status: correctionRun.status,
          response: correctionRun.response ?? correctionRun.responseText ?? "",
        },
      },
      note: "显式偏好可验证；学习事实是否新增取决于反馈工具和后台学习链路，单次验证按 PARTIAL 处理。",
    };
  });

  const summary = {
    startedAt,
    finishedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    providerId: PROVIDER_ID,
    model: MODEL,
    sandboxDir: SANDBOX_DIR,
    results: cases,
  };
  safeWriteJson(path.join(RAW_DIR, "http-validation-results.json"), summary);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
