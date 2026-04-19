import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import { FridayDomainError } from "#errors";
import type { FridayProviderTenantContext } from "#providers";

import type { FridaySkillGeneratorService } from "#skills/generator";
import type { FridaySkillRegistry } from "#skills";
import type { FridaySkillUiSchemaV1 } from "#skills/generator";
import {
  FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV,
  createFridayNodeExecutor,
  createFridayShellExecutor,
  getFridayUnisolatedNodeSkillsDisabledMessage,
  isFridayUnisolatedNodeSkillsEnabled,
  loadFridaySkillPackage,
  type SkillManifestV2,
  validateFridaySkillPackage,
} from "#skills";
import type { FridaySelfHealingApiService } from "#learning";
import type { FridayObservabilityApiService } from "../../../observability/services/friday-observability-api-service.js";
import { extractFridaySkillGenerationContract } from "../../../skills/generator/services/friday-skill-generator-contract.js";

import type {
  FridayApproveResponse,
  FridayCancelSessionResponse,
  FridayGenerateResponse,
  FridayGetSessionResponse,
  FridayGetSkillUiResponse,
  FridaySkillGenerationEvidence,
  FridaySkillGeneratorEvidenceResponse,
  FridaySkillGeneratorTestResponse,
  FridayStartSessionResponse,
  FridaySubmitTurnResponse,
} from "../../model/friday-api-skill-generator.types.js";
import { throwFridayCapabilityDisabled } from "./friday-capability-disabled.js";

function requireUserId(principal: unknown): string {
  const record = principal && typeof principal === "object"
    ? principal as { userId?: unknown }
    : {};
  if (typeof record.userId === "string" && record.userId.trim().length > 0) {
    return record.userId.trim();
  }
  throw new FridayDomainError("UNAUTHORIZED", "A user-scoped skill-generator principal is required", {
    httpStatus: 401,
  });
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

// ─── Validation helpers ───

function validateStartSessionBody(
  body: unknown,
): asserts body is { goal: string; requestedModel?: string; userId: string; channel: string } {
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

  if (errors.length > 0) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `Invalid request body: ${errors.join("; ")}`,
      { httpStatus: 400 },
    );
  }
}

function validateSubmitTurnBody(
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
  if (body == null) return; // null/undefined is acceptable (no options)
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "Request body must be a plain object when provided",
      { httpStatus: 400 },
    );
  }
  const b = body as Record<string, unknown>;
  if (
    b.requestedModel !== undefined &&
    typeof b.requestedModel !== "string"
  ) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "requestedModel must be a string when provided",
      { httpStatus: 400 },
    );
  }
}

// ─── Dependencies ───

export interface FridaySkillGeneratorRoutesDeps {
  skillGenerator: FridaySkillGeneratorService;
  registry: FridaySkillRegistry;
  selfHealing?: FridaySelfHealingApiService;
  observability?: FridayObservabilityApiService;
}

const GENERATED_SKILL_HUB_VERSION = "1.0.0";
const GENERATED_SKILL_SUPPORTED_API_VERSIONS = ["1"];

function parseSpecSummary(specSummary: string): Record<string, unknown> | null {
  if (!specSummary.trim()) return null;
  try {
    const parsed = JSON.parse(specSummary) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function synthesizeStringInput(
  field: SkillManifestV2["inputs"][number],
  sessionGoal: string,
  requiredMarkers: readonly string[],
  expectedSkillId?: string,
): string {
  const signal = `${field.key} ${field.label} ${field.help ?? ""}`.toLowerCase();
  if (/(task|prompt|query|message|instruction|text|request)/.test(signal)) {
    return requiredMarkers[0]
      ? `Return exact marker ${requiredMarkers[0]} and nothing else.`
      : sessionGoal;
  }
  if (/(marker|expected|version)/.test(signal) && requiredMarkers[0]) {
    return requiredMarkers[0];
  }
  if (/(name|title|label|id)/.test(signal) && expectedSkillId) {
    return expectedSkillId;
  }
  return "test";
}

function buildDraftExecutionInput(
  manifest: SkillManifestV2,
  sessionGoal: string,
  requiredMarkers: readonly string[],
  expectedSkillId?: string,
): { ok: true; input: Record<string, unknown> } | { ok: false; reason: string } {
  const input: Record<string, unknown> = {};
  const missingRequired: string[] = [];

  for (const field of manifest.inputs) {
    let value = field.defaultValue;
    if (value === undefined) {
      switch (field.type) {
        case "string":
          value = synthesizeStringInput(field, sessionGoal, requiredMarkers, expectedSkillId);
          break;
        case "number":
          value = typeof field.validation?.min === "number" ? field.validation.min : 1;
          break;
        case "boolean":
          value = false;
          break;
        case "object":
          value = {};
          break;
        case "array":
          value = [];
          break;
        case "file":
        case "secret":
          value = undefined;
          break;
      }
    }

    if (value === undefined) {
      if (field.required) {
        missingRequired.push(field.key);
      }
      continue;
    }

    input[field.key] = value;
  }

  if (missingRequired.length > 0) {
    return {
      ok: false,
      reason: `Cannot synthesize required inputs for self-test: ${missingRequired.join(", ")}`,
    };
  }

  return { ok: true, input };
}

async function executeDraftFromTempDir(
  root: string,
  manifest: SkillManifestV2,
  input: Record<string, unknown>,
): Promise<{
  status: "completed" | "failed" | "timeout";
  output: Record<string, unknown>;
  stdout: string;
  stderr: string;
}> {
  if (manifest.runtime.kind === "shell") {
    const shellExecutor = createFridayShellExecutor();
    const env: Record<string, string> = {};
    for (const envKey of manifest.requirements.env) {
      if (process.env[envKey] != null) {
        env[envKey] = process.env[envKey]!;
      }
    }
    const shellResult = await shellExecutor.run({
      command: join(root, manifest.runtime.entrypoint),
      cwd: root,
      env,
      timeoutMs: manifest.runtime.timeoutMsDefault,
      stdin: JSON.stringify(input),
    });
    if (shellResult.timedOut) {
      return { status: "timeout", output: {}, stdout: shellResult.stdout, stderr: shellResult.stderr };
    }
    if (shellResult.exitCode !== 0) {
      return { status: "failed", output: {}, stdout: shellResult.stdout, stderr: shellResult.stderr };
    }
    try {
      const parsed = JSON.parse(shellResult.stdout) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { status: "completed", output: parsed as Record<string, unknown>, stdout: shellResult.stdout, stderr: shellResult.stderr };
      }
      return { status: "completed", output: { result: parsed }, stdout: shellResult.stdout, stderr: shellResult.stderr };
    } catch {
      return { status: "completed", output: { raw: shellResult.stdout }, stdout: shellResult.stdout, stderr: shellResult.stderr };
    }
  }

  if (manifest.runtime.kind === "node") {
    if (!isFridayUnisolatedNodeSkillsEnabled()) {
      throwFridayCapabilityDisabled({
        capability: "skill_node_runtime",
        surface: "POST /v1/skills/generator/sessions/:sessionId/test",
        message: getFridayUnisolatedNodeSkillsDisabledMessage(),
        details: {
          runtimeKind: "node",
          gate: FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV,
          skillId: manifest.id,
        },
      });
    }
    const nodeExecutor = createFridayNodeExecutor();
    const nodeResult = await nodeExecutor.run({
      entrypoint: manifest.runtime.entrypoint,
      cwd: root,
      input,
      timeoutMs: manifest.runtime.timeoutMsDefault,
    });
    if (nodeResult.timedOut) {
      return { status: "timeout", output: {}, stdout: "", stderr: nodeResult.error ?? "" };
    }
    if (nodeResult.error) {
      return { status: "failed", output: {}, stdout: "", stderr: nodeResult.error };
    }
    return { status: "completed", output: nodeResult.output, stdout: "", stderr: "" };
  }

  return {
    status: "failed",
    output: {},
    stdout: "",
    stderr: `Unsupported runtime kind for self-test: ${manifest.runtime.kind}`,
  };
}

// ─── Factory ───

export function createFridaySkillGeneratorRoutes(
  deps: FridaySkillGeneratorRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  async function reportGenerationFailure(input: {
    sessionId: string;
    userId: string;
    message: string;
  }): Promise<void> {
    if (!deps.selfHealing) {
      return;
    }
    deps.selfHealing.reportStructuredFailure({
      userId: input.userId,
      category: "workflow",
      severity: "medium",
      message: `skill_generator:${input.sessionId}:${input.message}`,
      context: {
        source: "skill_generator",
        sessionId: input.sessionId,
      },
      correlationId: input.sessionId,
    });
    await deps.observability?.recordSkillGeneratorEvent({
      sessionId: input.sessionId,
      userId: input.userId,
      event: "generation_failed",
      summary: input.message,
      ok: false,
    });
  }

  async function runDraftSelfTest(
    sessionId: string,
  ): Promise<FridaySkillGeneratorTestResponse["test"]> {
    const result = await deps.skillGenerator.getSession(sessionId);
    if (!result || !result.draft) {
      throw new FridayDomainError(
        "GENERATOR_DRAFT_NOT_FOUND",
        "No draft found for session. Generate a draft first.",
        { httpStatus: 404 },
      );
    }

    const draft = result.draft;
    const startedAt = Date.now();
    const root = join(tmpdir(), `friday-skill-test-${sessionId}`);

    rmSync(root, { force: true, recursive: true });
    mkdirSync(root, { recursive: true });

    try {
      writeFileSync(join(root, "skill.manifest.json"), JSON.stringify(draft.manifest, null, 2));
      writeFileSync(join(root, "skill.ui.json"), JSON.stringify(draft.uiSchema, null, 2));

      for (const file of draft.files) {
        const filePath = join(root, file.path);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, file.content, "utf-8");
        if (file.executable) {
          chmodSync(filePath, 0o755);
        }
      }

      const loaded = loadFridaySkillPackage({
        skillDir: root,
        workspaceDir: root,
      });

      if (!loaded.ok) {
        return {
          ok: false,
          executable: false,
          issues: [
            {
              code: "LOAD_FAILED",
              severity: "error",
              message: loaded.error.message,
            },
          ],
          durationMs: Date.now() - startedAt,
          testedAt: new Date().toISOString(),
        };
      }

      const validation = validateFridaySkillPackage({
        loaded: loaded.value,
        workspaceDir: root,
        hubVersion: GENERATED_SKILL_HUB_VERSION,
        supportedApiVersions: GENERATED_SKILL_SUPPORTED_API_VERSIONS,
      });

      const spec = parseSpecSummary(result.session.specSummary);
      const contract = extractFridaySkillGenerationContract({
        goal: result.session.goal,
        spec,
        turns: result.turns,
      });
      const issues = validation.issues.map((issue) => ({
        code: issue.code,
        severity: issue.severity,
        message: issue.message,
        path: issue.path,
      }));
      const behavioralCheck: NonNullable<FridaySkillGeneratorTestResponse["test"]["behavioralCheck"]> = {
        attempted: false,
        satisfied: false,
        expectedMarkers: [...contract.requiredOutputMarkers],
        matchedMarkers: [],
      };

      if (validation.ok) {
        if (contract.requiredOutputMarkers.length === 0) {
          behavioralCheck.reason =
            "Explicit self-test requires at least one required output marker to prove runtime behavior.";
          issues.push({
            code: "BEHAVIOR_TEST_MARKERS_REQUIRED",
            severity: "error",
            message: behavioralCheck.reason,
            path: undefined,
          });
        } else {
          const synthesized = buildDraftExecutionInput(
            draft.manifest,
            result.session.goal,
            contract.requiredOutputMarkers,
            contract.expectedSkillId,
          );
          if (!synthesized.ok) {
            behavioralCheck.reason = synthesized.reason;
            issues.push({
              code: "BEHAVIOR_TEST_INPUT_UNAVAILABLE",
              severity: "error",
              message: synthesized.reason,
              path: undefined,
            });
          } else {
            behavioralCheck.attempted = true;
            const execution = await executeDraftFromTempDir(root, loaded.value.manifest, synthesized.input);
            behavioralCheck.runStatus = execution.status;
            const combinedOutput = `${execution.stdout}\n${JSON.stringify(execution.output)}`;
            behavioralCheck.matchedMarkers = contract.requiredOutputMarkers.filter((marker) =>
              combinedOutput.includes(marker),
            );
            behavioralCheck.satisfied =
              execution.status === "completed" &&
              behavioralCheck.matchedMarkers.length === contract.requiredOutputMarkers.length;
            if (!behavioralCheck.satisfied) {
              behavioralCheck.reason = execution.status !== "completed"
                ? `Draft execution finished with status ${execution.status}`
                : `Runtime output missed required marker(s): ${contract.requiredOutputMarkers.filter((marker) => !behavioralCheck.matchedMarkers.includes(marker)).join(", ")}`;
              issues.push({
                code: execution.status !== "completed"
                  ? "BEHAVIOR_TEST_EXECUTION_FAILED"
                  : "BEHAVIOR_TEST_MARKER_MISMATCH",
                severity: "error",
                message: behavioralCheck.reason,
                path: undefined,
              });
            }
          }
        }
      }

      return {
        ok: validation.ok && issues.every((issue) => issue.severity !== "error"),
        executable: validation.ok && behavioralCheck.attempted && behavioralCheck.satisfied,
        issues,
        durationMs: Date.now() - startedAt,
        testedAt: new Date().toISOString(),
        behavioralCheck,
      };
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }

  async function buildEvidence(
    sessionId: string,
  ): Promise<FridaySkillGenerationEvidence> {
    const result = await deps.skillGenerator.getSession(sessionId);
    if (!result) {
      throw new FridayDomainError(
        "SESSION_NOT_FOUND",
        "Generation session not found",
        { httpStatus: 404 },
      );
    }

    const draft = result.draft;
    const test = result.session.explicitTest ?? null;
    const qaVerdict = await deps.skillGenerator.getQaVerdict(sessionId);
    const harness = await deps.skillGenerator.getHarnessSummary(sessionId);
    const savedOrApproved =
      result.session.status === "approved" ||
      result.session.status === "saved";
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
          ready: draft.validation.ok && (test?.ok ?? false) && (test?.executable ?? false),
          reason: draft.validation.ok
            ? !test
              ? "Draft still needs to pass explicit self-test"
              : !test.ok
                ? "Draft still needs to pass explicit self-test"
                : !test.executable
                  ? "Draft explicit self-test did not execute runtime behavior"
                  : "Draft passed validation and explicit self-test"
            : "Draft has validation issues that must be fixed before approval",
        }
        : savedOrApproved
          ? {
            ready: true,
            reason: result.session.status === "saved"
              ? "Generated skill saved."
              : "Generated skill approved and ready to save.",
          }
        : {
          ready: false,
          reason: "No draft has been generated yet",
        };

    return {
      sessionId,
      validationSummary: {
        ok: draft?.validation.ok ?? savedOrApproved,
        repaired: draft?.validation.repaired ?? false,
        repairAttempts: draft?.validation.repairAttempts ?? 0,
        issueCount: draft?.validation.issues.length ?? 0,
      },
      repairSummary: {
        attempted: (draft?.validation.repairAttempts ?? 0) > 0,
        attempts: draft?.validation.repairAttempts ?? 0,
      },
      executableTestSummary: test,
      approvalReadiness,
      qaVerdict,
      harness,
      savedSkillIdentity: result.session.draftSkillId
        ? {
          skillId: result.session.draftSkillId,
        }
        : undefined,
    };
  }

  return [
    // ─── Start session ───
    {
      operationId: "skills.generator.sessions.create",
      method: "POST",
      path: "/v1/skills/generator/sessions",
      auth: { public: false, anyOfScopes: ["skill.write"] },
      rateLimitPolicyId: "skill_generator.write",
      async handler(ctx): Promise<FridayStartSessionResponse> {
        validateStartSessionBody(ctx.body);
        const body = ctx.body;
        const principalUserId = requireUserId(ctx.principal);
        if (body.userId.trim() !== principalUserId) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "userId must match the authenticated principal",
            { httpStatus: 400 },
          );
        }
        const result = await deps.skillGenerator.startSession({
          goal: body.goal,
          requestedModel: body.requestedModel,
          userId: principalUserId,
          channel: body.channel,
          tenantContext: buildTenantContext(ctx.principal, principalUserId, body.channel),
        });
        if (result.mode === "generation_failed") {
          await reportGenerationFailure({
            sessionId: result.session.sessionId,
            userId: result.session.userId,
            message: result.errors?.map((error) => error.message).join("; ") ?? "generation failed",
          });
        }
        await deps.observability?.recordSkillGeneratorEvent({
          sessionId: result.session.sessionId,
          userId: result.session.userId,
          event: "session_started",
          summary: `Started skill generation session for ${result.session.goal}`,
          ok: result.mode !== "generation_failed",
        });
        return result;
      },
    },

    // ─── Get session ───
    {
      operationId: "skills.generator.sessions.get",
      method: "GET",
      path: "/v1/skills/generator/sessions/:sessionId",
      auth: { public: false, anyOfScopes: ["skill.read"] },
      async handler(ctx): Promise<FridayGetSessionResponse> {
        const { sessionId } = ctx.params as { sessionId: string };
        const result = await deps.skillGenerator.getSession(sessionId);
        if (!result) {
          throw new FridayDomainError(
            "SESSION_NOT_FOUND",
            "Generation session not found",
            { httpStatus: 404 },
          );
        }
        return result;
      },
    },

    // ─── Submit turn ───
    {
      operationId: "skills.generator.sessions.messages.create",
      method: "POST",
      path: "/v1/skills/generator/sessions/:sessionId/messages",
      auth: { public: false, anyOfScopes: ["skill.write"] },
      rateLimitPolicyId: "skill_generator.llm",
      async handler(ctx): Promise<FridaySubmitTurnResponse> {
        const { sessionId } = ctx.params as { sessionId: string };
        validateSubmitTurnBody(ctx.body);
        const body = ctx.body;
        const result = await deps.skillGenerator.submitTurn(sessionId, {
          message: body.message,
          requestedModel: body.requestedModel,
        });
        if (result.mode === "generation_failed") {
          await reportGenerationFailure({
            sessionId: result.session.sessionId,
            userId: result.session.userId,
            message: result.errors?.map((error) => error.message).join("; ") ?? "generation failed",
          });
        }
        return result;
      },
    },

    // ─── Force generation ───
    {
      operationId: "skills.generator.sessions.generate",
      method: "POST",
      path: "/v1/skills/generator/sessions/:sessionId/generate",
      auth: { public: false, anyOfScopes: ["skill.write"] },
      rateLimitPolicyId: "skill_generator.llm",
      async handler(ctx): Promise<FridayGenerateResponse> {
        const { sessionId } = ctx.params as { sessionId: string };
        validateGenerateBody(ctx.body);
        const body = (ctx.body ?? {}) as { requestedModel?: string };
        try {
          const draft = await deps.skillGenerator.generateDraft(
            sessionId,
            body.requestedModel,
          );
          const session = await deps.skillGenerator.getSession(sessionId);
          if (session) {
            await deps.observability?.recordSkillGeneratorEvent({
              sessionId,
              userId: session.session.userId,
              event: "draft_generated",
              summary: `Generated a skill draft for session ${sessionId}`,
              ok: draft.validation.ok,
            });
          }
          return { draft };
        } catch (error) {
          const session = await deps.skillGenerator.getSession(sessionId);
          if (session) {
            await reportGenerationFailure({
              sessionId,
              userId: session.session.userId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
          throw error;
        }
      },
    },

    // ─── Explicit test run ───
    {
      operationId: "skills.generator.sessions.test",
      method: "POST",
      path: "/v1/skills/generator/sessions/:sessionId/test",
      auth: { public: false, anyOfScopes: ["skill.write"] },
      rateLimitPolicyId: "skill_generator.write",
      async handler(ctx): Promise<FridaySkillGeneratorTestResponse> {
        const { sessionId } = ctx.params as { sessionId: string };
        const session = await deps.skillGenerator.getSession(sessionId);
        if (!session) {
          throw new FridayDomainError(
            "SESSION_NOT_FOUND",
            "Generation session not found",
            { httpStatus: 404 },
          );
        }
        const test = await runDraftSelfTest(sessionId);
        if (!test.ok) {
          await reportGenerationFailure({
            sessionId,
            userId: session.session.userId,
            message: test.issues.map((issue) => issue.message).join("; ") || "draft self-test failed",
          });
        }
        await deps.skillGenerator.recordExplicitTestResult(sessionId, test);
        await deps.observability?.recordSkillGeneratorEvent({
          sessionId,
          userId: session.session.userId,
          event: "draft_tested",
          summary: test.ok
            ? `Skill draft self-test passed for session ${sessionId}`
            : `Skill draft self-test failed for session ${sessionId}`,
          ok: test.ok,
        });
        return { sessionId, test };
      },
    },

    // ─── Evidence summary ───
    {
      operationId: "skills.generator.sessions.evidence.get",
      method: "GET",
      path: "/v1/skills/generator/sessions/:sessionId/evidence",
      auth: { public: false, anyOfScopes: ["skill.read"] },
      async handler(ctx): Promise<FridaySkillGeneratorEvidenceResponse> {
        const { sessionId } = ctx.params as { sessionId: string };
        const evidence = await buildEvidence(sessionId);
        return { evidence };
      },
    },

    // ─── Approve and save ───
    {
      operationId: "skills.generator.sessions.approve",
      method: "POST",
      path: "/v1/skills/generator/sessions/:sessionId/approve",
      auth: { public: false, anyOfScopes: ["skill.write"] },
      rateLimitPolicyId: "skill_generator.write",
      async handler(ctx): Promise<FridayApproveResponse> {
        const { sessionId } = ctx.params as { sessionId: string };
        const result = await deps.skillGenerator.approveAndSave(sessionId);
        const evidence = await buildEvidence(sessionId).catch(() => ({
          sessionId,
          validationSummary: {
            ok: true,
            repaired: false,
            repairAttempts: 0,
            issueCount: 0,
          },
          repairSummary: {
            attempted: false,
            attempts: 0,
          },
          executableTestSummary: null,
          approvalReadiness: {
            ready: true,
            reason: "Generated skill saved.",
          },
          qaVerdict: result.qaVerdict ?? null,
          harness: result.harness ?? null,
          savedSkillIdentity: {
            skillId: result.skillId,
            skillDir: result.skillDir,
          },
        }));
        await deps.observability?.recordSkillGeneratorEvent({
          sessionId,
          userId: "operator",
          event: "draft_saved",
          summary: `Saved generated skill ${result.skillId}`,
          ok: true,
          evidence,
        });
        return {
          ...result,
          evidence: {
            ...evidence,
            qaVerdict: result.qaVerdict ?? evidence.qaVerdict ?? null,
            harness: result.harness ?? evidence.harness ?? null,
            savedSkillIdentity: {
              skillId: result.skillId,
              skillDir: result.skillDir,
            },
            approvalReadiness: {
              ready: true,
              reason: "Generated skill saved.",
            },
          },
        };
      },
    },

    // ─── Cancel session ───
    {
      operationId: "skills.generator.sessions.cancel",
      method: "DELETE",
      path: "/v1/skills/generator/sessions/:sessionId",
      auth: { public: false, anyOfScopes: ["skill.write"] },
      async handler(ctx): Promise<FridayCancelSessionResponse> {
        const { sessionId } = ctx.params as { sessionId: string };
        await deps.skillGenerator.cancelSession(sessionId);
        return { cancelled: true };
      },
    },

    // ─── Get skill UI schema ───
    {
      operationId: "skills.ui.get",
      method: "GET",
      path: "/v1/skills/:skillId/ui",
      auth: { public: false, anyOfScopes: ["skill.read"] },
      async handler(ctx): Promise<FridayGetSkillUiResponse> {
        const { skillId } = ctx.params as { skillId: string };

        const registered = deps.registry.get(skillId);
        if (!registered) {
          throw new FridayDomainError(
            "SKILL_NOT_FOUND",
            `Skill '${skillId}' not found`,
            { httpStatus: 404 },
          );
        }

        const uiPath = join(registered.skillDir, "skill.ui.json");
        if (!existsSync(uiPath)) {
          throw new FridayDomainError(
            "SKILL_UI_NOT_FOUND",
            `No UI schema found for skill '${skillId}'`,
            { httpStatus: 404 },
          );
        }

        let content: string;
        try {
          content = readFileSync(uiPath, "utf-8");
        } catch (err) {
          throw new FridayDomainError(
            "SKILL_UI_READ_ERROR",
            `Failed to read UI schema for skill '${skillId}'`,
            { httpStatus: 500, cause: err },
          );
        }

        let ui: FridaySkillUiSchemaV1;
        try {
          ui = JSON.parse(content) as FridaySkillUiSchemaV1;
        } catch (err) {
          throw new FridayDomainError(
            "SKILL_UI_PARSE_ERROR",
            `Failed to parse UI schema for skill '${skillId}': invalid JSON`,
            { httpStatus: 500, cause: err },
          );
        }
        return { ui };
      },
    },
  ];
}
