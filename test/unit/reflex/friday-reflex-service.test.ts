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

  it("answers and skips questions while persisting explicit preferences", () => {
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

  it("enforces candidate state transitions and principal binding", () => {
    const service = createService();
    expect(() => service.updatePreference({
      userId: "",
      category: "reflex",
      key: "automation.conservatism",
      value: "balanced",
      sourceSurface: "operate",
    })).toThrow(/bound Friday user/);

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
      key: "automation.conservatism",
      value: "balanced",
      sourceSurface: "operate",
    });

    const revoked = service.revokePreference({
      userId: "user-1",
      preferenceId: written.preference.id,
      sourceSurface: "review_center",
    });
    expect(revoked.revoked).toBe(true);
    expect(revoked.preference.key).toBe("automation.conservatism");
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
});
