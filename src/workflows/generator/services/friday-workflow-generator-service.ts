import { FridayDomainError } from "#errors";
import { safeJsonParse } from "#utilities";
import { createFridayProviderInferenceClient } from "#skills/generator";
import type { FridayProviderInferenceClient } from "#skills/generator";
import {
  buildHarnessSchemaTest,
  createFridayTemplateHarnessService,
  type FridayHarnessDeliveryContractV1,
  type FridayHarnessPlanningSpecV1,
  type FridayHarnessQaVerdictV1,
  type FridayTemplateHarnessStage,
  type FridayTemplateHarnessSummary,
} from "#harness";
import { createFridayWorkflowCompiler } from "../../compiler/friday-workflow-compiler.js";
import { createFridayWorkflowValidator } from "../../compiler/friday-workflow-validator.js";
import type {
  FridayWorkflowSpecStep,
  FridayWorkflowSpecTestCase,
  FridayWorkflowSpecV1,
} from "../../model/friday-workflow-spec.types.js";
import type { FridayWorkflowVisualGraphV1 } from "../../builder/model/friday-workflow-builder-canvas.types.js";
import { createFridayWorkflowBuilderSpecVersionRepository } from "../../builder/persistence/friday-workflow-builder-spec-version-repository.js";

import type {
  CreateFridayWorkflowGeneratorServiceDeps,
  FridayWorkflowGeneratorPublicationBoundary,
  FridayWorkflowGeneratorService,
} from "./friday-workflow-generator-service.types.js";

import type {
  FridayGeneratedWorkflowDraft,
  FridayGeneratedWorkflowValidationIssue,
  FridayGeneratedWorkflowValidationReport,
  FridayStartWorkflowGenerationRequest,
  FridayWorkflowGenerationMaintenanceTarget,
  FridayWorkflowGenerationRequirements,
  FridayWorkflowGenerationSession,
  FridayWorkflowGenerationTurn,
  FridayWorkflowGenerationTurnRequest,
  FridayWorkflowGenerationTurnResponse,
  FridayWorkflowGeneratorSessionStatus,
  FridayWorkflowGeneratorSkillContext,
} from "../model/friday-workflow-generator.types.js";

import {
  createFridayWorkflowGenerationSessionRepository,
} from "../persistence/friday-workflow-generation-session-repository.js";
import {
  createFridayWorkflowGenerationApprovalRepository,
} from "../persistence/friday-workflow-generation-approval-repository.js";

import type {
  FridayWorkflowGenerationSessionRepository,
} from "../persistence/friday-workflow-generation-session-repository.js";

import {
  buildWorkflowRequirementsPrompt,
  buildWorkflowSpecPrompt,
  buildWorkflowTestsPrompt,
  buildWorkflowVisualLayoutPrompt,
} from "../prompts/friday-workflow-generator-prompts.js";

import { createFridayGeneratedWorkflowValidator } from "../validation/friday-generated-workflow-validator.js";

import type { FridayGeneratedWorkflowValidator } from "../validation/friday-generated-workflow-validator.js";

// ─── Constants ───

const MAX_RECENT_TURNS = 12;
const MAX_REPAIR_ATTEMPTS = 2;
const WORKFLOW_GENERATOR_PUBLICATION_BOUNDARY: FridayWorkflowGeneratorPublicationBoundary = {
  stage: "published_version",
  lifecyclePromotion: "not_lifecycle_promoted",
  proofBoundary: "crud_publish_only",
  summary: "The generated workflow version was published through Workflow CRUD. This is not shadow, canary, promote, or rollback proof from the workflow upgrade lifecycle.",
};
const DRAFT_NAMESPACE = "workflow-generator-draft";

// ─── Requirements analyzer response shape ───

interface WorkflowRequirementsAnalyzerResponse {
  state: "needs_clarification" | "ready_for_generation";
  questions: string[];
  requirements: FridayWorkflowGenerationRequirements;
}

function buildFallbackVisualLayout(
  spec: FridayWorkflowSpecV1,
): FridayWorkflowVisualGraphV1 {
  const nodes: FridayWorkflowVisualGraphV1["nodes"] = [
    { nodeId: "__trigger__", x: 0, y: 0 },
    ...spec.steps.map((step, index) => ({
      nodeId: step.id,
      x: 280 * (index + 1),
      y: 0,
    })),
  ];

  const edges: FridayWorkflowVisualGraphV1["edges"] = [];
  if (spec.startStepId) {
    edges.push({
      edgeKey: `__trigger__:${spec.startStepId}:any`,
    });
  }
  for (const edge of spec.edges) {
    edges.push({
      edgeKey: `${edge.from}:${edge.to}:${edge.when ?? "any"}`,
    });
  }

  return {
    schemaVersion: "1.0",
    workflowId: spec.workflowId,
    viewport: { x: 0, y: 0, zoom: 1 },
    panelLayout: { leftOpen: true, rightOpen: true, bottomOpen: false },
    nodes,
    edges,
  };
}

function normalizeVisualLayout(
  parsed: unknown,
  spec: FridayWorkflowSpecV1,
): FridayWorkflowVisualGraphV1 {
  const base = buildFallbackVisualLayout(spec);
  const visual =
    parsed != null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    typeof (parsed as Record<string, unknown>)["visual"] === "object"
      ? (parsed as Record<string, unknown>)["visual"]
      : parsed;

  if (visual == null || typeof visual !== "object" || Array.isArray(visual)) {
    return base;
  }

  const visualObj = visual as Record<string, unknown>;

  const nodesById = new Map(base.nodes.map((node) => [node.nodeId, node]));
  const rawNodes = visualObj["nodes"];
  if (Array.isArray(rawNodes)) {
    for (const candidate of rawNodes) {
      if (candidate == null || typeof candidate !== "object") continue;
      const record = candidate as Record<string, unknown>;
      const nodeId =
        typeof record["nodeId"] === "string"
          ? record["nodeId"]
          : typeof record["id"] === "string"
            ? record["id"]
            : undefined;
      if (!nodeId || !nodesById.has(nodeId)) continue;
      const current = nodesById.get(nodeId)!;
      const x = Number(record["x"]);
      const y = Number(record["y"]);
      nodesById.set(nodeId, {
        ...current,
        x: Number.isFinite(x) ? x : current.x,
        y: Number.isFinite(y) ? y : current.y,
      });
    }
  }

  const edgeMap = new Map(base.edges.map((edge) => [edge.edgeKey, edge]));
  const rawEdges = visualObj["edges"];
  if (Array.isArray(rawEdges)) {
    for (const candidate of rawEdges) {
      if (candidate == null || typeof candidate !== "object") continue;
      const record = candidate as Record<string, unknown>;
      const derivedEdgeKey =
        typeof record["edgeKey"] === "string"
          ? record["edgeKey"]
          : typeof record["from"] === "string" && typeof record["to"] === "string"
            ? `${record["from"]}:${record["to"]}:${typeof record["when"] === "string" ? record["when"] : "any"}`
            : undefined;
      if (!derivedEdgeKey) continue;
      edgeMap.set(derivedEdgeKey, {
        edgeKey: derivedEdgeKey,
      });
    }
  }

  const viewportRaw = visualObj["viewport"];
  const panelLayoutRaw = visualObj["panelLayout"];

  const viewport =
    viewportRaw != null && typeof viewportRaw === "object" && !Array.isArray(viewportRaw)
      ? {
          x: Number.isFinite(Number((viewportRaw as Record<string, unknown>)["x"]))
            ? Number((viewportRaw as Record<string, unknown>)["x"])
            : base.viewport.x,
          y: Number.isFinite(Number((viewportRaw as Record<string, unknown>)["y"]))
            ? Number((viewportRaw as Record<string, unknown>)["y"])
            : base.viewport.y,
          zoom: Number.isFinite(Number((viewportRaw as Record<string, unknown>)["zoom"]))
            ? Number((viewportRaw as Record<string, unknown>)["zoom"])
            : base.viewport.zoom,
        }
      : base.viewport;

  const panelLayout =
    panelLayoutRaw != null && typeof panelLayoutRaw === "object" && !Array.isArray(panelLayoutRaw)
      ? {
          leftOpen:
            typeof (panelLayoutRaw as Record<string, unknown>)["leftOpen"] === "boolean"
              ? ((panelLayoutRaw as Record<string, unknown>)["leftOpen"] as boolean)
              : base.panelLayout.leftOpen,
          rightOpen:
            typeof (panelLayoutRaw as Record<string, unknown>)["rightOpen"] === "boolean"
              ? ((panelLayoutRaw as Record<string, unknown>)["rightOpen"] as boolean)
              : base.panelLayout.rightOpen,
          bottomOpen:
            typeof (panelLayoutRaw as Record<string, unknown>)["bottomOpen"] === "boolean"
              ? ((panelLayoutRaw as Record<string, unknown>)["bottomOpen"] as boolean)
              : base.panelLayout.bottomOpen,
        }
      : base.panelLayout;

  return {
    schemaVersion: "1.0",
    workflowId: spec.workflowId,
    viewport,
    panelLayout,
    nodes: [...nodesById.values()],
    edges: [...edgeMap.values()],
  };
}

function buildFallbackTests(spec: FridayWorkflowSpecV1): FridayWorkflowSpecTestCase[] {
  const firstOutput = spec.outputs[0];
  const firstStepId = spec.startStepId || spec.steps[0]?.id;
  const fallbackInputs = firstOutput || firstStepId
    ? {}
    : { __friday_smoke__: true };
  return [
    {
      name: "smoke",
      description: "Auto-generated smoke test",
      inputs: fallbackInputs,
      assertions: [
        firstOutput
          ? {
            path: `outputs.${firstOutput.key}`,
            operator: "!=",
            expected: null,
          }
          : firstStepId
            ? {
              path: `steps.${firstStepId}.status`,
              operator: "==",
              expected: "completed",
            }
            : {
              path: "inputs.__friday_smoke__",
              operator: "==",
              expected: true,
            },
      ],
    },
  ];
}

function normalizeGeneratedTests(
  parsed: unknown,
  spec: FridayWorkflowSpecV1,
): FridayWorkflowSpecTestCase[] {
  const source =
    parsed != null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    Array.isArray((parsed as Record<string, unknown>)["tests"])
      ? (parsed as Record<string, unknown>)["tests"]
      : parsed;

  if (!Array.isArray(source)) {
    return buildFallbackTests(spec);
  }

  const normalized: FridayWorkflowSpecTestCase[] = [];
  for (const item of source) {
    if (item == null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const rawAssertions = Array.isArray(record["assertions"])
      ? (record["assertions"] as unknown[])
      : [];
    const assertions = rawAssertions
      .filter((a): a is { path: string; operator: "==" | "!=" | ">" | "<" | "contains" | "matches"; expected: unknown } => {
        if (a == null || typeof a !== "object") return false;
        const assertion = a as Record<string, unknown>;
        const operator = assertion["operator"];
        return (
          typeof assertion["path"] === "string" &&
          (operator === "==" ||
            operator === "!=" ||
            operator === ">" ||
            operator === "<" ||
            operator === "contains" ||
            operator === "matches")
        );
      })
      .map((assertion) => ({
        path: assertion.path,
        operator: assertion.operator,
        expected: assertion.expected,
      }));

    normalized.push({
      name:
        typeof record["name"] === "string" && record["name"].trim().length > 0
          ? record["name"]
          : "smoke",
      description:
        typeof record["description"] === "string" ? record["description"] : undefined,
      inputs:
        record["inputs"] != null &&
        typeof record["inputs"] === "object" &&
        !Array.isArray(record["inputs"])
          ? (record["inputs"] as Record<string, unknown>)
          : {},
      assertions: assertions.length > 0 ? assertions : buildFallbackTests(spec)[0].assertions,
    });
  }

  return normalized.length > 0 ? normalized : buildFallbackTests(spec);
}

// Returns the parsed value iff `value` is a string that JSON-parses to a plain
// (non-null, non-array) object; otherwise undefined. Used to rewrite a
// JSON-object-literal `transform` string into runnable `mapping` form. Refs
// (`$x`), arithmetic (`$a + $b`), and bare literals are not valid JSON and
// return undefined (left as a `transform` for the expression evaluator).
function tryParseJsonObjectTransform(value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON (a ref/arithmetic/expression) — leave as a transform.
  }
  return undefined;
}

function normalizeGeneratedSpecStep(
  step: FridayWorkflowSpecStep,
): FridayWorkflowSpecStep {
  if (step.type !== "transform") {
    return step;
  }

  const raw = step as FridayWorkflowSpecStep & Record<string, unknown>;
  const normalizedArgs =
    step.args && typeof step.args === "object" && !Array.isArray(step.args)
      ? { ...step.args }
      : {};

  if (raw.transform !== undefined) {
    if (
      raw.transform != null &&
      typeof raw.transform === "object" &&
      !Array.isArray(raw.transform) &&
      normalizedArgs.mapping === undefined
    ) {
      normalizedArgs.mapping = raw.transform;
    } else if (normalizedArgs.transform === undefined) {
      normalizedArgs.transform = raw.transform;
    }
  }
  if (raw.mapping !== undefined && normalizedArgs.mapping === undefined) {
    normalizedArgs.mapping = raw.mapping;
  }
  if (raw.expression !== undefined && normalizedArgs.transform === undefined) {
    normalizedArgs.transform = raw.expression;
  }
  if (
    normalizedArgs.transform != null &&
    typeof normalizedArgs.transform === "object" &&
    !Array.isArray(normalizedArgs.transform) &&
    normalizedArgs.mapping === undefined
  ) {
    normalizedArgs.mapping = normalizedArgs.transform;
    delete normalizedArgs.transform;
  }
  // A `transform` STRING that is a JSON object literal (e.g.
  // `'{"message":"version two"}'`) is NOT executable by the data-node
  // expression evaluator (which evaluates a single expression, not an object
  // literal). The runnable representation is `config.mapping`, whose values go
  // through resolveArgs (literals pass through; `$`-prefixed values are
  // evaluated). Rewrite it to mapping form so it RUNS instead of throwing
  // EXPRESSION_PARSE_ERROR at execution. Refs/arithmetic strings (not valid
  // JSON) are left untouched and handled by the evaluator.
  if (
    typeof normalizedArgs.transform === "string" &&
    normalizedArgs.mapping === undefined
  ) {
    const parsedObject = tryParseJsonObjectTransform(normalizedArgs.transform);
    if (parsedObject !== undefined) {
      normalizedArgs.mapping = parsedObject;
      delete normalizedArgs.transform;
    }
  }

  return {
    id: step.id,
    type: step.type,
    ref: step.ref,
    condition: step.condition,
    timeoutSec: step.timeoutSec,
    retry: step.retry,
    args: Object.keys(normalizedArgs).length > 0 ? normalizedArgs : step.args,
  };
}

function normalizeGeneratedSpec(spec: FridayWorkflowSpecV1): FridayWorkflowSpecV1 {
  return {
    ...spec,
    steps: spec.steps.map((step) => normalizeGeneratedSpecStep(step)),
  };
}

// ─── Factory ───

export function createFridayWorkflowGeneratorService(
  deps: CreateFridayWorkflowGeneratorServiceDeps,
): FridayWorkflowGeneratorService {
  // ─── TS Runtime Retirement: METHOD-level fail-closed guard ───
  // Phase 3 (route-only-guard defect): the workflow-generator retirement was
  // ROUTE-only (friday-workflow-generator-routes asserts the test-oracle flag
  // before EVERY handler — the route surface retires the WHOLE session
  // lifecycle). The agent workflow-generator tool (start/turn/generate/approve/
  // cancel actions), the UIX assistant surface (`startWorkflowSession`/
  // `continueWorkflowSession`), and the reflex candidate pipeline
  // (`generateWorkflowDraft`/`approveGeneratedCandidate`) reach these methods
  // directly, bypassing the HTTP route guard. Guarding here fails ALL non-route
  // callers closed BEFORE any session-row write, provider call, or workflow
  // save — unless the explicit test-oracle flag is set. Never default this flag
  // on in production. ALL mutating session-lifecycle methods are guarded:
  // startSession, submitTurn (turn append + requirements-analyzer provider call
  // + on ready_for_generation the full generation pipeline + draft persist),
  // generateDraft, approveAndSave, and cancelSession (status flip + draft
  // delete) — mirroring the route surface exactly. Reads
  // (`getSession`/`getQaVerdict`/`getHarnessSummary`) stay live.
  function assertWorkflowGeneratorExecutionAllowed(): void {
    if (deps.allowTestOnlyWorkflowGeneratorExecution !== true) {
      throw new FridayDomainError(
        "TS_RUNTIME_WORKFLOW_GENERATOR_RETIRED",
        "TypeScript workflow generator sessions are retired in default/live runtime; use the Rust-owned workflow generator entrypoint.",
        {
          httpStatus: 503,
          details: {
            classification: "fail_closed",
            replacement: "rust_owned_workflow_generator_entrypoint_required",
          },
        },
      );
    }
  }

  const repo: FridayWorkflowGenerationSessionRepository =
    createFridayWorkflowGenerationSessionRepository({
      db: deps.db,
      idGenerator: deps.idGenerator,
      nowIso: deps.nowIso,
    });
  const approvalRepo = createFridayWorkflowGenerationApprovalRepository({
    db: deps.db,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  const llm: FridayProviderInferenceClient =
    createFridayProviderInferenceClient({
      providerService: deps.providerService,
    });
  function resolveTenantContext(session: FridayWorkflowGenerationSession) {
    return session.tenantContext ?? {
      hubId: "default",
      userId: session.userId,
      channelKind: session.channel,
    };
  }

  async function resolveUserRulesContext(
    session: FridayWorkflowGenerationSession,
  ): Promise<string | null> {
    const fragment = await deps.userRulesContextProvider?.({
      task: session.goal,
      userId: session.userId,
      channel: session.channel,
      surface: "workflow_generator",
    });
    const trimmed = fragment?.trim();
    return trimmed ? trimmed : null;
  }

  function withUserRulesContext<T extends { system: string; user: string }>(
    prompt: T,
    userRulesContext: string | null,
  ): T {
    if (!userRulesContext) return prompt;
    return {
      ...prompt,
      system:
        `${prompt.system}\n\n` +
        "Friday user/project rules (prompt guidance only; hard enforcement remains in approval and deterministic policy gates):\n" +
        userRulesContext,
    };
  }
  const harness = createFridayTemplateHarnessService({
    db: deps.db,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });
  const specVersionRepo = createFridayWorkflowBuilderSpecVersionRepository();

  const compiler = createFridayWorkflowCompiler({
    computeChecksum: deps.computeChecksum,
    idGenerator: deps.idGenerator,
  });

  const workflowValidator = createFridayWorkflowValidator();

  const generatedValidator: FridayGeneratedWorkflowValidator =
    createFridayGeneratedWorkflowValidator({
      compiler,
      workflowValidator,
      skillRegistry: deps.skillRegistry,
      getSkillLifecycleStatus: deps.getSkillLifecycleStatus,
      idGenerator: deps.idGenerator,
    });

  // ─── Draft persistence ───

  function saveDraft(sessionId: string, draft: FridayGeneratedWorkflowDraft): void {
    deps.db.withWriteTransaction((writer) => {
      writer
        .prepare(
          `INSERT INTO workflow_generation_drafts (session_id, created_at, updated_at, value_json, tags_json)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             value_json = excluded.value_json,
             tags_json = excluded.tags_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          sessionId,
          deps.nowIso(),
          deps.nowIso(),
          JSON.stringify(draft),
          JSON.stringify(["draft"]),
        );
    });
  }

  function loadDraft(sessionId: string): FridayGeneratedWorkflowDraft | undefined {
    return deps.db.withReadConnection((reader) => {
      const row = reader
        .prepare("SELECT value_json FROM workflow_generation_drafts WHERE session_id = ?")
        .get(sessionId) as { value_json: string } | undefined;
      if (row) return safeJsonParse<FridayGeneratedWorkflowDraft>(row.value_json);
      const legacyRow = reader
        .prepare("SELECT value_json FROM memory_items WHERE namespace = ? AND key = ?")
        .get(DRAFT_NAMESPACE, sessionId) as { value_json: string } | undefined;
      if (legacyRow) {
        return safeJsonParse<FridayGeneratedWorkflowDraft>(legacyRow.value_json);
      }
      return undefined;
    });
  }

  function deleteDraft(sessionId: string): void {
    deps.db.withWriteTransaction((writer) => {
      writer
        .prepare("DELETE FROM workflow_generation_drafts WHERE session_id = ?")
        .run(sessionId);
    });
  }

  // ─── Helpers ───

  function getRecentTurns(turns: FridayWorkflowGenerationTurn[]): FridayWorkflowGenerationTurn[] {
    if (turns.length <= MAX_RECENT_TURNS) return turns;
    return turns.slice(turns.length - MAX_RECENT_TURNS);
  }

  function parseCurrentRequirements(
    session: FridayWorkflowGenerationSession,
  ): FridayWorkflowGenerationRequirements | null {
    if (!session.requirementsSummary.trim()) return null;
    try {
      const parsed = JSON.parse(session.requirementsSummary) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as FridayWorkflowGenerationRequirements;
      }
    } catch (err) {
      console.warn("[friday][workflow-generator-service] requirements parse failed:", err instanceof Error ? err.message : String(err));
      return null;
    }
    return null;
  }

  function loadMaintenanceTarget(
    workflowId: string,
  ): FridayWorkflowGenerationMaintenanceTarget {
    const workflow = deps.workflowCrud.getWorkflow(workflowId);
    if (!workflow) {
      throw new FridayDomainError(
        "WORKFLOW_NOT_FOUND",
        `Workflow not found: ${workflowId}`,
        { httpStatus: 404 },
      );
    }

    const publishedVersion =
      deps.workflowCrud.getPublishedVersion(workflowId)
      ?? deps.workflowCrud.listVersions(workflowId, 1)[0]
      ?? null;

    const publishedSpec = publishedVersion
      ? deps.db.withReadConnection((reader) =>
        specVersionRepo.getByVersionId(reader, publishedVersion.id)?.spec ?? null,
      )
      : null;

    return {
      workflowId: workflow.id,
      slug: workflow.slug,
      currentSpecWorkflowId: publishedSpec?.workflowId,
      currentName: workflow.name,
      currentDescription: workflow.description,
      publishedVersionId: publishedVersion?.id,
      publishedVersionNumber: publishedVersion?.versionNumber,
      publishedSpec: publishedSpec ?? undefined,
    };
  }

  function extractStringArray(
    source: Record<string, unknown>,
    key: string,
  ): string[] {
    const value = source[key];
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }

  function workflowRequirementsRequireBrowserQa(
    requirements: FridayWorkflowGenerationRequirements | null,
  ): boolean {
    if (!requirements) return false;
    const candidate = requirements as unknown as Record<string, unknown>;
    if (candidate["requiresBrowserQa"] === true || candidate["browserQaRequired"] === true) {
      return true;
    }
    const evidenceRequirements = candidate["evidenceRequirements"];
    return Array.isArray(evidenceRequirements) && evidenceRequirements.includes("browser_qa");
  }

  function buildHarnessSummaryFromSession(
    session: FridayWorkflowGenerationSession,
    qaVerdict?: FridayHarnessQaVerdictV1 | null,
  ): FridayTemplateHarnessSummary | null {
    if (!harness.enabled || !session.harnessStage) return null;
    return harness.buildSummary({
      stage: session.harnessStage,
      planningSpecId: session.planningSpecId,
      deliveryContractId: session.deliveryContractId,
      qaVerdictId: session.qaVerdictId,
      handoffArtifactId: session.handoffArtifactId,
      summary: qaVerdict?.summary,
    });
  }

  function buildWorkflowPlanningSpecArtifact(
    session: FridayWorkflowGenerationSession,
    requirements: FridayWorkflowGenerationRequirements | null,
  ): FridayHarnessPlanningSpecV1 {
    const summary =
      requirements?.goal
      ?? (requirements?.plannedSteps[0]?.intent
        ? `${requirements.goal}: ${requirements.plannedSteps[0].intent}`
        : session.goal);
    return {
      artifactId: session.planningSpecId ?? deps.idGenerator(),
      version: 1,
      scopeKind: "workflow_generator",
      scopeId: session.sessionId,
      objective: session.goal,
      summary,
      assumptions: requirements?.assumptions ?? [],
      unknowns: [...session.openQuestions],
      outOfScope: extractStringArray(requirements as unknown as Record<string, unknown> ?? {}, "outOfScope"),
      constraints: extractStringArray(requirements as unknown as Record<string, unknown> ?? {}, "constraints"),
      successTests: requirements?.testScenarios.map((scenario) => scenario.name) ?? [],
      openQuestions: [...session.openQuestions],
      createdAt: deps.nowIso(),
      updatedAt: deps.nowIso(),
    };
  }

  function buildWorkflowDeliveryContractArtifact(
    session: FridayWorkflowGenerationSession,
    planningSpec: FridayHarnessPlanningSpecV1,
    requirements: FridayWorkflowGenerationRequirements | null,
  ): FridayHarnessDeliveryContractV1 {
    const evidenceRequirements: FridayHarnessDeliveryContractV1["evidenceRequirements"] = [
      "generator_validation",
      "workflow_acceptance",
    ];
    if (workflowRequirementsRequireBrowserQa(requirements)) {
      evidenceRequirements.push("browser_qa");
    }
    return {
      artifactId: session.deliveryContractId ?? deps.idGenerator(),
      version: 1,
      scopeKind: "workflow_generator",
      scopeId: session.sessionId,
      planningSpecId: planningSpec.artifactId,
      deliverableKind: "workflow",
      deliverables: [
        requirements?.goal ?? session.goal,
      ],
      doneDefinition: [
        "Generated workflow draft passes validation.",
        "Compiled graph and generated tests are present.",
        ...(evidenceRequirements.includes("browser_qa")
          ? ["Required browser QA evidence is attached."]
          : []),
      ],
      acceptanceCriteria: [
        "validation.ok must be true",
        "compiled graph must contain nodes",
        "generated tests must be present",
        ...(evidenceRequirements.includes("browser_qa")
          ? ["browser QA evidence must be present"]
          : []),
      ],
      evidenceRequirements,
      riskFlags: extractStringArray(requirements as unknown as Record<string, unknown> ?? {}, "riskFlags"),
      blockedBy: [...session.openQuestions],
      createdAt: deps.nowIso(),
      updatedAt: deps.nowIso(),
    };
  }

  function resolveWorkflowHarnessStage(input: {
    session: FridayWorkflowGenerationSession;
    qaVerdict?: FridayHarnessQaVerdictV1 | null;
  }): FridayTemplateHarnessStage {
    if (input.session.status === "saved") return "completed";
    if (input.session.status === "approved") return "handoff_ready";
    if (
      input.session.status === "ready_for_review"
      || input.session.status === "draft_ready_needs_repair"
      || input.qaVerdict
    ) {
      return "qa_verdict";
    }
    if (input.session.deliveryContractId) return "delivery_contract";
    return "planning_spec";
  }

  function buildWorkflowNextActions(input: {
    session: FridayWorkflowGenerationSession;
    qaVerdict?: FridayHarnessQaVerdictV1 | null;
  }): string[] {
    if (input.qaVerdict?.verdict === "blocked") {
      return input.qaVerdict.blockedReasons.map((reason) =>
        reason.includes("browser")
          ? "Attach the required browser QA evidence."
          : reason,
      );
    }
    if (input.qaVerdict?.verdict === "fail") {
      return ["Fix the failing workflow draft issues and regenerate the workflow."];
    }
    if (input.session.status === "ready_for_review") {
      return ["Approve and save the generated workflow."];
    }
    if (input.session.status === "draft_ready_needs_repair") {
      return ["Review the draft issues, then repair or regenerate the workflow."];
    }
    if (input.session.status === "retryable_provider_failure") {
      return ["Retry generation when the model provider is available again."];
    }
    if (input.session.status === "terminal_failed") {
      return ["Fix the blocking generation issue, then restart generation."];
    }
    if (input.session.status === "needs_clarification") {
      return ["Answer the remaining clarification question(s)."];
    }
    return [];
  }

  async function syncWorkflowHarness(
    session: FridayWorkflowGenerationSession,
    draft?: FridayGeneratedWorkflowDraft,
  ): Promise<{
    session: FridayWorkflowGenerationSession;
    qaVerdict: FridayHarnessQaVerdictV1 | null;
    harnessSummary: FridayTemplateHarnessSummary | null;
  }> {
    if (!harness.enabled) {
      return { session, qaVerdict: null, harnessSummary: null };
    }

    const requirements = parseCurrentRequirements(session);
    const planningSpec = harness.createOrUpdatePlanningSpec(
      buildWorkflowPlanningSpecArtifact(session, requirements),
    );

    const contract = session.status === "needs_clarification" && session.openQuestions.length > 0
      ? null
      : harness.createOrUpdateDeliveryContract(
        buildWorkflowDeliveryContractArtifact(session, planningSpec, requirements),
      );

    let qaVerdict: FridayHarnessQaVerdictV1 | null = null;
    if (draft && contract) {
      const missingEvidenceReasons: string[] = [];
      if (contract.evidenceRequirements.includes("browser_qa")) {
        missingEvidenceReasons.push("Required browser QA evidence has not been attached.");
      }
      qaVerdict = await harness.evaluateQaVerdict({
        existingQaVerdictId: session.qaVerdictId,
        scopeKind: "workflow_generator",
        scopeId: session.sessionId,
        deliveryContract: contract,
        missingEvidenceReasons,
        evidenceRefs: [
          `workflow-generator-session:${session.sessionId}`,
          `workflow-draft:${draft.spec.workflowId}`,
          `workflow-compiled:${draft.compiledGraph.workflowVersionId}`,
        ],
        artifactContent: {
          validation: {
            ok: draft.validation.ok,
            issueCount: draft.validation.issues.length,
          },
          spec: {
            workflowId: draft.spec.workflowId,
            stepCount: draft.spec.steps.length,
            outputCount: draft.spec.outputs.length,
          },
          tests: {
            count: draft.tests.length,
          },
          visual: {
            nodeCount: draft.visual.nodes.length,
            edgeCount: draft.visual.edges.length,
          },
          compiledGraph: {
            nodeCount: draft.compiledGraph.graph.nodes.length,
            edgeCount: draft.compiledGraph.graph.edges.length,
          },
        },
        tests: [
          buildHarnessSchemaTest({
            id: `${session.sessionId}:workflow:validation`,
            name: "Workflow draft validation passes",
            schema: {
              type: "object",
              properties: {
                validation: {
                  type: "object",
                  properties: {
                    ok: { const: true },
                  },
                  required: ["ok"],
                },
              },
              required: ["validation"],
            },
            priority: 10,
            shortCircuit: true,
          }),
          buildHarnessSchemaTest({
            id: `${session.sessionId}:workflow:tests`,
            name: "Workflow draft includes generated tests",
            schema: {
              type: "object",
              properties: {
                tests: {
                  type: "object",
                  properties: {
                    count: { type: "number", minimum: 1 },
                  },
                  required: ["count"],
                },
              },
              required: ["tests"],
            },
            priority: 20,
            shortCircuit: true,
          }),
          buildHarnessSchemaTest({
            id: `${session.sessionId}:workflow:compiled`,
            name: "Compiled workflow graph contains nodes",
            schema: {
              type: "object",
              properties: {
                compiledGraph: {
                  type: "object",
                  properties: {
                    nodeCount: { type: "number", minimum: 1 },
                  },
                  required: ["nodeCount"],
                },
              },
              required: ["compiledGraph"],
            },
            priority: 30,
            shortCircuit: true,
          }),
        ],
      });
    }

    const effectiveQaVerdict =
      qaVerdict ?? (session.qaVerdictId ? harness.getQaVerdict(session.qaVerdictId) : null);
    const stage = resolveWorkflowHarnessStage({ session, qaVerdict: effectiveQaVerdict });
    const handoff = harness.createOrUpdateHandoffArtifact({
      artifactId: session.handoffArtifactId ?? deps.idGenerator(),
      version: 1,
      scopeKind: "workflow_generator",
      scopeId: session.sessionId,
      stage,
      summary: effectiveQaVerdict?.summary
        ?? (session.status === "needs_clarification"
          ? "Waiting for one more answer before generation can continue."
          : session.status === "saved"
            ? "Generated workflow version published through Workflow CRUD; lifecycle promotion is not claimed."
            : "Workflow generator state recorded."),
      completedWork: [
        "Planning spec recorded.",
        contract?.artifactId ? "Delivery contract recorded." : "",
        draft ? "Draft generated." : "",
      ].filter(Boolean),
      remainingWork: buildWorkflowNextActions({ session, qaVerdict: effectiveQaVerdict }),
      blockers: [
        ...(effectiveQaVerdict?.blockedReasons ?? []),
        ...(session.status === "needs_clarification" ? session.openQuestions : []),
      ],
      nextActions: buildWorkflowNextActions({ session, qaVerdict: effectiveQaVerdict }),
      artifactRefs: [
        planningSpec.artifactId,
        contract?.artifactId,
        effectiveQaVerdict?.artifactId,
      ].filter((value): value is string => typeof value === "string"),
      createdAt: deps.nowIso(),
      updatedAt: deps.nowIso(),
    });

    const nextSession: FridayWorkflowGenerationSession = {
      ...session,
      harnessStage: stage,
      planningSpecId: planningSpec.artifactId,
      deliveryContractId:
        contract?.artifactId
        ?? (session.status === "approved" || session.status === "saved" ? session.deliveryContractId : undefined),
      qaVerdictId: effectiveQaVerdict?.artifactId,
      handoffArtifactId: handoff.artifactId,
    };

    return {
      session: nextSession,
      qaVerdict: effectiveQaVerdict,
      harnessSummary: buildHarnessSummaryFromSession(nextSession, effectiveQaVerdict),
    };
  }

  function buildAvailableSkillContext(): FridayWorkflowGeneratorSkillContext[] {
    const skills = deps.skillRegistry.list();
    return skills
      .filter((skill) => {
        const lifecycleStatus = deps.getSkillLifecycleStatus?.(skill.manifest.id) ?? skill.status ?? "installed";
        return lifecycleStatus === "installed";
      })
      .map((s) => ({
        id: s.manifest.id,
        name: s.manifest.name,
        description: s.manifest.description,
        inputs: s.manifest.inputs.map((inp) => ({
          key: inp.key,
          type: inp.type,
          required: inp.required,
        })),
        outputs: s.manifest.outputs.map((out) => ({
          key: out.key,
          type: out.type,
        })),
      }));
  }

  function slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
  }

  function makeUniqueSlug(base: string): string {
    let slug = slugify(base);
    if (!slug) slug = "generated-workflow";

    let existing = deps.workflowCrud.getWorkflowBySlug(slug);
    if (!existing) return slug;

    let suffix = 2;
    while (suffix <= 100) {
      const candidate = `${slug}-${suffix}`;
      existing = deps.workflowCrud.getWorkflowBySlug(candidate);
      if (!existing) return candidate;
      suffix++;
    }

    // Fallback: append random ID segment
    return `${slug}-${deps.idGenerator().slice(0, 8)}`;
  }

  function classifyProviderFailure(error: unknown): {
    retryable: boolean;
    message: string;
  } {
    const message = error instanceof Error ? error.message : String(error);
    const retryable =
      /\b(429|529|rate limit|rate-limited|overloaded|timeout|timed out|deadline exceeded|temporarily unavailable|econnreset|eai_again|etimedout)\b/i
        .test(message)
      || (error instanceof FridayDomainError && error.code === "PROVIDER_ERROR"
        && /\b(502|503|504)\b/.test(String(error.httpStatus ?? "")));
    return { retryable, message };
  }

  function resolveDraftSessionStatus(
    draft: FridayGeneratedWorkflowDraft,
  ): Extract<FridayWorkflowGeneratorSessionStatus, "ready_for_review" | "draft_ready_needs_repair"> {
    return draft.validation.ok ? "ready_for_review" : "draft_ready_needs_repair";
  }

  async function persistFailureState(input: {
    session: FridayWorkflowGenerationSession;
    error: unknown;
    stage: FridayGeneratedWorkflowValidationIssue["stage"];
    draft?: FridayGeneratedWorkflowDraft;
  }): Promise<FridayWorkflowGenerationTurnResponse> {
    const failure = classifyProviderFailure(input.error);
    const issue: FridayGeneratedWorkflowValidationIssue = {
      code: failure.retryable ? "RETRYABLE_PROVIDER_FAILURE" : "GENERATION_ERROR",
      stage: input.stage,
      severity: "error",
      message: failure.message,
    };
    const nextStatus: FridayWorkflowGeneratorSessionStatus = input.draft?.validation.ok
      ? "ready_for_review"
      : failure.retryable
        ? "retryable_provider_failure"
        : "terminal_failed";
    const failedSession: FridayWorkflowGenerationSession = {
      ...input.session,
      status: nextStatus,
      draftWorkflowId: input.draft?.spec.workflowId ?? input.session.draftWorkflowId,
      updatedAt: deps.nowIso(),
    };
    const syncedFailed = await syncWorkflowHarness(failedSession, input.draft);
    repo.updateSession(syncedFailed.session);

    return {
      session: syncedFailed.session,
      mode: failure.retryable ? "retryable_provider_failure" : "generation_failed",
      draft: input.draft,
      errors: [issue],
    };
  }

  async function runRequirementsAnalyzer(
    session: FridayWorkflowGenerationSession,
    turns: FridayWorkflowGenerationTurn[],
    requestedModel?: string,
  ): Promise<WorkflowRequirementsAnalyzerResponse> {
    const recentTurns = getRecentTurns(turns);
    const availableSkills = buildAvailableSkillContext();
    const prompt = withUserRulesContext(
      buildWorkflowRequirementsPrompt(
        session.goal,
        session.requirementsSummary,
        session.openQuestions,
        availableSkills,
        recentTurns,
        session.maintenanceTarget,
      ),
      await resolveUserRulesContext(session),
    );
    const result = await llm.infer<WorkflowRequirementsAnalyzerResponse>({
      prompt,
      requestedModel,
      taskProfile: "planning",
      tenantContext: resolveTenantContext(session),
    });
    return result.parsed;
  }

  async function generateSpec(
    session: FridayWorkflowGenerationSession,
    requirements: FridayWorkflowGenerationRequirements & { _repairContext?: { errors: string; attempt: number } },
    availableSkills: FridayWorkflowGeneratorSkillContext[],
    requestedModel?: string,
  ): Promise<FridayWorkflowSpecV1> {
    const prompt = withUserRulesContext(
      buildWorkflowSpecPrompt(
        requirements,
        availableSkills,
        requirements._repairContext,
        session.maintenanceTarget,
      ),
      await resolveUserRulesContext(session),
    );
    const result = await llm.infer<FridayWorkflowSpecV1>({
      prompt,
      requestedModel,
      taskProfile: "deterministic",
      tenantContext: resolveTenantContext(session),
    });
    return normalizeGeneratedSpec(result.parsed);
  }

  async function generateVisual(
    session: FridayWorkflowGenerationSession,
    spec: FridayWorkflowSpecV1,
    requestedModel?: string,
  ): Promise<FridayWorkflowVisualGraphV1> {
    const prompt = withUserRulesContext(
      buildWorkflowVisualLayoutPrompt(spec),
      await resolveUserRulesContext(session),
    );
    const result = await llm.infer<unknown>({
      prompt,
      requestedModel,
      taskProfile: "creative",
      tenantContext: resolveTenantContext(session),
    });
    return normalizeVisualLayout(result.parsed, spec);
  }

  async function generateTests(
    session: FridayWorkflowGenerationSession,
    spec: FridayWorkflowSpecV1,
    requestedModel?: string,
  ): Promise<FridayWorkflowSpecTestCase[]> {
    const prompt = withUserRulesContext(
      buildWorkflowTestsPrompt(spec),
      await resolveUserRulesContext(session),
    );
    const result = await llm.infer<unknown>({
      prompt,
      requestedModel,
      taskProfile: "review",
      tenantContext: resolveTenantContext(session),
    });
    return normalizeGeneratedTests(result.parsed, spec);
  }

  function buildTurnResponse(
    session: FridayWorkflowGenerationSession,
    analyzerResult: WorkflowRequirementsAnalyzerResponse,
    draft?: FridayGeneratedWorkflowDraft,
    errors?: FridayGeneratedWorkflowValidationIssue[],
  ): FridayWorkflowGenerationTurnResponse {
    if (draft) {
      return {
        session,
        mode: draft.validation.ok ? "preview_ready" : "draft_needs_repair",
        draft,
        errors: draft.validation.ok ? undefined : draft.validation.issues,
      };
    }

    if (errors && errors.length > 0) {
      return {
        session,
        mode: session.status === "retryable_provider_failure"
          ? "retryable_provider_failure"
          : "generation_failed",
        errors,
      };
    }

    if (analyzerResult.state === "needs_clarification") {
      return {
        session,
        mode: "clarification_required",
        questions: analyzerResult.questions,
      };
    }

    // Defensive fallback
    return {
      session,
      mode: "clarification_required",
      questions: [],
    };
  }

  async function runGenerationPipeline(
    session: FridayWorkflowGenerationSession,
    requirements: FridayWorkflowGenerationRequirements,
    requestedModel?: string,
  ): Promise<FridayGeneratedWorkflowDraft> {
    const availableSkills = buildAvailableSkillContext();

    let generatedSpec!: FridayWorkflowSpecV1;
    let generatedVisual!: FridayWorkflowVisualGraphV1;
    let generatedTests!: FridayWorkflowSpecTestCase[];
    let allIssues: FridayGeneratedWorkflowValidationIssue[] = [];
    let repairAttempts = 0;
    let compiledGraphResult: ReturnType<FridayGeneratedWorkflowValidator["validate"]> | undefined;

    for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
      const currentRequirements =
        attempt === 0
          ? requirements
          : {
              ...requirements,
              _repairContext: {
                errors: allIssues
                  .filter((i) => i.severity === "error")
                  .map((i) => `[${i.code}] ${i.message}`)
                  .join("\n"),
                attempt,
              },
            };

      try {
        // Step 1: Generate spec
        generatedSpec = await generateSpec(
          session,
          currentRequirements,
          availableSkills,
          requestedModel,
        );
      } catch (err) {
        allIssues = [
          {
            code: "GENERATION_ERROR",
            stage: "spec",
            severity: "error" as const,
            message: err instanceof Error ? err.message : String(err),
          },
        ];
        const hasErrors = allIssues.some((i) => i.severity === "error");
        if (!hasErrors) break;

        if (attempt < MAX_REPAIR_ATTEMPTS) {
          repairAttempts++;
        }
        continue;
      }

      const nonBlockingIssues: FridayGeneratedWorkflowValidationIssue[] = [];

      // Step 2: Generate visual layout. Fall back to deterministic layout if the model
      // refuses or returns an unusable auxiliary response.
      try {
        generatedVisual = await generateVisual(session, generatedSpec, requestedModel);
      } catch (err) {
        generatedVisual = buildFallbackVisualLayout(generatedSpec);
        nonBlockingIssues.push({
          code: "VISUAL_FALLBACK",
          stage: "visual",
          severity: "warning",
          message: `Visual generation fell back to deterministic layout: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // Step 3: Generate tests. Fall back to smoke tests if the provider refuses or
      // returns no structured output, so a valid draft can still be reviewed/saved.
      try {
        generatedTests = await generateTests(session, generatedSpec, requestedModel);
      } catch (err) {
        generatedTests = buildFallbackTests(generatedSpec);
        nonBlockingIssues.push({
          code: "TESTS_FALLBACK",
          stage: "tests",
          severity: "warning",
          message: `Test generation fell back to smoke tests: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // Merge tests into spec
      generatedSpec.tests = generatedTests;

      try {
        // Step 4: Validate all artifacts
        compiledGraphResult = generatedValidator.validate({
          spec: generatedSpec,
          visual: generatedVisual,
          tests: generatedTests,
        });
        allIssues = [...nonBlockingIssues, ...compiledGraphResult.issues];
      } catch (err) {
        allIssues = [
          ...nonBlockingIssues,
          {
            code: "GENERATION_ERROR",
            stage: "compile",
            severity: "error" as const,
            message: err instanceof Error ? err.message : String(err),
          },
        ];
      }

      const hasErrors = allIssues.some((i) => i.severity === "error");
      if (!hasErrors) break;

      if (attempt < MAX_REPAIR_ATTEMPTS) {
        repairAttempts++;
      }
    }

    const finalHasErrors = allIssues.some((i) => i.severity === "error");
    const validation: FridayGeneratedWorkflowValidationReport = {
      ok: !finalHasErrors,
      issues: allIssues,
      repaired: repairAttempts > 0 && !finalHasErrors,
      repairAttempts,
    };

    // If no valid artifacts were produced after retries, throw instead of persisting malformed data
    if (!generatedSpec || !generatedVisual) {
      throw new FridayDomainError(
        "GENERATION_FAILED",
        `Workflow generation failed after ${repairAttempts} repair attempt(s): ${allIssues.map((i) => i.message).join("; ")}`,
        { httpStatus: 422 },
      );
    }

    // Build draft with compiled graph (or a placeholder if compilation failed)
    const compiledGraph = compiledGraphResult?.compiledGraph ?? {
      schemaVersion: "2.0" as const,
      workflowId: generatedSpec.workflowId,
      workflowVersionId: deps.idGenerator(),
      sourceSpecSchemaVersion: "1.0" as const,
      graph: { nodes: [], edges: [] },
      failurePolicy: requirements.errorPolicy,
      tests: [],
      checksum: deps.computeChecksum("{}"),
    };

    const draft: FridayGeneratedWorkflowDraft = {
      spec: generatedSpec,
      visual: generatedVisual,
      tests: generatedTests ?? [],
      compiledGraph,
      validation,
    };

    // Only persist draft when artifacts are actually populated
    saveDraft(session.sessionId, draft);

    return draft;
  }

  function requireSession(sessionId: string): FridayWorkflowGenerationSession {
    const session = repo.getSession(sessionId);
    if (!session) {
      throw new FridayDomainError(
        "GENERATOR_SESSION_NOT_FOUND",
        `Generation session not found: ${sessionId}`,
        { httpStatus: 404 },
      );
    }
    return session;
  }

  // ─── Service methods ───

  return {
    async startSession(
      input: FridayStartWorkflowGenerationRequest,
    ): Promise<FridayWorkflowGenerationTurnResponse> {
      assertWorkflowGeneratorExecutionAllowed();
      const now = deps.nowIso();
      const sessionId = deps.idGenerator();
      const maintenanceTarget = input.targetWorkflowId
        ? loadMaintenanceTarget(input.targetWorkflowId)
        : undefined;

      const session: FridayWorkflowGenerationSession = {
        sessionId,
        userId: input.userId,
        channel: input.channel,
        tenantContext: input.tenantContext,
        status: "collecting_requirements",
        goal: input.goal,
        requirementsSummary: "",
        openQuestions: [],
        decisions: maintenanceTarget
          ? [`Updating existing workflow ${maintenanceTarget.slug} (${maintenanceTarget.workflowId})`]
          : [],
        workflowId: maintenanceTarget?.workflowId,
        workflowVersionId: maintenanceTarget?.publishedVersionId,
        maintenanceTarget,
        createdAt: now,
        updatedAt: now,
      };

      repo.createSession(session);

      // Add the initial user turn
      const userTurn: FridayWorkflowGenerationTurn = {
        turnId: deps.idGenerator(),
        sessionId,
        role: "user",
        content: input.goal,
        createdAt: now,
      };
      repo.addTurn(userTurn);

      // Run requirements analyzer
      let analyzerResult: WorkflowRequirementsAnalyzerResponse;
      try {
        analyzerResult = await runRequirementsAnalyzer(
          session,
          [userTurn],
          input.requestedModel,
        );
      } catch (error) {
        return persistFailureState({
          session,
          error,
          stage: "requirements",
        });
      }

      // Update session based on analyzer result
      const updatedSession: FridayWorkflowGenerationSession = {
        ...session,
        status:
          analyzerResult.state === "needs_clarification"
            ? "needs_clarification"
            : "generating",
        requirementsSummary: analyzerResult.requirements
          ? JSON.stringify(analyzerResult.requirements)
          : session.requirementsSummary,
        openQuestions: analyzerResult.questions ?? [],
        updatedAt: deps.nowIso(),
      };

      const syncedUpdated = await syncWorkflowHarness(updatedSession);
      repo.updateSession(syncedUpdated.session);

      // Add assistant turn
      const assistantContent =
        analyzerResult.state === "needs_clarification"
          ? analyzerResult.questions.join("\n")
          : "Requirements complete. Generating workflow...";

      const assistantTurn: FridayWorkflowGenerationTurn = {
        turnId: deps.idGenerator(),
        sessionId,
        role: "assistant",
        content: assistantContent,
        createdAt: deps.nowIso(),
      };
      repo.addTurn(assistantTurn);

      // If ready for generation, run the pipeline
      if (analyzerResult.state === "ready_for_generation") {
        try {
          const draft = await runGenerationPipeline(
            syncedUpdated.session,
            analyzerResult.requirements,
            input.requestedModel,
          );

          const finalSession: FridayWorkflowGenerationSession = {
            ...syncedUpdated.session,
            status: resolveDraftSessionStatus(draft),
            draftWorkflowId: draft.spec.workflowId,
            updatedAt: deps.nowIso(),
          };
          const syncedFinal = await syncWorkflowHarness(finalSession, draft);
          repo.updateSession(syncedFinal.session);

          return buildTurnResponse(syncedFinal.session, analyzerResult, draft);
        } catch (error) {
          return persistFailureState({
            session: syncedUpdated.session,
            error,
            stage: "spec",
            draft: loadDraft(sessionId),
          });
        }
      }

      return buildTurnResponse(syncedUpdated.session, analyzerResult);
    },

    async submitTurn(
      sessionId: string,
      input: FridayWorkflowGenerationTurnRequest,
    ): Promise<FridayWorkflowGenerationTurnResponse> {
      assertWorkflowGeneratorExecutionAllowed();
      const session = requireSession(sessionId);

      if (
        session.status === "approved" ||
        session.status === "saved" ||
        session.status === "cancelled"
      ) {
        throw new FridayDomainError(
          "STATE_CONFLICT",
          `Cannot submit turn to session in '${session.status}' status`,
          { httpStatus: 409 },
        );
      }

      const now = deps.nowIso();

      // Add user turn
      const userTurn: FridayWorkflowGenerationTurn = {
        turnId: deps.idGenerator(),
        sessionId,
        role: "user",
        content: input.message,
        createdAt: now,
      };
      repo.addTurn(userTurn);

      // Get all turns for context
      const allTurns = repo.getTurns(sessionId);

      // Run requirements analyzer with updated conversation
      let analyzerResult: WorkflowRequirementsAnalyzerResponse;
      try {
        analyzerResult = await runRequirementsAnalyzer(
          session,
          allTurns,
          input.requestedModel,
        );
      } catch (error) {
        return persistFailureState({
          session,
          error,
          stage: "requirements",
          draft: loadDraft(sessionId),
        });
      }

      // Update session
      const updatedSession: FridayWorkflowGenerationSession = {
        ...session,
        status:
          analyzerResult.state === "needs_clarification"
            ? "needs_clarification"
            : "generating",
        requirementsSummary: analyzerResult.requirements
          ? JSON.stringify(analyzerResult.requirements)
          : session.requirementsSummary,
        openQuestions: analyzerResult.questions ?? [],
        decisions: [
          ...session.decisions,
          ...(analyzerResult.requirements
            ? [`User provided: ${input.message}`]
            : []),
        ],
        draftWorkflowId: undefined,
        updatedAt: deps.nowIso(),
      };

      const syncedUpdated = await syncWorkflowHarness(updatedSession);
      repo.updateSession(syncedUpdated.session);

      // Add assistant turn
      const assistantContent =
        analyzerResult.state === "needs_clarification"
          ? analyzerResult.questions.join("\n")
          : "Requirements complete. Generating workflow...";

      const assistantTurn: FridayWorkflowGenerationTurn = {
        turnId: deps.idGenerator(),
        sessionId,
        role: "assistant",
        content: assistantContent,
        createdAt: deps.nowIso(),
      };
      repo.addTurn(assistantTurn);

      // If ready, generate
      if (analyzerResult.state === "ready_for_generation") {
        try {
          const draft = await runGenerationPipeline(
            syncedUpdated.session,
            analyzerResult.requirements,
            input.requestedModel,
          );

          const finalSession: FridayWorkflowGenerationSession = {
            ...syncedUpdated.session,
            status: resolveDraftSessionStatus(draft),
            draftWorkflowId: draft.spec.workflowId,
            updatedAt: deps.nowIso(),
          };
          const syncedFinal = await syncWorkflowHarness(finalSession, draft);
          repo.updateSession(syncedFinal.session);

          return buildTurnResponse(syncedFinal.session, analyzerResult, draft);
        } catch (error) {
          return persistFailureState({
            session: syncedUpdated.session,
            error,
            stage: "spec",
            draft: loadDraft(sessionId),
          });
        }
      }

      return buildTurnResponse(syncedUpdated.session, analyzerResult);
    },

    async getSession(sessionId: string) {
      const session = repo.getSession(sessionId);
      if (!session) return null;

      const turns = repo.getTurns(sessionId);
      const draft = loadDraft(sessionId);

      return { session, turns, draft };
    },

    async generateDraft(
      sessionId: string,
      requestedModel?: string,
    ): Promise<FridayGeneratedWorkflowDraft> {
      assertWorkflowGeneratorExecutionAllowed();
      const session = requireSession(sessionId);

      if (
        session.status === "approved" ||
        session.status === "saved" ||
        session.status === "cancelled"
      ) {
        throw new FridayDomainError(
          "STATE_CONFLICT",
          `Cannot generate draft for session in '${session.status}' status`,
          { httpStatus: 409 },
        );
      }

      // Parse the current requirements from requirementsSummary
      let requirements: FridayWorkflowGenerationRequirements;
      try {
        requirements = JSON.parse(session.requirementsSummary) as FridayWorkflowGenerationRequirements;
      } catch (err) {
        console.warn("[friday][workflow-generator-service] requirements JSON invalid:", err instanceof Error ? err.message : String(err));
        throw new FridayDomainError(
          "VALIDATION_ERROR",
          "No valid requirements available. Continue the conversation to provide requirements.",
          { httpStatus: 400 },
        );
      }

      // Update status to generating
      const generatingSession: FridayWorkflowGenerationSession = {
        ...session,
        status: "generating",
        draftWorkflowId: undefined,
        updatedAt: deps.nowIso(),
      };
      const syncedGenerating = await syncWorkflowHarness(generatingSession);
      repo.updateSession(syncedGenerating.session);

      try {
        const draft = await runGenerationPipeline(
          syncedGenerating.session,
          requirements,
          requestedModel,
        );

        const finalSession: FridayWorkflowGenerationSession = {
          ...syncedGenerating.session,
          status: resolveDraftSessionStatus(draft),
          draftWorkflowId: draft.spec.workflowId,
          updatedAt: deps.nowIso(),
        };
        const syncedFinal = await syncWorkflowHarness(finalSession, draft);
        repo.updateSession(syncedFinal.session);

        return draft;
      } catch (error) {
        const fallbackDraft = loadDraft(sessionId);
        const failure = classifyProviderFailure(error);
        const failedSession: FridayWorkflowGenerationSession = {
          ...syncedGenerating.session,
          status: fallbackDraft?.validation.ok
            ? "ready_for_review"
            : failure.retryable
              ? "retryable_provider_failure"
              : "terminal_failed",
          draftWorkflowId: fallbackDraft?.spec.workflowId,
          updatedAt: deps.nowIso(),
        };
        const syncedFailed = await syncWorkflowHarness(failedSession, fallbackDraft);
        repo.updateSession(syncedFailed.session);
        throw error;
      }
    },

    async getQaVerdict(sessionId: string) {
      const session = requireSession(sessionId);
      if (!session.qaVerdictId || !harness.enabled) {
        return null;
      }
      return harness.getQaVerdict(session.qaVerdictId);
    },

    async getHarnessSummary(sessionId: string) {
      const session = requireSession(sessionId);
      const qaVerdict = session.qaVerdictId && harness.enabled
        ? harness.getQaVerdict(session.qaVerdictId)
        : null;
      return buildHarnessSummaryFromSession(session, qaVerdict);
    },

    async approveAndSave(sessionId: string) {
      assertWorkflowGeneratorExecutionAllowed();
      const session = requireSession(sessionId);

      if (session.status !== "ready_for_review") {
        throw new FridayDomainError(
          "STATE_CONFLICT",
          `Cannot approve session in '${session.status}' status. Must be 'ready_for_review'.`,
          { httpStatus: 409 },
        );
      }

      // Load draft from persistence
      const draft = loadDraft(sessionId);
      if (!draft) {
        throw new FridayDomainError(
          "GENERATOR_DRAFT_NOT_FOUND",
          "No draft found for session. Generate a draft first.",
          { httpStatus: 404 },
        );
      }

      if (!draft.validation.ok) {
        throw new FridayDomainError(
          "VALIDATION_ERROR",
          "Cannot approve a draft with validation errors.",
          { httpStatus: 422 },
        );
      }

      const syncedReview = await syncWorkflowHarness(session, draft);
      repo.updateSession(syncedReview.session);

      if (harness.enabled && syncedReview.qaVerdict?.verdict !== "pass") {
        throw new FridayDomainError(
          "VALIDATION_ERROR",
          syncedReview.qaVerdict?.summary
            ?? "Cannot approve the draft until the QA verdict passes.",
          { httpStatus: 422 },
        );
      }

      const targetWorkflowId = syncedReview.session.maintenanceTarget?.workflowId ?? syncedReview.session.workflowId;
      const existingWorkflow = targetWorkflowId
        ? deps.workflowCrud.getWorkflow(targetWorkflowId)
        : null;

      const workflow = existingWorkflow
        ? deps.workflowCrud.updateWorkflow({
          workflowId: existingWorkflow.id,
          expectedRevision: existingWorkflow.revision,
          etag: existingWorkflow.etag,
          name: draft.spec.name,
          description: draft.spec.description,
        })
        : deps.workflowCrud.createWorkflow({
          slug: makeUniqueSlug(draft.spec.name || draft.spec.workflowId),
          name: draft.spec.name,
          description: draft.spec.description,
        });

      const version = deps.workflowCrud.createVersion(
        workflow.id,
        draft.compiledGraph,
      );

      deps.db.withWriteTransaction((db) => {
        specVersionRepo.create(db, {
          workflowId: workflow.id,
          workflowVersionId: version.id,
          spec: draft.spec,
          checksum: draft.compiledGraph.checksum,
          createdAt: deps.nowIso(),
        });
      });

      // Publish version
      const publishedVersion = deps.workflowCrud.publishVersion(
        workflow.id,
        version.versionNumber,
      );

      // Update session status to approved then saved
      const approvedSession: FridayWorkflowGenerationSession = {
        ...syncedReview.session,
        status: "approved",
        workflowId: workflow.id,
        workflowVersionId: publishedVersion.id,
        updatedAt: deps.nowIso(),
      };
      const syncedApproved = await syncWorkflowHarness(approvedSession);
      repo.updateSession(syncedApproved.session);

      const savedSession: FridayWorkflowGenerationSession = {
        ...syncedApproved.session,
        status: "saved",
        updatedAt: deps.nowIso(),
      };
      const syncedSaved = await syncWorkflowHarness(savedSession);
      repo.updateSession(syncedSaved.session);
      approvalRepo.save({
        sessionId,
        workflowId: workflow.id,
        workflowVersionId: publishedVersion.id,
        savedAt: deps.nowIso(),
      });

      // Clean up persisted draft
      deleteDraft(sessionId);

      return {
        sessionId,
        workflowId: workflow.id,
        workflowVersionId: publishedVersion.id,
        versionNumber: publishedVersion.versionNumber,
        slug: workflow.slug,
        published: true,
        publicationBoundary: WORKFLOW_GENERATOR_PUBLICATION_BOUNDARY,
        harness: syncedSaved.harnessSummary,
        qaVerdict: syncedReview.qaVerdict,
      };
    },

    async cancelSession(sessionId: string): Promise<void> {
      assertWorkflowGeneratorExecutionAllowed();
      const session = requireSession(sessionId);

      if (session.status === "saved") {
        throw new FridayDomainError(
          "STATE_CONFLICT",
          "Cannot cancel a session that is already saved.",
          { httpStatus: 409 },
        );
      }

      const cancelledSession: FridayWorkflowGenerationSession = {
        ...session,
        status: "cancelled",
        updatedAt: deps.nowIso(),
      };
      const syncedCancelled = await syncWorkflowHarness(cancelledSession);
      repo.updateSession(syncedCancelled.session);

      // Clean up persisted draft
      deleteDraft(sessionId);
    },
  };
}
