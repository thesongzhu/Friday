import type { JsonValue } from "../../uix/model/friday-uix.types.js";

export type FridayReflexCandidateKind =
  | "memory"
  | "learned_fact"
  | "preference"
  | "recipe"
  | "skill"
  | "workflow"
  | "fix"
  | "test_policy";

export type FridayReflexCandidateStatus =
  | "proposed"
  | "testing"
  | "ready_for_review"
  | "approved"
  | "rejected"
  | "dismissed"
  | "failed"
  | "superseded";

export type FridayReflexCandidateOrigin =
  | "onboarding"
  | "channel"
  | "operate"
  | "post_run"
  | "cold_start"
  | "import"
  | "curator";

export type FridayReflexOnboardingStatus =
  | "not_started"
  | "active"
  | "completed"
  | "dismissed";

export type FridayReflexOnboardingAnswerStatus = "answered" | "skipped";

export type FridayReflexSurface = "channel" | "operate" | "review_center";

export interface FridayReflexCandidate {
  id: string;
  userId: string;
  kind: FridayReflexCandidateKind;
  status: FridayReflexCandidateStatus;
  origin: FridayReflexCandidateOrigin;
  sourceRunId?: string;
  sessionKey?: string;
  channelKind?: string;
  channelUserId?: string;
  title: string;
  summary: string;
  payload: Record<string, JsonValue>;
  evidence: Record<string, JsonValue>;
  confidence: number;
  riskTier: number;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
}

export interface FridayReflexCandidateInput {
  userId: string;
  kind: FridayReflexCandidateKind;
  origin: FridayReflexCandidateOrigin;
  status?: FridayReflexCandidateStatus;
  sourceRunId?: string;
  sessionKey?: string;
  channelKind?: string;
  channelUserId?: string;
  title: string;
  summary: string;
  payload?: Record<string, JsonValue>;
  evidence?: Record<string, JsonValue>;
  confidence?: number;
  riskTier?: number;
}

export interface FridayReflexOnboardingSession {
  id: string;
  userId: string;
  status: FridayReflexOnboardingStatus;
  activeQuestionId?: string;
  primaryChannelKind?: string;
  primaryChannelUserId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  dismissedAt?: string;
}

export interface FridayReflexOnboardingAnswer {
  id: string;
  sessionId: string;
  userId: string;
  questionId: string;
  status: FridayReflexOnboardingAnswerStatus;
  answer: Record<string, JsonValue>;
  sourceSurface: FridayReflexSurface;
  createdAt: string;
  updatedAt: string;
}

export interface FridayReflexQuestionOption {
  value: string;
  label: string;
  description: string;
}

export interface FridayReflexQuestion {
  id: string;
  title: string;
  scenario: string;
  prompt: string;
  options: FridayReflexQuestionOption[];
  skippable: true;
}

export interface FridayReflexPreferenceWrite {
  category: "communication" | "uix" | "reflex";
  key: string;
  value: JsonValue;
}
