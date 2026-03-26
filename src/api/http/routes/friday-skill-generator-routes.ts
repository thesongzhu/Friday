import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import { FridayDomainError } from "#errors";

import type { FridaySkillGeneratorService } from "#skills/generator";
import type { FridaySkillRegistry } from "#skills";
import type { FridaySkillUiSchemaV1 } from "#skills/generator";
import { loadFridaySkillPackage, validateFridaySkillPackage } from "#skills";
import type { FridaySelfHealingApiService } from "#learning";
import type { FridayObservabilityApiService } from "../../../observability/services/friday-observability-api-service.js";

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
        };
      }

      const validation = validateFridaySkillPackage({
        loaded: loaded.value,
        workspaceDir: root,
        hubVersion: GENERATED_SKILL_HUB_VERSION,
        supportedApiVersions: GENERATED_SKILL_SUPPORTED_API_VERSIONS,
      });

      return {
        ok: validation.ok,
        executable: validation.ok,
        issues: validation.issues.map((issue) => ({
          code: issue.code,
          severity: issue.severity,
          message: issue.message,
          path: issue.path,
        })),
        durationMs: Date.now() - startedAt,
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
    const test = draft ? await runDraftSelfTest(sessionId) : null;
    const approvalReadiness = draft
      ? {
        ready: draft.validation.ok && (test?.ok ?? false),
        reason: draft.validation.ok
          ? test?.ok
            ? "Draft passed validation and explicit self-test"
            : "Draft still needs to pass explicit self-test"
          : "Draft has validation issues that must be fixed before approval",
      }
      : {
        ready: false,
        reason: "No draft has been generated yet",
      };

    return {
      sessionId,
      validationSummary: {
        ok: draft?.validation.ok ?? false,
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
        const result = await deps.skillGenerator.startSession({
          goal: body.goal,
          requestedModel: body.requestedModel,
          userId: body.userId,
          channel: body.channel,
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
        const evidence = await buildEvidence(sessionId);
        const result = await deps.skillGenerator.approveAndSave(sessionId);
        await deps.observability?.recordSkillGeneratorEvent({
          sessionId,
          userId: "operator",
          event: "draft_saved",
          summary: `Saved generated skill ${result.skillId}`,
          ok: true,
        });
        return {
          ...result,
          evidence,
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
