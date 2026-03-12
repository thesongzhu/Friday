import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFridayExpressionEvaluator,
  createFridayWorkflowArtifactRepository,
  createFridayWorkflowArtifactWriter,
  createFridayWorkflowDagScheduler,
  createFridayWorkflowExecutionService,
  createFridayWorkflowNodeExecutor,
  createFridayWorkflowNodeMachine,
  createFridayWorkflowRepository,
  createFridayWorkflowRetryManager,
  createFridayWorkflowRunMachine,
  createFridayWorkflowRunNodeRepository,
  createFridayWorkflowRunRepository,
} from "#workflows";
import type { FridayCompiledWorkflowGraphV2 } from "#workflows";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "./_helpers/create-test-db.helper.js";

describe("FridayWorkflowExecutionService — distributed execution", () => {
  let db: FridaySqliteLayer;
  let publishedEvents: Array<{ event: string; payload: unknown }>;
  let skillInvocations: Array<{ nodeId: string }>;

  function insertSatellite(id: string, pairingStatus: string = "online") {
    db.writer.prepare(
      `INSERT INTO satellites (
         id, display_name, type, pairing_status, trust_level, public_key,
         token_version, transport, platform, arch, app_version, node_version,
         tags_json, last_seen_at, created_at, updated_at
       ) VALUES (?, ?, 'standard', ?, 'trusted', 'pk', 1, 'https', 'linux', 'arm64', '1.0', '22.0', '[]', ?, ?, ?)`,
    ).run(
      id,
      `Satellite ${id}`,
      pairingStatus,
      "2026-02-16T12:00:00.000Z",
      "2026-02-16T12:00:00.000Z",
      "2026-02-16T12:00:00.000Z",
    );
  }

  function makeGraph(
    workflowId: string,
    versionId: string,
    nodes: FridayCompiledWorkflowGraphV2["graph"]["nodes"],
    edges: FridayCompiledWorkflowGraphV2["graph"]["edges"],
  ): FridayCompiledWorkflowGraphV2 {
    return {
      schemaVersion: "2.0",
      workflowId,
      workflowVersionId: versionId,
      sourceSpecSchemaVersion: "1.0",
      graph: {
        nodes,
        edges,
      },
      failurePolicy: { onFailure: "continue_on_error", notifyUser: false },
      tests: [],
      checksum: `${workflowId}:${versionId}`,
    };
  }

  function seedWorkflow(compiledGraph: FridayCompiledWorkflowGraphV2) {
    const workflowRepo = createFridayWorkflowRepository();
    db.withWriteTransaction((wdb) => {
      wdb.prepare(
        `INSERT INTO workflows (id, slug, name, description, tags_json, owner_user_id,
         latest_version_number, published_version_number, is_archived, revision, etag,
         created_at, updated_at)
         VALUES (?, ?, ?, NULL, '[]', 'test-user', 1, 1, 0, 1, 'etag-1',
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      ).run(compiledGraph.workflowId, `slug-${compiledGraph.workflowId}`, compiledGraph.workflowId);

      wdb.prepare(
        `INSERT INTO workflow_versions (id, workflow_id, version_number, checksum, graph_json,
         created_by_user_id, is_published, change_note, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, 'test-user', 1, NULL,
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      ).run(
        compiledGraph.workflowVersionId,
        compiledGraph.workflowId,
        compiledGraph.checksum,
        JSON.stringify(compiledGraph),
      );

      const version = workflowRepo.getPublishedVersion(wdb, compiledGraph.workflowId);
      expect(version?.id).toBe(compiledGraph.workflowVersionId);
    });
  }

  function buildService() {
    const idGen = createTestIdGenerator();
    const workflowRepo = createFridayWorkflowRepository();
    const runRepo = createFridayWorkflowRunRepository();
    const nodeRepo = createFridayWorkflowRunNodeRepository();
    const artifactRepo = createFridayWorkflowArtifactRepository();
    const dagScheduler = createFridayWorkflowDagScheduler();
    const runMachine = createFridayWorkflowRunMachine();
    const nodeMachine = createFridayWorkflowNodeMachine();
    const retryManager = createFridayWorkflowRetryManager({
      idGenerator: idGen,
      randomFn: () => 0,
    });
    const expressionEvaluator = createFridayExpressionEvaluator();
    const artifactWriter = createFridayWorkflowArtifactWriter({
      db,
      artifactRepo,
      idGenerator: idGen,
      nowIso: () => "2026-02-16T12:00:00.000Z",
    });
    const nodeExecutor = createFridayWorkflowNodeExecutor({
      expressionEvaluator,
      resolveSkill: () => "test-skill",
      invokeSkill: async (_skillId, _runId, nodeId) => {
        skillInvocations.push({ nodeId });
        return { ok: true, nodeId };
      },
      nowIso: () => "2026-02-16T12:00:00.000Z",
    });

    return createFridayWorkflowExecutionService({
      db,
      workflowRepo,
      runRepo,
      nodeRepo,
      artifactRepo,
      dagScheduler,
      runMachine,
      nodeMachine,
      nodeExecutor,
      retryManager,
      artifactWriter,
      expressionEvaluator,
      idGenerator: idGen,
      nowIso: () => "2026-02-16T12:00:00.000Z",
      publishEvent: async (event, payload) => {
        publishedEvents.push({ event, payload });
      },
    });
  }

  async function settle(ms = 50): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  beforeEach(() => {
    db = createTestDb();
    publishedEvents = [];
    skillInvocations = [];
  });

  afterEach(() => {
    db.close();
  });

  it("dispatches configured nodes to a satellite without silently executing on hub", async () => {
    const graph = makeGraph(
      "wf-sat-dispatch",
      "wv-sat-dispatch",
      [
        {
          id: "remote-step",
          type: "action",
          label: "remote-step",
          config: {
            skillId: "test-skill",
            executionTarget: "satellite:sat-1",
          },
        },
      ],
      [],
    );
    seedWorkflow(graph);
    insertSatellite("sat-1");
    const svc = buildService();
    svc.setDistributedDispatcher({
      dispatchNode: async () => ({
        kind: "satellite_dispatched",
        satelliteId: "sat-1",
        leaseOwner: "satellite:sat-1",
        leaseExpiresAt: "2026-02-16T12:05:00.000Z",
      }),
    });

    const run = await svc.startRun({
      workflowId: graph.workflowId,
      workflowVersionId: graph.workflowVersionId,
      triggerType: "manual",
    });

    await settle(100);

    const currentRun = svc.getRun(run.id);
    expect(currentRun?.status).toBe("running");
    const nodes = svc.getRunNodes(run.id);
    expect(nodes.find((node) => node.nodeId === "remote-step")?.status).toBe("running");
    expect(nodes.find((node) => node.nodeId === "remote-step")?.satelliteId).toBe("sat-1");
    expect(skillInvocations).toHaveLength(0);
    expect(publishedEvents.some((entry) => entry.event === "workflow.node.started")).toBe(true);

    await svc.cancelRun(run.id, "test-cleanup");
  });

  it("pauses the run when the selected satellite is blocked offline", async () => {
    const graph = makeGraph(
      "wf-sat-blocked",
      "wv-sat-blocked",
      [
        {
          id: "remote-step",
          type: "action",
          label: "remote-step",
          config: {
            skillId: "test-skill",
            executionTarget: "satellite:sat-1",
          },
        },
      ],
      [],
    );
    seedWorkflow(graph);
    insertSatellite("sat-1", "offline");
    const svc = buildService();
    svc.setDistributedDispatcher({
      dispatchNode: async () => ({
        kind: "blocked",
        satelliteId: "sat-1",
        code: "SATELLITE_OFFLINE",
        message: "Target satellite is offline",
        retryable: true,
      }),
    });

    const run = await svc.startRun({
      workflowId: graph.workflowId,
      workflowVersionId: graph.workflowVersionId,
      triggerType: "manual",
    });

    await settle(100);

    const currentRun = svc.getRun(run.id);
    expect(currentRun?.status).toBe("paused");
    const remoteNode = svc.getRunNodes(run.id).find((node) => node.nodeId === "remote-step");
    expect(remoteNode?.status).toBe("blocked_offline");
    expect(remoteNode?.error?.code).toBe("SATELLITE_OFFLINE");
    expect(skillInvocations).toHaveLength(0);
    expect(publishedEvents.some((entry) => entry.event === "workflow.node.blocked_offline")).toBe(true);

    await svc.cancelRun(run.id, "test-cleanup");
  });

  it("continues a remotely dispatched run after the satellite reports completion", async () => {
    const graph = makeGraph(
      "wf-sat-complete",
      "wv-sat-complete",
      [
        {
          id: "remote-step",
          type: "action",
          label: "remote-step",
          config: {
            skillId: "test-skill",
            executionTarget: "satellite:sat-1",
          },
        },
        {
          id: "final-step",
          type: "action",
          label: "final-step",
          config: {
            skillId: "test-skill",
          },
        },
      ],
      [{ id: "edge-1", sourceNodeId: "remote-step", targetNodeId: "final-step" }],
    );
    seedWorkflow(graph);
    insertSatellite("sat-1");
    const svc = buildService();
    svc.setDistributedDispatcher({
      dispatchNode: async ({ nodeId }) =>
        nodeId === "remote-step"
          ? {
            kind: "satellite_dispatched",
            satelliteId: "sat-1",
            leaseOwner: "satellite:sat-1",
            leaseExpiresAt: "2026-02-16T12:05:00.000Z",
          }
          : { kind: "hub" },
    });

    const run = await svc.startRun({
      workflowId: graph.workflowId,
      workflowVersionId: graph.workflowVersionId,
      triggerType: "manual",
    });

    await settle(100);

    const remoteAttempt = svc
      .getRunNodes(run.id)
      .find((node) => node.nodeId === "remote-step" && node.status === "running");
    expect(remoteAttempt).toBeDefined();

    await svc.reportRemoteNodeResult({
      satelliteId: "sat-1",
      runId: run.id,
      nodeId: "remote-step",
      attemptId: remoteAttempt!.attemptId,
      attempt: remoteAttempt!.attempt,
      status: "completed",
      output: { remote: true },
    });

    await settle(100);

    const currentRun = svc.getRun(run.id);
    expect(currentRun?.status).toBe("completed");
    const nodes = svc.getRunNodes(run.id);
    expect(nodes.find((node) => node.nodeId === "remote-step" && node.status === "completed")).toBeDefined();
    expect(nodes.find((node) => node.nodeId === "final-step" && node.status === "completed")).toBeDefined();
  });

  it("retries blocked satellite nodes after operator resume once the target becomes available", async () => {
    const graph = makeGraph(
      "wf-sat-recover",
      "wv-sat-recover",
      [
        {
          id: "remote-step",
          type: "action",
          label: "remote-step",
          config: {
            skillId: "test-skill",
            executionTarget: "satellite:sat-1",
          },
        },
      ],
      [],
    );
    seedWorkflow(graph);
    insertSatellite("sat-1");

    let online = false;
    const svc = buildService();
    svc.setDistributedDispatcher({
      dispatchNode: async () =>
        online
          ? {
            kind: "satellite_dispatched",
            satelliteId: "sat-1",
            leaseOwner: "satellite:sat-1",
            leaseExpiresAt: "2026-02-16T12:05:00.000Z",
          }
          : {
            kind: "blocked",
            satelliteId: "sat-1",
            code: "SATELLITE_OFFLINE",
            message: "Target satellite is offline",
            retryable: true,
          },
    });

    const run = await svc.startRun({
      workflowId: graph.workflowId,
      workflowVersionId: graph.workflowVersionId,
      triggerType: "manual",
    });

    await settle(100);
    expect(svc.getRun(run.id)?.status).toBe("paused");
    expect(
      svc.getRunNodes(run.id).find((node) => node.nodeId === "remote-step" && node.status === "blocked_offline"),
    ).toBeDefined();

    online = true;
    await svc.resumeRun(run.id);
    await settle(100);

    const runningAttempt = svc
      .getRunNodes(run.id)
      .find((node) => node.nodeId === "remote-step" && node.status === "running");
    expect(runningAttempt).toBeDefined();

    await svc.reportRemoteNodeResult({
      satelliteId: "sat-1",
      runId: run.id,
      nodeId: "remote-step",
      attemptId: runningAttempt!.attemptId,
      attempt: runningAttempt!.attempt,
      status: "completed",
      output: { resumed: true },
    });

    await settle(100);
    expect(svc.getRun(run.id)?.status).toBe("completed");
  });
});
