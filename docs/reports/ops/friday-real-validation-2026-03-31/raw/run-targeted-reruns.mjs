import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const BASE_URL = "http://127.0.0.1:3141";
const PROVIDER_ID = "11053bd1-a47b-4e07-a195-59a56a96c83c";
const MODEL = "claude-sonnet-4-20250514";
const ROOT_DIR = "/path/to/friday/artifacts/manual/friday-real-validation-2026-03-31";
const RESPONSES_DIR = path.join(ROOT_DIR, "responses");

fs.mkdirSync(RESPONSES_DIR, { recursive: true });

function safeWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function checksum(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, json };
}

async function login() {
  const res = await fetchJson(`${BASE_URL}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ local: true }),
  });
  if (!res.json?.ok) throw new Error(`login failed: ${res.text}`);
  return res.json.data.accessToken;
}

function headers(token) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

async function api(token, method, pathName, body) {
  return fetchJson(`${BASE_URL}${pathName}`, {
    method,
    headers: headers(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function pollAgentRun(token, runId, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await api(token, "GET", `/v1/agent/runs/${runId}`);
    if (res.status === 200 && res.json?.ok) {
      const status = res.json.data.run.status;
      if (["completed", "failed", "cancelled", "awaiting_plan_approval", "awaiting_clarification"].includes(status)) {
        return res.json.data.run;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`agent run ${runId} did not reach terminal state`);
}

async function pollWorkflowRun(token, runId, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await api(token, "GET", `/v1/workflow-runs/${runId}`);
    if (res.status === 200 && res.json?.ok) {
      const run = res.json.data.run;
      if (["completed", "failed", "paused", "cancelled", "rejected"].includes(run.status)) {
        return run;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`workflow run ${runId} did not reach terminal state`);
}

async function main() {
  const token = await login();
  const results = [];

  const summaryRun = await api(token, "POST", "/v1/agent/runs", {
    task: "Direct answer only, no plan, no questions, no workflow. Summarize this in exactly 12 English words: Friday is a supervised automation platform with evidence, approval, rollback, and observability.",
    providerId: PROVIDER_ID,
    model: MODEL,
    timeoutMs: 60000,
  });
  results.push({
    caseId: "claude-summary-rerun",
    verdict:
      summaryRun.status === 200 &&
      summaryRun.json?.ok &&
      summaryRun.json.data.status === "completed"
        ? "PASS"
        : "FAIL",
    observed: summaryRun.json ?? summaryRun.text,
  });

  const channel = "manual-real";
  const chatId = `manual-real-20260331-chat-${Date.now().toString(36)}`;
  const createSession = await api(token, "POST", "/v1/sessions", { channel, chatId });
  let sessionFlow = {
    createSession,
  };
  if (createSession.status === 200 && createSession.json?.ok) {
    const sessionKey = createSession.json.data.session.key;
    const message1 = await api(token, "POST", `/v1/sessions/${encodeURIComponent(sessionKey)}/messages`, {
      role: "user",
      content: "Remember that my favorite editor is Neovim.",
    });
    const fork = await api(token, "POST", `/v1/sessions/${encodeURIComponent(sessionKey)}/fork`, {
      title: `${chatId}-fork`,
    });
    let merge = null;
    if (fork.status === 200 && fork.json?.ok) {
      const forkKey = fork.json.data.fork?.key ?? fork.json.data.fork?.sessionKey;
      if (forkKey) {
        await api(token, "POST", `/v1/sessions/${encodeURIComponent(forkKey)}/messages`, {
          role: "user",
          content: "Fork-specific context for merge validation.",
        });
        merge = await api(token, "POST", `/v1/sessions/${encodeURIComponent(sessionKey)}/merge`, {
          forkSessionKey: forkKey,
          summary: "Merged fork context back into parent.",
        });
      }
    }
    sessionFlow = {
      ...sessionFlow,
      sessionKey,
      message1,
      fork,
      merge,
    };
  }
  results.push({
    caseId: "sessions-rerun",
    verdict: createSession.status === 200 ? "PASS" : "FAIL",
    observed: sessionFlow,
  });

  const graph = {
    nodes: [
      { id: "trigger-1", type: "trigger", label: "Manual Trigger", config: { triggerType: "manual" } },
      { id: "approval-1", type: "approval", label: "Approve Step", config: { approverRole: "admin", timeoutMs: 60000 } },
      { id: "action-1", type: "action", label: "After Approval", config: { message: "approved path" } },
    ],
    edges: [
      { id: "e1", sourceNodeId: "trigger-1", targetNodeId: "approval-1" },
      { id: "e2", sourceNodeId: "approval-1", targetNodeId: "action-1" },
    ],
  };
  const graphContent = JSON.stringify(graph);
  const approvalGraph = {
    schemaVersion: "2.0",
    workflowId: "manual-real-approval",
    workflowVersionId: "manual-real-approval-v1",
    sourceSpecSchemaVersion: "1.0",
    graph,
    failurePolicy: {
      onFailure: "fail_fast",
      notifyUser: false,
    },
    tests: [],
    checksum: checksum(graphContent),
  };

  const createWorkflow = await api(token, "POST", "/v1/workflows", {
    slug: `manual-real-approval-${Date.now().toString(36)}`,
    name: "Manual Real Approval Workflow",
    graph: approvalGraph,
  });
  let workflowFlow = { createWorkflow };
  if (createWorkflow.status === 200 && createWorkflow.json?.ok) {
    const workflowId = createWorkflow.json.data.workflow.id;
    const publish = await api(token, "POST", `/v1/workflows/${workflowId}/publish`, { versionNumber: 1 });
    const run = await api(token, "POST", "/v1/workflow-runs", {
      workflowId,
      triggerType: "manual",
      triggerPayload: {},
    });
    let approve = null;
    let terminal = null;
    if (run.status === 200 && run.json?.ok) {
      const runId = run.json.data.run.id;
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const approvals = await api(token, "GET", "/v1/workflow-approvals");
      const approval = approvals.json?.data?.items?.find((item) => item.runId === runId || item.workflowId === workflowId);
      if (approval) {
        approve = await api(token, "POST", `/v1/workflow-approvals/${approval.id}/approve`, {
          comment: "manual validation rerun approval",
        });
      }
      terminal = await pollWorkflowRun(token, runId);
      workflowFlow = { workflowId, publish, run, approvals, approvalId: approval?.id ?? null, approve, terminal };
    } else {
      workflowFlow = { workflowId, publish, run };
    }
  }
  results.push({
    caseId: "approval-workflow-rerun",
    verdict:
      workflowFlow.terminal?.status === "completed"
        ? "PASS"
        : "FAIL",
    observed: workflowFlow,
  });

  const desktopRun = await api(token, "POST", "/v1/agent/runs", {
    task: "Check desktop permissions using the desktop tool. Report accessibility, screen recording, input monitoring, and automation. Keep it short.",
    providerId: PROVIDER_ID,
    model: MODEL,
    timeoutMs: 60000,
  });
  let desktopFlow = { start: desktopRun };
  if (desktopRun.status === 200 && desktopRun.json?.ok) {
    const runId = desktopRun.json.data.runId;
    let postApprove = null;
    if (desktopRun.json.data.status === "awaiting_plan_approval") {
      postApprove = await api(token, "POST", `/v1/agent/runs/${runId}/approve-plan`);
    }
    const terminal = await pollAgentRun(token, runId);
    desktopFlow = { runId, start: desktopRun, postApprove, terminal };
  }
  results.push({
    caseId: "desktop-permissions-rerun",
    verdict:
      JSON.stringify(desktopFlow).toLowerCase().includes("screen recording") ||
      JSON.stringify(desktopFlow).toLowerCase().includes("input monitoring") ||
      JSON.stringify(desktopFlow).toLowerCase().includes("automation")
        ? "BLOCKED"
        : "PARTIAL",
    observed: desktopFlow,
  });

  const skillStart = await api(token, "POST", "/v1/skills/generator/sessions", {
    goal: "Create a shell skill that prints hello Friday.",
    userId: "local-admin",
    channel: "assistant",
    requestedModel: MODEL,
  });
  const workflowStart = await api(token, "POST", "/v1/workflows/generator/sessions", {
    goal: "Create a manual workflow that outputs hello Friday.",
    userId: "local-admin",
    channel: "assistant",
    requestedModel: MODEL,
  });
  results.push({
    caseId: "generator-rerun",
    verdict:
      skillStart.status === 200 || workflowStart.status === 200 ? "PARTIAL" : "FAIL",
    observed: { skillStart, workflowStart },
  });

  const incidents = await api(token, "GET", "/v1/diagnosis/incidents");
  let diagnosisFlow = { incidents };
  const firstIncidentId = incidents.json?.data?.items?.[0]?.incident?.incidentId;
  if (firstIncidentId) {
    const detail = await api(token, "GET", `/v1/diagnosis/incidents/${firstIncidentId}/diagnosis`);
    diagnosisFlow = { incidents, detail };
  }
  results.push({
    caseId: "diagnosis-evidence-rerun",
    verdict:
      diagnosisFlow.detail?.status === 200 ? "PASS" : "PARTIAL",
    observed: diagnosisFlow,
  });

  const output = {
    startedAt: new Date().toISOString(),
    results,
    finishedAt: new Date().toISOString(),
  };

  safeWriteJson(path.join(RESPONSES_DIR, "targeted-reruns.json"), output);
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
