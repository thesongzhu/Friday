/**
 * A-007 Deterministic Pipeline API Routes
 *
 * Unified route definitions for the five core pipeline modules:
 * rules, node-runner, acceptance, retry, and playbook.
 *
 * Uses existing workflow.read / workflow.write scopes since these
 * modules are sub-features of the workflow execution engine.
 *
 * @module api/http/routes
 */

import type {
  FridayRouteDefinition,
} from "../../model/friday-api-common.types.js";
import { FridayDomainError } from "../../../errors/friday-domain-error.js";

// ─── Deps Interface ───

export interface FridayDeterministicPipelineRoutesDeps {
  // ─ Rules ─
  rules: {
    listBundles: (query: Record<string, unknown>) => unknown;
    getBundle: (bundleId: string) => unknown;
    createBundle: (body: unknown) => unknown;
    updateBundle: (bundleId: string, body: unknown) => unknown;
    listBundleVersions: (bundleId: string, query: Record<string, unknown>) => unknown;
    listRules: (bundleId: string, query: Record<string, unknown>) => unknown;
    evaluateRules: (body: unknown) => unknown;
    simulateRules: (body: unknown) => unknown;
    listRuleVersions: (ruleId: string, query: Record<string, unknown>) => unknown;
    listEvaluationAuditLog: (query: Record<string, unknown>) => unknown;
  };

  // ─ Node Runner ─
  nodeRunner: {
    executeNode: (body: unknown) => Promise<unknown>;
    getExecution: (executionId: string) => unknown;
    listExecutions: (query: Record<string, unknown>) => unknown;
  };

  // ─ Acceptance ─
  acceptance: {
    runChecks: (body: unknown) => Promise<unknown>;
    getResult: (resultId: string) => unknown;
    listResults: (query: Record<string, unknown>) => unknown;
    listTests: (query: Record<string, unknown>) => unknown;
    getTest: (testId: string) => unknown;
    createTest: (body: unknown) => unknown;
    updateTest: (testId: string, body: unknown) => unknown;
    deleteTest: (testId: string, body: unknown) => unknown;
    listVersions: (testId: string, query: Record<string, unknown>) => unknown;
    listArtifactHistory: (query: Record<string, unknown>) => unknown;
  };

  // ─ Retry ─
  retry: {
    getPolicy: (policyId: string) => unknown;
    listPolicies: (query: Record<string, unknown>) => unknown;
    createPolicy: (body: unknown) => unknown;
    updatePolicy: (policyId: string, body: unknown) => unknown;
    deletePolicy: (policyId: string, body: unknown) => unknown;
    getTrace: (traceId: string) => unknown;
    listTraces: (query: Record<string, unknown>) => unknown;
    classifyFailure: (body: unknown) => unknown;
    decideRetry: (body: unknown) => unknown;
    getCostSummary: (query: Record<string, unknown>) => unknown;
    listEscalations: (query: Record<string, unknown>) => unknown;
    acknowledgeEscalation: (escalationId: string, body: unknown) => unknown;
    listCircuitBreakers: (query: Record<string, unknown>) => unknown;
  };

  // ─ Playbook ─
  playbook: {
    selectPlaybook: (body: unknown) => Promise<unknown>;
    listPlaybooks: (query: Record<string, unknown>) => unknown;
    getPlaybook: (playbookId: string) => unknown;
    promoteCandidate: (candidateId: string, body: unknown) => Promise<unknown>;
    listCandidates: (query: Record<string, unknown>) => unknown;
    rollbackPlaybook: (playbookId: string, body: unknown) => Promise<unknown>;
    getScoreHistory: (playbookId: string, query: Record<string, unknown>) => unknown;
  };
}

// ─── Route Factory ───

export function createFridayDeterministicPipelineRoutes(
  deps: FridayDeterministicPipelineRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    // ═══════════════════════════════════════════
    // RULES
    // ═══════════════════════════════════════════

    {
      operationId: "rules.bundles.list",
      method: "GET",
      path: "/v1/rules/bundles",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        return deps.rules.listBundles(ctx.query as Record<string, unknown>);
      },
    },

    {
      operationId: "rules.bundles.get",
      method: "GET",
      path: "/v1/rules/bundles/:bundleId",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { bundleId } = ctx.params as { bundleId: string };
        return deps.rules.getBundle(bundleId);
      },
    },

    {
      operationId: "rules.bundles.create",
      method: "POST",
      path: "/v1/rules/bundles",
      auth: { public: false, anyOfScopes: ["workflow.write"] },
      async handler(ctx) {
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || typeof body.name !== "string" || body.name.trim() === "") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "name is required and must be a non-empty string",
            { httpStatus: 400 },
          );
        }
        return deps.rules.createBundle(body);
      },
    },
    {
      operationId: "rules.bundles.update",
      method: "PATCH",
      path: "/v1/rules/bundles/:bundleId",
      auth: { public: false, anyOfScopes: ["workflow.write"] },
      async handler(ctx) {
        const { bundleId } = ctx.params as { bundleId: string };
        const body = ctx.body as Record<string, unknown> | null;
        if (!body) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "Request body is required",
            { httpStatus: 400 },
          );
        }
        return deps.rules.updateBundle(bundleId, body);
      },
    },
    {
      operationId: "rules.bundles.versions.list",
      method: "GET",
      path: "/v1/rules/bundles/:bundleId/versions",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { bundleId } = ctx.params as { bundleId: string };
        return deps.rules.listBundleVersions(bundleId, ctx.query as Record<string, unknown>);
      },
    },

    {
      operationId: "rules.list",
      method: "GET",
      path: "/v1/rules/bundles/:bundleId/rules",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { bundleId } = ctx.params as { bundleId: string };
        return deps.rules.listRules(bundleId, ctx.query as Record<string, unknown>);
      },
    },

    {
      operationId: "rules.evaluate",
      method: "POST",
      path: "/v1/rules/evaluate",
      auth: { public: false, anyOfScopes: ["workflow.run"] },
      async handler(ctx) {
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || typeof body.bundleId !== "string") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "bundleId is required",
            { httpStatus: 400 },
          );
        }
        return deps.rules.evaluateRules(body);
      },
    },

    {
      operationId: "rules.simulate",
      method: "POST",
      path: "/v1/rules/simulate",
      auth: { public: false, anyOfScopes: ["workflow.run"] },
      async handler(ctx) {
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || typeof body.bundleId !== "string") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "bundleId is required",
            { httpStatus: 400 },
          );
        }
        return deps.rules.simulateRules(body);
      },
    },

    {
      operationId: "rules.versions.list",
      method: "GET",
      path: "/v1/rules/:ruleId/versions",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { ruleId } = ctx.params as { ruleId: string };
        return deps.rules.listRuleVersions(ruleId, ctx.query as Record<string, unknown>);
      },
    },

    {
      operationId: "rules.audit.log.list",
      method: "GET",
      path: "/v1/rules/audit-log",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        return deps.rules.listEvaluationAuditLog(ctx.query as Record<string, unknown>);
      },
    },

    // ═══════════════════════════════════════════
    // NODE RUNNER
    // ═══════════════════════════════════════════

    {
      operationId: "node.runner.execute",
      method: "POST",
      path: "/v1/node-runner/execute",
      auth: { public: false, anyOfScopes: ["workflow.run"] },
      async handler(ctx) {
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || typeof body.nodeId !== "string") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "nodeId is required",
            { httpStatus: 400 },
          );
        }
        return deps.nodeRunner.executeNode(body);
      },
    },

    {
      operationId: "node.runner.executions.get",
      method: "GET",
      path: "/v1/node-runner/executions/:executionId",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { executionId } = ctx.params as { executionId: string };
        return deps.nodeRunner.getExecution(executionId);
      },
    },

    {
      operationId: "node.runner.executions.list",
      method: "GET",
      path: "/v1/node-runner/executions",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        return deps.nodeRunner.listExecutions(ctx.query as Record<string, unknown>);
      },
    },

    // ═══════════════════════════════════════════
    // ACCEPTANCE
    // ═══════════════════════════════════════════

    {
      operationId: "acceptance.run",
      method: "POST",
      path: "/v1/acceptance/run",
      auth: { public: false, anyOfScopes: ["workflow.run"] },
      async handler(ctx) {
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || typeof body.artifactType !== "string") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "artifactType is required",
            { httpStatus: 400 },
          );
        }
        return deps.acceptance.runChecks(body);
      },
    },

    {
      operationId: "acceptance.results.get",
      method: "GET",
      path: "/v1/acceptance/results/:resultId",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { resultId } = ctx.params as { resultId: string };
        return deps.acceptance.getResult(resultId);
      },
    },

    {
      operationId: "acceptance.results.list",
      method: "GET",
      path: "/v1/acceptance/results",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        return deps.acceptance.listResults(ctx.query as Record<string, unknown>);
      },
    },

    {
      operationId: "acceptance.runs.get",
      method: "GET",
      path: "/v1/acceptance/runs/:runId",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: string };
        return deps.acceptance.getResult(runId);
      },
    },

    {
      operationId: "acceptance.tests.list",
      method: "GET",
      path: "/v1/acceptance/tests",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        return deps.acceptance.listTests(ctx.query as Record<string, unknown>);
      },
    },

    {
      operationId: "acceptance.tests.get",
      method: "GET",
      path: "/v1/acceptance/tests/:testId",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { testId } = ctx.params as { testId: string };
        return deps.acceptance.getTest(testId);
      },
    },

    {
      operationId: "acceptance.tests.create",
      method: "POST",
      path: "/v1/acceptance/tests",
      auth: { public: false, anyOfScopes: ["workflow.write"] },
      async handler(ctx) {
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || typeof body.name !== "string" || typeof body.artifactType !== "string") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "name and artifactType are required",
            { httpStatus: 400 },
          );
        }
        return deps.acceptance.createTest(body);
      },
    },

    {
      operationId: "acceptance.tests.update",
      method: "PUT",
      path: "/v1/acceptance/tests/:testId",
      auth: { public: false, anyOfScopes: ["workflow.write"] },
      async handler(ctx) {
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || typeof body.etag !== "string") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "etag is required",
            { httpStatus: 400 },
          );
        }
        const { testId } = ctx.params as { testId: string };
        return deps.acceptance.updateTest(testId, body);
      },
    },

    {
      operationId: "acceptance.tests.delete",
      method: "DELETE",
      path: "/v1/acceptance/tests/:testId",
      auth: { public: false, anyOfScopes: ["workflow.write"] },
      async handler(ctx) {
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || typeof body.etag !== "string") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "etag is required",
            { httpStatus: 400 },
          );
        }
        const { testId } = ctx.params as { testId: string };
        return deps.acceptance.deleteTest(testId, body);
      },
    },

    {
      operationId: "acceptance.tests.versions.list",
      method: "GET",
      path: "/v1/acceptance/tests/:testId/versions",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { testId } = ctx.params as { testId: string };
        return deps.acceptance.listVersions(testId, ctx.query as Record<string, unknown>);
      },
    },

    {
      operationId: "acceptance.artifacts.history",
      method: "GET",
      path: "/v1/acceptance/artifacts/history",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        if (typeof (ctx.query as Record<string, unknown>).artifactUri !== "string") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "artifactUri is required",
            { httpStatus: 400 },
          );
        }
        return deps.acceptance.listArtifactHistory(ctx.query as Record<string, unknown>);
      },
    },

    // ═══════════════════════════════════════════
    // RETRY
    // ═══════════════════════════════════════════

    {
      operationId: "retry.policies.list",
      method: "GET",
      path: "/v1/retry/policies",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        return deps.retry.listPolicies(ctx.query as Record<string, unknown>);
      },
    },

    {
      operationId: "retry.policies.get",
      method: "GET",
      path: "/v1/retry/policies/:policyId",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { policyId } = ctx.params as { policyId: string };
        return deps.retry.getPolicy(policyId);
      },
    },

    {
      operationId: "retry.policies.create",
      method: "POST",
      path: "/v1/retry/policies",
      auth: { public: false, anyOfScopes: ["workflow.write"] },
      async handler(ctx) {
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || typeof body.name !== "string") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "name is required",
            { httpStatus: 400 },
          );
        }
        return deps.retry.createPolicy(body);
      },
    },

    {
      operationId: "retry.policies.update",
      method: "PUT",
      path: "/v1/retry/policies/:policyId",
      auth: { public: false, anyOfScopes: ["workflow.write"] },
      async handler(ctx) {
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || typeof body.etag !== "string") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "etag is required",
            { httpStatus: 400 },
          );
        }
        const { policyId } = ctx.params as { policyId: string };
        return deps.retry.updatePolicy(policyId, body);
      },
    },

    {
      operationId: "retry.policies.delete",
      method: "DELETE",
      path: "/v1/retry/policies/:policyId",
      auth: { public: false, anyOfScopes: ["workflow.write"] },
      async handler(ctx) {
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || typeof body.etag !== "string") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "etag is required",
            { httpStatus: 400 },
          );
        }
        const { policyId } = ctx.params as { policyId: string };
        return deps.retry.deletePolicy(policyId, body);
      },
    },

    {
      operationId: "retry.classify",
      method: "POST",
      path: "/v1/retry/classify",
      auth: { public: false, anyOfScopes: ["workflow.run"] },
      async handler(ctx) {
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || typeof body.error !== "object" || body.error === null) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "error is required",
            { httpStatus: 400 },
          );
        }
        return deps.retry.classifyFailure(body);
      },
    },

    {
      operationId: "retry.decide",
      method: "POST",
      path: "/v1/retry/decide",
      auth: { public: false, anyOfScopes: ["workflow.run"] },
      async handler(ctx) {
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || typeof body.runId !== "string" || typeof body.workflowId !== "string" || typeof body.nodeId !== "string") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "runId, workflowId, and nodeId are required",
            { httpStatus: 400 },
          );
        }
        return deps.retry.decideRetry(body);
      },
    },

    {
      operationId: "retry.traces.list",
      method: "GET",
      path: "/v1/retry/traces",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        return deps.retry.listTraces(ctx.query as Record<string, unknown>);
      },
    },

    {
      operationId: "retry.traces.get",
      method: "GET",
      path: "/v1/retry/traces/:traceId",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { traceId } = ctx.params as { traceId: string };
        return deps.retry.getTrace(traceId);
      },
    },

    {
      operationId: "retry.costs.summary",
      method: "GET",
      path: "/v1/retry/costs",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        return deps.retry.getCostSummary(ctx.query as Record<string, unknown>);
      },
    },

    {
      operationId: "retry.escalations.list",
      method: "GET",
      path: "/v1/retry/escalations",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        return deps.retry.listEscalations(ctx.query as Record<string, unknown>);
      },
    },

    {
      operationId: "retry.escalations.acknowledge",
      method: "POST",
      path: "/v1/retry/escalations/:escalationId/acknowledge",
      auth: { public: false, anyOfScopes: ["workflow.write"] },
      async handler(ctx) {
        const { escalationId } = ctx.params as { escalationId: string };
        return deps.retry.acknowledgeEscalation(escalationId, ctx.body);
      },
    },

    {
      operationId: "retry.circuit.breakers.list",
      method: "GET",
      path: "/v1/retry/circuit-breakers",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        return deps.retry.listCircuitBreakers(ctx.query as Record<string, unknown>);
      },
    },

    // ═══════════════════════════════════════════
    // PLAYBOOK
    // ═══════════════════════════════════════════

    {
      operationId: "playbook.list",
      method: "GET",
      path: "/v1/playbooks",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        return deps.playbook.listPlaybooks(ctx.query as Record<string, unknown>);
      },
    },

    {
      operationId: "playbook.get",
      method: "GET",
      path: "/v1/playbooks/:playbookId",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { playbookId } = ctx.params as { playbookId: string };
        return deps.playbook.getPlaybook(playbookId);
      },
    },

    {
      operationId: "playbook.select",
      method: "POST",
      path: "/v1/playbooks/select",
      auth: { public: false, anyOfScopes: ["workflow.run"] },
      async handler(ctx) {
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || typeof body.workflowType !== "string") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "workflowType is required",
            { httpStatus: 400 },
          );
        }
        return deps.playbook.selectPlaybook(body);
      },
    },

    {
      operationId: "playbook.candidates.list",
      method: "GET",
      path: "/v1/playbooks/candidates",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        return deps.playbook.listCandidates(ctx.query as Record<string, unknown>);
      },
    },

    {
      operationId: "playbook.candidates.promote",
      method: "POST",
      path: "/v1/playbooks/candidates/:candidateId/promote",
      auth: { public: false, anyOfScopes: ["workflow.write"] },
      async handler(ctx) {
        const { candidateId } = ctx.params as { candidateId: string };
        return deps.playbook.promoteCandidate(candidateId, ctx.body);
      },
    },

    {
      operationId: "playbook.rollback",
      method: "POST",
      path: "/v1/playbooks/:playbookId/rollback",
      auth: { public: false, anyOfScopes: ["workflow.write"] },
      async handler(ctx) {
        const { playbookId } = ctx.params as { playbookId: string };
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || typeof body.targetVersionNumber !== "number") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "targetVersionNumber is required and must be a number",
            { httpStatus: 400 },
          );
        }
        return deps.playbook.rollbackPlaybook(playbookId, body);
      },
    },

    {
      operationId: "playbook.scores",
      method: "GET",
      path: "/v1/playbooks/:playbookId/scores",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { playbookId } = ctx.params as { playbookId: string };
        return deps.playbook.getScoreHistory(playbookId, ctx.query as Record<string, unknown>);
      },
    },
  ];
}
