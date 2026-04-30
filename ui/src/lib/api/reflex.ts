import { apiClient } from "./client";

export type ReflexCandidateKind = "memory" | "preference" | "recipe" | "skill" | "workflow" | "fix" | "test_policy";
export type ReflexCandidateStatus = "proposed" | "testing" | "ready_for_review" | "approved" | "rejected" | "dismissed" | "failed" | "superseded";
export type ReflexSurface = "channel" | "operate" | "review_center";
export type ReflexPreferenceCategory = "communication" | "uix" | "reflex";

export interface ReflexQuestionOption {
  value: string;
  label: string;
  description: string;
}

export interface ReflexQuestion {
  id: string;
  title: string;
  scenario: string;
  prompt: string;
  options: ReflexQuestionOption[];
  skippable: true;
}

export interface ReflexOnboardingSession {
  id: string;
  userId: string;
  status: "not_started" | "active" | "completed" | "dismissed";
  activeQuestionId?: string;
  primaryChannelKind?: string;
  primaryChannelUserId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  dismissedAt?: string;
}

export interface ReflexOnboardingAnswer {
  id: string;
  sessionId: string;
  userId: string;
  questionId: string;
  status: "answered" | "skipped";
  answer: Record<string, unknown>;
  sourceSurface: ReflexSurface;
  createdAt: string;
  updatedAt: string;
}

export interface ReflexOnboardingSnapshot {
  session: ReflexOnboardingSession | null;
  questions: ReflexQuestion[];
  answers: ReflexOnboardingAnswer[];
  activeQuestion: ReflexQuestion | null;
  progress: {
    total: number;
    completed: number;
    answered: number;
    skipped: number;
  };
}

export interface ReflexCandidate {
  id: string;
  userId: string;
  kind: ReflexCandidateKind;
  status: ReflexCandidateStatus;
  origin: string;
  sourceRunId?: string;
  sessionKey?: string;
  channelKind?: string;
  channelUserId?: string;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  evidence: Record<string, unknown>;
  confidence: number;
  riskTier: number;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
}

export interface ReflexPreference {
  id: string;
  principalId: string;
  category: ReflexPreferenceCategory;
  key: string;
  value: unknown;
  source: "explicit" | "implicit";
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

export const reflexApi = {
  getOnboarding(): Promise<ReflexOnboardingSnapshot> {
    return apiClient.get<ReflexOnboardingSnapshot>("/v1/reflex/onboarding");
  },
  startOnboarding(): Promise<ReflexOnboardingSnapshot> {
    return apiClient.post<Record<string, never>, ReflexOnboardingSnapshot>("/v1/reflex/onboarding/start", {});
  },
  answerOnboarding(input: {
    questionId: string;
    answer: Record<string, unknown>;
    sourceSurface?: ReflexSurface;
  }): Promise<ReflexOnboardingSnapshot> {
    return apiClient.post<typeof input, ReflexOnboardingSnapshot>("/v1/reflex/onboarding/answer", {
      ...input,
      sourceSurface: input.sourceSurface ?? "review_center",
    });
  },
  skipOnboarding(input: {
    questionId: string;
    sourceSurface?: ReflexSurface;
  }): Promise<ReflexOnboardingSnapshot> {
    return apiClient.post<typeof input, ReflexOnboardingSnapshot>("/v1/reflex/onboarding/skip", {
      ...input,
      sourceSurface: input.sourceSurface ?? "review_center",
    });
  },
  listCandidates(query: {
    status?: ReflexCandidateStatus;
    kind?: ReflexCandidateKind;
    limit?: number;
  } = {}): Promise<{ items: ReflexCandidate[] }> {
    const params = new URLSearchParams();
    if (query.status) params.set("status", query.status);
    if (query.kind) params.set("kind", query.kind);
    if (query.limit) params.set("limit", String(query.limit));
    const suffix = params.toString();
    return apiClient.get<{ items: ReflexCandidate[] }>(`/v1/reflex/candidates${suffix ? `?${suffix}` : ""}`);
  },
  testCandidate(id: string): Promise<ReflexCandidate> {
    return apiClient.post<Record<string, never>, ReflexCandidate>(`/v1/reflex/candidates/${encodeURIComponent(id)}/test`, {});
  },
  approveCandidate(id: string): Promise<ReflexCandidate> {
    return apiClient.post<Record<string, never>, ReflexCandidate>(`/v1/reflex/candidates/${encodeURIComponent(id)}/approve`, {});
  },
  rejectCandidate(id: string, reason?: string): Promise<ReflexCandidate> {
    return apiClient.post<{ reason?: string }, ReflexCandidate>(`/v1/reflex/candidates/${encodeURIComponent(id)}/reject`, { reason });
  },
  dismissCandidate(id: string, reason?: string): Promise<ReflexCandidate> {
    return apiClient.post<{ reason?: string }, ReflexCandidate>(`/v1/reflex/candidates/${encodeURIComponent(id)}/dismiss`, { reason });
  },
  listPreferences(): Promise<{ items: ReflexPreference[] }> {
    return apiClient.get<{ items: ReflexPreference[] }>("/v1/reflex/preferences");
  },
};
