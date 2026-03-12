import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFridaySetupAssistant } from "../../../src/setup/friday-setup-assistant.js";
import type { CreateFridaySetupAssistantDeps } from "../../../src/setup/friday-setup-assistant.js";
import { createOnboardingEngine } from "../../../src/uix/engine/onboarding-engine.js";
import type { FridaySetupRecipeRegistry, FridaySetupRecipeExecutor, FridayEnvironmentScanner } from "../../../src/setup/friday-setup.types.js";
import type { FridaySetupCoordinator } from "../../../src/setup/friday-setup-coordinator.types.js";
import type { FridayPrerequisiteInstaller } from "../../../src/setup/friday-setup-prerequisite-installer.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

let counter = 0;
function idGen(): string {
  return `id-${++counter}`;
}
function nowIso(): string {
  return "2026-03-11T10:00:00Z";
}

function createMockRegistry(): FridaySetupRecipeRegistry {
  return {
    register: vi.fn(),
    get: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([
      {
        id: "channel-discord-bot",
        name: "Discord Bot Setup",
        description: "Set up a Discord bot",
        version: "1.0.0",
        category: "channel",
        targetService: "discord",
        steps: [{
          id: "s1",
          index: 0,
          domain: "browser",
          instruction: "Create the Discord bot in the developer portal.",
          guidance: "Open the Discord developer portal and create a new bot application.",
          requiresApproval: false,
          verification: {
            method: "visual",
            expected: "Bot created",
            description: "The Discord bot application exists in the portal.",
          },
          risk: "low",
          maxRetries: 2,
        }],
        outputs: [{ key: "botToken", label: "Bot Token", sensitive: true }],
        prerequisites: [
          {
            type: "network_reachable",
            target: "https://discord.com",
            description: "Discord reachable",
            blocking: true,
          },
        ],
      },
    ]),
    getByTarget: vi.fn(),
  };
}

function createMockExecutor(): FridaySetupRecipeExecutor {
  return {
    execute: vi.fn().mockResolvedValue({
      id: "exec-001",
      recipeId: "channel-discord-bot",
      status: "completed",
      currentStepIndex: 1,
      stepResults: [{ stepId: "s1", status: "completed", outputs: {}, approachIndex: 0 }],
      outputs: { botToken: "test-token-abc123" },
      prerequisiteResults: [],
      createdAt: "2026-03-11T10:00:00Z",
      completedAt: "2026-03-11T10:05:00Z",
    }),
    checkPrerequisites: vi.fn().mockResolvedValue([
      { type: "network_reachable", target: "https://discord.com", met: true, actual: "reachable" },
    ]),
    getExecution: vi.fn().mockReturnValue(null),
    cancelExecution: vi.fn(),
    listExecutions: vi.fn().mockReturnValue([]),
  };
}

function createMockScanner(): FridayEnvironmentScanner {
  return {
    isInstalled: vi.fn().mockResolvedValue(true),
    getVersion: vi.fn().mockResolvedValue("22.0.0"),
    isReachable: vi.fn().mockResolvedValue(true),
    fileExists: vi.fn().mockResolvedValue(true),
    getEnvVar: vi.fn().mockReturnValue("value"),
    getOs: vi.fn().mockReturnValue("darwin"),
    scan: vi.fn().mockResolvedValue({
      os: "darwin",
      arch: "arm64",
      nodeVersion: "22.0.0",
      npmVersion: "10.0.0",
      pythonVersion: "3.12.0",
      gitVersion: "2.43.0",
      dockerVersion: null,
      installedBrowsers: ["chrome"],
      networkConnectivity: true,
    }),
  };
}

function createMockCoordinator(): FridaySetupCoordinator {
  const session = {
    id: "coord-1",
    recipeId: "",
    executionId: "",
    phase: "idle" as const,
    activeDomain: null,
    handoffHistory: [],
    sharedContext: {},
    createdAt: "2026-03-11T10:00:00Z",
    updatedAt: "2026-03-11T10:00:00Z",
  };

  return {
    createSession: vi.fn().mockReturnValue(session),
    acquireDomain: vi.fn().mockReturnValue({ ...session, phase: "acquired" }),
    handoff: vi.fn().mockReturnValue(session),
    releaseDomain: vi.fn().mockReturnValue({ ...session, phase: "idle" }),
    setSharedContext: vi.fn().mockReturnValue(session),
    getSession: vi.fn().mockReturnValue(session),
    failSession: vi.fn().mockReturnValue({ ...session, phase: "failed" }),
    closeSession: vi.fn().mockReturnValue({ ...session, phase: "released" }),
  };
}

function createMockPrereqInstaller(): FridayPrerequisiteInstaller {
  return {
    planInstallations: vi.fn().mockResolvedValue([]),
    install: vi.fn().mockResolvedValue({ software: "node", status: "installed", version: "22.0.0" }),
    installAll: vi.fn().mockResolvedValue([{ software: "node", status: "not_needed", version: "22.0.0" }]),
  };
}

function createDeps(overrides?: Partial<CreateFridaySetupAssistantDeps>): CreateFridaySetupAssistantDeps {
  return {
    onboardingEngine: createOnboardingEngine(),
    recipeRegistry: createMockRegistry(),
    recipeExecutor: createMockExecutor(),
    environmentScanner: createMockScanner(),
    coordinator: createMockCoordinator(),
    prerequisiteInstaller: createMockPrereqInstaller(),
    idGenerator: idGen,
    nowIso,
    ...overrides,
  };
}

describe("FridaySetupAssistant", () => {
  beforeEach(() => {
    counter = 0;
  });

  describe("planSetup", () => {
    it("should return a setup plan", async () => {
      const assistant = createFridaySetupAssistant(createDeps());
      const plan = await assistant.planSetup();

      expect(plan.length).toBeGreaterThan(0);
      expect(plan[0].recipeId).toBe("channel-discord-bot");
      expect(plan[0].prerequisitesMet).toBe(true);
    });

    it("should identify missing prerequisites", async () => {
      const executor = createMockExecutor();
      (executor.checkPrerequisites as ReturnType<typeof vi.fn>).mockResolvedValue([
        { type: "software_installed", target: "node", met: false, actual: null, fixInstruction: "Install Node.js" },
      ]);

      const assistant = createFridaySetupAssistant(createDeps({ recipeExecutor: executor }));
      const plan = await assistant.planSetup();

      expect(plan[0].prerequisitesMet).toBe(false);
      expect(plan[0].missingPrerequisites).toContain("node");
    });
  });

  describe("executeSetup", () => {
    it("should execute setup and complete successfully", async () => {
      const deps = createDeps();
      const assistant = createFridaySetupAssistant(deps);

      const result = await assistant.executeSetup({
        signal: signal(),
        principalId: "user-1",
      });

      expect(result.phase).toBe("completed");
      expect(result.completedRecipes).toBe(1);
      expect(result.failedRecipes).toBe(0);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].status).toBe("completed");
    });

    it("should handle recipe execution failure", async () => {
      const executor = createMockExecutor();
      (executor.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "exec-001",
        recipeId: "channel-discord-bot",
        status: "failed",
        currentStepIndex: 0,
        stepResults: [{
          stepId: "s1",
          status: "failed",
          outputs: {},
          approachIndex: 0,
          failureReason: "Browser crashed",
        }],
        outputs: {},
        prerequisiteResults: [],
        failureReason: "Browser crashed",
        createdAt: "2026-03-11T10:00:00Z",
      });

      const assistant = createFridaySetupAssistant(createDeps({ recipeExecutor: executor }));
      const result = await assistant.executeSetup({ signal: signal() });

      expect(result.failedRecipes).toBe(1);
      expect(result.results[0].status).toBe("failed");
      expect(result.results[0].failureReason).toBe("Browser crashed");
    });

    it("should skip recipes when cancelled", async () => {
      const controller = new AbortController();
      // Create an executor that aborts mid-execution
      const slowExecutor = createMockExecutor();
      (slowExecutor.execute as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        // Simulate the abort happening during recipe execution
        controller.abort();
        throw new Error("Aborted");
      });

      const assistant = createFridaySetupAssistant(createDeps({ recipeExecutor: slowExecutor }));
      const result = await assistant.executeSetup({
        signal: controller.signal,
      });

      // Recipe should be failed since execution threw
      expect(result.failedRecipes).toBe(1);
    });

    it("should skip prerequisites when configured", async () => {
      const prereqInstaller = createMockPrereqInstaller();
      const assistant = createFridaySetupAssistant(createDeps({ prerequisiteInstaller: prereqInstaller }));

      await assistant.executeSetup({
        signal: signal(),
        skipPrerequisites: true,
      });

      expect(prereqInstaller.installAll).not.toHaveBeenCalled();
    });

    it("should show/hide companion overlay", async () => {
      const companionBridge = {
        setOverlayVisible: vi.fn().mockResolvedValue({ visible: true, changedAt: "2026-03-11T10:00:00Z" }),
      };

      const assistant = createFridaySetupAssistant(createDeps({ companionBridge }));
      await assistant.executeSetup({ signal: signal() });

      expect(companionBridge.setOverlayVisible).toHaveBeenCalledWith(true);
      expect(companionBridge.setOverlayVisible).toHaveBeenCalledWith(false);
    });

    it("should emit events during setup", async () => {
      const emitter = { emit: vi.fn() };
      const assistant = createFridaySetupAssistant(createDeps({ eventEmitter: emitter }));

      await assistant.executeSetup({ signal: signal() });

      const eventNames = (emitter.emit as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
      expect(eventNames).toContain("setup.assistant.phase_changed");
      expect(eventNames).toContain("setup.assistant.scan_completed");
      expect(eventNames).toContain("setup.assistant.recipe_started");
      expect(eventNames).toContain("setup.assistant.recipe_completed");
      expect(eventNames).toContain("setup.assistant.completed");
    });

    it("should execute only specified recipe IDs", async () => {
      const registry = createMockRegistry();
      const executor = createMockExecutor();
      const assistant = createFridaySetupAssistant(createDeps({
        recipeRegistry: registry,
        recipeExecutor: executor,
      }));

      await assistant.executeSetup({
        recipeIds: ["channel-discord-bot"],
        signal: signal(),
      });

      expect(executor.execute).toHaveBeenCalledWith(
        expect.objectContaining({ recipeId: "channel-discord-bot" }),
      );
    });
  });

  describe("getProgress", () => {
    it("should return idle progress before setup starts", () => {
      const assistant = createFridaySetupAssistant(createDeps());
      const progress = assistant.getProgress();

      expect(progress.phase).toBe("idle");
      expect(progress.totalRecipes).toBe(0);
      expect(progress.completedRecipes).toBe(0);
    });

    it("should return progress during setup", async () => {
      const assistant = createFridaySetupAssistant(createDeps());
      await assistant.executeSetup({ signal: signal() });

      const progress = assistant.getProgress();
      expect(progress.completedRecipes).toBe(1);
      expect(progress.percentComplete).toBeGreaterThan(0);
    });
  });

  describe("cancel", () => {
    it("should cancel an active setup", () => {
      const assistant = createFridaySetupAssistant(createDeps());
      assistant.cancel();

      const progress = assistant.getProgress();
      expect(progress.phase).toBe("failed");
    });
  });
});
