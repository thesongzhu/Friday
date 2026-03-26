import {
  AcceptanceTestSuiteRunner,
  type FridayAcceptanceTest,
  InMemoryTestRegistry,
} from "#acceptance";

import type { JsonObject, JsonValue } from "#rules";

import { createFridayTemplateHarnessRepository } from "../persistence/friday-template-harness-repository.js";
import type { CreateFridayTemplateHarnessRepositoryDeps } from "../persistence/friday-template-harness-repository.js";
import type {
  FridayHarnessDeliveryContractV1,
  FridayHarnessHandoffArtifactV1,
  FridayHarnessPlanningSpecV1,
  FridayHarnessQaVerdictV1,
  FridayTemplateHarnessAcceptanceInput,
  FridayTemplateHarnessSummary,
} from "../model/friday-template-harness.types.js";

export interface FridayTemplateHarnessService {
  readonly enabled: boolean;
  createOrUpdatePlanningSpec(
    artifact: FridayHarnessPlanningSpecV1,
  ): FridayHarnessPlanningSpecV1;
  getPlanningSpec(artifactId: string): FridayHarnessPlanningSpecV1 | null;
  createOrUpdateDeliveryContract(
    artifact: FridayHarnessDeliveryContractV1,
  ): FridayHarnessDeliveryContractV1;
  getDeliveryContract(artifactId: string): FridayHarnessDeliveryContractV1 | null;
  evaluateQaVerdict(
    input: FridayTemplateHarnessAcceptanceInput,
  ): Promise<FridayHarnessQaVerdictV1>;
  getQaVerdict(artifactId: string): FridayHarnessQaVerdictV1 | null;
  createOrUpdateHandoffArtifact(
    artifact: FridayHarnessHandoffArtifactV1,
  ): FridayHarnessHandoffArtifactV1;
  getHandoffArtifact(artifactId: string): FridayHarnessHandoffArtifactV1 | null;
  buildSummary(input: {
    stage: FridayTemplateHarnessSummary["stage"];
    planningSpecId?: string;
    deliveryContractId?: string;
    qaVerdictId?: string;
    handoffArtifactId?: string;
    summary?: string;
  }): FridayTemplateHarnessSummary;
}

export interface CreateFridayTemplateHarnessServiceDeps
  extends CreateFridayTemplateHarnessRepositoryDeps {}

function isTemplateHarnessEnabled(): boolean {
  return (process.env.FRIDAY_TEMPLATE_HARNESS_V1 ?? "").trim().toLowerCase() === "true";
}

function makeQaSummary(
  verdict: FridayHarnessQaVerdictV1["verdict"],
  failedCriteria: string[],
  blockedReasons: string[],
): string {
  if (verdict === "blocked") {
    return blockedReasons.length > 0
      ? `Blocked: ${blockedReasons.join("; ")}`
      : "Blocked waiting for required evidence.";
  }
  if (verdict === "fail") {
    return failedCriteria.length > 0
      ? `Failed: ${failedCriteria.join("; ")}`
      : "Failed one or more required checks.";
  }
  return "All required checks passed.";
}

function summarizeEvidenceRef(id: string): string {
  return id.trim();
}

export function createFridayTemplateHarnessService(
  deps: CreateFridayTemplateHarnessServiceDeps,
): FridayTemplateHarnessService {
  const repo = createFridayTemplateHarnessRepository(deps);
  const enabled = isTemplateHarnessEnabled();

  return {
    enabled,

    createOrUpdatePlanningSpec(artifact) {
      return repo.upsertPlanningSpec(artifact);
    },

    getPlanningSpec(artifactId) {
      return repo.getPlanningSpec(artifactId);
    },

    createOrUpdateDeliveryContract(artifact) {
      return repo.upsertDeliveryContract(artifact);
    },

    getDeliveryContract(artifactId) {
      return repo.getDeliveryContract(artifactId);
    },

    async evaluateQaVerdict(input) {
      const now = deps.nowIso();
      const blockedReasons = (input.missingEvidenceReasons ?? []).filter(Boolean);

      if (blockedReasons.length > 0) {
        const verdict: FridayHarnessQaVerdictV1 = {
          artifactId: input.existingQaVerdictId ?? deps.idGenerator(),
          version: 1,
          scopeKind: input.scopeKind,
          scopeId: input.scopeId,
          deliveryContractId: input.deliveryContract.artifactId,
          verdict: "blocked",
          summary: makeQaSummary("blocked", [], blockedReasons),
          passedCriteria: [],
          failedCriteria: [],
          blockedReasons,
          warnings: [],
          evidenceRefs: (input.evidenceRefs ?? []).map(summarizeEvidenceRef),
          createdAt: now,
          updatedAt: now,
        };
        return repo.upsertQaVerdict(verdict);
      }

      const registry = new InMemoryTestRegistry();
      for (const test of input.tests) {
        registry.register(test);
      }

      const runner = new AcceptanceTestSuiteRunner({ registry });
      const artifact = {
        artifactType: "json" as const,
        uri: `memory://template-harness/${input.scopeKind}/${input.scopeId}/${input.deliveryContract.artifactId}`,
        metadata: { content: input.artifactContent },
      };
      const run = await runner.runForArtifact(deps.idGenerator(), artifact);
      const executedChecks = run.checks.filter((check): check is Extract<typeof run.checks[number], { status: "executed" }> => check.status === "executed");

      const failedCriteria = executedChecks
        .filter((check) => check.verdict === "fail")
        .map((check) => registry.getById(check.testId)?.name ?? check.testId);
      const warnings = executedChecks
        .filter((check) => check.verdict === "warn")
        .map((check) => registry.getById(check.testId)?.name ?? check.testId);
      const passedCriteria = executedChecks
        .filter((check) => check.verdict === "pass")
        .map((check) => registry.getById(check.testId)?.name ?? check.testId);

      const verdict: FridayHarnessQaVerdictV1 = {
        artifactId: input.existingQaVerdictId ?? deps.idGenerator(),
        version: 1,
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        deliveryContractId: input.deliveryContract.artifactId,
        verdict: run.overallVerdict === "fail" ? "fail" : "pass",
        summary: makeQaSummary(
          run.overallVerdict === "fail" ? "fail" : "pass",
          failedCriteria,
          [],
        ),
        passedCriteria,
        failedCriteria,
        blockedReasons: [],
        warnings,
        evidenceRefs: [
          ...new Set([
            ...(input.evidenceRefs ?? []).map(summarizeEvidenceRef),
            run.id,
          ]),
        ],
        createdAt: now,
        updatedAt: now,
      };

      return repo.upsertQaVerdict(verdict);
    },

    getQaVerdict(artifactId) {
      return repo.getQaVerdict(artifactId);
    },

    createOrUpdateHandoffArtifact(artifact) {
      return repo.upsertHandoffArtifact(artifact);
    },

    getHandoffArtifact(artifactId) {
      return repo.getHandoffArtifact(artifactId);
    },

    buildSummary(input) {
      const qaVerdict = input.qaVerdictId ? repo.getQaVerdict(input.qaVerdictId) : null;
      return {
        stage: input.stage,
        planningSpecId: input.planningSpecId,
        deliveryContractId: input.deliveryContractId,
        qaVerdictId: input.qaVerdictId,
        handoffArtifactId: input.handoffArtifactId,
        verdict: qaVerdict?.verdict,
        summary: input.summary ?? qaVerdict?.summary,
      };
    },
  };
}

export function buildHarnessSchemaTest(input: {
  id: string;
  name: string;
  schema: JsonObject;
  priority?: number;
  shortCircuit?: boolean;
  tags?: string[];
}): FridayAcceptanceTest {
  const now = new Date().toISOString();
  return {
    id: input.id,
    name: input.name,
    artifactType: "json",
    checkConfig: {
      checkType: "schema",
      schema: input.schema,
      strict: true,
    },
    priority: input.priority ?? 100,
    enabled: true,
    shortCircuit: input.shortCircuit ?? false,
    tags: input.tags ?? ["template-harness"],
    version: 1,
    etag: input.id,
    createdAt: now,
    updatedAt: now,
  };
}

export function buildHarnessQuantitativeTest(input: {
  id: string;
  name: string;
  metricPath: string;
  operator: "gt" | "gte" | "lt" | "lte" | "eq";
  threshold: number;
  priority?: number;
  shortCircuit?: boolean;
  tags?: string[];
}): FridayAcceptanceTest {
  const now = new Date().toISOString();
  return {
    id: input.id,
    name: input.name,
    artifactType: "json",
    checkConfig: {
      checkType: "quantitative",
      metricPath: input.metricPath,
      operator: input.operator,
      threshold: input.threshold,
    },
    priority: input.priority ?? 100,
    enabled: true,
    shortCircuit: input.shortCircuit ?? false,
    tags: input.tags ?? ["template-harness"],
    version: 1,
    etag: input.id,
    createdAt: now,
    updatedAt: now,
  };
}
