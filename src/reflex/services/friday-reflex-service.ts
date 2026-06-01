import { FridayDomainError } from "#errors";
import type { FridayLearningEventAppendInput } from "#ledger";
import type { FridayMemoryService } from "#memory";
import type { FridaySkillGeneratorService } from "#skills/generator";
import type { FridaySqliteLayer } from "#state";
import type { FridayWorkflowGeneratorService } from "#workflows";

import { isFridaySensitiveLearningCandidate } from "../../learning/services/friday-sensitive-learning-guard.js";
import type { FridayUixUserPreferenceRepository } from "../../uix/persistence/friday-uix-user-preference-repository.js";
import type { FridayUserPreferenceCategory, JsonValue } from "../../uix/model/friday-uix.types.js";
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
import { requiresFridayReflexPreferenceConfirmation } from "./friday-reflex-preference-sensitivity.js";

const REFLEX_INTERNAL_CHANNEL = "reflex";
const REFLEX_RECIPE_NAMESPACE = "reflex.recipes";
const REFLEX_MEMORY_NAMESPACE = "reflex.memories";
const REFLEX_CURATOR_METADATA_VERSION = 1;
const REFLEX_CURATOR_STALE_DAYS = 14;
const REFLEX_CURATOR_FAILED_STALE_DAYS = 7;
const LEARNED_FACT_TASK_MAX_LENGTH = 500;
const LEARNED_FACT_VALUE_MAX_LENGTH = 160;
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
  requestPreferenceUpdate(input: {
    userId: string;
    category: FridayUserPreferenceCategory;
    key: string;
    value: JsonValue;
    sourceSurface?: FridayReflexSurface;
  }): FridayPreferenceRequestResult;
  revokePreference(input: {
    userId: string;
    preferenceId: string;
    sourceSurface?: FridayReflexSurface;
  }): FridayPreferenceRevokeResult;
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

export type FridayPreferenceRequestResult =
  | ({ requiresConfirmation: false } & FridayPreferenceWriteResult)
  | {
      requiresConfirmation: true;
      candidate: FridayReflexCandidate;
    };

type FridayReflexDb = Parameters<FridayReflexCandidateRepository["list"]>[0];

export interface FridayPreferenceRevokeResult {
  revoked: true;
  preference: FridayPreferenceWriteResult["preference"];
}

export interface FridayReflexLearnedFactApprovalResult {
  factId?: string;
  key: string;
  confidence: number;
  evidenceCount: number;
  lastConfirmedAt: string;
}

export interface CreateFridayReflexServiceDeps {
  db: FridaySqliteLayer;
  candidateRepo: FridayReflexCandidateRepository;
  onboardingRepo: FridayReflexOnboardingRepository;
  preferenceRepo: FridayUixUserPreferenceRepository;
  memoryService?: FridayMemoryService;
  learnedFactApprover?: (input: {
    userId: string;
    key: string;
    value: JsonValue;
    confidence: number;
    candidateId: string;
    origin: string;
    sourceRunId?: string;
    sessionKey?: string;
    nowIso: string;
    evidence: Record<string, JsonValue>;
  }) => FridayReflexLearnedFactApprovalResult;
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

function cleanLearnedFactValue(value: string): string {
  return value
    .replace(/[。.!！?？]+$/u, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LEARNED_FACT_VALUE_MAX_LENGTH)
    .trim();
}

function learnedFactSubjectSlug(subject: string): string | null {
  const cleaned = subject
    .replace(/^(?:my|our|the|this|a|an)\s+/iu, "")
    .replace(/^(?:我的|我们的|这个|本项目|项目)/u, "")
    .trim();
  const slug = cleaned
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/giu, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_")
    .slice(0, 64)
    .replace(/_+$/g, "");
  return slug.length >= 2 ? slug : null;
}

function extractLearnedFactFromRunTask(task: string | undefined): {
  key: string;
  value: JsonValue;
  statement: string;
  subject: string;
} | null {
  const text = task?.trim().slice(0, LEARNED_FACT_TASK_MAX_LENGTH) ?? "";
  if (!text) return null;
  if (/(?:do not|don't|dont|never|不要|别|不用|不许).{0,40}(?:remember|learn|record|store|记住|学习|保存)/iu.test(text)) {
    return null;
  }
  if (isFridaySensitiveLearningCandidate(text)) return null;

  const english = /(?:remember|learn|note|record|for future reference)[,:]?\s+(?:that\s+)?((?:my|our|the|this|a|an)\s+[^.!?;\n:=]{2,80}?)\s+(?:is|are|=|:)\s+([^.!?;\n]{1,160})/iu.exec(text);
  const chinese = /(?:请记住|记住|学习|以后记得|以后请记得)[:：]?\s*((?:我的|我们的|这个|本项目|项目)?[^，。！？\n:=：]{2,50}?)(?:是|为|=|：|:)\s*([^，。！？\n]{1,120})/u.exec(text);
  const subject = (english?.[1] ?? chinese?.[1] ?? "").trim();
  const value = cleanLearnedFactValue(english?.[2] ?? chinese?.[2] ?? "");
  if (!subject || !value) return null;
  if (isFridaySensitiveLearningCandidate(subject, value)) return null;
  const slug = learnedFactSubjectSlug(subject);
  if (!slug) return null;
  return {
    key: `learned.${slug}`,
    value,
    statement: `${subject} = ${value}`,
    subject,
  };
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

function normalizeReflexTaskSignature(task: string | undefined, toolSequence: string[]): string {
  const normalizedTask = (task ?? "unknown")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return JSON.stringify({
    task: normalizedTask,
    tools: toolSequence.map((tool) => tool.toLowerCase().trim()).filter(Boolean),
  });
}

function readIsoMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readEvidenceString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function candidateHasGeneratedDraft(candidate: FridayReflexCandidate): boolean {
  return Boolean(readEvidenceString(candidate.evidence.draftSkillId) || readEvidenceString(candidate.evidence.draftWorkflowId));
}

function candidateHasCompletedTest(candidate: FridayReflexCandidate): boolean {
  return Boolean(readEvidenceString(candidate.evidence.testCompletedAt) || candidate.evidence.deterministicReview === true);
}

function resolveCuratorRecommendedAction(input: {
  candidate: FridayReflexCandidate;
  duplicateOf?: string;
  hasFailedTest: boolean;
  stale: boolean;
  tested: boolean;
}): string {
  if (input.duplicateOf) return "superseded";
  if (input.candidate.status === "failed" || input.hasFailedTest) return "diagnose_or_retest";
  if ((input.candidate.kind === "skill" || input.candidate.kind === "workflow") && !input.tested) {
    return "test_before_review";
  }
  if (input.stale) return "review_or_dismiss";
  return "review";
}

function resolveCuratorReviewReason(input: {
  candidate: FridayReflexCandidate;
  duplicateOf?: string;
  hasFailedTest: boolean;
}): string {
  if (input.duplicateOf) {
    return "Curator found an exact duplicate candidate; keep the earlier candidate and do not ask the user twice.";
  }
  if (input.candidate.status === "failed" || input.hasFailedTest) {
    return "This candidate has failed evidence; diagnose or retest before any approval.";
  }
  if (input.candidate.kind === "skill" || input.candidate.kind === "workflow") {
    return "Friday saw a reusable pattern, but executable candidates stay draft-only until test evidence and Review Center approval.";
  }
  return "Friday found a reusable learning candidate; review it before it changes memory, preferences, recipes, skills, or workflows.";
}

function buildCuratorReviewMetadata(input: {
  candidate: FridayReflexCandidate;
  nowIso: string;
  duplicateOf?: string;
}): Record<string, JsonValue> {
  const { candidate } = input;
  const nowMs = readIsoMs(input.nowIso) ?? Date.now();
  const createdMs = readIsoMs(candidate.createdAt) ?? readIsoMs(candidate.updatedAt) ?? nowMs;
  const ageDays = Math.max(0, Math.floor((nowMs - createdMs) / 86_400_000));
  const staleAfterDays = candidate.status === "failed" ? REFLEX_CURATOR_FAILED_STALE_DAYS : REFLEX_CURATOR_STALE_DAYS;
  const stale = ageDays >= staleAfterDays;
  const tested = candidateHasCompletedTest(candidate) || candidateHasGeneratedDraft(candidate);
  const hasFailedTest = Boolean(readEvidenceString(candidate.evidence.testFailedAt) || readEvidenceString(candidate.evidence.error));
  const priority = Math.min(100, Math.max(1,
    (candidate.riskTier * 12)
    + Math.round(candidate.confidence * 20)
    + (candidate.status === "ready_for_review" ? 24 : candidate.status === "failed" ? 16 : 8)
    + (candidate.kind === "skill" || candidate.kind === "workflow" ? 12 : 0)
    + (stale ? 6 : 0),
  ));

  return {
    version: REFLEX_CURATOR_METADATA_VERSION,
    curatedBy: "friday_reflex_curator",
    lastCuratedAt: input.nowIso,
    reviewReason: resolveCuratorReviewReason({ candidate, duplicateOf: input.duplicateOf, hasFailedTest }),
    recommendedAction: resolveCuratorRecommendedAction({
      candidate,
      duplicateOf: input.duplicateOf,
      hasFailedTest,
      stale,
      tested,
    }),
    priority,
    stale,
    ageDays,
    staleAfterDays,
    tested,
    duplicateOf: input.duplicateOf ?? null,
    safetyBoundary: "review_center_required_before_activation",
    evidenceSummary: hasFailedTest
      ? "failed_test_or_approval_evidence_present"
      : tested
        ? "test_or_draft_evidence_present"
        : "no_test_evidence_yet",
  };
}

function curatorMetadataMatches(current: JsonValue | undefined, next: Record<string, JsonValue>): boolean {
  if (!current || typeof current !== "object" || Array.isArray(current)) return false;
  const currentRecord = { ...(current as Record<string, JsonValue>) };
  const nextRecord = { ...next };
  delete currentRecord.lastCuratedAt;
  delete nextRecord.lastCuratedAt;
  return JSON.stringify(currentRecord) === JSON.stringify(nextRecord);
}

function buildCuratorDuplicateKey(candidate: FridayReflexCandidate): string {
  return JSON.stringify({
    userId: candidate.userId,
    kind: candidate.kind,
    title: candidate.title,
    payload: candidate.payload,
  });
}

function curatorCandidateRank(candidate: FridayReflexCandidate): number {
  const statusRank: Record<FridayReflexCandidateStatus, number> = {
    ready_for_review: 0,
    proposed: 1,
    failed: 2,
    testing: 3,
    approved: 4,
    rejected: 5,
    dismissed: 6,
    superseded: 7,
  };
  return statusRank[candidate.status] ?? 9;
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

  function findPendingPreferenceConfirmation(db: FridayReflexDb, input: {
    userId: string;
    category: FridayUserPreferenceCategory;
    key: string;
    value: JsonValue;
  }): FridayReflexCandidate | null {
    return deps.candidateRepo.list(db, {
      userId: input.userId,
      kind: "preference",
      limit: 200,
    }).find((candidate) =>
      (candidate.status === "proposed" || candidate.status === "ready_for_review" || candidate.status === "testing")
      && candidate.evidence.requiresExplicitConfirmation === true
      && candidate.payload.category === input.category
      && candidate.payload.key === input.key
      && JSON.stringify(candidate.payload.value) === JSON.stringify(input.value),
    ) ?? null;
  }

  function findPendingLearnedFactCandidate(db: FridayReflexDb, input: {
    userId: string;
    key: string;
    value: JsonValue;
  }): FridayReflexCandidate | null {
    return deps.candidateRepo.list(db, {
      userId: input.userId,
      kind: "learned_fact",
      limit: 200,
    }).find((candidate) =>
      (candidate.status === "proposed" || candidate.status === "ready_for_review" || candidate.status === "testing")
      && candidate.payload.key === input.key
      && JSON.stringify(candidate.payload.value) === JSON.stringify(input.value),
    ) ?? null;
  }

  function createLearnedFactCandidateFromRunTask(input: {
    userId: string;
    runId?: string;
    sessionKey?: string;
    channelKind?: string;
    channelUserId?: string;
    task?: string;
  }): FridayReflexCandidate | null {
    const extracted = extractLearnedFactFromRunTask(input.task);
    if (!extracted) return null;
    return deps.db.withWriteTransaction((db) => {
      const existing = findPendingLearnedFactCandidate(db, {
        userId: input.userId,
        key: extracted.key,
        value: extracted.value,
      });
      if (existing) return existing;
      return deps.candidateRepo.insert(db, {
        id: deps.idGenerator(),
        nowIso: deps.nowIso(),
        userId: input.userId,
        kind: "learned_fact",
        origin: input.channelKind ? "channel" : "post_run",
        status: "ready_for_review",
        sourceRunId: input.runId,
        sessionKey: input.sessionKey,
        channelKind: input.channelKind,
        channelUserId: input.channelUserId,
        title: `Review learned fact: ${extracted.subject.slice(0, 80)}`,
        summary: "Friday detected an explicit fact-like memory request during a completed run. Review once before it becomes a revocable learned fact.",
        payload: {
          key: extracted.key,
          value: extracted.value,
          confidence: 0.84,
        },
        evidence: {
          requiresExplicitConfirmation: true,
          source: "post_run_task_text",
          extractionMode: "explicit_fact_pattern",
          statement: extracted.statement,
          safetyBoundary: "review_center_required_before_learned_fact_persistence",
        },
        confidence: 0.84,
        riskTier: 1,
      });
    });
  }

  function createPreferenceConfirmationCandidate(db: FridayReflexDb, input: {
    userId: string;
    category: FridayUserPreferenceCategory;
    key: string;
    value: JsonValue;
    sourceSurface?: FridayReflexSurface;
    origin?: FridayReflexCandidate["origin"];
    evidence?: Record<string, JsonValue>;
  }): FridayReflexCandidate {
    if (!candidatesEnabled) {
      throw new FridayDomainError(
        "REFLEX_CANDIDATES_DISABLED",
        "Reflex candidates are disabled in this runtime.",
        { httpStatus: 503 },
      );
    }
    const existing = findPendingPreferenceConfirmation(db, input);
    if (existing) return existing;
    const now = deps.nowIso();
    return deps.candidateRepo.insert(db, {
      userId: input.userId,
      kind: "preference",
      origin: input.origin ?? (input.sourceSurface === "channel" ? "channel" : "operate"),
      status: "ready_for_review",
      title: `Confirm Friday setting: ${input.key}`,
      summary:
        "This preference affects safety, execution, automation, memory, or test behavior. Review once before it becomes a durable Friday setting.",
      payload: {
        category: input.category,
        key: input.key,
        value: input.value,
        source: "explicit",
        sourceSurface: input.sourceSurface ?? "operate",
      },
      evidence: {
        requiresExplicitConfirmation: true,
        reason: "high_impact_reflex_preference",
        requestedAt: now,
        sourceSurface: input.sourceSurface ?? "operate",
        ...(input.evidence ?? {}),
      },
      confidence: 1,
      riskTier: 2,
      id: deps.idGenerator(),
      nowIso: now,
    });
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
          if (requiresFridayReflexPreferenceConfirmation({
            category: write.category,
            key: write.key,
          })) {
            createPreferenceConfirmationCandidate(db, {
              userId: input.userId,
              category: write.category,
              key: write.key,
              value: write.value,
              sourceSurface: input.sourceSurface,
              origin: "onboarding",
              evidence: {
                onboardingQuestionId: input.questionId,
              },
            });
            continue;
          }
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
        stagedCandidateId: saved.candidateId,
        stagedCandidateDir: saved.candidateDir,
        savedFiles: saved.savedFiles,
        registryRefreshed: saved.registryRefreshed,
        promotionStage: saved.promotionStage,
        lifecycleBoundary: "candidate_staged_not_installed_or_promoted",
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
        publicationBoundary: {
          stage: saved.publicationBoundary.stage,
          lifecyclePromotion: saved.publicationBoundary.lifecyclePromotion,
          proofBoundary: saved.publicationBoundary.proofBoundary,
          summary: saved.publicationBoundary.summary,
        },
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
        } else if (candidate.kind === "learned_fact") {
          if (!deps.learnedFactApprover) {
            throw new FridayDomainError(
              "REFLEX_LEARNED_FACT_UNAVAILABLE",
              "Learned-fact approval is not available in this runtime.",
              { httpStatus: 503 },
            );
          }
          const key = readPayloadString(candidate.payload, "key");
          const value = candidate.payload["value"];
          if (!key || value === undefined) {
            throw new FridayDomainError(
              "REFLEX_LEARNED_FACT_INVALID",
              "Learned-fact candidate payload requires key and value.",
              { httpStatus: 400 },
            );
          }
          const payloadConfidence = candidate.payload.confidence;
          const confidence = typeof payloadConfidence === "number" && Number.isFinite(payloadConfidence)
            ? Math.max(0, Math.min(1, payloadConfidence))
            : Math.max(0, Math.min(1, candidate.confidence));
          const result = deps.learnedFactApprover({
            userId: candidate.userId,
            key,
            value,
            confidence,
            candidateId: candidate.id,
            origin: candidate.origin,
            sourceRunId: candidate.sourceRunId,
            sessionKey: candidate.sessionKey,
            nowIso: deps.nowIso(),
            evidence: candidate.evidence,
          });
          evidence = {
            ...evidence,
            learnedFactKey: result.key,
            learnedFactConfidence: result.confidence,
            learnedFactEvidenceCount: result.evidenceCount,
            learnedFactLastConfirmedAt: result.lastConfirmedAt,
            ...(result.factId ? { learnedFactId: result.factId } : {}),
          };
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
            source: candidate.payload.source === "explicit" || candidate.evidence.requiresExplicitConfirmation === true
              ? "explicit"
              : "implicit",
            confidence: candidate.payload.source === "explicit" || candidate.evidence.requiresExplicitConfirmation === true
              ? 1
              : candidate.confidence,
            preserveExplicit: !(candidate.payload.source === "explicit" || candidate.evidence.requiresExplicitConfirmation === true),
            sourceSurface: "review_center",
          });
          evidence = {
            ...evidence,
            preferenceId: result.preference.id,
            skippedBecauseExplicit: result.skippedBecauseExplicit ?? false,
            explicitPreferenceConfirmed: candidate.payload.source === "explicit"
              || candidate.evidence.requiresExplicitConfirmation === true,
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
      assertPrincipal(input.userId);
      assertPreferenceTarget(input);
      if (requiresFridayReflexPreferenceConfirmation({
        category: input.category,
        key: input.key,
      })) {
        throw new FridayDomainError(
          "REFLEX_PREFERENCE_REQUIRES_CONFIRMATION",
          `Preference '${input.key}' requires Review Center confirmation.`,
          { httpStatus: 409 },
        );
      }
      return writePreference({
        ...input,
        source: "explicit",
        confidence: 1,
      });
    },

    requestPreferenceUpdate(input) {
      assertPrincipal(input.userId);
      assertPreferenceTarget(input);
      if (requiresFridayReflexPreferenceConfirmation({
        category: input.category,
        key: input.key,
      })) {
        return {
          requiresConfirmation: true,
          candidate: deps.db.withWriteTransaction((db) => createPreferenceConfirmationCandidate(db, {
            userId: input.userId,
            category: input.category,
            key: input.key,
            value: input.value,
            sourceSurface: input.sourceSurface,
          })),
        };
      }
      return {
        requiresConfirmation: false,
        ...writePreference({
          ...input,
          source: "explicit",
          confidence: 1,
        }),
      };
    },

    revokePreference(input) {
      assertPrincipal(input.userId);
      const now = deps.nowIso();
      const preference = deps.db.withWriteTransaction((db) => {
        const existing = deps.preferenceRepo.getById(db, {
          principalId: input.userId,
          preferenceId: input.preferenceId,
        });
        if (!existing) {
          throw new FridayDomainError(
            "REFLEX_PREFERENCE_NOT_FOUND",
            `Preference '${input.preferenceId}' was not found.`,
            { httpStatus: 404 },
          );
        }
        const deleted = deps.preferenceRepo.deleteById(db, {
          principalId: input.userId,
          preferenceId: input.preferenceId,
        });
        if (!deleted) {
          throw new FridayDomainError(
            "REFLEX_PREFERENCE_NOT_FOUND",
            `Preference '${input.preferenceId}' was not found.`,
            { httpStatus: 404 },
          );
        }
        return existing;
      });
      emitLearning([
        buildPreferenceEvent({
          eventId: deps.idGenerator(),
          ts: now,
          userId: input.userId,
          category: preference.category,
          key: preference.key,
          value: null,
          sourceSurface: input.sourceSurface ?? "review_center",
        }),
      ]);
      return { revoked: true, preference };
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
      if (input.outcome === "success") {
        const learnedFactCandidate = createLearnedFactCandidateFromRunTask(input);
        if (learnedFactCandidate) created.push(learnedFactCandidate);
      }
      const reflexSignature = normalizeReflexTaskSignature(input.task, toolSequence);
      const hasPriorReusableSuccess = toolSequence.length >= 2 && deps.db.withReadConnection((db) =>
        deps.candidateRepo.list(db, {
          userId: input.userId,
          kind: "recipe",
          limit: 200,
        }).some((candidate) => candidate.evidence.reflexSignature === reflexSignature));
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
            reflexSignature,
            toolSequence,
            artifacts: input.artifacts ?? {},
            feedback: input.feedback ?? {},
          },
          confidence: 0.72,
          riskTier: 1,
        }));
        if (hasPriorReusableSuccess) {
          const generatedKind: FridayReflexCandidateKind = toolSequence.length >= 3 ? "workflow" : "skill";
          const generated = this.createCandidate({
            userId: input.userId,
            kind: generatedKind,
            origin: "post_run",
            sourceRunId: input.runId,
            sessionKey: input.sessionKey,
            channelKind: input.channelKind,
            channelUserId: input.channelUserId,
            title: input.task
              ? `Draft ${generatedKind}: ${input.task.slice(0, 80)}`
              : `Draft ${generatedKind} from repeated success`,
            summary: input.task
              ? `Friday saw this task pattern succeed repeatedly and should test a ${generatedKind} draft before any approval.`
              : `Friday saw the same tool pattern succeed repeatedly and should test a ${generatedKind} draft before any approval.`,
            payload: {
              goal: input.task ?? `Automate repeated tool sequence: ${toolSequence.join(" -> ")}`,
              sourceRecipeSignature: reflexSignature,
              toolSequence,
              approvalBoundary: "draft_only_until_user_approval",
            },
            evidence: {
              reflexSignature,
              repeatedSuccessDetectedAt: deps.nowIso(),
              priorRecipeCandidate: true,
              toolSequence,
              artifacts: input.artifacts ?? {},
              feedback: input.feedback ?? {},
            },
            confidence: 0.78,
            riskTier: generatedKind === "workflow" ? 3 : 2,
          });
          created.push(await this.testCandidate({
            userId: input.userId,
            candidateId: generated.id,
          }));
        }
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
      const now = deps.nowIso();
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
      const keptByKey = new Map<string, FridayReflexCandidate>();
      const curated: FridayReflexCandidate[] = [];
      for (const candidate of [...candidates].sort((left, right) => {
        const rankDiff = curatorCandidateRank(left) - curatorCandidateRank(right);
        if (rankDiff !== 0) return rankDiff;
        const createdDiff = left.createdAt.localeCompare(right.createdAt);
        return createdDiff !== 0 ? createdDiff : left.id.localeCompare(right.id);
      })) {
        const key = buildCuratorDuplicateKey(candidate);
        const kept = keptByKey.get(key);
        if (!kept) {
          keptByKey.set(key, candidate);
          const curator = buildCuratorReviewMetadata({ candidate, nowIso: now });
          if (curatorMetadataMatches(candidate.evidence.curator, curator)) continue;
          const updated = deps.db.withWriteTransaction((db) => deps.candidateRepo.updateEvidence(db, {
            userId: candidate.userId,
            id: candidate.id,
            evidence: { curator },
            nowIso: now,
          }));
          if (updated) curated.push(updated);
          continue;
        }
        const curator = buildCuratorReviewMetadata({
          candidate,
          nowIso: now,
          duplicateOf: kept.id,
        });
        curated.push(updateCandidateStatus({
          userId: candidate.userId,
          candidateId: candidate.id,
          status: "superseded",
          evidence: {
            curator,
            supersededByCuratorAt: now,
            reason: "Duplicate reflex candidate",
            duplicateOf: kept.id,
          },
        }));
      }
      return curated;
    },
  };
}
