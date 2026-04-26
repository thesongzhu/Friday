import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "#state";
import type { FridayRuntimeCapabilityId, FridayRuntimeCapabilityMatrix } from "#providers";
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
    });
    standingAgendaService = createFridayStandingAgendaService({
      db,
      idGenerator,
      nowIso,
      policyService,
      acquisitionService,
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

  it("requires approval before a generated custom capability can register", async () => {
    const run = await acquisitionService.startRun({
      userId: "test-user",
      goal: "给我生成一个自定义 API 集成 skill",
      requiredCapabilities: ["text", "custom"],
    });

    expect(run.status).toBe("awaiting_approval");
    expect(run.approvalReasons.join("\n")).toContain("custom");

    const approved = await acquisitionService.approveRun(run.id);
    expect(approved.status).toBe("verified");
    expect(approved.executionSuggestion.canExecute).toBe(true);
    expect(approved.registeredCapabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: "custom", state: "available" }),
      ]),
    );
  });

  it("keeps OAuth, payment, CAPTCHA, and sensitive permissions human-gated even in max autonomy", () => {
    const policy = policyService.updatePolicy({ mode: "max_autonomy" });

    expect(policy.mode).toBe("max_autonomy");
    expect(policy.riskSwitches.external_download).toBe(true);
    expect(policy.riskSwitches.oauth).toBe(false);

    const decision = policyService.evaluateRisks(["oauth", "payment", "captcha", "sensitive_permission"]);
    expect(decision.allowed).toBe(false);
    expect(decision.hardHumanBlockers.length).toBe(4);
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

function matrixWith(): FridayRuntimeCapabilityMatrix {
  const available = new Set<FridayRuntimeCapabilityId>([
    "text",
    "web_search",
    "web_fetch",
    "file_read",
    "file_write",
    "pdf_parse",
    "browser",
    "skills",
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
