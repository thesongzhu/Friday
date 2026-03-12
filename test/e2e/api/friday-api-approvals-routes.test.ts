import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FridayCompiledWorkflowGraphV2 } from "#workflows";
import {
  createFridayApiTestEnv,
  loginTestUser,
  authHeaders,
  type FridayApiTestEnv,
} from "./_helpers/friday-api-test-server.helper.js";

// ─── Valid graph with approval node ─────────────────────────────────────────

function makeApprovalGraph(): FridayCompiledWorkflowGraphV2 {
  return {
    schemaVersion: "2.0",
    workflowId: "wf-placeholder",
    workflowVersionId: "wv-placeholder",
    sourceSpecSchemaVersion: "1.0",
    graph: {
      nodes: [
        { id: "trigger", type: "trigger", label: "Trigger", config: {} },
        {
          id: "approval1",
          type: "approval",
          label: "Approve this",
          config: { approverRole: "admin" },
        },
        {
          id: "action1",
          type: "action",
          label: "Action 1",
          config: { skillId: "test-skill" },
        },
      ],
      edges: [
        { id: "e1", sourceNodeId: "trigger", targetNodeId: "approval1" },
        { id: "e2", sourceNodeId: "approval1", targetNodeId: "action1" },
      ],
    },
    failurePolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [],
    checksum: "placeholder-checksum",
  };
}

/** Helper: create + publish a workflow with an approval node, start a run,
 *  and poll until the run reaches "paused" status (approval blocks it). */
async function createApprovalRun(
  baseUrl: string,
  token: string,
): Promise<{ workflowId: string; runId: string }> {
  const slug = `approval-wf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  // 1. Create workflow with approval graph
  const createRes = await fetch(`${baseUrl}/v1/workflows`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      slug,
      name: "Approval Workflow",
      graph: makeApprovalGraph(),
    }),
  });
  const createJson = (await createRes.json()) as {
    ok: boolean;
    data: {
      workflow: { id: string };
      version: { id: string; versionNumber: number };
    };
  };
  expect(createJson.ok).toBe(true);
  const workflowId = createJson.data.workflow.id;
  const versionId = createJson.data.version.id;
  const versionNumber = createJson.data.version.versionNumber;

  // 2. Publish the workflow
  const publishRes = await fetch(
    `${baseUrl}/v1/workflows/${workflowId}/publish`,
    {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ versionNumber }),
    },
  );
  expect(publishRes.status).toBe(200);

  // 3. Start a run
  const runRes = await fetch(`${baseUrl}/v1/workflow-runs`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      workflowId,
      workflowVersionId: versionId,
      triggerType: "manual",
      triggerPayload: {},
    }),
  });
  const runJson = (await runRes.json()) as {
    ok: boolean;
    data: { run: { id: string; status: string } };
  };
  expect(runJson.ok).toBe(true);
  const runId = runJson.data.run.id;

  // 4. Poll until run reaches "paused" (approval node blocks execution)
  const maxAttempts = 40;
  const delayMs = 50;
  let runStatus = runJson.data.run.status;
  for (let i = 0; i < maxAttempts && runStatus !== "paused"; i++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const pollRes = await fetch(`${baseUrl}/v1/workflow-runs/${runId}`, {
      headers: authHeaders(token),
    });
    const pollJson = (await pollRes.json()) as {
      ok: boolean;
      data: { run: { status: string } };
    };
    runStatus = pollJson.data.run.status;
  }
  expect(runStatus).toBe("paused");

  return { workflowId, runId };
}

describe("API — Approval routes", () => {
  let env: FridayApiTestEnv;
  let token: string;

  beforeAll(async () => {
    env = await createFridayApiTestEnv();
    const login = await loginTestUser(env.baseUrl);
    token = login.accessToken;
  });

  afterAll(async () => {
    await env.close();
  });

  // ── list_pending_approvals ─────────────────────────────────────────────

  it("list_pending_approvals", async () => {
    await createApprovalRun(env.baseUrl, token);

    const res = await fetch(`${env.baseUrl}/v1/workflow-approvals`, {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { items: Array<{ id: string; status: string }> };
    };
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.data.items)).toBe(true);
    // At least one pending approval from the run we just created
    const pending = json.data.items.filter((item) => item.status === "pending");
    expect(pending.length).toBeGreaterThanOrEqual(1);
  });

  it("list_pending_approvals_via_compatibility_alias", async () => {
    await createApprovalRun(env.baseUrl, token);

    const res = await fetch(`${env.baseUrl}/v1/approvals`, {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { items: Array<{ id: string; status: string }> };
    };
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.data.items)).toBe(true);
    expect(json.data.items.some((item) => item.status === "pending")).toBe(true);
  });

  // ── get_approval_by_id ─────────────────────────────────────────────────

  it("get_approval_by_id", async () => {
    const { workflowId, runId } = await createApprovalRun(env.baseUrl, token);

    // List pending approvals and find the one matching THIS run
    const listRes = await fetch(`${env.baseUrl}/v1/workflow-approvals`, {
      headers: authHeaders(token),
    });
    const listJson = (await listRes.json()) as {
      ok: boolean;
      data: {
        items: Array<{
          id: string;
          status: string;
          runId: string;
          workflowId: string;
        }>;
      };
    };
    const matchingApproval = listJson.data.items.find(
      (item) => item.runId === runId && item.status === "pending",
    );
    expect(matchingApproval).toBeDefined();
    const approvalId = matchingApproval!.id;

    const res = await fetch(
      `${env.baseUrl}/v1/workflow-approvals/${approvalId}`,
      { headers: authHeaders(token) },
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: {
        approval: {
          id: string;
          status: string;
          runId: string;
          workflowId: string;
        };
      };
    };
    expect(json.ok).toBe(true);
    expect(json.data.approval.id).toBe(approvalId);
    expect(json.data.approval.status).toBe("pending");
    expect(json.data.approval.runId).toBe(runId);
    expect(json.data.approval.workflowId).toBe(workflowId);
  });

  // ── approve_resumes_run ────────────────────────────────────────────────

  it("approve_resumes_run", async () => {
    const { runId } = await createApprovalRun(env.baseUrl, token);

    // Find the pending approval for this run
    const listRes = await fetch(`${env.baseUrl}/v1/workflow-approvals`, {
      headers: authHeaders(token),
    });
    const listJson = (await listRes.json()) as {
      ok: boolean;
      data: { items: Array<{ id: string; status: string; runId: string }> };
    };
    const approval = listJson.data.items.find(
      (item) => item.runId === runId && item.status === "pending",
    );
    expect(approval).toBeDefined();
    const approvalId = approval!.id;

    // Approve
    const res = await fetch(
      `${env.baseUrl}/v1/workflow-approvals/${approvalId}/approve`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ comment: "Looks good" }),
      },
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { approval: { status: string } };
    };
    expect(json.ok).toBe(true);
    expect(json.data.approval.status).toBe("approved");

    // Poll until the run progresses past "paused" (should become completed or running)
    const maxAttempts = 40;
    const delayMs = 50;
    let runStatus = "paused";
    for (let i = 0; i < maxAttempts && runStatus === "paused"; i++) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const runRes = await fetch(`${env.baseUrl}/v1/workflow-runs/${runId}`, {
        headers: authHeaders(token),
      });
      const runJson = (await runRes.json()) as {
        ok: boolean;
        data: { run: { status: string } };
      };
      runStatus = runJson.data.run.status;
    }
    // After approval, the run should have progressed (not stuck at "paused")
    expect(["running", "completed"]).toContain(runStatus);
  });

  it("approve_resumes_run_via_compatibility_alias", async () => {
    const { runId } = await createApprovalRun(env.baseUrl, token);

    const listRes = await fetch(`${env.baseUrl}/v1/approvals`, {
      headers: authHeaders(token),
    });
    const listJson = (await listRes.json()) as {
      ok: boolean;
      data: { items: Array<{ id: string; status: string; runId: string }> };
    };
    const approval = listJson.data.items.find(
      (item) => item.runId === runId && item.status === "pending",
    );
    expect(approval).toBeDefined();

    const res = await fetch(
      `${env.baseUrl}/v1/approvals/${approval!.id}/approve`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ comment: "Compatibility alias approval" }),
      },
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { approval: { status: string } };
    };
    expect(json.ok).toBe(true);
    expect(json.data.approval.status).toBe("approved");

    const maxAttempts = 40;
    const delayMs = 50;
    let runStatus = "paused";
    for (let i = 0; i < maxAttempts && runStatus === "paused"; i++) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const runRes = await fetch(`${env.baseUrl}/v1/workflow-runs/${runId}`, {
        headers: authHeaders(token),
      });
      const runJson = (await runRes.json()) as {
        ok: boolean;
        data: { run: { status: string } };
      };
      runStatus = runJson.data.run.status;
    }

    expect(["running", "completed"]).toContain(runStatus);
  });

  // ── reject_fails_run ───────────────────────────────────────────────────

  it("reject_fails_run", async () => {
    const { runId } = await createApprovalRun(env.baseUrl, token);

    // Find the pending approval for this run
    const listRes = await fetch(`${env.baseUrl}/v1/workflow-approvals`, {
      headers: authHeaders(token),
    });
    const listJson = (await listRes.json()) as {
      ok: boolean;
      data: { items: Array<{ id: string; status: string; runId: string }> };
    };
    const approval = listJson.data.items.find(
      (item) => item.runId === runId && item.status === "pending",
    );
    expect(approval).toBeDefined();
    const approvalId = approval!.id;

    // Reject
    const res = await fetch(
      `${env.baseUrl}/v1/workflow-approvals/${approvalId}/reject`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ comment: "Nope" }),
      },
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { approval: { status: string } };
    };
    expect(json.ok).toBe(true);
    expect(json.data.approval.status).toBe("rejected");

    // Poll until the run reaches terminal status
    const maxAttempts = 40;
    const delayMs = 50;
    let runStatus = "paused";
    for (let i = 0; i < maxAttempts && runStatus === "paused"; i++) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const runRes = await fetch(`${env.baseUrl}/v1/workflow-runs/${runId}`, {
        headers: authHeaders(token),
      });
      const runJson = (await runRes.json()) as {
        ok: boolean;
        data: { run: { status: string } };
      };
      runStatus = runJson.data.run.status;
    }
    // After rejection, the run should be failed
    expect(runStatus).toBe("failed");
  });

  // ── approval_not_found_returns_404 ─────────────────────────────────────

  it("approval_not_found_returns_404", async () => {
    const res = await fetch(
      `${env.baseUrl}/v1/workflow-approvals/nonexistent`,
      { headers: authHeaders(token) },
    );

    expect(res.status).toBe(404);
    const json = (await res.json()) as {
      ok: boolean;
      error: { code: string; message: string };
      requestId: string;
    };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("WORKFLOW_APPROVAL_NOT_FOUND");
    expect(typeof json.error.message).toBe("string");
    expect(typeof json.requestId).toBe("string");
  });
});
