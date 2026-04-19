import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FridayCompiledWorkflowGraphV2 } from "#workflows";
import {
  createFridayApiTestEnv,
  loginTestUser,
  authHeaders,
  type FridayApiTestEnv,
} from "./_helpers/friday-api-test-server.helper.js";

// ─── Valid minimal graph fixture ────────────────────────────────────────────

function makeValidGraph(
  workflowId = "wf-placeholder",
  versionId = "wv-placeholder",
): FridayCompiledWorkflowGraphV2 {
  return {
    schemaVersion: "2.0",
    workflowId,
    workflowVersionId: versionId,
    sourceSpecSchemaVersion: "1.0",
    graph: {
      nodes: [
        { id: "trigger", type: "trigger", label: "Trigger", config: {} },
        {
          id: "action1",
          type: "action",
          label: "Action 1",
          config: { skillId: "test-skill" },
        },
      ],
      edges: [{ id: "e1", sourceNodeId: "trigger", targetNodeId: "action1" }],
    },
    failurePolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [],
    checksum: "placeholder-checksum",
  };
}

/** Helper: create + publish a workflow, return IDs */
async function createAndPublishWorkflow(
  baseUrl: string,
  token: string,
  slug: string,
): Promise<{
  workflowId: string;
  versionId: string;
  versionNumber: number;
}> {
  const createRes = await fetch(`${baseUrl}/v1/workflows`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      slug,
      name: `Workflow ${slug}`,
      graph: makeValidGraph(),
    }),
  });
  const createJson = (await createRes.json()) as {
    ok: boolean;
    data: {
      workflow: { id: string };
      version: { id: string; versionNumber: number };
    };
  };
  const wfId = createJson.data.workflow.id;
  const versionId = createJson.data.version.id;
  const versionNumber = createJson.data.version.versionNumber;

  await fetch(`${baseUrl}/v1/workflows/${wfId}/publish`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ versionNumber }),
  });

  return { workflowId: wfId, versionId, versionNumber };
}

async function waitForRunTerminal(
  baseUrl: string,
  token: string,
  runId: string,
  timeoutMs = 12_000,
): Promise<"completed" | "failed" | "cancelled"> {
  const deadline = Date.now() + timeoutMs;
  const terminal = new Set(["completed", "failed", "cancelled"]);

  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/v1/workflow-runs/${runId}`, {
      headers: authHeaders(token),
    });
    if (res.ok) {
      const json = (await res.json()) as {
        ok: boolean;
        data: { run: { status: string } };
      };
      if (json.ok && terminal.has(json.data.run.status)) {
        return json.data.run.status as "completed" | "failed" | "cancelled";
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Run ${runId} did not reach terminal state within ${String(timeoutMs)}ms`);
}

describe("API — Workflow routes", () => {
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

  // ── create_workflow_returns_workflow_and_version ────────────────────────

  it("create_workflow_returns_workflow_and_version", async () => {
    const res = await fetch(`${env.baseUrl}/v1/workflows`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        slug: "test-wf-create",
        name: "Test Workflow",
        description: "A test workflow",
        graph: makeValidGraph(),
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: {
        workflow: { id: string; slug: string; name: string };
        version: { id: string; versionNumber: number };
      };
      requestId: string;
    };
    expect(json.ok).toBe(true);
    expect(json.data.workflow.slug).toBe("test-wf-create");
    expect(json.data.version.versionNumber).toBe(1);
    expect(typeof json.requestId).toBe("string");
  });

  // ── get_workflow_returns_details ────────────────────────────────────────

  it("get_workflow_returns_details", async () => {
    const createRes = await fetch(`${env.baseUrl}/v1/workflows`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        slug: "test-wf-get",
        name: "Get Workflow",
        graph: makeValidGraph(),
      }),
    });
    const createJson = (await createRes.json()) as {
      ok: boolean;
      data: { workflow: { id: string } };
    };
    const wfId = createJson.data.workflow.id;

    const res = await fetch(`${env.baseUrl}/v1/workflows/${wfId}`, {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: {
        workflow: { id: string; name: string };
        latestVersion: { versionNumber: number };
      };
    };
    expect(json.ok).toBe(true);
    expect(json.data.workflow.id).toBe(wfId);
    expect(json.data.workflow.name).toBe("Get Workflow");
    expect(json.data.latestVersion.versionNumber).toBe(1);
  });

  // ── list_workflows_returns_items ───────────────────────────────────────

  it("list_workflows_returns_items", async () => {
    // Create a fresh workflow so we know there's at least one
    await fetch(`${env.baseUrl}/v1/workflows`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        slug: "test-wf-list",
        name: "List Workflow",
        graph: makeValidGraph(),
      }),
    });

    const res = await fetch(`${env.baseUrl}/v1/workflows`, {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { items: Array<{ id: string; slug: string }> };
    };
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.data.items)).toBe(true);
    // We know at least the one we just created exists
    const found = json.data.items.some((w) => w.slug === "test-wf-list");
    expect(found).toBe(true);
  });

  // ── update_workflow_name ───────────────────────────────────────────────

  it("update_workflow_name", async () => {
    const createRes = await fetch(`${env.baseUrl}/v1/workflows`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        slug: "test-wf-update",
        name: "Original Name",
        graph: makeValidGraph(),
      }),
    });
    const createJson = (await createRes.json()) as {
      ok: boolean;
      data: { workflow: { id: string; revision: number; etag: string } };
    };
    const wfId = createJson.data.workflow.id;
    const revision = createJson.data.workflow.revision;
    const etag = createJson.data.workflow.etag;

    const res = await fetch(`${env.baseUrl}/v1/workflows/${wfId}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({
        name: "Updated Name",
        expectedRevision: revision,
        etag,
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { workflow: { name: string } };
    };
    expect(json.ok).toBe(true);
    expect(json.data.workflow.name).toBe("Updated Name");
  });

  // ── publish_version ────────────────────────────────────────────────────

  it("publish_version", async () => {
    const createRes = await fetch(`${env.baseUrl}/v1/workflows`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        slug: "test-wf-publish",
        name: "Publish Workflow",
        graph: makeValidGraph(),
      }),
    });
    const createJson = (await createRes.json()) as {
      ok: boolean;
      data: { workflow: { id: string }; version: { versionNumber: number } };
    };
    const wfId = createJson.data.workflow.id;
    const versionNumber = createJson.data.version.versionNumber;

    const res = await fetch(`${env.baseUrl}/v1/workflows/${wfId}/publish`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ versionNumber }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: {
        publishedVersion: {
          versionNumber: number;
          isPublished: boolean;
          updatedAt: string;
        };
      };
    };
    expect(json.ok).toBe(true);
    expect(json.data.publishedVersion.versionNumber).toBe(versionNumber);
    // Assert the version is marked as published
    expect(json.data.publishedVersion.isPublished).toBe(true);
    // Assert updatedAt is set (reflects the publish timestamp)
    expect(json.data.publishedVersion.updatedAt).toBeTruthy();
  });

  // ── list_versions ──────────────────────────────────────────────────────

  it("list_versions", async () => {
    const createRes = await fetch(`${env.baseUrl}/v1/workflows`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        slug: "test-wf-versions",
        name: "Versions Workflow",
        graph: makeValidGraph(),
      }),
    });
    const createJson = (await createRes.json()) as {
      ok: boolean;
      data: { workflow: { id: string } };
    };
    const wfId = createJson.data.workflow.id;

    const res = await fetch(`${env.baseUrl}/v1/workflows/${wfId}/versions`, {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { items: Array<{ versionNumber: number }> };
    };
    expect(json.ok).toBe(true);
    // Create inserts exactly one version record (version 2; version 1 is just the counter seed)
    expect(json.data.items.length).toBe(1);
  });

  // ── archive_workflow ───────────────────────────────────────────────────

  it("archive_workflow", async () => {
    const createRes = await fetch(`${env.baseUrl}/v1/workflows`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        slug: "test-wf-archive",
        name: "Archive Workflow",
        graph: makeValidGraph(),
      }),
    });
    const createJson = (await createRes.json()) as {
      ok: boolean;
      data: { workflow: { id: string } };
    };
    const wfId = createJson.data.workflow.id;

    const res = await fetch(`${env.baseUrl}/v1/workflows/${wfId}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { archived: boolean };
    };
    expect(json.ok).toBe(true);
    expect(json.data.archived).toBe(true);
  });

  it("archived_workflow_cannot_start_run", async () => {
    const slug = `test-wf-archived-run-${Date.now()}`;
    const { workflowId } = await createAndPublishWorkflow(
      env.baseUrl,
      token,
      slug,
    );

    const archiveRes = await fetch(`${env.baseUrl}/v1/workflows/${workflowId}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    expect(archiveRes.status).toBe(200);

    const runRes = await fetch(`${env.baseUrl}/v1/workflow-runs`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        workflowId,
        triggerType: "manual",
        triggerPayload: {},
      }),
    });

    expect(runRes.status).toBe(410);
    const runJson = (await runRes.json()) as {
      ok: boolean;
      error: { code: string };
    };
    expect(runJson.ok).toBe(false);
    expect(runJson.error.code).toBe("WORKFLOW_ARCHIVED");
  });

  it("archive_frees_slug_for_reuse", async () => {
    const slug = `test-wf-reuse-${Date.now()}`;
    const first = await fetch(`${env.baseUrl}/v1/workflows`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        slug,
        name: "First Workflow",
        graph: makeValidGraph(),
      }),
    });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as {
      data: { workflow: { id: string } };
    };
    const firstId = firstJson.data.workflow.id;

    const archiveRes = await fetch(`${env.baseUrl}/v1/workflows/${firstId}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    expect(archiveRes.status).toBe(200);

    const second = await fetch(`${env.baseUrl}/v1/workflows`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        slug,
        name: "Second Workflow",
        graph: makeValidGraph(),
      }),
    });
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as {
      data: { workflow: { id: string; slug: string } };
    };
    expect(secondJson.data.workflow.slug).toBe(slug);
    expect(secondJson.data.workflow.id).not.toBe(firstId);
  });

  // ── start_run ──────────────────────────────────────────────────────────

  it("start_run", async () => {
    const { workflowId, versionId } = await createAndPublishWorkflow(
      env.baseUrl,
      token,
      "test-wf-startrun",
    );

    const res = await fetch(`${env.baseUrl}/v1/workflow-runs`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        workflowId,
        workflowVersionId: versionId,
        triggerType: "manual",
        triggerPayload: {},
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { run: { id: string; status: string } };
    };
    expect(json.ok).toBe(true);
    expect(json.data.run.id).toBeTruthy();
    // Run should start in queued or running status
    expect(["queued", "running", "completed"]).toContain(json.data.run.status);
  });

  // ── get_run ────────────────────────────────────────────────────────────

  it("get_run", async () => {
    const { workflowId, versionId } = await createAndPublishWorkflow(
      env.baseUrl,
      token,
      "test-wf-getrun",
    );

    const runRes = await fetch(`${env.baseUrl}/v1/workflow-runs`, {
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
      data: { run: { id: string } };
    };
    const runId = runJson.data.run.id;

    const res = await fetch(`${env.baseUrl}/v1/workflow-runs/${runId}`, {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { run: { id: string; status: string } };
    };
    expect(json.ok).toBe(true);
    expect(json.data.run.id).toBe(runId);
    expect(typeof json.data.run.status).toBe("string");
  });

  // ── list_run_nodes ─────────────────────────────────────────────────────

  it("list_run_nodes", async () => {
    const { workflowId, versionId } = await createAndPublishWorkflow(
      env.baseUrl,
      token,
      "test-wf-listnodes",
    );

    const runRes = await fetch(`${env.baseUrl}/v1/workflow-runs`, {
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
      data: { run: { id: string } };
    };
    const runId = runJson.data.run.id;

    const res = await fetch(`${env.baseUrl}/v1/workflow-runs/${runId}/nodes`, {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { items: Array<{ nodeId: string; status: string }> };
    };
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.data.items)).toBe(true);
  });

  // ── webhook_invoke_returns_404_for_unknown_token ───────────────────────

  it("webhook_invoke_returns_404_for_unknown_token", async () => {
    const res = await fetch(
      `${env.baseUrl}/v1/workflow-webhooks/nonexistent-token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "value" }),
      },
    );

    expect(res.status).toBe(404);
    const json = (await res.json()) as {
      ok: boolean;
      error: { code: string };
    };
    expect(json.ok).toBe(false);
    expect(typeof json.error.code).toBe("string");
  });

  // ── workflow_builder_draft_lifecycle ────────────────────────────────────

  it("workflow_builder_draft_lifecycle", async () => {
    // 1. Create a workflow
    const createRes = await fetch(`${env.baseUrl}/v1/workflows`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        slug: "test-wf-draft-lifecycle",
        name: "Draft Lifecycle Workflow",
        graph: makeValidGraph(),
      }),
    });
    const createJson = (await createRes.json()) as {
      ok: boolean;
      data: { workflow: { id: string }; version: { id: string } };
    };
    expect(createJson.ok).toBe(true);
    const wfId = createJson.data.workflow.id;
    const baseVersionId = createJson.data.version.id;

    // 2. Create a draft
    const draftRes = await fetch(`${env.baseUrl}/v1/workflows/${wfId}/drafts`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        title: "My Draft",
        spec: { nodes: [], edges: [] },
        ownerUserId: "test-user",
        baseWorkflowVersionId: baseVersionId,
      }),
    });
    expect(draftRes.status).toBe(200);
    const draftJson = (await draftRes.json()) as {
      ok: boolean;
      data: { draft: { draftId: string; title: string; revision: number } };
    };
    expect(draftJson.ok).toBe(true);
    expect(draftJson.data.draft.title).toBe("My Draft");
    const draftId = draftJson.data.draft.draftId;

    // 3. Acquire lock (required for save/autosave)
    const lockRes = await fetch(
      `${env.baseUrl}/v1/workflows/${wfId}/locks/acquire`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          ownerUserId: "test-user",
          ownerSessionId: "test-session",
          ttlSec: 300,
        }),
      },
    );
    expect(lockRes.status).toBe(200);
    const lockJson = (await lockRes.json()) as {
      ok: boolean;
      data: { acquired: boolean; lock: { lockToken: string } };
    };
    expect(lockJson.ok).toBe(true);
    expect(lockJson.data.acquired).toBe(true);
    const lockToken = lockJson.data.lock.lockToken;

    // 4. Save draft
    const saveRes = await fetch(
      `${env.baseUrl}/v1/workflows/${wfId}/drafts/${draftId}`,
      {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({
          title: "Updated Draft",
          expectedRevision: draftJson.data.draft.revision,
          lockToken,
          spec: { nodes: [{ id: "n1", type: "trigger" }], edges: [] },
        }),
      },
    );
    expect(saveRes.status).toBe(200);
    const saveJson = (await saveRes.json()) as {
      ok: boolean;
      data: { draft: { title: string; revision: number } };
    };
    expect(saveJson.ok).toBe(true);
    expect(saveJson.data.draft.title).toBe("Updated Draft");

    // 5. Autosave draft
    const autosaveRes = await fetch(
      `${env.baseUrl}/v1/workflows/${wfId}/drafts/${draftId}/autosave`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          lockToken,
          spec: { nodes: [{ id: "n1", type: "trigger" }, { id: "n2", type: "action" }], edges: [] },
        }),
      },
    );
    expect(autosaveRes.status).toBe(200);
    const autosaveJson = (await autosaveRes.json()) as {
      ok: boolean;
      data: { draft: { id: string } };
    };
    expect(autosaveJson.ok).toBe(true);

    // 6. Compile draft — exercises the compile endpoint. An empty spec won't
    //    produce a valid graph, so we accept 200 (compiled) or 400/500 (validation
    //    errors mapped through error handler). The key thing is the endpoint exists
    //    and returns structured JSON.
    const compileRes = await fetch(
      `${env.baseUrl}/v1/workflows/${wfId}/drafts/${draftId}/compile`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({}),
      },
    );
    const compileJson = (await compileRes.json()) as {
      ok: boolean;
      requestId: string;
    };
    expect(typeof compileJson.requestId).toBe("string");

    // 7. List drafts to verify it shows up
    const listRes = await fetch(`${env.baseUrl}/v1/workflows/${wfId}/drafts`, {
      headers: authHeaders(token),
    });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as {
      ok: boolean;
      data: { items: Array<{ draftId: string }> };
    };
    expect(listJson.ok).toBe(true);
    const foundDraft = listJson.data.items.some((d) => d.draftId === draftId);
    expect(foundDraft).toBe(true);
  });

  // ── workflow_run_timeline ──────────────────────────────────────────────

  it("workflow_run_timeline", async () => {
    const { workflowId, versionId } = await createAndPublishWorkflow(
      env.baseUrl,
      token,
      "test-wf-timeline",
    );

    // Start a run
    const runRes = await fetch(`${env.baseUrl}/v1/workflow-runs`, {
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
      data: { run: { id: string } };
    };
    expect(runJson.ok).toBe(true);
    const runId = runJson.data.run.id;
    await waitForRunTerminal(env.baseUrl, token, runId);

    // Get timeline
    const timelineRes = await fetch(
      `${env.baseUrl}/v1/workflow-runs/${runId}/timeline`,
      { headers: authHeaders(token) },
    );
    expect(timelineRes.status).toBe(200);
    const timelineJson = (await timelineRes.json()) as {
      ok: boolean;
      data: { items: Array<{ seq: number; event: string }> };
    };
    expect(timelineJson.ok).toBe(true);
    expect(Array.isArray(timelineJson.data.items)).toBe(true);
    expect(timelineJson.data.items.length).toBeGreaterThan(0);
  });

  // ── workflow_run_evidence_export_download ───────────────────────────────

  it("workflow_run_evidence_export_download", async () => {
    const { workflowId, versionId } = await createAndPublishWorkflow(
      env.baseUrl,
      token,
      `test-wf-evidence-${Date.now()}`,
    );

    const runRes = await fetch(`${env.baseUrl}/v1/workflow-runs`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        workflowId,
        workflowVersionId: versionId,
        triggerType: "manual",
        triggerPayload: {},
      }),
    });
    expect(runRes.status).toBe(200);
    const runJson = (await runRes.json()) as {
      ok: boolean;
      data: { run: { id: string } };
    };
    expect(runJson.ok).toBe(true);
    const runId = runJson.data.run.id;

    const terminalStatus = await waitForRunTerminal(env.baseUrl, token, runId);
    expect(["completed", "failed", "cancelled"]).toContain(terminalStatus);

    const evidenceRes = await fetch(
      `${env.baseUrl}/v1/workflow-runs/${runId}/evidence`,
      { headers: authHeaders(token) },
    );
    expect(evidenceRes.status).toBe(200);
    const evidenceJson = (await evidenceRes.json()) as {
      ok: boolean;
      data: {
        summary: { totalEvents: number };
      };
    };
    expect(evidenceJson.ok).toBe(true);
    expect(typeof evidenceJson.data.summary.totalEvents).toBe("number");

    const exportRes = await fetch(
      `${env.baseUrl}/v1/workflow-runs/${runId}/evidence/exports`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({}),
      },
    );
    expect(exportRes.status).toBe(200);
    const exportJson = (await exportRes.json()) as {
      ok: boolean;
      data: {
        export: {
          exportId: string;
          runId: string;
          uri: string;
        };
      };
    };
    expect(exportJson.ok).toBe(true);
    expect(exportJson.data.export.runId).toBe(runId);
    expect(exportJson.data.export.exportId).toBeTruthy();
    expect(typeof exportJson.data.export.uri).toBe("string");
    const exportId = exportJson.data.export.exportId;

    const listRes = await fetch(
      `${env.baseUrl}/v1/workflow-runs/${runId}/evidence/exports`,
      { headers: authHeaders(token) },
    );
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as {
      ok: boolean;
      data: {
        items: Array<{ exportId: string }>;
      };
    };
    expect(listJson.ok).toBe(true);
    expect(listJson.data.items.some((item) => item.exportId === exportId)).toBe(true);

    const getExportRes = await fetch(
      `${env.baseUrl}/v1/workflow-runs/${runId}/evidence/exports/${exportId}`,
      { headers: authHeaders(token) },
    );
    expect(getExportRes.status).toBe(200);
    const getExportJson = (await getExportRes.json()) as {
      ok: boolean;
      data: {
        export: {
          exportId: string;
          runId: string;
          checksum: string;
        };
      };
    };
    expect(getExportJson.ok).toBe(true);
    expect(getExportJson.data.export.exportId).toBe(exportId);
    expect(getExportJson.data.export.runId).toBe(runId);

    const downloadRes = await fetch(
      `${env.baseUrl}/v1/workflow-runs/${runId}/evidence/exports/${exportId}/download`,
      { headers: authHeaders(token) },
    );
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get("content-type")).toContain("application/json");
    expect(downloadRes.headers.get("x-friday-evidence-checksum")).toBe(
      getExportJson.data.export.checksum,
    );
    const downloadBody = await downloadRes.text();
    expect(downloadBody.length).toBeGreaterThan(0);
    expect(createHash("sha256").update(downloadBody).digest("hex")).toBe(
      getExportJson.data.export.checksum,
    );

    const missingRes = await fetch(
      `${env.baseUrl}/v1/workflow-runs/${runId}/evidence/exports/not-found-export/download`,
      { headers: authHeaders(token) },
    );
    expect(missingRes.status).toBe(404);
    const missingJson = (await missingRes.json()) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(missingJson.ok).toBe(false);
    expect(missingJson.error.code).toBe("WORKFLOW_RUN_EVIDENCE_EXPORT_NOT_FOUND");
    expect(typeof missingJson.error.message).toBe("string");
  });

  // ── workflow_trigger_webhook_happy_path ─────────────────────────────────

  it("workflow_trigger_webhook_happy_path", async () => {
    // 1. Create a workflow with a webhook trigger node in the graph
    const webhookGraph = makeValidGraph();
    // Set the trigger node's config to triggerType=webhook so resync creates a webhook registration
    webhookGraph.graph.nodes[0] = {
      id: "trigger",
      type: "trigger",
      label: "Webhook Trigger",
      config: { triggerType: "webhook" },
    };

    const createRes = await fetch(`${env.baseUrl}/v1/workflows`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        slug: "test-wf-webhook-real",
        name: "Webhook Workflow",
        graph: webhookGraph,
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
    const versionNumber = createJson.data.version.versionNumber;

    // 2. Publish the workflow
    const publishRes = await fetch(
      `${env.baseUrl}/v1/workflows/${workflowId}/publish`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ versionNumber }),
      },
    );
    expect(publishRes.status).toBe(200);

    // 3. Resync triggers to register the webhook
    const resyncRes = await fetch(
      `${env.baseUrl}/v1/workflows/${workflowId}/triggers/resync`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({}),
      },
    );
    expect(resyncRes.status).toBe(200);

    // 4. List triggers to find the webhookPathToken
    const triggersRes = await fetch(
      `${env.baseUrl}/v1/workflows/${workflowId}/triggers`,
      { headers: authHeaders(token) },
    );
    expect(triggersRes.status).toBe(200);
    const triggersJson = (await triggersRes.json()) as {
      ok: boolean;
      data: {
        items: Array<{
          triggerType: string;
          webhookPathToken?: string;
        }>;
      };
    };
    expect(triggersJson.ok).toBe(true);

    const webhookReg = triggersJson.data.items.find(
      (t) => t.triggerType === "webhook",
    );
    expect(webhookReg).toBeDefined();
    expect(webhookReg!.webhookPathToken).toBeTruthy();

    const pathToken = webhookReg!.webhookPathToken!;

    // 5. Invoke the webhook
    const webhookRes = await fetch(
      `${env.baseUrl}/v1/workflow-webhooks/${pathToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "test", data: { foo: "bar" } }),
      },
    );
    expect(webhookRes.status).toBe(200);
    const webhookJson = (await webhookRes.json()) as {
      ok: boolean;
      data: { accepted: boolean; runId: string };
    };
    expect(webhookJson.ok).toBe(true);
    expect(webhookJson.data.accepted).toBe(true);
    expect(webhookJson.data.runId).toBeTruthy();
  });

  // ── workflow_error_shapes ──────────────────────────────────────────────

  it("workflow_error_shapes", async () => {
    // 404 for nonexistent workflow
    const res = await fetch(`${env.baseUrl}/v1/workflows/nonexistent-wf-id`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as {
      ok: boolean;
      error: { code: string; message: string; retryable: boolean };
      requestId: string;
    };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("WORKFLOW_NOT_FOUND");
    expect(typeof json.error.message).toBe("string");
    expect(typeof json.requestId).toBe("string");

    // 404 for nonexistent run
    const resRun = await fetch(`${env.baseUrl}/v1/workflow-runs/nonexistent-run-id`, {
      headers: authHeaders(token),
    });
    expect(resRun.status).toBe(404);
    const jsonRun = (await resRun.json()) as {
      ok: boolean;
      error: { code: string; message: string };
      requestId: string;
    };
    expect(jsonRun.ok).toBe(false);
    expect(jsonRun.error.code).toBe("WORKFLOW_RUN_NOT_FOUND");
    expect(typeof jsonRun.requestId).toBe("string");
  });
});
