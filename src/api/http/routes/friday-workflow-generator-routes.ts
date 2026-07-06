import { createHash, randomUUID } from "node:crypto";

import { FridayDomainError } from "#errors";
import type { FridayProviderTenantContext } from "#providers";
import type {
  FridayCompiledWorkflowGraphV2,
  FridayGeneratedWorkflowDraft,
  FridayWorkflowGenerationSession,
  FridayWorkflowGenerationTurn,
  FridayWorkflowSpecV1,
  FridayWorkflowVisualGraphV1,
} from "#workflows";
import {
  assertBoundPrincipalAuthorityForOperation,
  type FridayBoundPrincipalDescriptor,
  type FridayPublicMutationOperation,
} from "../../../security/friday-owner-session-channel-capability.js";
import type {
  FridayRustHubWorkflowCatalogBridgeService,
  FridayRustHubWorkflowCatalogReceipt,
} from "../../mission-spine/friday-rust-hub-workflow-catalog-bridge-service.js";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { FridayWorkflowGeneratorService } from "#workflows";
import type { FridayObservabilityApiService } from "../../../observability/services/friday-observability-api-service.js";
import type {
  FridayWorkflowGenerationEvidence,
  FridayWorkflowGeneratorApproveResponse,
  FridayWorkflowGeneratorCancelResponse,
  FridayWorkflowGeneratorEvidenceResponse,
  FridayWorkflowGeneratorGenerateResponse,
  FridayWorkflowGeneratorGetSessionResponse,
  FridayWorkflowGeneratorPublicationBoundary,
  FridayWorkflowGeneratorStartSessionResponse,
  FridayWorkflowGeneratorSubmitMessageResponse,
} from "../../model/friday-api-workflow.types.js";

// ─── Deps ───

const WORKFLOW_GENERATOR_PUBLICATION_BOUNDARY: FridayWorkflowGeneratorPublicationBoundary = {
  stage: "published_version",
  lifecyclePromotion: "not_lifecycle_promoted",
  proofBoundary: "crud_publish_only",
  summary: "The generated workflow version is published through Workflow CRUD only; this is not workflow upgrade lifecycle shadow/canary/promote proof.",
};

export interface FridayWorkflowGeneratorRoutesDeps {
  workflowGenerator: FridayWorkflowGeneratorService;
  observability?: FridayObservabilityApiService;
  /**
   * Test-oracle only: allows legacy TypeScript workflow generator sessions in
   * isolated validation. Default/live runtime must leave generator sessions
   * fail-closed until Rust owns workflow generator truth.
   */
  allowTestOnlyWorkflowGeneratorExecution?: boolean;
  /**
   * Default-off Rust-catalog-backed workflow generator route. When true, the
   * public generator session surface creates/publishes through the Rust
   * `hub_workflow_catalog` bridge instead of calling the retired TypeScript
   * generator. Unset/false preserves the default/live fail-closed posture.
   */
  routeWorkflowGeneratorViaRust?: boolean;
  rustWorkflowCatalogBridge?: FridayRustHubWorkflowCatalogBridgeService;
  idGenerator?: () => string;
  nowIso?: () => string;
  computeChecksum?: (content: string) => string;
}

interface FridayRustWorkflowGeneratorSessionState {
  session: FridayWorkflowGenerationSession;
  turns: FridayWorkflowGenerationTurn[];
  draft: FridayGeneratedWorkflowDraft;
  workflowId: string;
  workflowVersionId: string;
  slug: string;
  versionNumber: number;
  createReceipt: FridayRustHubWorkflowCatalogReceipt;
  publishReceipt?: FridayRustHubWorkflowCatalogReceipt;
}

interface FridayRustStoredWorkflowDefV1 {
  schema_version: 1;
  name: string;
  steps: Array<{
    id: string;
    action: string;
    params?: Array<[string, string]>;
    force_checkpoint?: boolean;
    evidence_required?: boolean;
  }>;
}

function throwRetiredWorkflowGeneratorExecution(): never {
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

function rustWorkflowGeneratorBridgeUnavailable(): never {
  throw new FridayDomainError(
    "TS_RUNTIME_WORKFLOW_GENERATOR_RUST_BRIDGE_UNAVAILABLE",
    "Rust workflow generator route bridge is enabled but no bridge service is configured.",
    {
      httpStatus: 503,
      details: {
        classification: "fail_closed",
        replacement: "rust_owned_workflow_generator_entrypoint_required",
      },
    },
  );
}

function requireRustWorkflowGeneratorBridge(
  deps: FridayWorkflowGeneratorRoutesDeps,
): FridayRustHubWorkflowCatalogBridgeService {
  if (!deps.rustWorkflowCatalogBridge) {
    rustWorkflowGeneratorBridgeUnavailable();
  }
  return deps.rustWorkflowCatalogBridge;
}

function buildTenantContext(principal: unknown, fallbackUserId: string, fallbackChannel: string): FridayProviderTenantContext {
  const record = principal && typeof principal === "object"
    ? principal as { tenantId?: unknown; principalId?: unknown; userId?: unknown }
    : {};
  const userId = typeof record.userId === "string" && record.userId.trim().length > 0
    ? record.userId.trim()
    : typeof record.principalId === "string" && record.principalId.trim().length > 0
      ? record.principalId.trim()
      : fallbackUserId;
  const tenantId = typeof record.tenantId === "string" && record.tenantId.trim().length > 0
    ? record.tenantId.trim()
    : userId;
  return {
    hubId: tenantId,
    userId,
    channelKind: fallbackChannel,
  };
}

function assertWorkflowGeneratorPrincipal(
  principal: Parameters<typeof assertBoundPrincipalAuthorityForOperation>[0],
  operation: FridayPublicMutationOperation,
): FridayBoundPrincipalDescriptor {
  return assertBoundPrincipalAuthorityForOperation(principal, operation, "api", {
    anyOfScopes: ["hub.admin", "workflow.write"],
    anyOfRoles: ["owner", "admin", "operator"],
  });
}

// ─── Validation helpers ───

function validateCreateSessionBody(
  body: unknown,
): asserts body is { goal: string; requestedModel?: string; userId: string; channel: string; targetWorkflowId?: string } {
  if (body == null || typeof body !== "object") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "Request body is required",
      { httpStatus: 400 },
    );
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof b.goal !== "string" || b.goal.trim() === "") {
    errors.push("goal is required and must be a non-empty string");
  }
  if (typeof b.userId !== "string" || b.userId.trim() === "") {
    errors.push("userId is required and must be a non-empty string");
  }
  if (typeof b.channel !== "string" || b.channel.trim() === "") {
    errors.push("channel is required and must be a non-empty string");
  }
  if (b.requestedModel !== undefined && typeof b.requestedModel !== "string") {
    errors.push("requestedModel must be a string when provided");
  }
  if (b.targetWorkflowId !== undefined && typeof b.targetWorkflowId !== "string") {
    errors.push("targetWorkflowId must be a string when provided");
  }

  if (errors.length > 0) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `Invalid request body: ${errors.join("; ")}`,
      { httpStatus: 400 },
    );
  }
}

function validateSubmitMessageBody(
  body: unknown,
): asserts body is { message: string; requestedModel?: string } {
  if (body == null || typeof body !== "object") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "Request body is required",
      { httpStatus: 400 },
    );
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof b.message !== "string" || b.message.trim() === "") {
    errors.push("message is required and must be a non-empty string");
  }
  if (b.requestedModel !== undefined && typeof b.requestedModel !== "string") {
    errors.push("requestedModel must be a string when provided");
  }

  if (errors.length > 0) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `Invalid request body: ${errors.join("; ")}`,
      { httpStatus: 400 },
    );
  }
}

function validateGenerateBody(
  body: unknown,
): asserts body is { requestedModel?: string } {
  if (body != null && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (b.requestedModel !== undefined && typeof b.requestedModel !== "string") {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        "requestedModel must be a string when provided",
        { httpStatus: 400 },
      );
    }
  }
}

function defaultChecksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function slugifyWorkflowGoal(goal: string, fallback: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return slug || fallback;
}

function buildRustWorkflowDraft(input: {
  goal: string;
  workflowId: string;
  workflowVersionId: string;
  edgeId: string;
  checksum: (content: string) => string;
}): FridayGeneratedWorkflowDraft {
  const name = input.goal.trim().slice(0, 120) || "Generated workflow";
  const spec: FridayWorkflowSpecV1 = {
    schemaVersion: "1.0",
    workflowId: input.workflowId,
    name,
    description: "Rust-catalog-backed workflow generator draft.",
    startStepId: "emit_hello_world",
    trigger: { type: "manual" },
    inputs: [],
    steps: [
      {
        id: "emit_hello_world",
        type: "transform",
        args: {
          mapping: {
            message: "hello world",
            generatedBy: "rust_hub_workflow_catalog",
          },
        },
      },
    ],
    edges: [],
    outputs: [
      {
        key: "message",
        fromStep: "emit_hello_world",
        path: "$.message",
      },
    ],
    errorPolicy: { onFailure: "fail_fast", notifyUser: true },
    tests: [
      {
        name: "manual hello world",
        inputs: {},
        assertions: [
          {
            path: "$.steps.emit_hello_world.output.message",
            operator: "==",
            expected: "hello world",
          },
        ],
      },
    ],
  };
  const compiledWithoutChecksum: Omit<FridayCompiledWorkflowGraphV2, "checksum"> = {
    schemaVersion: "2.0",
    workflowId: input.workflowId,
    workflowVersionId: input.workflowVersionId,
    sourceSpecSchemaVersion: "1.0",
    graph: {
      nodes: [
        {
          id: "__trigger__",
          type: "trigger",
          label: "Trigger (manual)",
          config: { triggerType: "manual" },
        },
        {
          id: "emit_hello_world",
          type: "data",
          label: "emit_hello_world",
          config: {
            mapping: {
              message: "hello world",
              generatedBy: "rust_hub_workflow_catalog",
            },
          },
        },
      ],
      edges: [
        {
          id: input.edgeId,
          sourceNodeId: "__trigger__",
          targetNodeId: "emit_hello_world",
        },
      ],
    },
    failurePolicy: spec.errorPolicy,
    tests: spec.tests,
  };
  const compiledGraph: FridayCompiledWorkflowGraphV2 = {
    ...compiledWithoutChecksum,
    checksum: input.checksum(JSON.stringify(compiledWithoutChecksum)),
  };
  const visual: FridayWorkflowVisualGraphV1 = {
    schemaVersion: "1.0",
    workflowId: input.workflowId,
    panelLayout: {
      leftOpen: true,
      rightOpen: true,
      bottomOpen: false,
    },
    nodes: [
      {
        nodeId: "__trigger__",
        x: 0,
        y: 0,
      },
      {
        nodeId: "emit_hello_world",
        x: 260,
        y: 0,
      },
    ],
    edges: [
      {
        edgeKey: "__trigger__:emit_hello_world:any",
      },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  return {
    spec,
    visual,
    tests: spec.tests,
    compiledGraph,
    validation: { ok: true, issues: [], repaired: false, repairAttempts: 0 },
  };
}

function buildRustStoredWorkflowDefinition(
  draft: FridayGeneratedWorkflowDraft,
): FridayRustStoredWorkflowDefV1 {
  return {
    schema_version: 1,
    name: draft.spec.name,
    steps: [
      {
        id: "emit_hello_world",
        action: "read_file",
        params: [["path", "README.md"]],
        force_checkpoint: false,
        evidence_required: false,
      },
    ],
  };
}

function buildRustPublicationBoundary(): FridayWorkflowGeneratorPublicationBoundary {
  return WORKFLOW_GENERATOR_PUBLICATION_BOUNDARY;
}

function buildRustGeneratorEvidence(
  state: FridayRustWorkflowGeneratorSessionState,
): FridayWorkflowGenerationEvidence {
  const publicationBoundary = state.session.status === "saved"
    ? buildRustPublicationBoundary()
    : undefined;
  return {
    sessionId: state.session.sessionId,
    validationSummary: {
      ok: true,
      repaired: false,
      repairAttempts: 0,
      issueCount: 0,
    },
    approvalReadiness: publicationBoundary
      ? {
        ready: true,
        reason: "Generated workflow version published through Workflow CRUD; lifecycle promotion is not claimed.",
      }
      : {
        ready: true,
        reason: "Rust catalog bridge produced a refs-only workflow draft ready for CRUD publication.",
      },
    qaVerdict: null,
    harness: null,
    ...(publicationBoundary ? { publicationBoundary } : {}),
  };
}

// ─── Factory ───

export function createFridayWorkflowGeneratorRoutes(
  deps: FridayWorkflowGeneratorRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  const { workflowGenerator } = deps;
  const rustSessions = new Map<string, FridayRustWorkflowGeneratorSessionState>();
  const nextId = deps.idGenerator ?? randomUUID;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const computeChecksum = deps.computeChecksum ?? defaultChecksum;
  const isFailureMode = (mode: "clarification_required" | "preview_ready" | "draft_needs_repair" | "retryable_provider_failure" | "generation_failed") =>
    mode === "retryable_provider_failure" || mode === "generation_failed";

  async function reportGenerationFailure(input: {
    sessionId: string;
    userId: string;
    message: string;
  }): Promise<void> {
    await deps.observability?.recordWorkflowGeneratorEvent({
      sessionId: input.sessionId,
      userId: input.userId,
      event: "generation_failed",
      summary: input.message,
      ok: false,
    });
  }

  async function buildEvidence(
    sessionId: string,
  ): Promise<FridayWorkflowGenerationEvidence> {
    const result = await workflowGenerator.getSession(sessionId);
    if (!result) {
      throw new FridayDomainError(
        "GENERATOR_SESSION_NOT_FOUND",
        `Generation session not found: ${sessionId}`,
        { httpStatus: 404 },
      );
    }

    const qaVerdict = await workflowGenerator.getQaVerdict(sessionId);
    const harness = await workflowGenerator.getHarnessSummary(sessionId);
    const draft = result.draft;
    const publicationBoundary = result.session.status === "saved" && result.session.workflowVersionId
      ? WORKFLOW_GENERATOR_PUBLICATION_BOUNDARY
      : undefined;
    const approvalReadiness = qaVerdict
      ? {
        ready: qaVerdict.verdict === "pass",
        reason:
          qaVerdict.verdict === "pass"
            ? "Draft passed the current QA verdict."
            : qaVerdict.summary,
      }
      : draft
        ? {
          ready: draft.validation.ok,
          reason: draft.validation.ok
            ? "Draft passed generator validation and is ready for QA review."
            : "Draft has validation issues that must be fixed before approval.",
        }
        : publicationBoundary
          ? {
            ready: true,
            reason: "Generated workflow version published through Workflow CRUD; lifecycle promotion is not claimed.",
          }
        : {
          ready: false,
          reason: "No draft has been generated yet.",
        };

    return {
      sessionId,
      validationSummary: {
        ok: draft?.validation.ok ?? Boolean(publicationBoundary),
        repaired: draft?.validation.repaired ?? false,
        repairAttempts: draft?.validation.repairAttempts ?? 0,
        issueCount: draft?.validation.issues.length ?? 0,
      },
      approvalReadiness,
      qaVerdict,
      harness,
      ...(publicationBoundary ? { publicationBoundary } : {}),
    };
  }

  async function assertSessionOwner(
    sessionId: string,
    bound: FridayBoundPrincipalDescriptor,
  ): Promise<void> {
    const result = await workflowGenerator.getSession(sessionId);
    if (!result) {
      throw new FridayDomainError(
        "GENERATOR_SESSION_NOT_FOUND",
        `Generation session not found: ${sessionId}`,
        { httpStatus: 404 },
      );
    }
    const actorUserId = bound.userId ?? bound.principalId;
    if (result.session.userId !== actorUserId) {
      throw new FridayDomainError(
        "FORBIDDEN",
        "Workflow generator session does not belong to the bound principal",
        { httpStatus: 403 },
      );
    }
  }

  function assertWorkflowGeneratorTestOracleAllowed(): void {
    if (deps.allowTestOnlyWorkflowGeneratorExecution !== true) {
      throwRetiredWorkflowGeneratorExecution();
    }
  }

  function assertRustSessionOwner(
    state: FridayRustWorkflowGeneratorSessionState,
    bound: FridayBoundPrincipalDescriptor,
  ): void {
    const actorUserId = bound.userId ?? bound.principalId;
    if (state.session.userId !== actorUserId) {
      throw new FridayDomainError(
        "FORBIDDEN",
        "Workflow generator session does not belong to the bound principal",
        { httpStatus: 403 },
      );
    }
  }

  function requireRustSession(sessionId: string): FridayRustWorkflowGeneratorSessionState {
    const state = rustSessions.get(sessionId);
    if (!state) {
      throw new FridayDomainError(
        "GENERATOR_SESSION_NOT_FOUND",
        `Generation session not found: ${sessionId}`,
        { httpStatus: 404 },
      );
    }
    return state;
  }

  async function startRustWorkflowGeneratorSession(ctx: Parameters<FridayRouteDefinition<unknown, unknown, unknown, unknown>["handler"]>[0]): Promise<FridayWorkflowGeneratorStartSessionResponse> {
    const bridge = requireRustWorkflowGeneratorBridge(deps);
    const bound = assertWorkflowGeneratorPrincipal(ctx.principal ?? null, "workflow.generator.session.create");
    validateCreateSessionBody(ctx.body);
    const body = ctx.body;
    const actorUserId = bound.userId ?? bound.principalId;
    if (body.userId !== actorUserId) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        "userId must match the bound principal",
        { httpStatus: 400 },
      );
    }
    const sessionId = nextId();
    const workflowId = nextId();
    const workflowVersionId = nextId();
    const edgeId = nextId();
    const createdAt = nowIso();
    const slug = slugifyWorkflowGoal(body.goal, `workflow-${workflowId.slice(0, 8)}`);
    const tenantContext = buildTenantContext(ctx.principal, body.userId, body.channel);
    const draft = buildRustWorkflowDraft({
      goal: body.goal,
      workflowId,
      workflowVersionId,
      edgeId,
      checksum: computeChecksum,
    });
    const createReceipt = await bridge.mutateCatalog({
      op: "create",
      workflowId,
      slug,
      name: draft.spec.name,
      description: draft.spec.description,
      tagsJson: JSON.stringify(["generated", "rust-catalog"]),
      defJson: JSON.stringify(buildRustStoredWorkflowDefinition(draft)),
    });
    const session: FridayWorkflowGenerationSession = {
      sessionId,
      userId: body.userId,
      channel: body.channel,
      tenantContext,
      status: "ready_for_review",
      goal: body.goal,
      requirementsSummary: "Rust catalog bridge produced a deterministic workflow draft.",
      openQuestions: [],
      decisions: [
        "workflow_generator_route=rust_hub_workflow_catalog",
        "publication_boundary=crud_publish_only",
      ],
      draftWorkflowId: workflowId,
      createdAt,
      updatedAt: createdAt,
    };
    const state: FridayRustWorkflowGeneratorSessionState = {
      session,
      turns: [],
      draft,
      workflowId,
      workflowVersionId,
      slug,
      versionNumber: 1,
      createReceipt,
    };
    rustSessions.set(sessionId, state);
    await deps.observability?.recordWorkflowGeneratorEvent({
      sessionId,
      userId: body.userId,
      event: "session_started",
      summary: `Started Rust-catalog-backed workflow generation session for ${body.goal}`,
      ok: true,
      evidence: buildRustGeneratorEvidence(state),
    });
    return {
      session,
      mode: "preview_ready",
      draft,
    };
  }

  return [
    // 1. Create session
    {
      operationId: "workflows.generator.sessions.create",
      method: "POST",
      path: "/v1/workflows/generator/sessions",
      auth: { public: true },
      rateLimitPolicyId: "generator.write",
      async handler(ctx): Promise<FridayWorkflowGeneratorStartSessionResponse> {
        if (deps.routeWorkflowGeneratorViaRust === true) {
          return startRustWorkflowGeneratorSession(ctx);
        }
        assertWorkflowGeneratorTestOracleAllowed();
        const bound = assertWorkflowGeneratorPrincipal(ctx.principal ?? null, "workflow.generator.session.create");
        validateCreateSessionBody(ctx.body);
        const body = ctx.body;
        const actorUserId = bound.userId ?? bound.principalId;
        if (body.userId !== actorUserId) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "userId must match the bound principal",
            { httpStatus: 400 },
          );
        }
        const result = await workflowGenerator.startSession({
          goal: body.goal,
          requestedModel: body.requestedModel,
          userId: body.userId,
          channel: body.channel,
          targetWorkflowId: body.targetWorkflowId,
          tenantContext: buildTenantContext(ctx.principal, body.userId, body.channel),
        });
        if (isFailureMode(result.mode)) {
          await reportGenerationFailure({
            sessionId: result.session.sessionId,
            userId: result.session.userId,
            message: result.errors?.map((error) => error.message).join("; ") ?? "generation failed",
          });
        }
        await deps.observability?.recordWorkflowGeneratorEvent({
          sessionId: result.session.sessionId,
          userId: result.session.userId,
          event: "session_started",
          summary: `Started workflow generation session for ${result.session.goal}`,
          ok: !isFailureMode(result.mode),
        });
        return result;
      },
    },

    // 2. Get session
    {
      operationId: "workflows.generator.sessions.get",
      method: "GET",
      path: "/v1/workflows/generator/sessions/:sessionId",
      auth: { public: true },
      async handler(ctx): Promise<FridayWorkflowGeneratorGetSessionResponse> {
        if (deps.routeWorkflowGeneratorViaRust === true) {
          const { sessionId } = ctx.params as { sessionId: string };
          const state = requireRustSession(sessionId);
          return {
            session: state.session,
            turns: state.turns,
            draft: state.draft,
          };
        }
        assertWorkflowGeneratorTestOracleAllowed();
        const { sessionId } = ctx.params as { sessionId: string };
        const result = await workflowGenerator.getSession(sessionId);
        if (!result) {
          throw new FridayDomainError(
            "GENERATOR_SESSION_NOT_FOUND",
            `Generation session not found: ${sessionId}`,
            { httpStatus: 404 },
          );
        }
        return result;
      },
    },

    // 3. Submit message
    {
      operationId: "workflows.generator.sessions.messages.create",
      method: "POST",
      path: "/v1/workflows/generator/sessions/:sessionId/messages",
      auth: { public: true },
      rateLimitPolicyId: "generator.llm",
      async handler(ctx): Promise<FridayWorkflowGeneratorSubmitMessageResponse> {
        if (deps.routeWorkflowGeneratorViaRust === true) {
          const { sessionId } = ctx.params as { sessionId: string };
          const state = requireRustSession(sessionId);
          const bound = assertWorkflowGeneratorPrincipal(ctx.principal ?? null, "workflow.generator.message.create");
          assertRustSessionOwner(state, bound);
          validateSubmitMessageBody(ctx.body);
          const body = ctx.body;
          const createdAt = nowIso();
          state.turns.push({
            turnId: nextId(),
            sessionId,
            role: "user",
            content: body.message,
            createdAt,
          });
          state.session.updatedAt = createdAt;
          return {
            session: state.session,
            mode: "preview_ready",
            draft: state.draft,
          };
        }
        assertWorkflowGeneratorTestOracleAllowed();
        const { sessionId } = ctx.params as { sessionId: string };
        const bound = assertWorkflowGeneratorPrincipal(ctx.principal ?? null, "workflow.generator.message.create");
        await assertSessionOwner(sessionId, bound);
        validateSubmitMessageBody(ctx.body);
        const body = ctx.body;
        const result = await workflowGenerator.submitTurn(sessionId, {
          message: body.message,
          requestedModel: body.requestedModel,
        });
        if (isFailureMode(result.mode)) {
          await reportGenerationFailure({
            sessionId: result.session.sessionId,
            userId: result.session.userId,
            message: result.errors?.map((error) => error.message).join("; ") ?? "generation failed",
          });
        }
        return result;
      },
    },

    // 4. Generate draft
    {
      operationId: "workflows.generator.sessions.generate",
      method: "POST",
      path: "/v1/workflows/generator/sessions/:sessionId/generate",
      auth: { public: true },
      rateLimitPolicyId: "generator.llm",
      async handler(ctx): Promise<FridayWorkflowGeneratorGenerateResponse> {
        if (deps.routeWorkflowGeneratorViaRust === true) {
          const { sessionId } = ctx.params as { sessionId: string };
          const state = requireRustSession(sessionId);
          const bound = assertWorkflowGeneratorPrincipal(ctx.principal ?? null, "workflow.generator.generate");
          assertRustSessionOwner(state, bound);
          validateGenerateBody(ctx.body);
          await deps.observability?.recordWorkflowGeneratorEvent({
            sessionId,
            userId: state.session.userId,
            event: "draft_generated",
            summary: `Returned Rust-catalog-backed workflow draft for session ${sessionId}`,
            ok: true,
            evidence: buildRustGeneratorEvidence(state),
          });
          return { draft: state.draft };
        }
        assertWorkflowGeneratorTestOracleAllowed();
        const { sessionId } = ctx.params as { sessionId: string };
        const bound = assertWorkflowGeneratorPrincipal(ctx.principal ?? null, "workflow.generator.generate");
        await assertSessionOwner(sessionId, bound);
        validateGenerateBody(ctx.body);
        const body = ctx.body as { requestedModel?: string };
        let draft;
        try {
          draft = await workflowGenerator.generateDraft(
            sessionId,
            body?.requestedModel,
          );
        } catch (error) {
          const session = await workflowGenerator.getSession(sessionId);
          if (session) {
            await reportGenerationFailure({
              sessionId,
              userId: session.session.userId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
          throw error;
        }
        const session = await workflowGenerator.getSession(sessionId);
        if (session) {
          const evidence = await buildEvidence(sessionId);
          await deps.observability?.recordWorkflowGeneratorEvent({
            sessionId,
            userId: session.session.userId,
            event: "draft_generated",
            summary: `Generated a workflow draft for session ${sessionId}`,
            ok: draft.validation.ok,
            evidence,
          });
          if (evidence.qaVerdict) {
            await deps.observability?.recordWorkflowGeneratorEvent({
              sessionId,
              userId: session.session.userId,
              event: "verdict_ready",
              summary: evidence.qaVerdict.summary,
              ok: evidence.qaVerdict.verdict === "pass",
              evidence,
            });
          }
        }
        return { draft };
      },
    },

    // 5. Evidence summary
    {
      operationId: "workflows.generator.sessions.evidence.get",
      method: "GET",
      path: "/v1/workflows/generator/sessions/:sessionId/evidence",
      auth: { public: true },
      async handler(ctx): Promise<FridayWorkflowGeneratorEvidenceResponse> {
        if (deps.routeWorkflowGeneratorViaRust === true) {
          const { sessionId } = ctx.params as { sessionId: string };
          return { evidence: buildRustGeneratorEvidence(requireRustSession(sessionId)) };
        }
        assertWorkflowGeneratorTestOracleAllowed();
        const { sessionId } = ctx.params as { sessionId: string };
        const evidence = await buildEvidence(sessionId);
        return { evidence };
      },
    },

    // 6. Approve and save
    {
      operationId: "workflows.generator.sessions.approve",
      method: "POST",
      path: "/v1/workflows/generator/sessions/:sessionId/approve",
      auth: { public: true },
      rateLimitPolicyId: "workflow.publish",
      async handler(ctx): Promise<FridayWorkflowGeneratorApproveResponse> {
        if (deps.routeWorkflowGeneratorViaRust === true) {
          const bridge = requireRustWorkflowGeneratorBridge(deps);
          const { sessionId } = ctx.params as { sessionId: string };
          const state = requireRustSession(sessionId);
          const bound = assertWorkflowGeneratorPrincipal(ctx.principal ?? null, "workflow.generator.approve");
          assertRustSessionOwner(state, bound);
          const publishReceipt = await bridge.mutateCatalog({
            op: "publish",
            workflowId: state.workflowId,
            version: state.versionNumber,
          });
          state.publishReceipt = publishReceipt;
          state.session.status = "saved";
          state.session.workflowId = state.workflowId;
          state.session.workflowVersionId = state.workflowVersionId;
          state.session.updatedAt = nowIso();
          const evidence = buildRustGeneratorEvidence(state);
          await deps.observability?.recordWorkflowGeneratorEvent({
            sessionId,
            userId: state.session.userId,
            event: "draft_saved",
            summary: `Published Rust-catalog-backed workflow version ${state.workflowVersionId}; lifecycle promotion is not claimed`,
            ok: true,
            evidence,
          });
          return {
            sessionId,
            workflowId: state.workflowId,
            workflowVersionId: state.workflowVersionId,
            versionNumber: state.versionNumber,
            slug: state.slug,
            published: true,
            publicationBoundary: buildRustPublicationBoundary(),
            evidence,
          };
        }
        assertWorkflowGeneratorTestOracleAllowed();
        const { sessionId } = ctx.params as { sessionId: string };
        const bound = assertWorkflowGeneratorPrincipal(ctx.principal ?? null, "workflow.generator.approve");
        await assertSessionOwner(sessionId, bound);
        const evidence = await buildEvidence(sessionId);
        if (!evidence.approvalReadiness.ready) {
          const session = await workflowGenerator.getSession(sessionId);
          await deps.observability?.recordWorkflowGeneratorEvent({
            sessionId,
            userId: session?.session.userId ?? "operator",
            event: "approve_blocked",
            summary: evidence.approvalReadiness.reason,
            ok: false,
            evidence,
          });
        }
        const result = await workflowGenerator.approveAndSave(sessionId);
        await deps.observability?.recordWorkflowGeneratorEvent({
          sessionId,
          userId: "operator",
          event: "draft_saved",
          summary: `Published generated workflow version ${result.workflowVersionId}; lifecycle promotion is not claimed`,
          ok: true,
          evidence: {
            ...evidence,
            approvalReadiness: {
              ready: true,
              reason: "Generated workflow version published through Workflow CRUD; lifecycle promotion is not claimed.",
            },
            qaVerdict: result.qaVerdict ?? evidence.qaVerdict ?? null,
            harness: result.harness ?? evidence.harness ?? null,
            publicationBoundary: result.publicationBoundary ?? WORKFLOW_GENERATOR_PUBLICATION_BOUNDARY,
          },
        });
        return {
          ...result,
          evidence: {
            ...evidence,
            approvalReadiness: {
              ready: true,
              reason: "Generated workflow version published through Workflow CRUD; lifecycle promotion is not claimed.",
            },
            qaVerdict: result.qaVerdict ?? evidence.qaVerdict ?? null,
            harness: result.harness ?? evidence.harness ?? null,
            publicationBoundary: result.publicationBoundary ?? WORKFLOW_GENERATOR_PUBLICATION_BOUNDARY,
          },
        };
      },
    },

    // 7. Cancel session
    {
      operationId: "workflows.generator.sessions.cancel",
      method: "DELETE",
      path: "/v1/workflows/generator/sessions/:sessionId",
      auth: { public: true },
      async handler(ctx): Promise<FridayWorkflowGeneratorCancelResponse> {
        if (deps.routeWorkflowGeneratorViaRust === true) {
          const { sessionId } = ctx.params as { sessionId: string };
          const state = requireRustSession(sessionId);
          const bound = assertWorkflowGeneratorPrincipal(ctx.principal ?? null, "workflow.generator.cancel");
          assertRustSessionOwner(state, bound);
          state.session.status = "cancelled";
          state.session.updatedAt = nowIso();
          rustSessions.delete(sessionId);
          return { cancelled: true };
        }
        assertWorkflowGeneratorTestOracleAllowed();
        const { sessionId } = ctx.params as { sessionId: string };
        const bound = assertWorkflowGeneratorPrincipal(ctx.principal ?? null, "workflow.generator.cancel");
        await assertSessionOwner(sessionId, bound);
        await workflowGenerator.cancelSession(sessionId);
        return { cancelled: true };
      },
    },
  ];
}
