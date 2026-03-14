import { FridayDomainError } from "#errors";
import { createFridayProviderInferenceClient } from "#skills/generator";
import type { FridayProviderInferenceClient } from "#skills/generator";
import { createFridayWorkflowCompiler } from "../../compiler/friday-workflow-compiler.js";
import { createFridayWorkflowValidator } from "../../compiler/friday-workflow-validator.js";
import type { FridayWorkflowSpecTestCase, FridayWorkflowSpecV1 } from "../../model/friday-workflow-spec.types.js";
import type { FridayWorkflowVisualGraphV1 } from "../../builder/model/friday-workflow-builder-canvas.types.js";
import { createFridayWorkflowBuilderSpecVersionRepository } from "../../builder/persistence/friday-workflow-builder-spec-version-repository.js";

import type {
  CreateFridayWorkflowGeneratorServiceDeps,
  FridayWorkflowGeneratorService,
} from "./friday-workflow-generator-service.types.js";

import type {
  FridayGeneratedWorkflowDraft,
  FridayGeneratedWorkflowValidationIssue,
  FridayGeneratedWorkflowValidationReport,
  FridayStartWorkflowGenerationRequest,
  FridayWorkflowGenerationRequirements,
  FridayWorkflowGenerationSession,
  FridayWorkflowGenerationTurn,
  FridayWorkflowGenerationTurnRequest,
  FridayWorkflowGenerationTurnResponse,
  FridayWorkflowGeneratorSkillContext,
} from "../model/friday-workflow-generator.types.js";

import {
  createFridayWorkflowGenerationSessionRepository,
} from "../persistence/friday-workflow-generation-session-repository.js";

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
  return [
    {
      name: "smoke",
      description: "Auto-generated smoke test",
      inputs: {},
      assertions: [
        {
          path: firstOutput ? `outputs.${firstOutput.key}` : "run.status",
          operator: "!=",
          expected: null,
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

// ─── Factory ───

export function createFridayWorkflowGeneratorService(
  deps: CreateFridayWorkflowGeneratorServiceDeps,
): FridayWorkflowGeneratorService {
  const repo: FridayWorkflowGenerationSessionRepository =
    createFridayWorkflowGenerationSessionRepository({
      db: deps.db,
      idGenerator: deps.idGenerator,
      nowIso: deps.nowIso,
    });

  const llm: FridayProviderInferenceClient =
    createFridayProviderInferenceClient({
      providerService: deps.providerService,
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
      idGenerator: deps.idGenerator,
    });

  // ─── Draft persistence via memory_items ───

  function saveDraft(sessionId: string, draft: FridayGeneratedWorkflowDraft): void {
    deps.db.withWriteTransaction((writer) => {
      writer
        .prepare(
          `INSERT INTO memory_items (id, namespace, key, value_json, tags_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(namespace, key) DO UPDATE SET
             value_json = excluded.value_json,
             tags_json = excluded.tags_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          deps.idGenerator(),
          DRAFT_NAMESPACE,
          sessionId,
          JSON.stringify(draft),
          JSON.stringify(["draft"]),
          deps.nowIso(),
          deps.nowIso(),
        );
    });
  }

  function loadDraft(sessionId: string): FridayGeneratedWorkflowDraft | undefined {
    return deps.db.withReadConnection((reader) => {
      const row = reader
        .prepare("SELECT value_json FROM memory_items WHERE namespace = ? AND key = ?")
        .get(DRAFT_NAMESPACE, sessionId) as { value_json: string } | undefined;
      if (!row) return undefined;
      return JSON.parse(row.value_json) as FridayGeneratedWorkflowDraft;
    });
  }

  function deleteDraft(sessionId: string): void {
    deps.db.withWriteTransaction((writer) => {
      writer
        .prepare("DELETE FROM memory_items WHERE namespace = ? AND key = ?")
        .run(DRAFT_NAMESPACE, sessionId);
    });
  }

  // ─── Helpers ───

  function getRecentTurns(turns: FridayWorkflowGenerationTurn[]): FridayWorkflowGenerationTurn[] {
    if (turns.length <= MAX_RECENT_TURNS) return turns;
    return turns.slice(turns.length - MAX_RECENT_TURNS);
  }

  function buildAvailableSkillContext(): FridayWorkflowGeneratorSkillContext[] {
    const skills = deps.skillRegistry.list();
    return skills.map((s) => ({
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

  async function runRequirementsAnalyzer(
    session: FridayWorkflowGenerationSession,
    turns: FridayWorkflowGenerationTurn[],
    requestedModel?: string,
  ): Promise<WorkflowRequirementsAnalyzerResponse> {
    const recentTurns = getRecentTurns(turns);
    const availableSkills = buildAvailableSkillContext();
    const prompt = buildWorkflowRequirementsPrompt(
      session.goal,
      session.requirementsSummary,
      session.openQuestions,
      availableSkills,
      recentTurns,
    );
    const result = await llm.infer<WorkflowRequirementsAnalyzerResponse>({
      prompt,
      requestedModel,
    });
    return result.parsed;
  }

  async function generateSpec(
    requirements: FridayWorkflowGenerationRequirements & { _repairContext?: { errors: string; attempt: number } },
    availableSkills: FridayWorkflowGeneratorSkillContext[],
    requestedModel?: string,
  ): Promise<FridayWorkflowSpecV1> {
    const prompt = buildWorkflowSpecPrompt(requirements, availableSkills, requirements._repairContext);
    const result = await llm.infer<FridayWorkflowSpecV1>({
      prompt,
      requestedModel,
    });
    return result.parsed;
  }

  async function generateVisual(
    spec: FridayWorkflowSpecV1,
    requestedModel?: string,
  ): Promise<FridayWorkflowVisualGraphV1> {
    const prompt = buildWorkflowVisualLayoutPrompt(spec);
    const result = await llm.infer<unknown>({
      prompt,
      requestedModel,
    });
    return normalizeVisualLayout(result.parsed, spec);
  }

  async function generateTests(
    spec: FridayWorkflowSpecV1,
    requestedModel?: string,
  ): Promise<FridayWorkflowSpecTestCase[]> {
    const prompt = buildWorkflowTestsPrompt(spec);
    const result = await llm.infer<unknown>({
      prompt,
      requestedModel,
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
        mode: draft.validation.ok ? "preview_ready" : "generation_failed",
        draft,
        errors: draft.validation.ok ? undefined : draft.validation.issues,
      };
    }

    if (errors && errors.length > 0) {
      return {
        session,
        mode: "generation_failed",
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
        generatedVisual = await generateVisual(generatedSpec, requestedModel);
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
        generatedTests = await generateTests(generatedSpec, requestedModel);
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
      const now = deps.nowIso();
      const sessionId = deps.idGenerator();

      const session: FridayWorkflowGenerationSession = {
        sessionId,
        userId: input.userId,
        channel: input.channel,
        status: "collecting_requirements",
        goal: input.goal,
        requirementsSummary: "",
        openQuestions: [],
        decisions: [],
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
      const analyzerResult = await runRequirementsAnalyzer(
        session,
        [userTurn],
        input.requestedModel,
      );

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

      repo.updateSession(updatedSession);

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
            updatedSession,
            analyzerResult.requirements,
            input.requestedModel,
          );

          const finalSession: FridayWorkflowGenerationSession = {
            ...updatedSession,
            status: draft.validation.ok ? "ready_for_review" : "failed",
            draftWorkflowId: draft.spec.workflowId,
            updatedAt: deps.nowIso(),
          };
          repo.updateSession(finalSession);

          return buildTurnResponse(finalSession, analyzerResult, draft);
        } catch (err) {
          const failedSession: FridayWorkflowGenerationSession = {
            ...updatedSession,
            status: "failed",
            updatedAt: deps.nowIso(),
          };
          repo.updateSession(failedSession);

          return {
            session: failedSession,
            mode: "generation_failed",
            errors: [
              {
                code: "GENERATION_ERROR",
                stage: "spec",
                severity: "error",
                message:
                  err instanceof Error ? err.message : String(err),
              },
            ],
          };
        }
      }

      return buildTurnResponse(updatedSession, analyzerResult);
    },

    async submitTurn(
      sessionId: string,
      input: FridayWorkflowGenerationTurnRequest,
    ): Promise<FridayWorkflowGenerationTurnResponse> {
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
      const analyzerResult = await runRequirementsAnalyzer(
        session,
        allTurns,
        input.requestedModel,
      );

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
        updatedAt: deps.nowIso(),
      };

      repo.updateSession(updatedSession);

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
            updatedSession,
            analyzerResult.requirements,
            input.requestedModel,
          );

          const finalSession: FridayWorkflowGenerationSession = {
            ...updatedSession,
            status: draft.validation.ok ? "ready_for_review" : "failed",
            draftWorkflowId: draft.spec.workflowId,
            updatedAt: deps.nowIso(),
          };
          repo.updateSession(finalSession);

          return buildTurnResponse(finalSession, analyzerResult, draft);
        } catch (err) {
          const failedSession: FridayWorkflowGenerationSession = {
            ...updatedSession,
            status: "failed",
            updatedAt: deps.nowIso(),
          };
          repo.updateSession(failedSession);

          return {
            session: failedSession,
            mode: "generation_failed",
            errors: [
              {
                code: "GENERATION_ERROR",
                stage: "spec",
                severity: "error",
                message:
                  err instanceof Error ? err.message : String(err),
              },
            ],
          };
        }
      }

      return buildTurnResponse(updatedSession, analyzerResult);
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
      } catch {
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
        updatedAt: deps.nowIso(),
      };
      repo.updateSession(generatingSession);

      try {
        const draft = await runGenerationPipeline(
          generatingSession,
          requirements,
          requestedModel,
        );

        const finalSession: FridayWorkflowGenerationSession = {
          ...generatingSession,
          status: draft.validation.ok ? "ready_for_review" : "failed",
          draftWorkflowId: draft.spec.workflowId,
          updatedAt: deps.nowIso(),
        };
        repo.updateSession(finalSession);

        return draft;
      } catch (err) {
        const failedSession: FridayWorkflowGenerationSession = {
          ...generatingSession,
          status: "failed",
          updatedAt: deps.nowIso(),
        };
        repo.updateSession(failedSession);
        throw err;
      }
    },

    async approveAndSave(sessionId: string) {
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

      // Derive unique slug
      const slug = makeUniqueSlug(draft.spec.name || draft.spec.workflowId);

      // Create workflow
      const workflow = deps.workflowCrud.createWorkflow({
        slug,
        name: draft.spec.name,
        description: draft.spec.description,
      });

      // Create version
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
        ...session,
        status: "approved",
        workflowId: workflow.id,
        workflowVersionId: publishedVersion.id,
        updatedAt: deps.nowIso(),
      };
      repo.updateSession(approvedSession);

      const savedSession: FridayWorkflowGenerationSession = {
        ...approvedSession,
        status: "saved",
        updatedAt: deps.nowIso(),
      };
      repo.updateSession(savedSession);

      // Clean up persisted draft
      deleteDraft(sessionId);

      return {
        sessionId,
        workflowId: workflow.id,
        workflowVersionId: publishedVersion.id,
        versionNumber: publishedVersion.versionNumber,
        slug: workflow.slug,
        published: true,
      };
    },

    async cancelSession(sessionId: string): Promise<void> {
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
      repo.updateSession(cancelledSession);

      // Clean up persisted draft
      deleteDraft(sessionId);
    },
  };
}
