import type {
  FridayCanonicalApprovalResolution,
  FridayMutatingActionActor,
  FridayMutatingActionRequest,
} from "../../../security/friday-mutating-action-gate.js";
import {
  createFridaySkillStageMutatingActionRequest,
  type FridayConvertedSkillDraft,
  type FridaySkillConversionSource,
} from "#skills/converter";
import type {
  FridayGeneratedSkillDraft,
  FridaySkillGenerationSession,
} from "../model/friday-skill-generator.types.js";
import type { SkillManifestV2 } from "../../model/friday-skill-manifest-v2.types.js";

export const FRIDAY_SKILL_GENERATOR_CANDIDATE_CONVERTER_ID = "friday-skill-generator";

export function createFridayGeneratedSkillCandidateSource(input: {
  session: FridaySkillGenerationSession;
  draft: FridayGeneratedSkillDraft;
}): FridaySkillConversionSource {
  const payload = {
    schemaVersion: "friday.skill-generator.candidate-source.v1",
    sessionId: input.session.sessionId,
    userId: input.session.userId,
    channel: input.session.channel,
    goal: input.session.goal,
    skillId: input.draft.manifest.id,
    version: input.draft.manifest.version,
    manifest: input.draft.manifest,
    uiSchema: input.draft.uiSchema,
    files: input.draft.files.map((file) => ({
      path: file.path,
      content: file.content,
      executable: file.executable === true,
    })),
  };

  return {
    contentBase64: Buffer.from(JSON.stringify(payload)).toString("base64"),
    formatHint: "friday-package",
  };
}

export function createFridayGeneratedSkillCandidateDraft(input: {
  manifest: SkillManifestV2;
  draft: FridayGeneratedSkillDraft;
  convertedAt: string;
}): FridayConvertedSkillDraft {
  return {
    manifest: input.manifest,
    uiSchema: input.draft.uiSchema,
    files: [
      {
        path: "skill.manifest.json",
        content: JSON.stringify(input.manifest, null, 2),
      },
      {
        path: "skill.ui.json",
        content: JSON.stringify(input.draft.uiSchema, null, 2),
      },
      ...input.draft.files.map((file) => ({
        path: file.path,
        content: file.content,
        executable: file.executable === true,
      })),
    ],
    warnings: [],
    conversionReport: {
      sourceFormat: "friday-package",
      convertedAt: input.convertedAt,
      converterId: FRIDAY_SKILL_GENERATOR_CANDIDATE_CONVERTER_ID,
    },
  };
}

export function createFridaySkillGeneratorStageMutatingActionRequest(input: {
  session: FridaySkillGenerationSession;
  draft: FridayGeneratedSkillDraft;
  actor: FridayMutatingActionActor;
  surface: string;
  idempotencyKey?: string;
  planDigest?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}): FridayMutatingActionRequest {
  return createFridaySkillStageMutatingActionRequest({
    source: createFridayGeneratedSkillCandidateSource({
      session: input.session,
      draft: input.draft,
    }),
    actor: input.actor,
    surface: input.surface,
    idempotencyKey: input.idempotencyKey,
    planDigest: input.planDigest,
    canonicalApproval: input.canonicalApproval,
  });
}
