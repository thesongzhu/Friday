import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "#state";
import type { FridayRuntimeCapabilityId, FridayRuntimeCapabilityMatrix } from "#providers";
import { FridayDomainError } from "#errors";
import {
  createFridayAutonomyPolicyService,
  createFridayCapabilityAcquisitionService,
  createFridayStandingAgendaService,
  type FridayAutonomyPolicyService,
  type FridayCapabilityAcquisitionService,
  type FridayStandingAgendaService,
} from "../../../src/autonomy/index.js";
import { createTestDb, createTestIdGenerator } from "../satellites/_helpers/create-test-db.helper.js";

describe("controlled autonomy closed loops", () => {
  let db: FridaySqliteLayer;
  let policyService: FridayAutonomyPolicyService;
  let acquisitionService: FridayCapabilityAcquisitionService;
  let standingAgendaService: FridayStandingAgendaService;
  let nowCounter = 0;

  beforeEach(() => {
    db = createTestDb();
    const idGenerator = createTestIdGenerator();
    const nowIso = () => `2026-04-25T00:00:${String(++nowCounter).padStart(2, "0")}.000Z`;
    policyService = createFridayAutonomyPolicyService({ db, nowIso });
    acquisitionService = createFridayCapabilityAcquisitionService({
      db,
      idGenerator,
      nowIso,
      policyService,
      capabilitySnapshotGetter: () => ({ readOnly: false, ...emptyAgentSnapshot(), runtime: matrixWith() }),
      // Test-oracle opt-in: these tests exercise the legacy acquisition run
      // mutations, which are method-level fail-closed by default (TS-R1).
      allowTestOnlyCapabilityAcquisitionExecution: true,
    });
    standingAgendaService = createFridayStandingAgendaService({
      db,
      idGenerator,
      nowIso,
      policyService,
      acquisitionService,
      // Test-oracle opt-in: these tests exercise the legacy standing-agenda WRITE
      // mutations (createStandingGoal/updateStandingGoal), which are method-level
      // fail-closed by default (route-only-guard defect fix). The dedicated
      // guard describe-block below constructs a service WITHOUT this flag.
      allowTestOnlyStandingAgendaExecution: true,
    });
  });

  afterEach(() => {
    db.close();
    nowCounter = 0;
  });

  it("keeps credential-backed OCR acquisition human-blocked instead of marking it available", async () => {
    const run = await acquisitionService.startRun({
      userId: "test-user",
      goal: "识别这张扫描件里的文字",
      requiredCapabilities: ["text", "ocr"],
    });

    expect(run.status).toBe("human_blocked");
    expect(run.missingCapabilities).toContain("ocr");
    expect(run.humanBlockers.join("\n")).toContain("API key");
    expect(run.executionSuggestion.canExecute).toBe(false);
    expect(run.executionSuggestion.nextAction).toBe("complete_human_setup");

    const approved = await acquisitionService.approveRun(run.id);
    expect(approved.status).toBe("human_blocked");
    expect(approved.registeredCapabilities.some((item) => item.capability === "ocr")).toBe(false);
  });

  it("registers external setup_recipe candidate when live matrix confirms capability is available", async () => {
    let currentMatrix = matrixWith();
    const mutableService = createFridayCapabilityAcquisitionService({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => `2026-04-25T00:00:${String(++nowCounter).padStart(2, "0")}.000Z`,
      policyService,
      capabilitySnapshotGetter: () => ({ readOnly: false, ...emptyAgentSnapshot(), runtime: currentMatrix }),
      allowTestOnlyCapabilityAcquisitionExecution: true,
    });

    const run = await mutableService.startRun({
      userId: "test-user",
      goal: "识别这张扫描件里的文字",
      requiredCapabilities: ["text", "ocr"],
    });
    expect(run.status).toBe("human_blocked");
    expect(run.humanBlockers.join("\n")).toContain("API key");

    const stillBlocked = await mutableService.approveRun(run.id);
    expect(stillBlocked.status).toBe("human_blocked");

    currentMatrix = matrixWith("ocr");

    const approved = await mutableService.approveRun(run.id);
    expect(approved.status).toBe("verified");
    expect(approved.executionSuggestion.canExecute).toBe(true);
    expect(approved.executionSuggestion.nextAction).toBe("execute_task");
    expect(approved.registeredCapabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: "ocr", state: "available" }),
      ]),
    );
    const ocrVerification = approved.verificationResults.find((v) => v.capability === "ocr");
    expect(ocrVerification?.status).toBe("passed");
    expect(ocrVerification?.evidence).toContain("Live runtime capability matrix");
    expect(ocrVerification?.availabilityBoundary).toMatchObject({
      proofTier: "live_runtime_verified",
      liveRuntimeVerified: true,
      localCandidateOnly: false,
    });
  });

  it("keeps partial blockers when only some external capabilities become available", async () => {
    let currentMatrix = matrixWith();
    const mutableService = createFridayCapabilityAcquisitionService({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => `2026-04-25T00:00:${String(++nowCounter).padStart(2, "0")}.000Z`,
      policyService,
      capabilitySnapshotGetter: () => ({ readOnly: false, ...emptyAgentSnapshot(), runtime: currentMatrix }),
      allowTestOnlyCapabilityAcquisitionExecution: true,
    });

    const run = await mutableService.startRun({
      userId: "test-user",
      goal: "识别扫描件并生成语音",
      requiredCapabilities: ["text", "ocr", "tts"],
    });
    expect(run.status).toBe("human_blocked");
    expect(run.humanBlockers.length).toBeGreaterThanOrEqual(2);

    currentMatrix = matrixWith("ocr");

    const partial = await mutableService.approveRun(run.id);
    expect(partial.status).toBe("human_blocked");
    expect(partial.humanBlockers.some((b) => b.includes("ocr"))).toBe(false);
    expect(partial.humanBlockers.some((b) => b.includes("tts"))).toBe(true);
  });

  it("requires approval before a generated custom capability can register", async () => {
    const run = await acquisitionService.startRun({
      userId: "test-user",
      goal: "给我生成一个自定义 API 集成 skill",
      requiredCapabilities: ["text", "custom"],
    });

    expect(run.status).toBe("awaiting_approval");
    expect(run.approvalReasons.join("\n")).toContain("custom");

    const approved = await acquisitionService.approveRun(run.id);
    expect(approved.status).toBe("human_blocked");
    expect(approved.executionSuggestion.canExecute).toBe(false);
    expect(approved.executionSuggestion.nextAction).toBe("complete_human_setup");
    expect(approved.registeredCapabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: "custom", state: "blocked" }),
      ]),
    );
    const customRegistration = approved.registeredCapabilities.find((item) => item.capability === "custom");
    expect(customRegistration?.availabilityBoundary).toMatchObject({
      proofTier: "local_candidate_registered",
      liveRuntimeVerified: false,
      localCandidateOnly: true,
    });
    expect(approved.executionSuggestion.availabilityBoundary).toMatchObject({
      proofTier: "local_candidate_registered",
    });
    expect(approved.executionSuggestion.reason).toContain("not installed, promoted, or live-provider verified");
    const customVerification = approved.verificationResults.find((item) => item.capability === "custom");
    expect(customVerification?.status).toBe("blocked");
    expect(customVerification?.evidence).toContain("lifecycle promotion or installation proof is missing");
    expect(customVerification?.blocker).toContain("Lifecycle promotion or installation proof");
  });

  it("accepts studio artifact candidates in startRun and stays awaiting_approval before registration", async () => {
    const studioArtifactCandidates = [
      {
        id: "studio_artifact:run-001:custom",
        capability: "custom" as FridayRuntimeCapabilityId,
        sourceType: "studio_artifact" as const,
        trustTier: "generated" as const,
        label: "Integration - Example API",
        description: "Generated from Studio integration_builder run",
        risks: ["network_call" as const],
        requiresApproval: true,
        requiresHuman: false,
        rank: 35,
      },
      {
        id: "studio_artifact:run-001:skills",
        capability: "skills" as FridayRuntimeCapabilityId,
        sourceType: "studio_artifact" as const,
        trustTier: "generated" as const,
        label: "Integration - Example API",
        description: "Generated from Studio integration_builder run",
        risks: [] as string[],
        requiresApproval: true,
        requiresHuman: false,
        rank: 35,
      },
    ];

    const run = await acquisitionService.startRun({
      userId: "test-user",
      goal: "Register a Studio-generated API integration",
      requiredCapabilities: ["text", "custom", "skills"],
      studioArtifactCandidates,
    });

    expect(run.status).toBe("awaiting_approval");
    expect(run.candidates.some((c) => c.sourceType === "studio_artifact" && c.capability === "custom")).toBe(true);
    expect(run.candidates.some((c) => c.sourceType === "studio_artifact" && c.capability === "skills")).toBe(true);
    expect(run.approvalReasons.join("\n")).toContain("custom");
    expect(run.executionSuggestion.canExecute).toBe(false);
    expect(run.executionSuggestion.nextAction).toBe("approve_run");

    const approved = await acquisitionService.approveRun(run.id);
    expect(approved.status).toBe("human_blocked");
    expect(approved.executionSuggestion.canExecute).toBe(false);
    expect(approved.executionSuggestion.nextAction).toBe("complete_human_setup");
    expect(approved.registeredCapabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: "custom", state: "blocked" }),
        expect.objectContaining({ capability: "skills", state: "available" }),
      ]),
    );
    const customVerification = approved.verificationResults.find((v) => v.capability === "custom");
    expect(customVerification?.status).toBe("blocked");
    expect(customVerification?.blocker).toContain("Lifecycle promotion or installation proof");
    expect(customVerification?.availabilityBoundary).toMatchObject({
      proofTier: "local_candidate_registered",
      liveRuntimeVerified: false,
      localCandidateOnly: true,
    });
  });

  it("completes the studio artifact bridge pipeline: validate → candidates → startRun → approveRun → lifecycle-blocked local proof", async () => {
    const { validateStudioArtifactAsCandidate, buildStudioArtifactCapabilityCandidate } = await import("../../../src/studio/friday-studio-artifact-candidate-bridge.js");

    const mockRun = {
      id: "bridge-run-001",
      productId: "guided_browser_automation" as const,
      status: "completed" as const,
      title: "Guide - Bridge Test",
      createdAt: "2026-05-14T00:00:00.000Z",
      completedAt: "2026-05-14T00:00:01.000Z",
      artifactRoot: "/tmp/test",
      summary: { zh: "步骤包已生成", en: "Guided step pack generated." },
      inputs: { goal: "Audit a page" },
      artifacts: [
        { id: "guide_pack", kind: "json" as const, label: { zh: "步骤包", en: "Step pack" }, relativePath: "pack.json", mimeType: "application/json", sizeBytes: 100, previewable: true },
      ],
      checks: [],
      nextActions: [],
    };

    const validation = validateStudioArtifactAsCandidate({ run: mockRun });
    expect(validation.valid).toBe(true);
    expect(validation.risks).toHaveLength(0);

    const candidates = buildStudioArtifactCapabilityCandidate(validation, mockRun.id);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => c.sourceType === "studio_artifact")).toBe(true);
    expect(candidates.every((c) => c.requiresApproval)).toBe(true);
    expect(candidates.every((c) => !c.requiresHuman)).toBe(true);

    const run = await acquisitionService.startRun({
      userId: "test-user",
      goal: "Register bridge-test guided automation",
      requiredCapabilities: ["text", "custom"],
      studioArtifactCandidates: candidates,
    });

    expect(run.status).toBe("awaiting_approval");
    expect(run.candidates.some((c) => c.sourceType === "studio_artifact")).toBe(true);

    const approved = await acquisitionService.approveRun(run.id);
    expect(approved.status).toBe("human_blocked");
    expect(approved.executionSuggestion.canExecute).toBe(false);
    expect(approved.executionSuggestion.reason).toContain("complete the lifecycle");

    const customReg = approved.registeredCapabilities.find((r) => r.capability === "custom");
    expect(customReg).toBeDefined();
    expect(customReg!.state).toBe("blocked");
    expect(customReg!.note).toContain("sandbox");
    expect(customReg!.note).toContain("blocked from task execution");
    expect(customReg!.availabilityBoundary).toMatchObject({
      proofTier: "local_candidate_registered",
      liveRuntimeVerified: false,
      localCandidateOnly: true,
    });

    const customVerification = approved.verificationResults.find((v) => v.capability === "custom");
    expect(customVerification?.status).toBe("blocked");
    expect(customVerification?.evidence).toContain("Sandbox");
    expect(customVerification?.evidence).toContain("execution remains blocked");
    expect(customVerification?.blocker).toContain("Lifecycle promotion or installation proof");
    expect(customVerification?.availabilityBoundary?.summary).toContain("not proof of external install");
  });

  it("proves the full Studio runProduct → validate → acquire → approve chain with cancelRun rollback (local sandbox proof only)", async () => {
    const { createFridayStudioService } = await import("../../../src/studio/friday-studio-service.js");
    const { validateStudioArtifactAsCandidate, buildStudioArtifactCapabilityCandidate } = await import("../../../src/studio/friday-studio-artifact-candidate-bridge.js");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "friday-e2e-studio-"));
    try {
      const studioService = createFridayStudioService({ workspaceRoot });
      const studioRun = await studioService.runProduct({
        productId: "integration_builder",
        inputs: {
          sourceType: "curl",
          source: "curl -X GET https://api.example.com/items -H 'Content-Type: application/json'",
          name: "E2E Chain Test API",
        },
      });
      expect(studioRun.status).toBe("completed");

      const serviceResult = studioService.validateArtifactCandidate(studioRun.id);
      expect(serviceResult.validation.valid).toBe(true);
      expect(serviceResult.validation.sourceType).toBe("studio_artifact");
      expect(serviceResult.candidates.length).toBeGreaterThan(0);
      expect(serviceResult.candidates.every((c) => c.requiresApproval)).toBe(true);

      const validation = validateStudioArtifactAsCandidate({ run: serviceResult.run });
      const candidates = buildStudioArtifactCapabilityCandidate(validation, serviceResult.run.id);

      const acqRun = await acquisitionService.startRun({
        userId: "test-user",
        goal: "Register studio-generated E2E chain test API",
        requiredCapabilities: ["text", "custom"],
        studioArtifactCandidates: candidates,
      });
      expect(acqRun.status).toBe("awaiting_approval");
      expect(acqRun.candidates.some((c) => c.sourceType === "studio_artifact")).toBe(true);
      expect(acqRun.executionSuggestion.canExecute).toBe(false);
      expect(acqRun.executionSuggestion.nextAction).toBe("approve_run");

      const approved = await acquisitionService.approveRun(acqRun.id);
      expect(approved.status).toBe("human_blocked");
      expect(approved.executionSuggestion.canExecute).toBe(false);
      expect(approved.executionSuggestion.nextAction).toBe("complete_human_setup");
      expect(approved.registeredCapabilities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ capability: "custom", state: "blocked" }),
        ]),
      );

      const rollbackRun = await acquisitionService.startRun({
        userId: "test-user",
        goal: "Rollback test - studio artifact cancellation",
        requiredCapabilities: ["text", "custom"],
        studioArtifactCandidates: candidates,
      });
      expect(rollbackRun.status).toBe("awaiting_approval");
      const cancelled = acquisitionService.cancelRun(rollbackRun.id);
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.executionSuggestion.canExecute).toBe(false);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("keeps OAuth, payment, CAPTCHA, and sensitive permissions human-gated even in max autonomy", () => {
    // updatePolicy is METHOD-level fail-closed (TS-runtime retirement) unless the
    // explicit test-oracle flag is set, so this behavioral assertion uses a local
    // flagged service. The default-off behavior is covered by the dedicated
    // fail-closed tests below; the shared `policyService` stays unflagged.
    const flaggedPolicyService = createFridayAutonomyPolicyService({
      db,
      nowIso: () => `2026-04-25T00:00:${String(++nowCounter).padStart(2, "0")}.000Z`,
      allowTestOnlyAutonomyPolicyMutation: true,
    });
    const policy = flaggedPolicyService.updatePolicy({ mode: "max_autonomy" });

    expect(policy.mode).toBe("max_autonomy");
    expect(policy.riskSwitches.external_download).toBe(true);
    expect(policy.riskSwitches.oauth).toBe(false);

    const decision = flaggedPolicyService.evaluateRisks(["oauth", "payment", "captcha", "sensitive_permission"]);
    expect(decision.allowed).toBe(false);
    expect(decision.hardHumanBlockers.length).toBe(4);
  });

  describe("TS-runtime retirement: updatePolicy METHOD-level fail-closed guard", () => {
    it("fails closed for non-route callers when the test-oracle flag is unset and does NOT mutate the policy", () => {
      // The shared `policyService` is constructed without
      // allowTestOnlyAutonomyPolicyMutation (mirrors production/runtime + the
      // agent controlled-autonomy tool's `policy_update` path). Mutation must be
      // fenced BEFORE any persist.
      const before = policyService.getPolicy();
      expect(before.mode).toBe("low_risk_auto");

      let thrown: unknown;
      try {
        policyService.updatePolicy({ mode: "max_autonomy", paused: true });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(FridayDomainError);
      expect(thrown).toMatchObject({
        code: "TS_RUNTIME_AUTONOMY_POLICY_MUTATION_RETIRED",
        httpStatus: 503,
      });

      // No persist/mutation happened: reads stay live and unchanged.
      const after = policyService.getPolicy();
      expect(after.mode).toBe("low_risk_auto");
      expect(after.paused).toBe(false);
    });

    it("allows the test-oracle path to mutate the policy when the flag is set to true", () => {
      const flaggedPolicyService = createFridayAutonomyPolicyService({
        db,
        nowIso: () => `2026-04-25T00:00:${String(++nowCounter).padStart(2, "0")}.000Z`,
        allowTestOnlyAutonomyPolicyMutation: true,
      });

      const updated = flaggedPolicyService.updatePolicy({ mode: "max_autonomy", paused: true });
      expect(updated.mode).toBe("max_autonomy");
      expect(updated.paused).toBe(true);

      // The mutation persisted: a fresh read reflects it.
      expect(flaggedPolicyService.getPolicy().mode).toBe("max_autonomy");
      expect(flaggedPolicyService.getPolicy().paused).toBe(true);
    });
  });

  describe("TS-runtime retirement: standing-agenda mutators METHOD-level fail-closed guard", () => {
    it("fails closed (503) for create/update when the test-oracle flag is unset, before any persist; reads stay live", async () => {
      // Construct WITHOUT allowTestOnlyStandingAgendaExecution (mirrors
      // production/runtime + any non-route caller). The route is already
      // retired; this fences the off-route method callers.
      const fencedService = createFridayStandingAgendaService({
        db,
        idGenerator: createTestIdGenerator(),
        nowIso: () => `2026-04-25T00:01:${String(++nowCounter).padStart(2, "0")}.000Z`,
        policyService,
        acquisitionService,
      });

      let createThrown: unknown;
      try {
        await fencedService.createStandingGoal({
          userId: "fenced-user",
          objective: "应当被退役守卫拦截的目标",
          title: "blocked goal",
        });
      } catch (error) {
        createThrown = error;
      }
      expect(createThrown).toBeInstanceOf(FridayDomainError);
      expect(createThrown).toMatchObject({
        code: "TS_RUNTIME_STANDING_AGENDA_RETIRED",
        httpStatus: 503,
      });

      let updateThrown: unknown;
      try {
        fencedService.updateStandingGoal("any-goal-id", { title: "x" });
      } catch (error) {
        updateThrown = error;
      }
      expect(updateThrown).toBeInstanceOf(FridayDomainError);
      expect(updateThrown).toMatchObject({
        code: "TS_RUNTIME_STANDING_AGENDA_RETIRED",
        httpStatus: 503,
      });

      // approveAgendaItem (the agent controlled-autonomy `agenda_approve`
      // off-route caller) must ALSO fail closed BEFORE the requireAgendaItem DB
      // read — i.e. the guard fires even for a non-existent agenda id, proving
      // guard-before-lookup (a missing guard would surface AGENDA_ITEM_NOT_FOUND
      // 404 instead of the retirement 503).
      let approveThrown: unknown;
      try {
        fencedService.approveAgendaItem({ agendaItemId: "any-agenda-id", userId: "fenced-user" });
      } catch (error) {
        approveThrown = error;
      }
      expect(approveThrown).toBeInstanceOf(FridayDomainError);
      expect(approveThrown).toMatchObject({
        code: "TS_RUNTIME_STANDING_AGENDA_RETIRED",
        httpStatus: 503,
      });

      // No persist happened — the goal list read stays live and is empty.
      expect(fencedService.listStandingGoals({ userId: "fenced-user" })).toEqual([]);
    });

    it("allows the test-oracle path to create a standing goal when the flag is set to true", async () => {
      // The shared flag-on `standingAgendaService` (beforeEach) proves the
      // intended-live path: create proceeds and persists.
      const result = await standingAgendaService.createStandingGoal({
        userId: "flag-on-user",
        objective: "已授权的目标",
        title: "allowed goal",
      });
      expect(result.goal.status).toBe("active");
      expect(standingAgendaService.listStandingGoals({ userId: "flag-on-user" })).toHaveLength(1);
    });

    it("allows the test-oracle path to approve an agenda item when the flag is set to true", async () => {
      // The shared flag-on `standingAgendaService` (beforeEach) proves the
      // intended-live approveAgendaItem path: it locates the agenda item and
      // transitions it to "approved".
      const created = await standingAgendaService.createStandingGoal({
        userId: "approve-user",
        objective: "需要审批的高风险目标",
        title: "approval goal",
      });
      const approved = standingAgendaService.approveAgendaItem({
        agendaItemId: created.agendaItem.id,
        userId: "approve-user",
      });
      expect(approved.status).toBe("approved");
    });
  });

  it("creates standing-goal agenda and records strategy-only improvement after a low-risk run", async () => {
    const result = await standingAgendaService.createStandingGoal({
      userId: "test-user",
      objective: "每天搜索最新 AI 新闻并总结",
      title: "AI news monitor",
    });

    expect(result.goal.status).toBe("active");
    expect(result.agendaItem.status).toBe("proposed");
    expect(result.agendaItem.approvalRequired).toBe(false);

    const run = await standingAgendaService.runAgendaItem({
      agendaItemId: result.agendaItem.id,
      userId: "test-user",
    });

    expect(run.status).toBe("completed");
    expect(run.verification.passed).toBe(true);
    expect(run.improvementRecords[0]?.changes).toMatchObject({
      modelTraining: false,
    });
  });

  it("blocks high-risk agenda runs until approval or human setup closes the gap", async () => {
    const result = await standingAgendaService.createStandingGoal({
      userId: "test-user",
      objective: "自动识别每天收到的截图文字",
      title: "OCR monitor",
    });

    expect(result.agendaItem.approvalRequired).toBe(true);

    const run = await standingAgendaService.runAgendaItem({
      agendaItemId: result.agendaItem.id,
      userId: "test-user",
    });

    expect(run.status).toBe("blocked");
    expect(run.verification.passed).toBe(false);
    expect(run.rollback.summary).toContain("No side effects");
  });

  describe("TS-runtime retirement: agenda item reaches a terminal state (not stuck 'running') when startRun fails closed", () => {
    it("rethrows the retirement 503 and leaves the item 'failed', never committed at 'running'", async () => {
      // A fail-closed acquisition service (flag UNSET) — exactly the prod/live
      // posture. runAgendaItem persists the item as 'running' BEFORE calling
      // acquisitionService.startRun, which now throws the retirement error.
      const failClosedAcquisition = createFridayCapabilityAcquisitionService({
        db,
        idGenerator: createTestIdGenerator(),
        nowIso: () => `2026-04-26T00:00:${String(++nowCounter).padStart(2, "0")}.000Z`,
        policyService,
        capabilitySnapshotGetter: () => ({ readOnly: false, ...emptyAgentSnapshot(), runtime: matrixWith() }),
        // No allowTestOnlyCapabilityAcquisitionExecution → fail-closed.
      });
      const agendaService = createFridayStandingAgendaService({
        db,
        idGenerator: createTestIdGenerator(),
        nowIso: () => `2026-04-26T01:00:${String(++nowCounter).padStart(2, "0")}.000Z`,
        policyService,
        acquisitionService: failClosedAcquisition,
        // Standing-agenda WRITE is allowed here (this test's subject is the
        // CAPABILITY-acquisition guard firing inside runAgendaItem, not the
        // standing-agenda guard); createStandingGoal is only setup. The
        // capability flag stays UNSET so the 503 still fires in runAgendaItem.
        allowTestOnlyStandingAgendaExecution: true,
      });

      const { agendaItem } = await agendaService.createStandingGoal({
        userId: "test-user",
        objective: "每天搜索最新 AI 新闻并总结",
        title: "AI news monitor (retired)",
      });
      // Low-risk item — no approval gate; runAgendaItem reaches startRun.
      expect(agendaItem.approvalRequired).toBe(false);

      // The retirement semantics are NOT swallowed — the 503 propagates.
      await expect(
        agendaService.runAgendaItem({ agendaItemId: agendaItem.id, userId: "test-user" }),
      ).rejects.toMatchObject({
        code: "TS_RUNTIME_CAPABILITY_ACQUISITION_RETIRED",
        httpStatus: 503,
      });

      // The PERSISTED item must NOT be stuck 'running' — it reaches a terminal
      // 'failed' state so the row is never poisoned.
      const [persisted] = agendaService
        .listAgenda({ userId: "test-user" })
        .filter((item) => item.id === agendaItem.id);
      expect(persisted?.status).toBe("failed");
      expect(persisted?.status).not.toBe("running");
    });
  });
});

function emptyAgentSnapshot() {
  return {
    messaging: { enabled: false, kinds: [] },
    mcp: { enabled: false, serverCount: 0, servers: [] },
    provider: { available: true, configuredCount: 1, mutationBlockedByReadOnly: false },
    browser: {},
    system: { enabled: false },
    desktop: { connected: false },
    companion: { connected: false },
  };
}

function matrixWith(...extraAvailable: FridayRuntimeCapabilityId[]): FridayRuntimeCapabilityMatrix {
  const available = new Set<FridayRuntimeCapabilityId>([
    "text",
    "web_search",
    "web_fetch",
    "file_read",
    "file_write",
    "pdf_parse",
    "browser",
    "skills",
    ...extraAvailable,
  ]);
  const needsAuth = new Set<FridayRuntimeCapabilityId>(["vision", "ocr", "embedding", "tts"]);
  const buildable = new Set<FridayRuntimeCapabilityId>(["custom"]);
  const items = ([
    "text",
    "vision",
    "ocr",
    "embedding",
    "web_search",
    "web_fetch",
    "pdf_parse",
    "file_read",
    "file_write",
    "tts",
    "browser",
    "mcp",
    "skills",
    "custom",
  ] as FridayRuntimeCapabilityId[]).map((capability) => {
    const isAvailable = available.has(capability);
    const state = isAvailable
      ? "available"
      : needsAuth.has(capability)
        ? "needs_user_auth"
        : buildable.has(capability)
          ? "buildable_with_approval"
          : "installable_with_approval";
    return {
      capability,
      label: capability,
      description: `${capability} capability`,
      state,
      sources: isAvailable
        ? [{
            kind: "tool" as const,
            id: capability,
            label: capability,
            status: "verified" as const,
          }]
        : [],
      blockers: isAvailable ? [] : ["not configured"],
      repairOptions: capability === "ocr"
        ? [{
            id: "configure-ocr",
            label: "Configure OCR provider",
            description: "Add OCR provider credentials and verify extraction.",
            kind: "configure_provider" as const,
            requiresApproval: true,
            setupHref: "/setup?recipeId=capability-ocr",
            href: "https://example.com/ocr",
            risks: ["auth" as const, "paid_api" as const, "network" as const, "writes_config" as const],
          }]
        : [],
    };
  });
  return {
    schemaVersion: "1.0",
    generatedAt: "2026-04-25T00:00:00.000Z",
    items,
    summary: {
      available: items.filter((item) => item.state === "available").length,
      needsVerification: 0,
      needsUserAction: items.filter((item) => item.state === "needs_user_auth").length,
      installable: items.filter((item) => item.state === "installable_with_approval" || item.state === "buildable_with_approval").length,
      unsupported: 0,
    },
  };
}
