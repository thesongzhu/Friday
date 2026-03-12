/**
 * A-007 Deterministic Pipeline Routes — Contract Tests
 *
 * Validates route registration, auth scopes, request validation,
 * and handler delegation for rules/node-runner/acceptance/retry/playbook.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createFridayDeterministicPipelineRoutes,
  type FridayDeterministicPipelineRoutesDeps,
} from "../../../../../src/api/http/routes/friday-deterministic-pipeline-routes.js";
import type {
  FridayRouteDefinition,
  FridayHttpContext,
} from "../../../../../src/api/model/friday-api-common.types.js";

// ─── Helpers ───

function makeCtx(overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {}): FridayHttpContext<unknown, unknown, unknown> {
  return {
    requestId: "req-test-1",
    receivedAt: "2026-01-01T00:00:00Z",
    params: {},
    query: {},
    body: null,
    headers: {},
    principal: null,
    ...overrides,
  };
}

function findRoute(routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[], operationId: string) {
  return routes.find((r) => r.operationId === operationId)!;
}

function makeDeps(): FridayDeterministicPipelineRoutesDeps {
  return {
    rules: {
      listBundles: vi.fn().mockReturnValue({ bundles: [], total: 0 }),
      getBundle: vi.fn().mockReturnValue({ bundle: { id: "b-1" } }),
      createBundle: vi.fn().mockReturnValue({ bundle: { id: "b-new" } }),
      listRules: vi.fn().mockReturnValue({ rules: [] }),
      evaluateRules: vi.fn().mockReturnValue({ result: "pass" }),
      simulateRules: vi.fn().mockReturnValue({ result: "warn" }),
      listRuleVersions: vi.fn().mockReturnValue({ items: [] }),
      listEvaluationAuditLog: vi.fn().mockReturnValue({ items: [] }),
    },
    nodeRunner: {
      executeNode: vi.fn().mockResolvedValue({ executionId: "exec-1" }),
      getExecution: vi.fn().mockReturnValue({ execution: { id: "exec-1" } }),
      listExecutions: vi.fn().mockReturnValue({ executions: [] }),
    },
    acceptance: {
      runChecks: vi.fn().mockResolvedValue({ result: { decision: "pass" } }),
      getResult: vi.fn().mockReturnValue({ result: { id: "res-1" } }),
      listResults: vi.fn().mockReturnValue({ results: [] }),
      listTests: vi.fn().mockReturnValue({ items: [] }),
      getTest: vi.fn().mockReturnValue({ test: { id: "test-1" } }),
      createTest: vi.fn().mockReturnValue({ test: { id: "test-1" } }),
      updateTest: vi.fn().mockReturnValue({ test: { id: "test-1" } }),
      deleteTest: vi.fn().mockReturnValue({ deleted: true, testId: "test-1" }),
      listVersions: vi.fn().mockReturnValue({ items: [] }),
      listArtifactHistory: vi.fn().mockReturnValue({ items: [] }),
    },
    retry: {
      getPolicy: vi.fn().mockReturnValue({ policy: { id: "pol-1" } }),
      listPolicies: vi.fn().mockReturnValue({ policies: [] }),
      createPolicy: vi.fn().mockReturnValue({ policy: { id: "pol-new" } }),
      updatePolicy: vi.fn().mockReturnValue({ policy: { id: "pol-1" } }),
      deletePolicy: vi.fn().mockReturnValue({ deleted: true, policyId: "pol-1" }),
      getTrace: vi.fn().mockReturnValue({ trace: { id: "tr-1" } }),
      listTraces: vi.fn().mockReturnValue({ traces: [] }),
      classifyFailure: vi.fn().mockReturnValue({ classifiedFailure: { category: "transient" } }),
      decideRetry: vi.fn().mockReturnValue({ decision: { shouldRetry: true } }),
      getCostSummary: vi.fn().mockReturnValue({ summary: { totalCost: { tokens: 0, apiCalls: 0, computeMs: 0 } } }),
      listEscalations: vi.fn().mockReturnValue({ items: [] }),
      acknowledgeEscalation: vi.fn().mockReturnValue({ escalation: { id: "esc-1" } }),
      listCircuitBreakers: vi.fn().mockReturnValue({ items: [] }),
    },
    playbook: {
      selectPlaybook: vi.fn().mockResolvedValue({ match: { playbookId: "pb-1" } }),
      listPlaybooks: vi.fn().mockReturnValue({ playbooks: [] }),
      getPlaybook: vi.fn().mockReturnValue({ playbook: { id: "pb-1" } }),
      promoteCandidate: vi.fn().mockResolvedValue({ decision: "promote" }),
      listCandidates: vi.fn().mockReturnValue({ candidates: [] }),
      rollbackPlaybook: vi.fn().mockResolvedValue({ playbook: { id: "pb-1" } }),
      getScoreHistory: vi.fn().mockReturnValue({ scores: [] }),
    },
  };
}

// ─── Tests ───

describe("A-007 FridayDeterministicPipelineRoutes", () => {
  describe("route registration", () => {
    it("registers all expected routes", () => {
      const routes = createFridayDeterministicPipelineRoutes(makeDeps());
      expect(routes.length).toBe(42);
    });

    it("has unique operationIds", () => {
      const routes = createFridayDeterministicPipelineRoutes(makeDeps());
      const ids = routes.map((r) => r.operationId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("all routes require authentication", () => {
      const routes = createFridayDeterministicPipelineRoutes(makeDeps());
      for (const route of routes) {
        expect(route.auth).toHaveProperty("public", false);
      }
    });
  });

  describe("rules routes", () => {
    it("GET /v1/rules/bundles delegates to listBundles", async () => {
      const deps = makeDeps();
      const routes = createFridayDeterministicPipelineRoutes(deps);
      const route = findRoute(routes, "rules.bundles.list");

      expect(route.method).toBe("GET");
      expect(route.path).toBe("/v1/rules/bundles");
      expect(route.auth).toEqual({ public: false, anyOfScopes: ["workflow.read"] });

      await route.handler(makeCtx({ query: { status: "active" } }));
      expect(deps.rules.listBundles).toHaveBeenCalledWith({ status: "active" });
    });

    it("GET /v1/rules/bundles/:bundleId delegates to getBundle", async () => {
      const deps = makeDeps();
      const routes = createFridayDeterministicPipelineRoutes(deps);
      const route = findRoute(routes, "rules.bundles.get");

      expect(route.method).toBe("GET");
      await route.handler(makeCtx({ params: { bundleId: "b-42" } }));
      expect(deps.rules.getBundle).toHaveBeenCalledWith("b-42");
    });

    it("POST /v1/rules/bundles validates name", async () => {
      const deps = makeDeps();
      const routes = createFridayDeterministicPipelineRoutes(deps);
      const route = findRoute(routes, "rules.bundles.create");

      expect(route.method).toBe("POST");
      expect(route.auth).toEqual({ public: false, anyOfScopes: ["workflow.write"] });

      await expect(route.handler(makeCtx({ body: {} }))).rejects.toThrow("name is required");
      await expect(route.handler(makeCtx({ body: null }))).rejects.toThrow("name is required");
    });

    it("POST /v1/rules/bundles creates with valid body", async () => {
      const deps = makeDeps();
      const routes = createFridayDeterministicPipelineRoutes(deps);
      const route = findRoute(routes, "rules.bundles.create");

      await route.handler(makeCtx({ body: { name: "My Bundle" } }));
      expect(deps.rules.createBundle).toHaveBeenCalledWith({ name: "My Bundle" });
    });

    it("POST /v1/rules/evaluate validates bundleId", async () => {
      const deps = makeDeps();
      const routes = createFridayDeterministicPipelineRoutes(deps);
      const route = findRoute(routes, "rules.evaluate");

      expect(route.auth).toEqual({ public: false, anyOfScopes: ["workflow.run"] });
      await expect(route.handler(makeCtx({ body: {} }))).rejects.toThrow("bundleId is required");
    });

    it("GET /v1/rules/:ruleId/versions delegates to listRuleVersions", async () => {
      const deps = makeDeps();
      const routes = createFridayDeterministicPipelineRoutes(deps);
      const route = findRoute(routes, "rules.versions.list");

      await route.handler(makeCtx({ params: { ruleId: "rule-1" }, query: { limit: 10 } }));
      expect(deps.rules.listRuleVersions).toHaveBeenCalledWith("rule-1", { limit: 10 });
    });
  });

  describe("node-runner routes", () => {
    it("POST /v1/node-runner/execute validates nodeId", async () => {
      const deps = makeDeps();
      const routes = createFridayDeterministicPipelineRoutes(deps);
      const route = findRoute(routes, "node.runner.execute");

      expect(route.method).toBe("POST");
      expect(route.auth).toEqual({ public: false, anyOfScopes: ["workflow.run"] });
      await expect(route.handler(makeCtx({ body: {} }))).rejects.toThrow("nodeId is required");
    });

    it("POST /v1/node-runner/execute delegates with valid body", async () => {
      const deps = makeDeps();
      const routes = createFridayDeterministicPipelineRoutes(deps);
      const route = findRoute(routes, "node.runner.execute");

      await route.handler(makeCtx({ body: { nodeId: "n-1" } }));
      expect(deps.nodeRunner.executeNode).toHaveBeenCalledWith({ nodeId: "n-1" });
    });

    it("GET /v1/node-runner/executions/:executionId delegates to getExecution", async () => {
      const deps = makeDeps();
      const routes = createFridayDeterministicPipelineRoutes(deps);
      const route = findRoute(routes, "node.runner.executions.get");

      expect(route.method).toBe("GET");
      await route.handler(makeCtx({ params: { executionId: "exec-99" } }));
      expect(deps.nodeRunner.getExecution).toHaveBeenCalledWith("exec-99");
    });

    it("GET /v1/node-runner/executions delegates to listExecutions", async () => {
      const deps = makeDeps();
      const routes = createFridayDeterministicPipelineRoutes(deps);
      const route = findRoute(routes, "node.runner.executions.list");

      expect(route.method).toBe("GET");
      await route.handler(makeCtx({ query: { runId: "r-1" } }));
      expect(deps.nodeRunner.listExecutions).toHaveBeenCalledWith({ runId: "r-1" });
    });
  });

  describe("acceptance routes", () => {
    it("POST /v1/acceptance/run validates artifactType", async () => {
      const deps = makeDeps();
      const routes = createFridayDeterministicPipelineRoutes(deps);
      const route = findRoute(routes, "acceptance.run");

      expect(route.method).toBe("POST");
      await expect(route.handler(makeCtx({ body: {} }))).rejects.toThrow("artifactType is required");
    });

    it("POST /v1/acceptance/run delegates with valid body", async () => {
      const deps = makeDeps();
      const routes = createFridayDeterministicPipelineRoutes(deps);
      const route = findRoute(routes, "acceptance.run");

      await route.handler(makeCtx({ body: { artifactType: "workflow_output" } }));
      expect(deps.acceptance.runChecks).toHaveBeenCalledWith({ artifactType: "workflow_output" });
    });

    it("GET /v1/acceptance/results/:resultId delegates to getResult", async () => {
      const deps = makeDeps();
      const routes = createFridayDeterministicPipelineRoutes(deps);
      const route = findRoute(routes, "acceptance.results.get");

      await route.handler(makeCtx({ params: { resultId: "res-7" } }));
      expect(deps.acceptance.getResult).toHaveBeenCalledWith("res-7");
    });

    it("POST /v1/acceptance/tests validates required fields", async () => {
      const deps = makeDeps();
      const routes = createFridayDeterministicPipelineRoutes(deps);
      const route = findRoute(routes, "acceptance.tests.create");

      await expect(route.handler(makeCtx({ body: {} }))).rejects.toThrow("name and artifactType are required");
    });

    it("DELETE /v1/acceptance/tests/:testId validates etag", async () => {
      const deps = makeDeps();
      const routes = createFridayDeterministicPipelineRoutes(deps);
      const route = findRoute(routes, "acceptance.tests.delete");

      await expect(route.handler(makeCtx({ params: { testId: "test-1" }, body: {} }))).rejects.toThrow("etag is required");
    });
  });

  describe("retry routes", () => {
    it("GET /v1/retry/policies lists policies", async () => {
      const deps = makeDeps();
      const routes = createFridayDeterministicPipelineRoutes(deps);
      const route = findRoute(routes, "retry.policies.list");

      expect(route.method).toBe("GET");
      expect(route.auth).toEqual({ public: false, anyOfScopes: ["workflow.read"] });
      await route.handler(makeCtx());
      expect(deps.retry.listPolicies).toHaveBeenCalled();
    });

    it("GET /v1/retry/policies/:policyId delegates to getPolicy", async () => {
      const deps = makeDeps();
      const routes = createFridayDeterministicPipelineRoutes(deps);
      const route = findRoute(routes, "retry.policies.get");

      await route.handler(makeCtx({ params: { policyId: "pol-5" } }));
      expect(deps.retry.getPolicy).toHaveBeenCalledWith("pol-5");
    });

    it("GET /v1/retry/traces/:traceId delegates to getTrace", async () => {
      const deps = makeDeps();
      const routes = createFridayDeterministicPipelineRoutes(deps);
      const route = findRoute(routes, "retry.traces.get");

      await route.handler(makeCtx({ params: { traceId: "tr-3" } }));
      expect(deps.retry.getTrace).toHaveBeenCalledWith("tr-3");
    });

    it("POST /v1/retry/classify validates error descriptor", async () => {
      const deps = makeDeps();
      const routes = createFridayDeterministicPipelineRoutes(deps);
      const route = findRoute(routes, "retry.classify");

      await expect(route.handler(makeCtx({ body: {} }))).rejects.toThrow("error is required");
    });

    it("POST /v1/retry/escalations/:escalationId/acknowledge delegates", async () => {
      const deps = makeDeps();
      const routes = createFridayDeterministicPipelineRoutes(deps);
      const route = findRoute(routes, "retry.escalations.acknowledge");

      await route.handler(makeCtx({ params: { escalationId: "esc-1" }, body: { note: "ack" } }));
      expect(deps.retry.acknowledgeEscalation).toHaveBeenCalledWith("esc-1", { note: "ack" });
    });
  });

  describe("playbook routes", () => {
    it("GET /v1/playbooks lists playbooks", async () => {
      const deps = makeDeps();
      const routes = createFridayDeterministicPipelineRoutes(deps);
      const route = findRoute(routes, "playbook.list");

      expect(route.method).toBe("GET");
      await route.handler(makeCtx({ query: { status: "active" } }));
      expect(deps.playbook.listPlaybooks).toHaveBeenCalledWith({ status: "active" });
    });

    it("GET /v1/playbooks/:playbookId delegates to getPlaybook", async () => {
      const deps = makeDeps();
      const routes = createFridayDeterministicPipelineRoutes(deps);
      const route = findRoute(routes, "playbook.get");

      await route.handler(makeCtx({ params: { playbookId: "pb-42" } }));
      expect(deps.playbook.getPlaybook).toHaveBeenCalledWith("pb-42");
    });

    it("POST /v1/playbooks/select validates workflowType", async () => {
      const deps = makeDeps();
      const routes = createFridayDeterministicPipelineRoutes(deps);
      const route = findRoute(routes, "playbook.select");

      expect(route.auth).toEqual({ public: false, anyOfScopes: ["workflow.run"] });
      await expect(route.handler(makeCtx({ body: {} }))).rejects.toThrow("workflowType is required");
    });

    it("POST /v1/playbooks/select delegates with valid body", async () => {
      const deps = makeDeps();
      const routes = createFridayDeterministicPipelineRoutes(deps);
      const route = findRoute(routes, "playbook.select");

      await route.handler(makeCtx({ body: { workflowType: "data-pipeline" } }));
      expect(deps.playbook.selectPlaybook).toHaveBeenCalledWith({ workflowType: "data-pipeline" });
    });

    it("POST /v1/playbooks/candidates/:candidateId/promote delegates", async () => {
      const deps = makeDeps();
      const routes = createFridayDeterministicPipelineRoutes(deps);
      const route = findRoute(routes, "playbook.candidates.promote");

      expect(route.method).toBe("POST");
      expect(route.auth).toEqual({ public: false, anyOfScopes: ["workflow.write"] });
      await route.handler(makeCtx({ params: { candidateId: "cand-1" }, body: { force: true } }));
      expect(deps.playbook.promoteCandidate).toHaveBeenCalledWith("cand-1", { force: true });
    });

    it("POST /v1/playbooks/:playbookId/rollback validates targetVersionNumber", async () => {
      const deps = makeDeps();
      const routes = createFridayDeterministicPipelineRoutes(deps);
      const route = findRoute(routes, "playbook.rollback");

      expect(route.auth).toEqual({ public: false, anyOfScopes: ["workflow.write"] });
      await expect(route.handler(makeCtx({
        params: { playbookId: "pb-1" },
        body: { targetVersionNumber: "not-a-number" },
      }))).rejects.toThrow("targetVersionNumber is required");
    });

    it("POST /v1/playbooks/:playbookId/rollback delegates with valid body", async () => {
      const deps = makeDeps();
      const routes = createFridayDeterministicPipelineRoutes(deps);
      const route = findRoute(routes, "playbook.rollback");

      await route.handler(makeCtx({
        params: { playbookId: "pb-1" },
        body: { targetVersionNumber: 2 },
      }));
      expect(deps.playbook.rollbackPlaybook).toHaveBeenCalledWith("pb-1", { targetVersionNumber: 2 });
    });

    it("GET /v1/playbooks/:playbookId/scores delegates to getScoreHistory", async () => {
      const deps = makeDeps();
      const routes = createFridayDeterministicPipelineRoutes(deps);
      const route = findRoute(routes, "playbook.scores");

      await route.handler(makeCtx({ params: { playbookId: "pb-1" } }));
      expect(deps.playbook.getScoreHistory).toHaveBeenCalledWith("pb-1", {});
    });
  });

  describe("scope contract snapshot", () => {
    const routes = createFridayDeterministicPipelineRoutes(makeDeps());

    const readRoutes = routes.filter(
      (r) => r.auth && !("public" in r.auth && r.auth.public === true) && "anyOfScopes" in r.auth && r.auth.anyOfScopes.includes("workflow.read"),
    );
    const writeRoutes = routes.filter(
      (r) => r.auth && !("public" in r.auth && r.auth.public === true) && "anyOfScopes" in r.auth && r.auth.anyOfScopes.includes("workflow.write"),
    );
    const runRoutes = routes.filter(
      (r) => r.auth && !("public" in r.auth && r.auth.public === true) && "anyOfScopes" in r.auth && r.auth.anyOfScopes.includes("workflow.run"),
    );

    it("read-scoped routes are GET only", () => {
      for (const route of readRoutes) {
        expect(route.method).toBe("GET");
      }
    });

    it("run-scoped routes are POST only", () => {
      for (const route of runRoutes) {
        expect(route.method).toBe("POST");
      }
    });

    it("write-scoped routes are mutating operations", () => {
      for (const route of writeRoutes) {
        expect(["POST", "PUT", "PATCH", "DELETE"]).toContain(route.method);
      }
    });

    it("expected scope counts", () => {
      expect(readRoutes.length).toBe(25);
      expect(writeRoutes.length).toBe(10);
      expect(runRoutes.length).toBe(7);
    });
  });
});
