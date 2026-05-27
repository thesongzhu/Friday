import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFridaySqliteLayer, type FridaySqliteLayer } from "#state";
import { createFridayUixUserPreferenceRepository } from "../../../src/uix/persistence/friday-uix-user-preference-repository.js";
import {
  FRIDAY_REFLEX_ONBOARDING_QUESTION_IDS,
  FRIDAY_REFLEX_ONBOARDING_QUESTIONS,
  createFridayReflexCandidateRepository,
  createFridayReflexOnboardingRepository,
  createFridayReflexService,
  parseFridayReflexExplicitPreferenceMessage,
  resolveFridayReflexOnboardingPreferenceWrites,
} from "../../../src/reflex/index.js";

let db: FridaySqliteLayer | undefined;
let tempDir: string | undefined;
let idCounter = 0;

function nextId(): string {
  idCounter += 1;
  return `id-${String(idCounter).padStart(4, "0")}`;
}

function createService(overrides: Partial<Parameters<typeof createFridayReflexService>[0]> = {}) {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-reflex-test-"));
  db = createFridaySqliteLayer({
    dbPath: path.join(tempDir, "state.sqlite"),
    readPoolSize: 1,
    pragmas: { busyTimeoutMs: 5_000, synchronous: "NORMAL" },
  });
  return createFridayReflexService({
    db,
    candidateRepo: createFridayReflexCandidateRepository(),
    onboardingRepo: createFridayReflexOnboardingRepository(),
    preferenceRepo: createFridayUixUserPreferenceRepository(),
    idGenerator: nextId,
    nowIso: () => "2026-04-30T12:00:00.000Z",
    ...overrides,
  });
}

afterEach(() => {
  db?.close();
  db = undefined;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  idCounter = 0;
});

describe("Friday Reflex onboarding registry", () => {
  it("keeps all 24 skippable questions in stable order", () => {
    expect(FRIDAY_REFLEX_ONBOARDING_QUESTIONS).toHaveLength(24);
    expect(FRIDAY_REFLEX_ONBOARDING_QUESTION_IDS).toEqual(
      Array.from({ length: 24 }, (_, index) => `O${String(index + 1)}`),
    );
    expect(FRIDAY_REFLEX_ONBOARDING_QUESTIONS.every((question) => question.skippable)).toBe(true);
  });

  it("maps language policy without pretending follow-input is a fixed locale", () => {
    expect(resolveFridayReflexOnboardingPreferenceWrites({
      questionId: "O1",
      answer: { value: "follow_input" },
    })).toEqual([
      { category: "reflex", key: "communication.language_policy", value: "follow_input" },
    ]);
    expect(resolveFridayReflexOnboardingPreferenceWrites({
      questionId: "O1",
      answer: { value: "en" },
    })).toEqual([
      { category: "reflex", key: "communication.language_policy", value: "en" },
      { category: "uix", key: "display.locale", value: "en" },
    ]);
  });

  it("parses only explicit durable preference messages", () => {
    expect(parseFridayReflexExplicitPreferenceMessage("以后回答短一点")).toEqual([
      { category: "communication", key: "persona.verbosity", value: "concise" },
    ]);
    expect(parseFridayReflexExplicitPreferenceMessage("以后叫我 Wenxin")).toEqual([
      { category: "reflex", key: "user.display_name", value: "Wenxin" },
    ]);
    expect(parseFridayReflexExplicitPreferenceMessage("以后不要主动生成 workflow")).toEqual([
      { category: "reflex", key: "workflows.generation_policy", value: "do_not_suggest" },
    ]);
    expect(parseFridayReflexExplicitPreferenceMessage("以后不要盲从，先问问题，反驳风险，用白话解释")).toEqual([
      { category: "reflex", key: "constitution.skeptical_mode", value: "enabled" },
      { category: "reflex", key: "constitution.clarification_policy", value: "ask_when_uncertain" },
      { category: "reflex", key: "constitution.challenge_policy", value: "challenge_risky_or_inconsistent" },
      { category: "reflex", key: "constitution.plain_language_policy", value: "plain_language_for_decisions" },
    ]);
    expect(parseFridayReflexExplicitPreferenceMessage("不要记住这个")).toEqual([]);
  });
});

describe("Friday Reflex service", () => {
  it("marks new users eligible and only activates onboarding after start", () => {
    const service = createService();
    const eligible = service.markNewUserEligible({ userId: "user-1" });
    expect(eligible.session?.status).toBe("not_started");
    expect(eligible.activeQuestion).toBeNull();

    const active = service.startOnboarding({
      userId: "user-1",
      primaryChannelKind: "telegram",
      primaryChannelUserId: "tg-1",
    });
    expect(active.session?.status).toBe("active");
    expect(active.activeQuestion?.id).toBe("O1");
    expect(active.session?.primaryChannelKind).toBe("telegram");
  });

  it("answers and skips questions while persisting ordinary explicit preferences", () => {
    const service = createService();
    service.startOnboarding({ userId: "user-1", primaryChannelKind: "slack" });

    const afterO1 = service.answerOnboarding({
      userId: "user-1",
      questionId: "O1",
      answer: { value: "follow_input" },
      sourceSurface: "channel",
    });
    expect(afterO1.activeQuestion?.id).toBe("O2");

    const afterSkip = service.skipOnboarding({
      userId: "user-1",
      questionId: "O2",
      sourceSurface: "channel",
    });
    expect(afterSkip.activeQuestion?.id).toBe("O3");

    expect(() => service.answerOnboarding({
      userId: "user-1",
      questionId: "O2",
      answer: { value: "custom", text: "Wenxin" },
      sourceSurface: "channel",
    })).toThrow(/Review Center/);

    service.answerOnboarding({
      userId: "user-1",
      questionId: "O2",
      answer: { value: "custom", text: "Wenxin" },
      sourceSurface: "review_center",
    });

    const prefs = service.listPreferences("user-1");
    expect(prefs.find((pref) => pref.category === "reflex" && pref.key === "communication.language_policy")?.value)
      .toBe("follow_input");
    expect(prefs.find((pref) => pref.category === "reflex" && pref.key === "user.display_name")?.value)
      .toBe("Wenxin");
  });

  it("turns high-impact onboarding answers into review candidates without blocking progress", () => {
    const service = createService();
    service.startOnboarding({ userId: "user-1", primaryChannelKind: "slack" });
    for (const [questionId, value] of [
      ["O1", "follow_input"],
      ["O2", "none"],
      ["O3", "concise"],
      ["O4", "compact"],
      ["O5", "ask_first"],
    ] as const) {
      service.answerOnboarding({
        userId: "user-1",
        questionId,
        answer: { value },
        sourceSurface: "channel",
      });
    }

    const afterO6 = service.answerOnboarding({
      userId: "user-1",
      questionId: "O6",
      answer: { value: "save_immediately" },
      sourceSurface: "channel",
    });

    expect(afterO6.activeQuestion?.id).toBe("O7");
    expect(service.listPreferences("user-1")
      .find((pref) => pref.category === "reflex" && pref.key === "memory.explicit_instruction_policy"))
      .toBeUndefined();
    expect(service.listCandidates({ userId: "user-1", kind: "preference" })).toEqual([
      expect.objectContaining({
        kind: "preference",
        origin: "onboarding",
        status: "ready_for_review",
        payload: expect.objectContaining({
          category: "reflex",
          key: "memory.explicit_instruction_policy",
          value: "save_immediately",
        }),
        evidence: expect.objectContaining({
          requiresExplicitConfirmation: true,
          onboardingQuestionId: "O6",
        }),
      }),
    ]);
  });

  it("does not let approved preference candidates overwrite explicit preferences", async () => {
    const service = createService();
    service.updatePreference({
      userId: "user-1",
      category: "communication",
      key: "persona.verbosity",
      value: "concise",
      sourceSurface: "operate",
    });
    const candidate = service.createCandidate({
      userId: "user-1",
      kind: "preference",
      origin: "post_run",
      title: "Prefer detailed answers",
      summary: "Inferred from a long-form interaction.",
      payload: {
        category: "communication",
        key: "persona.verbosity",
        value: "detailed",
      },
      confidence: 0.8,
      riskTier: 1,
    });

    const approved = await service.approveCandidate({ userId: "user-1", candidateId: candidate.id });
    expect(approved.status).toBe("approved");
    expect(approved.evidence.skippedBecauseExplicit).toBe(true);
    expect(service.listPreferences("user-1").find((pref) => pref.key === "persona.verbosity")?.value)
      .toBe("concise");
  });

  it("applies ordinary preference requests immediately", () => {
    const service = createService();
    const result = service.requestPreferenceUpdate({
      userId: "user-1",
      category: "communication",
      key: "persona.verbosity",
      value: "concise",
      sourceSurface: "operate",
    });

    expect(result.requiresConfirmation).toBe(false);
    if (!result.requiresConfirmation) {
      expect(result.preference.value).toBe("concise");
    }
    expect(service.listCandidates({ userId: "user-1", kind: "preference" })).toEqual([]);
  });

  it("turns high-impact preference requests into one-tap review candidates", async () => {
    const service = createService();
    const result = service.requestPreferenceUpdate({
      userId: "user-1",
      category: "reflex",
      key: "testing.live_llm_policy",
      value: "allowed_with_cost_notice",
      sourceSurface: "operate",
    });

    expect(result.requiresConfirmation).toBe(true);
    if (result.requiresConfirmation) {
      expect(result.candidate.status).toBe("ready_for_review");
      expect(result.candidate.kind).toBe("preference");
      expect(result.candidate.payload).toMatchObject({
        category: "reflex",
        key: "testing.live_llm_policy",
        value: "allowed_with_cost_notice",
        source: "explicit",
      });
      expect(result.candidate.evidence.requiresExplicitConfirmation).toBe(true);
    }
    expect(service.listPreferences("user-1").find((pref) => pref.key === "testing.live_llm_policy"))
      .toBeUndefined();

    const duplicate = service.requestPreferenceUpdate({
      userId: "user-1",
      category: "reflex",
      key: "testing.live_llm_policy",
      value: "allowed_with_cost_notice",
      sourceSurface: "review_center",
    });
    expect(duplicate.requiresConfirmation).toBe(true);
    if (result.requiresConfirmation && duplicate.requiresConfirmation) {
      expect(duplicate.candidate.id).toBe(result.candidate.id);
      const approved = await service.approveCandidate({
        userId: "user-1",
        candidateId: result.candidate.id,
      });
      expect(approved.status).toBe("approved");
      expect(approved.evidence.explicitPreferenceConfirmed).toBe(true);
    }

    const pref = service.listPreferences("user-1")
      .find((item) => item.category === "reflex" && item.key === "testing.live_llm_policy");
    expect(pref?.source).toBe("explicit");
    expect(pref?.value).toBe("allowed_with_cost_notice");
  });

  it("requires Review Center confirmation before applying User Constitution preferences", async () => {
    const service = createService();
    const result = service.requestPreferenceUpdate({
      userId: "user-1",
      category: "reflex",
      key: "constitution.skeptical_mode",
      value: "enabled",
      sourceSurface: "operate",
    });

    expect(result.requiresConfirmation).toBe(true);
    if (result.requiresConfirmation) {
      expect(result.candidate).toMatchObject({
        kind: "preference",
        status: "ready_for_review",
        payload: {
          category: "reflex",
          key: "constitution.skeptical_mode",
          value: "enabled",
          source: "explicit",
        },
        evidence: {
          requiresExplicitConfirmation: true,
        },
      });
      expect(service.listPreferences("user-1")
        .find((pref) => pref.key === "constitution.skeptical_mode"))
        .toBeUndefined();

      await service.approveCandidate({ userId: "user-1", candidateId: result.candidate.id });
    }

    const pref = service.listPreferences("user-1")
      .find((item) => item.category === "reflex" && item.key === "constitution.skeptical_mode");
    expect(pref?.source).toBe("explicit");
    expect(pref?.value).toBe("enabled");
  });

  it("enforces candidate state transitions and principal binding", () => {
    const service = createService();
    expect(() => service.updatePreference({
      userId: "",
      category: "reflex",
      key: "automation.conservatism",
      value: "balanced",
      sourceSurface: "operate",
    })).toThrow(/bound Friday user/);
    expect(() => service.updatePreference({
      userId: "user-1",
      category: "reflex",
      key: "automation.conservatism",
      value: "balanced",
      sourceSurface: "operate",
    })).toThrow(/Review Center confirmation/);

    const candidate = service.createCandidate({
      userId: "user-1",
      kind: "recipe",
      origin: "post_run",
      title: "Reusable path",
      summary: "A reusable path.",
      payload: { content: "step one\nstep two" },
      confidence: 0.7,
      riskTier: 1,
    });
    const rejected = service.rejectCandidate({ userId: "user-1", candidateId: candidate.id });
    expect(rejected.status).toBe("rejected");
    expect(() => service.dismissCandidate({ userId: "user-1", candidateId: candidate.id }))
      .toThrow(/Invalid reflex candidate transition/);
  });

  it("generates post-run candidates without enabling skills or workflows", async () => {
    const service = createService();
    const created = await service.processRunCompletion({
      userId: "user-1",
      runId: "run-1",
      sessionKey: "agent:run-1",
      task: "Draft a report",
      outcome: "success",
      toolSequence: ["memory_search", "web_fetch", "write"],
    });
    expect(created).toHaveLength(1);
    expect(created[0]?.kind).toBe("recipe");
    expect(created[0]?.status).toBe("proposed");
  });

  it("revokes explicit preferences through the same canonical store", () => {
    const service = createService();
    const written = service.updatePreference({
      userId: "user-1",
      category: "reflex",
      key: "communication.language_policy",
      value: "zh",
      sourceSurface: "operate",
    });

    const revoked = service.revokePreference({
      userId: "user-1",
      preferenceId: written.preference.id,
      sourceSurface: "review_center",
    });
    expect(revoked.revoked).toBe(true);
    expect(revoked.preference.key).toBe("communication.language_policy");
    expect(service.listPreferences("user-1")).toEqual([]);
    expect(() => service.revokePreference({
      userId: "user-1",
      preferenceId: written.preference.id,
      sourceSurface: "review_center",
    })).toThrow(/not found/);
  });

  it("turns repeated successful tasks into tested draft candidates without approving them", async () => {
    const approveAndSave = vi.fn();
    const service = createService({
      workflowGenerator: {
        startSession: vi.fn(async () => ({
          mode: "new",
          session: { sessionId: "workflow-session-1" },
        })),
        submitTurn: vi.fn(),
        getSession: vi.fn(),
        generateDraft: vi.fn(async () => ({
          spec: { workflowId: "draft-workflow-1", name: "Draft repeated report workflow" },
          validation: { ok: true },
        })),
        getQaVerdict: vi.fn(async () => null),
        getHarnessSummary: vi.fn(async () => null),
        approveAndSave,
        cancelSession: vi.fn(),
      } as never,
    });

    await service.processRunCompletion({
      userId: "user-1",
      runId: "run-1",
      task: "Draft the weekly partner report",
      outcome: "success",
      toolSequence: ["memory_search", "web_fetch", "write"],
    });
    const repeated = await service.processRunCompletion({
      userId: "user-1",
      runId: "run-2",
      task: "Draft the weekly partner report",
      outcome: "success",
      toolSequence: ["memory_search", "web_fetch", "write"],
    });

    const workflow = repeated.find((candidate) => candidate.kind === "workflow");
    expect(workflow?.status).toBe("ready_for_review");
    expect(workflow?.evidence.generatorSessionId).toBe("workflow-session-1");
    expect(workflow?.evidence.draftWorkflowId).toBe("draft-workflow-1");
    expect(approveAndSave).not.toHaveBeenCalled();
  });

  it("approves tested workflow candidates through the generator save boundary", async () => {
    const approveAndSave = vi.fn(async () => ({
      workflowId: "approved-workflow-1",
      workflowVersionId: "approved-workflow-version-1",
      versionNumber: 1,
      slug: "approved-workflow-1",
      published: true,
      publicationBoundary: {
        stage: "published",
        lifecyclePromotion: "workflow_published",
        proofBoundary: "published_workflow_requires_separate_trigger_execution_proof",
        summary: "Workflow was saved, but fresh-session trigger execution remains separate proof.",
      },
    }));
    const service = createService({
      workflowGenerator: {
        startSession: vi.fn(),
        submitTurn: vi.fn(),
        getSession: vi.fn(),
        generateDraft: vi.fn(),
        getQaVerdict: vi.fn(),
        getHarnessSummary: vi.fn(),
        approveAndSave,
        cancelSession: vi.fn(),
      } as never,
    });
    const candidate = service.createCandidate({
      userId: "user-1",
      kind: "workflow",
      origin: "post_run",
      title: "Generated workflow candidate",
      summary: "A tested workflow waiting for Review Center approval.",
      payload: { goal: "Automate the repeated report workflow" },
      evidence: { generatorSessionId: "workflow-session-1", validationOk: true },
      confidence: 0.8,
      riskTier: 3,
    });

    const approved = await service.approveCandidate({ userId: "user-1", candidateId: candidate.id });

    expect(approveAndSave).toHaveBeenCalledWith("workflow-session-1");
    expect(approved.status).toBe("approved");
    expect(approved.evidence.savedWorkflowId).toBe("approved-workflow-1");
    expect(approved.evidence.workflowVersionId).toBe("approved-workflow-version-1");
    expect(approved.evidence.published).toBe(true);
    expect(approved.evidence.publicationBoundary).toMatchObject({
      proofBoundary: "published_workflow_requires_separate_trigger_execution_proof",
    });
  });

  it("fails closed when approving a skill candidate without canonical staging approval", async () => {
    const approveAndSave = vi.fn(async () => {
      throw new Error("Generated skill approval now stages a lifecycle candidate and requires canonical approval.");
    });
    const service = createService({
      skillGenerator: {
        startSession: vi.fn(),
        submitTurn: vi.fn(),
        getSession: vi.fn(),
        generateDraft: vi.fn(),
        recordExplicitTestResult: vi.fn(),
        getQaVerdict: vi.fn(),
        getHarnessSummary: vi.fn(),
        approveAndSave,
        cancelSession: vi.fn(),
      } as never,
    });
    const candidate = service.createCandidate({
      userId: "user-1",
      kind: "skill",
      origin: "post_run",
      title: "Generated skill candidate",
      summary: "A generated skill waiting for review.",
      payload: { skillId: "generated-skill" },
      evidence: { generatorSessionId: "skill-session-1" },
      confidence: 0.8,
      riskTier: 2,
    });

    const approved = await service.approveCandidate({ userId: "user-1", candidateId: candidate.id });

    expect(approveAndSave).toHaveBeenCalledWith("skill-session-1");
    expect(approved.status).toBe("failed");
    expect(approved.evidence.error).toContain("requires canonical approval");
    expect(approved.evidence.savedSkillId).toBeUndefined();
    expect(approved.evidence.promotionStage).toBeUndefined();
  });

  it("adds curator review metadata without approving generated candidates", async () => {
    const approveAndSave = vi.fn();
    const service = createService({
      workflowGenerator: {
        startSession: vi.fn(async () => ({
          mode: "new",
          session: { sessionId: "workflow-session-1" },
        })),
        submitTurn: vi.fn(),
        getSession: vi.fn(),
        generateDraft: vi.fn(async () => ({
          spec: { workflowId: "draft-workflow-1", name: "Draft repeated report workflow" },
          validation: { ok: true },
        })),
        getQaVerdict: vi.fn(async () => null),
        getHarnessSummary: vi.fn(async () => null),
        approveAndSave,
        cancelSession: vi.fn(),
      } as never,
    });

    await service.processRunCompletion({
      userId: "user-1",
      runId: "run-1",
      task: "Draft the weekly partner report",
      outcome: "success",
      toolSequence: ["memory_search", "web_fetch", "write"],
    });
    await service.processRunCompletion({
      userId: "user-1",
      runId: "run-2",
      task: "Draft the weekly partner report",
      outcome: "success",
      toolSequence: ["memory_search", "web_fetch", "write"],
    });

    const curated = service.curateCandidates({ userId: "user-1" });
    const workflow = service.listCandidates({ userId: "user-1", kind: "workflow" })[0];

    expect(curated.some((candidate) => candidate.id === workflow?.id)).toBe(true);
    expect(workflow?.status).toBe("ready_for_review");
    expect(workflow?.evidence.curator).toMatchObject({
      version: 1,
      curatedBy: "friday_reflex_curator",
      recommendedAction: "review",
      tested: true,
      safetyBoundary: "review_center_required_before_activation",
    });
    expect(approveAndSave).not.toHaveBeenCalled();
  });

  it("supersedes only exact duplicate candidates while keeping distinct candidates reviewable", () => {
    const service = createService();
    const first = service.createCandidate({
      userId: "user-1",
      kind: "recipe",
      origin: "post_run",
      title: "Reusable report path",
      summary: "A reusable report path.",
      payload: { content: "step one\nstep two" },
      confidence: 0.7,
      riskTier: 1,
    });
    const duplicate = service.createCandidate({
      userId: "user-1",
      kind: "recipe",
      origin: "post_run",
      title: "Reusable report path",
      summary: "Same candidate repeated.",
      payload: { content: "step one\nstep two" },
      confidence: 0.7,
      riskTier: 1,
    });
    const distinct = service.createCandidate({
      userId: "user-1",
      kind: "recipe",
      origin: "post_run",
      title: "Reusable report path",
      summary: "Same title with different payload.",
      payload: { content: "step one\nstep three" },
      confidence: 0.7,
      riskTier: 1,
    });

    service.curateCandidates({ userId: "user-1" });

    expect(service.getCandidate({ userId: "user-1", candidateId: first.id }).status).toBe("proposed");
    expect(service.getCandidate({ userId: "user-1", candidateId: distinct.id }).status).toBe("proposed");
    expect(service.getCandidate({ userId: "user-1", candidateId: duplicate.id })).toMatchObject({
      status: "superseded",
      evidence: expect.objectContaining({
        duplicateOf: first.id,
        curator: expect.objectContaining({
          recommendedAction: "superseded",
          duplicateOf: first.id,
        }),
      }),
    });
  });

  it("marks stale candidates for review without deleting or approving them", () => {
    let now = "2026-04-01T12:00:00.000Z";
    const service = createService({
      nowIso: () => now,
    });
    const candidate = service.createCandidate({
      userId: "user-1",
      kind: "recipe",
      origin: "post_run",
      title: "Old reusable path",
      summary: "An old candidate that still needs a user decision.",
      payload: { content: "old step one\nold step two" },
      confidence: 0.7,
      riskTier: 1,
    });

    now = "2026-04-30T12:00:00.000Z";
    service.curateCandidates({ userId: "user-1" });
    const refreshed = service.getCandidate({ userId: "user-1", candidateId: candidate.id });

    expect(refreshed.status).toBe("proposed");
    expect(refreshed.evidence.curator).toMatchObject({
      recommendedAction: "review_or_dismiss",
      stale: true,
      ageDays: 29,
      safetyBoundary: "review_center_required_before_activation",
    });
  });
});
