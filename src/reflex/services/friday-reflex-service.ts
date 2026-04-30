import { FridayDomainError } from "#errors";
import type { FridayLearningEventAppendInput } from "#ledger";
import type { FridayMemoryService } from "#memory";
import type { FridaySkillGeneratorService } from "#skills/generator";
import type { FridaySqliteLayer } from "#state";
import type { FridayWorkflowGeneratorService } from "#workflows";

import type { FridayUixUserPreferenceRepository } from "../../uix/persistence/friday-uix-user-preference-repository.js";
import type { JsonValue, FridayUserPreferenceCategory } from "../../uix/model/friday-uix.types.js";
import type {
  FridayReflexCandidate,
  FridayReflexCandidateInput,
  FridayReflexCandidateKind,
  FridayReflexCandidateStatus,
  FridayReflexOnboardingAnswer,
  FridayReflexOnboardingSession,
  FridayReflexQuestion,
  FridayReflexSurface,
} from "../model/friday-reflex.types.js";
import type { FridayReflexCandidateRepository } from "../persistence/friday-reflex-candidate-repository.js";
import type { FridayReflexOnboardingRepository } from "../persistence/friday-reflex-onboarding-repository.js";
import {
  FRIDAY_REFLEX_ONBOARDING_QUESTIONS,
  getFridayReflexQuestion,
  getNextFridayReflexQuestionId,
} from "./friday-reflex-question-registry.js";
import {
  isFridayReflexPreferenceKey,
  resolveFridayReflexOnboardingPreferenceWrites,
} from "./friday-reflex-preference-resolver.js";

const REFLEX_INTERNAL_CHANNEL = "reflex";
const REFLEX_RECIPE_NAMESPACE = "reflex.recipes";
const REFLEX_MEMORY_NAMESPACE = "reflex.memories";
const REFLEX_PREFERENCE_CATEGORIES = new Set<FridayUserPreferenceCategory>([
  "communication",
  "uix",
  "reflex",
]);

export interface FridayReflexOnboardingSnapshot {
  session: FridayReflexOnboardingSession | null;
  questions: readonly FridayReflexQuestion[];
  answers: FridayReflexOnboardingAnswer[];
  activeQuestion: FridayReflexQuestion | null;
  progress: {
    total: number;
    completed: number;
    answered: number;
    skipped: number;
  };
}

export interface FridayReflexRunCompletionInput {
  userId: string;
  runId?: string;
  sessionKey?: string;
  channelKind?: string;
  channelUserId?: string;
  task?: string;
  outcome: "success" | "failure" | "cancelled" | "unknown";
  toolSequence?: string[];
  toolFailures?: Array<{
    toolName: string;
    message?: string;
    code?: string;
  }>;
  artifacts?: Record<string, JsonValue>;
  feedback?: Record<string, JsonValue>;
}

export interface FridayReflexService {
  getOnboarding(userId: string): FridayReflexOnboardingSnapshot;
  markNewUserEligible(input: { userId: string }): FridayReflexOnboardingSnapshot;
  startOnboarding(input: {
    userId: string;
    primaryChannelKind?: string;
    primaryChannelUserId?: string;
  }): FridayReflexOnboardingSnapshot;
  answerOnboarding(input: {
    userId: string;
    questionId: string;
    answer: Record<string, JsonValue>;
    sourceSurface: FridayReflexSurface;
  }): FridayReflexOnboardingSnapshot;
  skipOnboarding(input: {
    userId: string;
    questionId: string;
    sourceSurface: FridayReflexSurface;
  }): FridayReflexOnboardingSnapshot;
  listCandidates(input: {
    userId: string;
    status?: FridayReflexCandidateStatus;
    kind?: FridayReflexCandidateKind;
    limit?: number;
  }): FridayReflexCandidate[];
  getCandidate(input: { userId: string; candidateId: string }): FridayReflexCandidate;
  createCandidate(input: FridayReflexCandidateInput): FridayReflexCandidate;
  testCandidate(input: {
    userId: string;
    candidateId: string;
    requestedModel?: string;
  }): Promise<FridayReflexCandidate>;
  approveCandidate(input: { userId: string; candidateId: string }): Promise<FridayReflexCandidate>;
  rejectCandidate(input: { userId: string; candidateId: string; reason?: string }): FridayReflexCandidate;
  dismissCandidate(input: { userId: string; candidateId: string; reason?: string }): FridayReflexCandidate;
  updatePreference(input: {
    userId: string;
    category: FridayUserPreferenceCategory;
    key: string;
    value: JsonValue;
    sourceSurface?: FridayReflexSurface;
  }): FridayPreferenceWriteResult;
  listPreferences(userId: string): FridayPreferenceWriteResult["preference"][];
  processRunCompletion(input: FridayReflexRunCompletionInput): Promise<FridayReflexCandidate[]>;
  curateCandidates(input?: { userId?: string }): FridayReflexCandidate[];
}

export interface FridayPreferenceWriteResult {
  preference: {
    id: string;
    principalId: string;
    category: FridayUserPreferenceCategory;
    key: string;
    value: JsonValue;
    source: "explicit" | "implicit";
    confidence: number;
    createdAt: string;
    updatedAt: string;
  };
  skippedBecauseExplicit?: boolean;
}

export interface CreateFridayReflexServiceDeps {
  db: FridaySqliteLayer;
  candidateRepo: FridayReflexCandidateRepository;
  onboardingRepo: FridayReflexOnboardingRepository;
  preferenceRepo: FridayUixUserPreferenceRepository;
  memoryService?: FridayMemoryService;
  skillGenerator?: FridaySkillGeneratorService;
  workflowGenerator?: FridayWorkflowGeneratorService;
  learningEventWriter?: (events: FridayLearningEventAppendInput[]) => void;
  idGenerator: () => string;
  nowIso: () => string;
  capabilities?: {
    reflexOnboardingEnabled?: boolean;
    reflexCandidatesEnabled?: boolean;
    reflexCuratorEnabled?: boolean;
    liveLlmReflexTestsEnabled?: boolean;
  };
}

function assertPrincipal(userId: string): void {
  if (!userId || userId.trim().length === 0) {
    throw new FridayDomainError(
      "REFLEX_PRINCIPAL_REQUIRED",
      "Reflex preferences require a bound Friday user. Complete channel binding first.",
      { httpStatus: 401 },
    );
  }
}

function assertJsonObject(value: unknown, label: string): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FridayDomainError(
      "REFLEX_VALIDATION_FAILED",
      `${label} must be an object.`,
      { httpStatus: 400 },
    );
  }
  return value as Record<string, JsonValue>;
}

function readPayloadString(
  payload: Record<string, JsonValue>,
  key: string,
): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function buildCandidateContent(candidate: FridayReflexCandidate): string {
  const content = readPayloadString(candidate.payload, "content")
    ?? readPayloadString(candidate.payload, "text")
    ?? readPayloadString(candidate.payload, "summary")
    ?? candidate.summary;
  return content.trim();
}

function validateOnboardingAnswer(question: FridayReflexQuestion, answer: Record<string, JsonValue>): void {
  const value = answer["value"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new FridayDomainError(
      "REFLEX_ONBOARDING_ANSWER_INVALID",
      `Question ${question.id} requires a selected answer value.`,
      { httpStatus: 400 },
    );
  }
  const allowed = question.options.some((option) => option.value === value);
  if (!allowed) {
    throw new FridayDomainError(
      "REFLEX_ONBOARDING_ANSWER_INVALID",
      `Question ${question.id} does not accept answer value '${value}'.`,
      { httpStatus: 400 },
    );
  }
  if (question.id === "O2" && value === "custom") {
    const text = answer["text"];
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new FridayDomainError(
        "REFLEX_ONBOARDING_ANSWER_INVALID",
        "Question O2 custom answer requires a name.",
        { httpStatus: 400 },
      );
    }
  }
}

function assertPreferenceTarget(write: {
  category: FridayUserPreferenceCategory;
  key: string;
  value: JsonValue;
}): void {
  if (!REFLEX_PREFERENCE_CATEGORIES.has(write.category)) {
    throw new FridayDomainError(
      "REFLEX_PREFERENCE_INVALID",
      `Unsupported preference category: ${write.category}`,
      { httpStatus: 400 },
    );
  }
  if (write.category === "reflex" && !isFridayReflexPreferenceKey(write.key)) {
    throw new FridayDomainError(
      "REFLEX_PREFERENCE_INVALID",
      `Unsupported reflex preference: ${write.key}`,
      { httpStatus: 400 },
    );
  }
}

function buildPreferenceEvent(input: {
  eventId: string;
  ts: string;
  userId: string;
  category: string;
  key: string;
  value: JsonValue;
  sourceSurface?: FridayReflexSurface;
}): FridayLearningEventAppendInput {
  return {
    eventId: input.eventId,
    ts: input.ts,
    userId: input.userId,
    kind: "user_correction",
    payload: {
      feedbackKind: "preference",
      correctedField: input.key,
      newValue: input.value,
      field: input.key,
      category: input.category,
      sourceSurface: input.sourceSurface ?? "operate",
      context: `Preference set through Friday Reflex: ${input.category}/${input.key}`,
    },
  };
}

export function createFridayReflexService(
  deps: CreateFridayReflexServiceDeps,
): FridayReflexService {
  const onboardingEnabled = deps.capabilities?.reflexOnboardingEnabled ?? true;
  const candidatesEnabled = deps.capabilities?.reflexCandidatesEnabled ?? true;
  const curatorEnabled = deps.capabilities?.reflexCuratorEnabled ?? true;

  function emitLearning(events: FridayLearningEventAppendInput[]): void {
    if (!deps.learningEventWriter || events.length === 0) return;
    deps.learningEventWriter(events);
  }

  function writePreference(input: {
    userId: string;
    category: FridayUserPreferenceCategory;
    key: string;
    value: JsonValue;
    source: "explicit" | "implicit";
    confidence: number;
    sourceSurface?: FridayReflexSurface;
    preserveExplicit?: boolean;
  }): FridayPreferenceWriteResult {
    assertPrincipal(input.userId);
    assertPreferenceTarget({ category: input.category, key: input.key, value: input.value });
    const now = deps.nowIso();
    const result = deps.db.withWriteTransaction((db) => {
      const existing = deps.preferenceRepo
        .listByPrincipal(db, { principalId: input.userId, category: input.category })
        .find((preference) => preference.key === input.key);
      if (input.preserveExplicit && existing?.source === "explicit") {
        return { preference: existing, skippedBecauseExplicit: true };
      }
      const preference = deps.preferenceRepo.upsert(db, {
        id: existing?.id ?? deps.idGenerator(),
        principalId: input.userId,
        category: input.category,
        key: input.key,
        value: input.value,
        source: input.source,
        confidence: input.confidence,
        nowIso: now,
      });
      return { preference };
    });

    if (!result.skippedBecauseExplicit && input.source === "explicit") {
      emitLearning([
        buildPreferenceEvent({
          eventId: deps.idGenerator(),
          ts: now,
          userId: input.userId,
          category: input.category,
          key: input.key,
          value: input.value,
          sourceSurface: input.sourceSurface,
        }),
      ]);
    }
    return result;
  }

  function loadOnboardingSnapshot(userId: string): FridayReflexOnboardingSnapshot {
    assertPrincipal(userId);
    return deps.db.withReadConnection((db) => {
      const session = deps.onboardingRepo.getSessionByUser(db, userId);
      const answers = session
        ? deps.onboardingRepo.listAnswers(db, { sessionId: session.id })
        : [];
      const activeQuestion = session?.activeQuestionId
        ? getFridayReflexQuestion(session.activeQuestionId) ?? null
        : null;
      const answered = answers.filter((answer) => answer.status === "answered").length;
      const skipped = answers.filter((answer) => answer.status === "skipped").length;
      return {
        session,
        questions: FRIDAY_REFLEX_ONBOARDING_QUESTIONS,
        answers,
        activeQuestion,
        progress: {
          total: FRIDAY_REFLEX_ONBOARDING_QUESTIONS.length,
          completed: answered + skipped,
          answered,
          skipped,
        },
      };
    });
  }

  function applyOnboardingAnswer(input: {
    userId: string;
    questionId: string;
    status: "answered" | "skipped";
    answer: Record<string, JsonValue>;
    sourceSurface: FridayReflexSurface;
  }): FridayReflexOnboardingSnapshot {
    if (!onboardingEnabled) {
      throw new FridayDomainError(
        "REFLEX_ONBOARDING_DISABLED",
        "Reflex onboarding is disabled in this runtime.",
        { httpStatus: 503 },
      );
    }
    assertPrincipal(input.userId);
    const question = getFridayReflexQuestion(input.questionId);
    if (!question) {
      throw new FridayDomainError(
        "REFLEX_ONBOARDING_QUESTION_NOT_FOUND",
        `Unknown onboarding question: ${input.questionId}`,
        { httpStatus: 404 },
      );
    }
    if (input.status === "answered") {
      validateOnboardingAnswer(question, input.answer);
    }

    const events: FridayLearningEventAppendInput[] = [];
    deps.db.withWriteTransaction((db) => {
      const session = deps.onboardingRepo.getSessionByUser(db, input.userId);
      if (!session) {
        throw new FridayDomainError(
          "REFLEX_ONBOARDING_NOT_STARTED",
          "Reflex onboarding has not started for this user.",
          { httpStatus: 404 },
        );
      }
      const existingAnswers = deps.onboardingRepo.listAnswers(db, { sessionId: session.id });
      const existing = existingAnswers.find((answer) => answer.questionId === input.questionId);
      if (
        existing?.status === "skipped"
        && input.status === "answered"
        && input.sourceSurface !== "review_center"
      ) {
        throw new FridayDomainError(
          "REFLEX_ONBOARDING_SKIPPED_LOCKED",
          "Skipped onboarding answers can only be filled from Review Center.",
          { httpStatus: 409 },
        );
      }
      if (
        input.sourceSurface !== "review_center"
        && session.status === "active"
        && session.activeQuestionId
        && session.activeQuestionId !== input.questionId
      ) {
        throw new FridayDomainError(
          "REFLEX_ONBOARDING_STALE_QUESTION",
          `Question ${input.questionId} is no longer active.`,
          { httpStatus: 409 },
        );
      }

      const now = deps.nowIso();
      deps.onboardingRepo.upsertAnswer(db, {
        id: existing?.id ?? deps.idGenerator(),
        sessionId: session.id,
        userId: input.userId,
        questionId: input.questionId,
        status: input.status,
        answer: input.answer,
        sourceSurface: input.sourceSurface,
        nowIso: now,
      });

      if (input.status === "answered") {
        for (const write of resolveFridayReflexOnboardingPreferenceWrites({
          questionId: input.questionId,
          answer: input.answer,
        })) {
          assertPreferenceTarget(write);
          const existingPreference = deps.preferenceRepo
            .listByPrincipal(db, { principalId: input.userId, category: write.category })
            .find((preference) => preference.key === write.key);
          deps.preferenceRepo.upsert(db, {
            id: existingPreference?.id ?? deps.idGenerator(),
            principalId: input.userId,
            category: write.category,
            key: write.key,
            value: write.value,
            source: "explicit",
            confidence: 1,
            nowIso: now,
          });
          events.push(buildPreferenceEvent({
            eventId: deps.idGenerator(),
            ts: now,
            userId: input.userId,
            category: write.category,
            key: write.key,
            value: write.value,
            sourceSurface: input.sourceSurface,
          }));
        }
      }

      const refreshedAnswers = deps.onboardingRepo.listAnswers(db, { sessionId: session.id });
      const completedQuestionIds = new Set(refreshedAnswers.map((answer) => answer.questionId));
      const nextQuestionId = getNextFridayReflexQuestionId(completedQuestionIds);
      deps.onboardingRepo.updateSession(db, {
        userId: input.userId,
        status: nextQuestionId ? "active" : "completed",
        activeQuestionId: nextQuestionId,
        nowIso: now,
      });
    });

    emitLearning(events);
    return loadOnboardingSnapshot(input.userId);
  }

  function updateCandidateStatus(input: {
    userId: string;
    candidateId: string;
    status: FridayReflexCandidateStatus;
    evidence?: Record<string, JsonValue>;
  }): FridayReflexCandidate {
    const now = deps.nowIso();
    try {
      const candidate = deps.db.withWriteTransaction((db) =>
        deps.candidateRepo.updateStatus(db, {
          userId: input.userId,
          id: input.candidateId,
          status: input.status,
          evidence: input.evidence,
          nowIso: now,
        }));
      if (!candidate) {
        throw new FridayDomainError(
          "REFLEX_CANDIDATE_NOT_FOUND",
          `Reflex candidate '${input.candidateId}' was not found.`,
          { httpStatus: 404 },
        );
      }
      return candidate;
    } catch (err) {
      if (err instanceof FridayDomainError) throw err;
      throw new FridayDomainError(
        "REFLEX_CANDIDATE_TRANSITION_INVALID",
        err instanceof Error ? err.message : "Invalid reflex candidate status transition.",
        { httpStatus: 409 },
      );
    }
  }

  async function generateSkillDraft(
    candidate: FridayReflexCandidate,
    requestedModel?: string,
  ): Promise<Record<string, JsonValue>> {
    if (!deps.skillGenerator) {
      throw new FridayDomainError(
        "REFLEX_SKILL_GENERATOR_UNAVAILABLE",
        "Skill generator is not available in this runtime.",
        { httpStatus: 503 },
      );
    }
    const goal = readPayloadString(candidate.payload, "goal")
      ?? candidate.summary
      ?? candidate.title;
    const started = await deps.skillGenerator.startSession({
      goal,
      requestedModel: requestedModel ?? readPayloadString(candidate.payload, "requestedModel"),
      userId: candidate.userId,
      channel: REFLEX_INTERNAL_CHANNEL,
    });
    const draft = await deps.skillGenerator.generateDraft(
      started.session.sessionId,
      requestedModel ?? readPayloadString(candidate.payload, "requestedModel"),
    );
    const qaVerdict = await deps.skillGenerator.getQaVerdict(started.session.sessionId);
    const harness = await deps.skillGenerator.getHarnessSummary(started.session.sessionId);
    return {
      generatorSessionId: started.session.sessionId,
      mode: started.mode,
      draftSkillId: draft.manifest.id,
      draftName: draft.manifest.name,
      validationOk: draft.validation.ok,
      validation: draft.validation as unknown as JsonValue,
      qaVerdict: qaVerdict as unknown as JsonValue,
      harness: harness as unknown as JsonValue,
    };
  }

  async function generateWorkflowDraft(
    candidate: FridayReflexCandidate,
    requestedModel?: string,
  ): Promise<Record<string, JsonValue>> {
    if (!deps.workflowGenerator) {
      throw new FridayDomainError(
        "REFLEX_WORKFLOW_GENERATOR_UNAVAILABLE",
        "Workflow generator is not available in this runtime.",
        { httpStatus: 503 },
      );
    }
    const goal = readPayloadString(candidate.payload, "goal")
      ?? candidate.summary
      ?? candidate.title;
    const started = await deps.workflowGenerator.startSession({
      goal,
      requestedModel: requestedModel ?? readPayloadString(candidate.payload, "requestedModel"),
      userId: candidate.userId,
      channel: REFLEX_INTERNAL_CHANNEL,
    });
    const draft = await deps.workflowGenerator.generateDraft(
      started.session.sessionId,
      requestedModel ?? readPayloadString(candidate.payload, "requestedModel"),
    );
    const qaVerdict = await deps.workflowGenerator.getQaVerdict(started.session.sessionId);
    const harness = await deps.workflowGenerator.getHarnessSummary(started.session.sessionId);
    return {
      generatorSessionId: started.session.sessionId,
      mode: started.mode,
      draftWorkflowId: draft.spec.workflowId,
      draftName: draft.spec.name,
      validationOk: draft.validation.ok,
      validation: draft.validation as unknown as JsonValue,
      qaVerdict: qaVerdict as unknown as JsonValue,
      harness: harness as unknown as JsonValue,
    };
  }

  async function approveGeneratedCandidate(candidate: FridayReflexCandidate): Promise<Record<string, JsonValue>> {
    const sessionId = readPayloadString(candidate.evidence, "generatorSessionId");
    if (!sessionId) {
      throw new FridayDomainError(
        "REFLEX_CANDIDATE_REQUIRES_TEST",
        "Skill and workflow candidates must be tested into a draft before approval.",
        { httpStatus: 409 },
      );
    }
    if (candidate.kind === "skill") {
      if (!deps.skillGenerator) {
        throw new FridayDomainError(
          "REFLEX_SKILL_GENERATOR_UNAVAILABLE",
          "Skill generator is not available in this runtime.",
          { httpStatus: 503 },
        );
      }
      const saved = await deps.skillGenerator.approveAndSave(sessionId);
      return {
        savedSkillId: saved.skillId,
        skillDir: saved.skillDir,
        savedFiles: saved.savedFiles,
        registryRefreshed: saved.registryRefreshed,
        promotionStage: saved.promotionStage,
      };
    }
    if (candidate.kind === "workflow") {
      if (!deps.workflowGenerator) {
        throw new FridayDomainError(
          "REFLEX_WORKFLOW_GENERATOR_UNAVAILABLE",
          "Workflow generator is not available in this runtime.",
          { httpStatus: 503 },
        );
      }
      const saved = await deps.workflowGenerator.approveAndSave(sessionId);
      return {
        savedWorkflowId: saved.workflowId,
        workflowVersionId: saved.workflowVersionId,
        versionNumber: saved.versionNumber,
        slug: saved.slug,
        published: saved.published,
      };
    }
    return {};
  }

  return {
    getOnboarding(userId) {
      return loadOnboardingSnapshot(userId);
    },

    markNewUserEligible(input) {
      if (!onboardingEnabled) {
        throw new FridayDomainError(
          "REFLEX_ONBOARDING_DISABLED",
          "Reflex onboarding is disabled in this runtime.",
          { httpStatus: 503 },
        );
      }
      assertPrincipal(input.userId);
      deps.db.withWriteTransaction((db) => {
        const existing = deps.onboardingRepo.getSessionByUser(db, input.userId);
        if (existing) return existing;
        return deps.onboardingRepo.createSession(db, {
          id: deps.idGenerator(),
          userId: input.userId,
          status: "not_started",
          activeQuestionId: null,
          nowIso: deps.nowIso(),
        });
      });
      return loadOnboardingSnapshot(input.userId);
    },

    startOnboarding(input) {
      if (!onboardingEnabled) {
        throw new FridayDomainError(
          "REFLEX_ONBOARDING_DISABLED",
          "Reflex onboarding is disabled in this runtime.",
          { httpStatus: 503 },
        );
      }
      assertPrincipal(input.userId);
      deps.db.withWriteTransaction((db) => {
        const existing = deps.onboardingRepo.getSessionByUser(db, input.userId);
        if (existing) {
          if (existing.status === "not_started") {
            return deps.onboardingRepo.updateSession(db, {
              userId: input.userId,
              status: "active",
              activeQuestionId: FRIDAY_REFLEX_ONBOARDING_QUESTIONS[0]?.id ?? null,
              primaryChannelKind: input.primaryChannelKind,
              primaryChannelUserId: input.primaryChannelUserId,
              nowIso: deps.nowIso(),
            });
          }
          return existing;
        }
        return deps.onboardingRepo.createSession(db, {
          id: deps.idGenerator(),
          userId: input.userId,
          activeQuestionId: FRIDAY_REFLEX_ONBOARDING_QUESTIONS[0]?.id ?? null,
          primaryChannelKind: input.primaryChannelKind,
          primaryChannelUserId: input.primaryChannelUserId,
          nowIso: deps.nowIso(),
        });
      });
      return loadOnboardingSnapshot(input.userId);
    },

    answerOnboarding(input) {
      return applyOnboardingAnswer({
        userId: input.userId,
        questionId: input.questionId,
        status: "answered",
        answer: assertJsonObject(input.answer, "answer"),
        sourceSurface: input.sourceSurface,
      });
    },

    skipOnboarding(input) {
      return applyOnboardingAnswer({
        userId: input.userId,
        questionId: input.questionId,
        status: "skipped",
        answer: {},
        sourceSurface: input.sourceSurface,
      });
    },

    listCandidates(input) {
      assertPrincipal(input.userId);
      return deps.db.withReadConnection((db) => deps.candidateRepo.list(db, input));
    },

    getCandidate(input) {
      assertPrincipal(input.userId);
      const candidate = deps.db.withReadConnection((db) =>
        deps.candidateRepo.getById(db, { userId: input.userId, id: input.candidateId }));
      if (!candidate) {
        throw new FridayDomainError(
          "REFLEX_CANDIDATE_NOT_FOUND",
          `Reflex candidate '${input.candidateId}' was not found.`,
          { httpStatus: 404 },
        );
      }
      return candidate;
    },

    createCandidate(input) {
      if (!candidatesEnabled) {
        throw new FridayDomainError(
          "REFLEX_CANDIDATES_DISABLED",
          "Reflex candidates are disabled in this runtime.",
          { httpStatus: 503 },
        );
      }
      assertPrincipal(input.userId);
      return deps.db.withWriteTransaction((db) =>
        deps.candidateRepo.insert(db, {
          ...input,
          id: deps.idGenerator(),
          nowIso: deps.nowIso(),
        }));
    },

    async testCandidate(input) {
      const candidate = this.getCandidate(input);
      const testing = updateCandidateStatus({
        userId: input.userId,
        candidateId: input.candidateId,
        status: "testing",
        evidence: { testStartedAt: deps.nowIso() },
      });
      try {
        let evidence: Record<string, JsonValue>;
        if (testing.kind === "skill") {
          evidence = await generateSkillDraft(testing, input.requestedModel);
        } else if (testing.kind === "workflow") {
          evidence = await generateWorkflowDraft(testing, input.requestedModel);
        } else {
          evidence = {
            deterministicReview: true,
            checkedAt: deps.nowIso(),
            constraints: [
              "candidate state machine remained valid",
              "approval boundary preserved",
            ],
          };
        }
        const status = evidence.validationOk === false ? "failed" : "ready_for_review";
        return updateCandidateStatus({
          userId: input.userId,
          candidateId: candidate.id,
          status,
          evidence: {
            ...evidence,
            testCompletedAt: deps.nowIso(),
          },
        });
      } catch (err) {
        return updateCandidateStatus({
          userId: input.userId,
          candidateId: candidate.id,
          status: "failed",
          evidence: {
            testFailedAt: deps.nowIso(),
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    },

    async approveCandidate(input) {
      const candidate = this.getCandidate(input);
      let evidence: Record<string, JsonValue> = {
        approvedBy: input.userId,
        approvedAt: deps.nowIso(),
      };
      try {
        if (candidate.kind === "memory") {
          if (!deps.memoryService) {
            throw new FridayDomainError(
              "REFLEX_MEMORY_UNAVAILABLE",
              "Memory service is not available in this runtime.",
              { httpStatus: 503 },
            );
          }
          const stored = await deps.memoryService.store(
            readPayloadString(candidate.payload, "namespace") ?? REFLEX_MEMORY_NAMESPACE,
            buildCandidateContent(candidate),
            {
              source: "reflex_candidate",
              key: candidate.id,
              tags: ["reflex", candidate.userId, candidate.kind],
              metadata: {
                candidateId: candidate.id,
                origin: candidate.origin,
                evidence: candidate.evidence,
              },
              confidence: candidate.confidence,
            },
          );
          evidence = { ...evidence, memoryItemId: stored.id };
        } else if (candidate.kind === "recipe") {
          if (!deps.memoryService) {
            throw new FridayDomainError(
              "REFLEX_MEMORY_UNAVAILABLE",
              "Memory service is not available in this runtime.",
              { httpStatus: 503 },
            );
          }
          const stored = await deps.memoryService.store(
            REFLEX_RECIPE_NAMESPACE,
            buildCandidateContent(candidate),
            {
              source: "reflex_recipe",
              key: candidate.id,
              tags: ["reflex", candidate.userId, "recipe"],
              metadata: {
                candidateId: candidate.id,
                origin: candidate.origin,
                toolSequence: candidate.evidence.toolSequence,
              },
              confidence: candidate.confidence,
            },
          );
          evidence = { ...evidence, recipeMemoryItemId: stored.id };
        } else if (candidate.kind === "preference") {
          const category = readPayloadString(candidate.payload, "category") as FridayUserPreferenceCategory | undefined;
          const key = readPayloadString(candidate.payload, "key");
          const value = candidate.payload["value"];
          if (!category || !key || value === undefined) {
            throw new FridayDomainError(
              "REFLEX_PREFERENCE_INVALID",
              "Preference candidate payload requires category, key, and value.",
              { httpStatus: 400 },
            );
          }
          const result = writePreference({
            userId: candidate.userId,
            category,
            key,
            value,
            source: "implicit",
            confidence: candidate.confidence,
            preserveExplicit: true,
            sourceSurface: "review_center",
          });
          evidence = {
            ...evidence,
            preferenceId: result.preference.id,
            skippedBecauseExplicit: result.skippedBecauseExplicit ?? false,
          };
        } else if (candidate.kind === "skill" || candidate.kind === "workflow") {
          evidence = { ...evidence, ...(await approveGeneratedCandidate(candidate)) };
        } else {
          evidence = {
            ...evidence,
            approvedPolicy: true,
          };
        }
        return updateCandidateStatus({
          userId: input.userId,
          candidateId: input.candidateId,
          status: "approved",
          evidence,
        });
      } catch (err) {
        return updateCandidateStatus({
          userId: input.userId,
          candidateId: input.candidateId,
          status: "failed",
          evidence: {
            ...evidence,
            approvalFailedAt: deps.nowIso(),
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    },

    rejectCandidate(input) {
      return updateCandidateStatus({
        userId: input.userId,
        candidateId: input.candidateId,
        status: "rejected",
        evidence: {
          rejectedBy: input.userId,
          rejectedAt: deps.nowIso(),
          ...(input.reason ? { reason: input.reason } : {}),
        },
      });
    },

    dismissCandidate(input) {
      return updateCandidateStatus({
        userId: input.userId,
        candidateId: input.candidateId,
        status: "dismissed",
        evidence: {
          dismissedBy: input.userId,
          dismissedAt: deps.nowIso(),
          ...(input.reason ? { reason: input.reason } : {}),
        },
      });
    },

    updatePreference(input) {
      return writePreference({
        ...input,
        source: "explicit",
        confidence: 1,
      });
    },

    listPreferences(userId) {
      assertPrincipal(userId);
      return deps.db.withReadConnection((db) =>
        deps.preferenceRepo.listByPrincipal(db, { principalId: userId }));
    },

    async processRunCompletion(input) {
      if (!candidatesEnabled || !input.userId) return [];
      assertPrincipal(input.userId);
      const created: FridayReflexCandidate[] = [];
      const toolSequence = input.toolSequence ?? [];
      if (input.outcome === "success" && toolSequence.length >= 2) {
        created.push(this.createCandidate({
          userId: input.userId,
          kind: "recipe",
          origin: "post_run",
          sourceRunId: input.runId,
          sessionKey: input.sessionKey,
          channelKind: input.channelKind,
          channelUserId: input.channelUserId,
          title: input.task ? `Reusable path: ${input.task.slice(0, 80)}` : "Reusable successful path",
          summary: input.task
            ? `Friday completed this task with ${toolSequence.length} reusable steps.`
            : `Friday completed a task with ${toolSequence.length} reusable steps.`,
          payload: {
            content: [
              input.task ? `Task: ${input.task}` : "Task: unknown",
              `Outcome: ${input.outcome}`,
              `Tools: ${toolSequence.join(" -> ")}`,
            ].join("\n"),
          },
          evidence: {
            toolSequence,
            artifacts: input.artifacts ?? {},
            feedback: input.feedback ?? {},
          },
          confidence: 0.72,
          riskTier: 1,
        }));
      }
      if (input.outcome === "failure" && (input.toolFailures?.length ?? 0) > 0) {
        const failure = input.toolFailures![0]!;
        created.push(this.createCandidate({
          userId: input.userId,
          kind: "fix",
          origin: "post_run",
          sourceRunId: input.runId,
          sessionKey: input.sessionKey,
          channelKind: input.channelKind,
          channelUserId: input.channelUserId,
          title: `Fix candidate: ${failure.toolName}`,
          summary: failure.message ?? "A tool failed during the run and may need a reusable fix.",
          payload: {
            toolName: failure.toolName,
            message: failure.message ?? "",
            code: failure.code ?? "",
          },
          evidence: {
            toolSequence,
            failures: input.toolFailures as unknown as JsonValue,
          },
          confidence: 0.66,
          riskTier: 2,
        }));
      }
      return created;
    },

    curateCandidates(input) {
      if (!curatorEnabled) return [];
      const statuses: FridayReflexCandidateStatus[] = ["proposed", "ready_for_review", "failed"];
      const candidates = deps.db.withReadConnection((db) => {
        const collected: FridayReflexCandidate[] = [];
        const userIds = input?.userId
          ? [input.userId]
          : (db.prepare(
            `SELECT DISTINCT user_id
             FROM friday_reflex_candidates`,
          ).all() as Array<{ user_id: string }>).map((row) => row.user_id);
        for (const status of statuses) {
          for (const userId of userIds) {
            collected.push(...deps.candidateRepo.list(db, {
              userId,
              status,
              limit: 200,
            }));
          }
        }
        return collected;
      });
      const seen = new Set<string>();
      const superseded: FridayReflexCandidate[] = [];
      for (const candidate of candidates) {
        const key = `${candidate.userId}:${candidate.kind}:${candidate.title}:${JSON.stringify(candidate.payload)}`;
        if (!seen.has(key)) {
          seen.add(key);
          continue;
        }
        superseded.push(updateCandidateStatus({
          userId: candidate.userId,
          candidateId: candidate.id,
          status: "superseded",
          evidence: {
            supersededByCuratorAt: deps.nowIso(),
            reason: "Duplicate reflex candidate",
          },
        }));
      }
      return superseded;
    },
  };
}
