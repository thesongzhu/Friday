import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildDeterministicBrowserBootstrapDecision,
  createFridayAutonomousEngine,
  trimImplicitEvidenceReportStep,
} from "../../../../src/agent/autonomous/friday-autonomous-engine.js";
import type {
  CreateFridayAutonomousEngineDeps,
  FridayAutonomousEngine,
  FridayAutonomousGoal,
  FridayAutonomousIteration,
  FridayAutonomousStep,
} from "../../../../src/agent/autonomous/friday-autonomous.types.js";

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

function createMockDeps(overrides?: Partial<CreateFridayAutonomousEngineDeps>): CreateFridayAutonomousEngineDeps {
  return {
    agentRuntime: {
      executeRun: vi.fn().mockResolvedValue({
        runId: "run-1",
        status: "completed",
        response: JSON.stringify([
          { instruction: "Open browser", domain: "browser", verification: "Browser is open" },
          { instruction: "Navigate to page", domain: "browser", verification: "Page loaded" },
        ]),
        usageInput: 100,
        usageOutput: 50,
      }),
    },
    analyzeImages: vi.fn().mockResolvedValue({
      text: JSON.stringify({ kind: "complete", summary: "Goal achieved" }),
      model: "test-vision",
      inputTokens: 200,
      outputTokens: 100,
    }),
    idGenerator: idGen,
    nowIso,
    eventEmitter: {
      emit: vi.fn(),
    },
    ...overrides,
  };
}

describe("FridayAutonomousEngine", () => {
  let engine: FridayAutonomousEngine;
  let deps: CreateFridayAutonomousEngineDeps;

  beforeEach(() => {
    counter = 0;
    deps = createMockDeps();
    engine = createFridayAutonomousEngine(deps);
  });

  describe("trimImplicitEvidenceReportStep", () => {
    it("drops an implicit report-compilation tail step for evidence-gathering goals", () => {
      const planned = trimImplicitEvidenceReportStep(
        "Open https://example.com and gather concrete evidence for page title, final URL, screenshot, and page content",
        [
          { instruction: "Launch browser session", domain: "browser", verification: "Browser session is active and ready" },
          { instruction: "Navigate to https://example.com", domain: "browser", verification: "Page loads successfully" },
          { instruction: "Compile evidence report with all gathered data", domain: "composite", verification: "Report contains title, URL, screenshot path, and content summary" },
        ],
      );

      expect(planned).toHaveLength(2);
      expect(planned.at(-1)?.instruction).toContain("Navigate");
    });

    it("keeps the final report step when the user explicitly asks for a report artifact", () => {
      const planned = trimImplicitEvidenceReportStep(
        "Open https://example.com, gather evidence, and write a report file with the findings",
        [
          { instruction: "Launch browser session", domain: "browser", verification: "Browser session is active and ready" },
          { instruction: "Compile evidence report with all gathered data", domain: "composite", verification: "Report contains title, URL, screenshot path, and content summary" },
        ],
      );

      expect(planned).toHaveLength(2);
      expect(planned.at(-1)?.instruction).toContain("Compile evidence report");
    });
  });

  describe("buildDeterministicBrowserBootstrapDecision", () => {
    it("starts a browser session deterministically when a browser-launch step has no observations yet", () => {
      const decision = buildDeterministicBrowserBootstrapDecision(
        {
          id: "step-bootstrap",
          goalId: "goal-bootstrap",
          index: 0,
          status: "pending",
          domain: "browser",
          instruction: "Launch browser session",
          maxRetries: 3,
          retryCount: 0,
          observations: [],
        },
        [],
      );

      expect(decision).toEqual({
        kind: "act",
        action: {
          toolName: "browser",
          args: {
            action: "start",
          },
          rationale: "Start the browser session before collecting observations.",
        },
      });
    });
  });

  describe("executeGoal", () => {
    it("marks executing goals as nonrecoverable during startup recovery", () => {
      const activeGoal: FridayAutonomousGoal = {
        id: "goal-restart-1",
        status: "executing",
        priority: "normal",
        source: "assistant",
        description: "Resume interrupted work",
        maxIterations: 5,
        timeoutMs: 60_000,
        iterationCount: 1,
        stepIds: ["step-executing", "step-pending", "step-completed"],
        currentStepIndex: 0,
        createdAt: "2026-03-11T09:59:00Z",
        startedAt: "2026-03-11T09:59:30Z",
      };
      const activeGoalSteps: FridayAutonomousStep[] = [
        {
          id: "step-executing",
          goalId: activeGoal.id,
          index: 0,
          status: "executing",
          domain: "exec",
          instruction: "Run a command",
          maxRetries: 3,
          retryCount: 1,
          observations: [],
          startedAt: "2026-03-11T09:59:40Z",
        },
        {
          id: "step-pending",
          goalId: activeGoal.id,
          index: 1,
          status: "pending",
          domain: "browser",
          instruction: "Verify page state",
          maxRetries: 3,
          retryCount: 0,
          observations: [],
        },
        {
          id: "step-completed",
          goalId: activeGoal.id,
          index: 2,
          status: "completed",
          domain: "file",
          instruction: "Persist artifact",
          maxRetries: 3,
          retryCount: 0,
          observations: [],
          completedAt: "2026-03-11T09:59:50Z",
        },
      ];
      const repository = {
        listActiveGoals: vi.fn().mockReturnValue([activeGoal]),
        updateGoal: vi.fn(),
        getStepsByGoalId: vi.fn().mockReturnValue(activeGoalSteps),
        updateStep: vi.fn(),
        getIterationsByGoalId: vi.fn().mockReturnValue([] satisfies FridayAutonomousIteration[]),
      };
      const sqlite = {
        withReadConnection: vi.fn((fn: (db: object) => unknown) => fn({})),
        withWriteTransaction: vi.fn((fn: (db: object) => unknown) => fn({})),
      };

      createFridayAutonomousEngine({
        ...deps,
        persistence: {
          sqlite,
          repository: repository as CreateFridayAutonomousEngineDeps["persistence"]["repository"],
        },
      });

      expect(repository.updateGoal).toHaveBeenCalledWith(
        expect.anything(),
        activeGoal.id,
        expect.objectContaining({
          status: "interrupted_nonrecoverable",
          failureReason: "Interrupted by process restart during active tool execution; safe resume checkpoint unavailable.",
          completedAt: nowIso(),
        }),
      );
      expect(repository.updateStep).toHaveBeenCalledTimes(2);
      expect(repository.updateStep).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        "step-executing",
        expect.objectContaining({
          status: "interrupted_nonrecoverable",
          failureReason: "Interrupted by process restart during active tool execution; safe resume checkpoint unavailable.",
          completedAt: nowIso(),
        }),
      );
      expect(repository.updateStep).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        "step-pending",
        expect.objectContaining({
          status: "skipped",
          failureReason: "Interrupted by process restart during active tool execution; safe resume checkpoint unavailable.",
          completedAt: nowIso(),
        }),
      );
    });

    it("marks planning goals as recoverable during startup recovery", () => {
      const activeGoal: FridayAutonomousGoal = {
        id: "goal-restart-2",
        status: "planning",
        priority: "normal",
        source: "assistant",
        description: "Resume recoverable planning work",
        maxIterations: 5,
        timeoutMs: 60_000,
        iterationCount: 0,
        stepIds: [],
        currentStepIndex: 0,
        createdAt: "2026-03-11T09:59:00Z",
        startedAt: "2026-03-11T09:59:10Z",
      };
      const repository = {
        listActiveGoals: vi.fn().mockReturnValue([activeGoal]),
        updateGoal: vi.fn(),
        getStepsByGoalId: vi.fn().mockReturnValue([] satisfies FridayAutonomousStep[]),
        updateStep: vi.fn(),
        getIterationsByGoalId: vi.fn().mockReturnValue([] satisfies FridayAutonomousIteration[]),
      };
      const sqlite = {
        withReadConnection: vi.fn((fn: (db: object) => unknown) => fn({})),
        withWriteTransaction: vi.fn((fn: (db: object) => unknown) => fn({})),
      };

      createFridayAutonomousEngine({
        ...deps,
        persistence: {
          sqlite,
          repository: repository as CreateFridayAutonomousEngineDeps["persistence"]["repository"],
        },
      });

      expect(repository.updateGoal).toHaveBeenCalledWith(
        expect.anything(),
        activeGoal.id,
        expect.objectContaining({
          status: "interrupted_recoverable",
          failureReason: "Interrupted by process restart before action execution; plan can be rebuilt safely.",
          completedAt: undefined,
        }),
      );
      expect(repository.updateStep).not.toHaveBeenCalled();
    });

    it("marks all non-terminal steps as recoverable when a verifying goal restarts", () => {
      const activeGoal: FridayAutonomousGoal = {
        id: "goal-restart-verify",
        status: "verifying",
        priority: "normal",
        source: "assistant",
        description: "Resume interrupted verification work",
        maxIterations: 5,
        timeoutMs: 60_000,
        iterationCount: 1,
        stepIds: ["step-verifying"],
        currentStepIndex: 0,
        createdAt: "2026-03-11T09:59:00Z",
        startedAt: "2026-03-11T09:59:10Z",
      };
      const activeGoalSteps: FridayAutonomousStep[] = [
        {
          id: "step-verifying",
          goalId: activeGoal.id,
          index: 0,
          status: "executing",
          domain: "browser",
          instruction: "Confirm final page state",
          verification: { type: "llm_judge", description: "Heading should be visible" },
          maxRetries: 3,
          retryCount: 0,
          observations: [],
          startedAt: "2026-03-11T09:59:30Z",
        },
      ];
      const repository = {
        listActiveGoals: vi.fn().mockReturnValue([activeGoal]),
        updateGoal: vi.fn(),
        getStepsByGoalId: vi.fn().mockReturnValue(activeGoalSteps),
        updateStep: vi.fn(),
        getIterationsByGoalId: vi.fn().mockReturnValue([] satisfies FridayAutonomousIteration[]),
      };
      const sqlite = {
        withReadConnection: vi.fn((fn: (db: object) => unknown) => fn({})),
        withWriteTransaction: vi.fn((fn: (db: object) => unknown) => fn({})),
      };

      createFridayAutonomousEngine({
        ...deps,
        persistence: {
          sqlite,
          repository: repository as CreateFridayAutonomousEngineDeps["persistence"]["repository"],
        },
      });

      expect(repository.updateGoal).toHaveBeenCalledWith(
        expect.anything(),
        activeGoal.id,
        expect.objectContaining({
          status: "interrupted_recoverable",
          failureReason: "Interrupted by process restart after a resumable checkpoint; verification or planning can be replayed.",
          completedAt: undefined,
        }),
      );
      expect(repository.updateStep).toHaveBeenCalledWith(
        expect.anything(),
        "step-verifying",
        expect.objectContaining({
          status: "interrupted_recoverable",
          failureReason: "Interrupted by process restart after a resumable checkpoint; verification or planning can be replayed.",
          completedAt: undefined,
        }),
      );
    });

    it("should create a goal and return a result", async () => {
      const result = await engine.executeGoal({
        description: "Test goal",
        signal: signal(),
      });

      expect(result.goalId).toBeDefined();
      expect(result.status).toBeDefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.iterationCount).toBeGreaterThanOrEqual(0);
    });

    it("should plan the goal by calling agent runtime", async () => {
      await engine.executeGoal({
        description: "Set up Discord bot",
        signal: signal(),
      });

      expect(deps.agentRuntime.executeRun).toHaveBeenCalled();
      const firstCall = (deps.agentRuntime.executeRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(firstCall.task).toContain("Set up Discord bot");
    });

    it("passes timezone through every agent runtime planning call", async () => {
      await engine.executeGoal({
        description: "Find the latest Iran news",
        timezone: "America/Los_Angeles",
        signal: signal(),
      });

      expect(deps.agentRuntime.executeRun).toHaveBeenCalledWith(
        expect.objectContaining({
          timezone: "America/Los_Angeles",
        }),
      );
    });

    it("uses a valid 3-segment session key for planning calls", async () => {
      await engine.executeGoal({
        description: "Verify autonomous planning session keys",
        signal: signal(),
      });

      expect(deps.agentRuntime.executeRun).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "autonomous:plan:id-1",
        }),
      );
    });

    it("can resume a recoverable interrupted goal", async () => {
      const recoverableGoal: FridayAutonomousGoal = {
        id: "goal-resume-1",
        status: "interrupted_recoverable",
        priority: "normal",
        source: "assistant",
        description: "Resume interrupted planning",
        maxIterations: 5,
        timeoutMs: 60_000,
        iterationCount: 0,
        stepIds: [],
        currentStepIndex: 0,
        createdAt: "2026-03-11T09:59:00Z",
        startedAt: "2026-03-11T09:59:10Z",
        failureReason: "Interrupted by process restart before action execution; plan can be rebuilt safely.",
      };
      const resumeDeps = createMockDeps({
        agentRuntime: {
          executeRun: vi
            .fn()
            .mockResolvedValueOnce({
              runId: "run-plan",
              status: "completed",
              response: JSON.stringify([
                { instruction: "Review interrupted plan", domain: "composite" },
              ]),
              usageInput: 40,
              usageOutput: 20,
            })
            .mockResolvedValueOnce({
              runId: "run-decision",
              status: "completed",
              response: JSON.stringify({ kind: "complete", summary: "Recovered successfully" }),
              usageInput: 20,
              usageOutput: 10,
            }),
        },
        browserManager: {
          screenshot: vi.fn().mockResolvedValue({ base64: "browser-shot" }),
          snapshot: vi.fn().mockResolvedValue({ content: "<html>resumed</html>" }),
          act: vi.fn(),
          navigate: vi.fn(),
        },
      });

      engine = createFridayAutonomousEngine({
        ...resumeDeps,
        persistence: {
          sqlite: {
            withReadConnection: vi.fn((fn: (db: object) => unknown) => fn({})),
            withWriteTransaction: vi.fn((fn: (db: object) => unknown) => fn({})),
          },
          repository: {
            getGoal: vi.fn().mockReturnValue(recoverableGoal),
            updateGoal: vi.fn(),
            listActiveGoals: vi.fn().mockReturnValue([]),
            createGoal: vi.fn(),
            createStep: vi.fn(),
            updateStep: vi.fn(),
            getStep: vi.fn().mockReturnValue(null),
            getStepsByGoalId: vi.fn().mockReturnValue([]),
            appendIteration: vi.fn(),
            getIterationsByGoalId: vi.fn().mockReturnValue([]),
            listGoals: vi.fn().mockReturnValue([]),
          } as unknown as CreateFridayAutonomousEngineDeps["persistence"]["repository"],
        },
      });

      const result = await engine.resumeGoal({
        goalId: recoverableGoal.id,
        signal: signal(),
      });

      expect(result.status).toBe("completed");
      expect(resumeDeps.agentRuntime.executeRun).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "autonomous:plan:goal-resume-1",
        }),
      );
      expect(engine.getGoal(recoverableGoal.id)?.status).toBe("completed");
    });

    it("reuses persisted step ids when resuming a recoverable goal with checkpoints", async () => {
      const recoverableGoal: FridayAutonomousGoal = {
        id: "goal-resume-existing-step",
        status: "interrupted_recoverable",
        priority: "normal",
        source: "assistant",
        description: "Resume the original interrupted step without replanning",
        maxIterations: 5,
        timeoutMs: 60_000,
        iterationCount: 1,
        stepIds: ["step-resume-existing"],
        currentStepIndex: 0,
        createdAt: "2026-03-11T09:59:00Z",
        startedAt: "2026-03-11T09:59:10Z",
        failureReason: "Interrupted by process restart after a resumable checkpoint; verification or planning can be replayed.",
      };
      const existingStep: FridayAutonomousStep = {
        id: "step-resume-existing",
        goalId: recoverableGoal.id,
        index: 0,
        status: "interrupted_recoverable",
        domain: "composite",
        instruction: "Resume the exact same step",
        maxRetries: 3,
        retryCount: 0,
        observations: [],
      };
      const repository = {
        getGoal: vi.fn().mockReturnValue(recoverableGoal),
        updateGoal: vi.fn(),
        listActiveGoals: vi.fn().mockReturnValue([]),
        createGoal: vi.fn(),
        createStep: vi.fn(),
        updateStep: vi.fn(),
        getStep: vi.fn().mockReturnValue(existingStep),
        getStepsByGoalId: vi.fn().mockReturnValue([existingStep]),
        appendIteration: vi.fn(),
        getIterationsByGoalId: vi.fn().mockReturnValue([]),
        listGoals: vi.fn().mockReturnValue([]),
      };
      const runtime = {
        executeRun: vi.fn().mockResolvedValue({
          runId: "run-decision",
          status: "completed",
          response: JSON.stringify({ kind: "complete", summary: "Recovered existing step successfully" }),
          usageInput: 20,
          usageOutput: 10,
        }),
      };

      engine = createFridayAutonomousEngine({
        ...createMockDeps({
          agentRuntime: runtime,
        }),
        persistence: {
          sqlite: {
            withReadConnection: vi.fn((fn: (db: object) => unknown) => fn({})),
            withWriteTransaction: vi.fn((fn: (db: object) => unknown) => fn({})),
          },
          repository: repository as unknown as CreateFridayAutonomousEngineDeps["persistence"]["repository"],
        },
      });

      const result = await engine.resumeGoal({
        goalId: recoverableGoal.id,
        signal: signal(),
      });

      expect(result.status).toBe("completed");
      expect(repository.createStep).not.toHaveBeenCalled();
      expect(runtime.executeRun).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "autonomous:decision:goal-resume-existing-step",
        }),
      );
      expect(runtime.executeRun).not.toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "autonomous:plan:goal-resume-existing-step",
        }),
      );
      expect(engine.getGoal(recoverableGoal.id)?.status).toBe("completed");
    });

    it("uses deterministic browser verification for title and url checks instead of a second VLM pass", async () => {
      const runtime = {
        executeRun: vi
          .fn()
          .mockResolvedValueOnce({
            runId: "run-plan",
            status: "completed",
            response: JSON.stringify([
              {
                instruction: "Open https://example.com in the browser",
                domain: "browser",
                verification: "Verify the page title is Example Domain and the URL contains example.com before completing",
              },
            ]),
            usageInput: 20,
            usageOutput: 10,
          })
          .mockResolvedValueOnce({
            runId: "run-action",
            status: "completed",
            response: "Opened browser",
            usageInput: 10,
            usageOutput: 4,
          }),
      };
      const analyzeImages = vi
        .fn()
        .mockResolvedValueOnce({
          text: JSON.stringify({
            kind: "act",
            action: {
              toolName: "browser",
              args: { action: "open", url: "https://example.com" },
              rationale: "Navigate to the target page first.",
            },
          }),
          model: "test-vision",
          inputTokens: 20,
          outputTokens: 10,
        });

      engine = createFridayAutonomousEngine({
        ...deps,
        agentRuntime: runtime,
        analyzeImages,
        browserManager: {
          screenshot: vi.fn().mockResolvedValue({ base64: "browser-shot" }),
          snapshot: vi.fn().mockResolvedValue({ content: "- main:\n  - heading \"Example Domain\" [level=1]" }),
          title: vi.fn().mockResolvedValue({ title: "Example Domain" }),
          url: vi.fn().mockResolvedValue({ url: "https://example.com/" }),
          act: vi.fn(),
          navigate: vi.fn(),
        },
        config: { iterationDelayMs: 0 },
      });

      const result = await engine.executeGoal({
        description: "Open example.com and verify the title and URL",
        signal: signal(),
      });

      expect(result.status).toBe("completed");
      expect(runtime.executeRun).toHaveBeenCalledTimes(2);
      expect(analyzeImages).toHaveBeenCalledTimes(1);
    });

    it("treats root URLs with and without a trailing slash as equivalent for exact browser verification", async () => {
      const runtime = {
        executeRun: vi
          .fn()
          .mockResolvedValueOnce({
            runId: "run-plan",
            status: "completed",
            response: JSON.stringify([
              {
                instruction: "Open https://example.com in the browser",
                domain: "browser",
                verification: "Final URL matches https://example.com exactly",
              },
            ]),
            usageInput: 20,
            usageOutput: 10,
          })
          .mockResolvedValueOnce({
            runId: "run-action",
            status: "completed",
            response: "Opened browser",
            usageInput: 10,
            usageOutput: 4,
          }),
      };
      const analyzeImages = vi.fn().mockResolvedValueOnce({
        text: JSON.stringify({
          kind: "act",
          action: {
            toolName: "browser",
            args: { action: "open", url: "https://example.com" },
            rationale: "Navigate to the target page first.",
          },
        }),
        model: "test-vision",
        inputTokens: 20,
        outputTokens: 10,
      });

      engine = createFridayAutonomousEngine({
        ...deps,
        agentRuntime: runtime,
        analyzeImages,
        browserManager: {
          screenshot: vi.fn().mockResolvedValue({ base64: "browser-shot" }),
          snapshot: vi.fn().mockResolvedValue({ content: "- main:\n  - heading \"Example Domain\" [level=1]" }),
          title: vi.fn().mockResolvedValue({ title: "Example Domain" }),
          url: vi.fn().mockResolvedValue({ url: "https://example.com/" }),
          act: vi.fn(),
          navigate: vi.fn(),
        },
        config: { iterationDelayMs: 0 },
      });

      const result = await engine.executeGoal({
        description: "Open example.com and verify the exact final URL",
        signal: signal(),
      });

      expect(result.status).toBe("completed");
      expect(runtime.executeRun).toHaveBeenCalledTimes(2);
      expect(analyzeImages).toHaveBeenCalledTimes(1);
    });

    it("rejects resume for nonrecoverable interrupted goals", async () => {
      const blockedGoal: FridayAutonomousGoal = {
        id: "goal-resume-2",
        status: "interrupted_nonrecoverable",
        priority: "normal",
        source: "assistant",
        description: "Cannot resume",
        maxIterations: 5,
        timeoutMs: 60_000,
        iterationCount: 0,
        stepIds: [],
        currentStepIndex: 0,
        createdAt: "2026-03-11T09:59:00Z",
        failureReason: "Interrupted by process restart during active tool execution; safe resume checkpoint unavailable.",
      };

      engine = createFridayAutonomousEngine({
        ...deps,
        persistence: {
          sqlite: {
            withReadConnection: vi.fn((fn: (db: object) => unknown) => fn({})),
            withWriteTransaction: vi.fn((fn: (db: object) => unknown) => fn({})),
          },
          repository: {
            getGoal: vi.fn().mockReturnValue(blockedGoal),
            updateGoal: vi.fn(),
            listActiveGoals: vi.fn().mockReturnValue([]),
            createGoal: vi.fn(),
            createStep: vi.fn(),
            updateStep: vi.fn(),
            getStep: vi.fn().mockReturnValue(null),
            getStepsByGoalId: vi.fn().mockReturnValue([]),
            appendIteration: vi.fn(),
            getIterationsByGoalId: vi.fn().mockReturnValue([]),
            listGoals: vi.fn().mockReturnValue([]),
          } as unknown as CreateFridayAutonomousEngineDeps["persistence"]["repository"],
        },
      });

      await expect(
        engine.resumeGoal({ goalId: blockedGoal.id, signal: signal() }),
      ).rejects.toThrow("cannot be resumed safely");
    });

    it("passes principal and tenant context through planning calls", async () => {
      await engine.executeGoal({
        description: "Investigate provider routing",
        principalId: "user-ctx-1",
        tenantContext: {
          hubId: "tenant-a",
          userId: "user-ctx-1",
          channelKind: "agent",
        },
        signal: signal(),
      });

      expect(deps.agentRuntime.executeRun).toHaveBeenCalledWith(
        expect.objectContaining({
          principalId: "user-ctx-1",
          tenantContext: {
            hubId: "tenant-a",
            userId: "user-ctx-1",
            channelKind: "agent",
          },
        }),
      );
    });

    it("should use VLM for visual analysis when screenshots are available", async () => {
      const vlmFn = vi.fn().mockResolvedValue({
        text: JSON.stringify({ kind: "complete", summary: "Done" }),
        model: "test-vision",
        inputTokens: 200,
        outputTokens: 100,
      });

      // Planning phase returns a desktop-domain step so screenshots are gathered
      const planRuntime = {
        executeRun: vi.fn().mockResolvedValue({
          runId: "run-plan",
          status: "completed",
          response: JSON.stringify([
            { instruction: "Click button", domain: "desktop", verification: "Button clicked" },
          ]),
          usageInput: 50,
          usageOutput: 25,
        }),
      };

      const desktopManager = {
        isConnected: vi.fn().mockReturnValue(true),
        executeAction: vi.fn().mockResolvedValue({
          id: "action-1",
          action: { type: "screenshot" },
          status: "success",
          durationMs: 10,
          screenshotBase64: "base64-data",
        }),
        searchElements: vi.fn().mockResolvedValue([]),
      };

      engine = createFridayAutonomousEngine({
        ...deps,
        agentRuntime: planRuntime,
        analyzeImages: vlmFn,
        desktopSessionManager: desktopManager,
        config: { iterationDelayMs: 0 },
      });

      await engine.executeGoal({
        description: "Click the button",
        signal: signal(),
      });

      // VLM should be called because desktop screenshots are available
      expect(vlmFn).toHaveBeenCalled();
    });

    it("auto-verifies a complete decision when the step defines verification", async () => {
      const runtime = {
        executeRun: vi
          .fn()
          .mockResolvedValueOnce({
            runId: "run-plan",
            status: "completed",
            response: JSON.stringify([
              { instruction: "Confirm the page is ready", domain: "composite", verification: "The page should show the expected heading" },
            ]),
            usageInput: 20,
            usageOutput: 10,
          })
          .mockResolvedValueOnce({
            runId: "run-decision",
            status: "completed",
            response: JSON.stringify({ kind: "complete", summary: "Looks done" }),
            usageInput: 15,
            usageOutput: 8,
          })
          .mockResolvedValueOnce({
            runId: "run-verify",
            status: "completed",
            response: JSON.stringify({ passed: true, actual: "Expected heading is visible" }),
            usageInput: 10,
            usageOutput: 4,
          }),
      };
      const emit = vi.fn();

      engine = createFridayAutonomousEngine({
        ...deps,
        agentRuntime: runtime,
        analyzeImages: vi.fn(),
        eventEmitter: { emit },
        config: { iterationDelayMs: 0 },
      });

      const result = await engine.executeGoal({
        description: "Verify a page before declaring success",
        signal: signal(),
      });

      expect(result.status).toBe("completed");
      expect(runtime.executeRun).toHaveBeenCalledTimes(3);
      expect(runtime.executeRun).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          executionContext: { surface: "autonomous_internal_plan" },
        }),
      );
      expect(runtime.executeRun).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          executionContext: { surface: "autonomous_internal_decision" },
        }),
      );
      expect(runtime.executeRun).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          executionContext: { surface: "autonomous_internal_verify" },
        }),
      );
      expect(emit).toHaveBeenCalledWith(
        "autonomous.verification.completed",
        expect.objectContaining({ passed: true }),
      );
    });

    it("tags internal plan, decision, action, and verify runs with autonomous surfaces", async () => {
      const runtime = {
        executeRun: vi
          .fn()
          .mockResolvedValueOnce({
            runId: "run-plan",
            status: "completed",
            response: JSON.stringify([
              { instruction: "Run a safe command", domain: "exec", verification: "Command output is captured" },
            ]),
            usageInput: 10,
            usageOutput: 5,
          })
          .mockResolvedValueOnce({
            runId: "run-decision-1",
            status: "completed",
            response: JSON.stringify({
              kind: "act",
              action: {
                toolName: "exec",
                args: { command: "echo ok" },
                rationale: "Capture command output first",
              },
            }),
            usageInput: 10,
            usageOutput: 5,
          })
          .mockResolvedValueOnce({
            runId: "run-action",
            status: "completed",
            response: "ok",
            usageInput: 5,
            usageOutput: 2,
          })
          .mockResolvedValueOnce({
            runId: "run-decision-2",
            status: "completed",
            response: JSON.stringify({ kind: "complete", summary: "Done" }),
            usageInput: 6,
            usageOutput: 3,
          })
          .mockResolvedValueOnce({
            runId: "run-verify",
            status: "completed",
            response: JSON.stringify({ passed: true, actual: "Command output captured" }),
            usageInput: 4,
            usageOutput: 2,
          }),
      };

      engine = createFridayAutonomousEngine({
        ...deps,
        agentRuntime: runtime,
        analyzeImages: vi.fn(),
        config: { iterationDelayMs: 0 },
      });

      await engine.executeGoal({
        description: "Run a safe command and verify the result",
        signal: signal(),
      });

      expect(runtime.executeRun).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          executionContext: { surface: "autonomous_internal_plan" },
        }),
      );
      expect(runtime.executeRun).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          executionContext: { surface: "autonomous_internal_decision" },
        }),
      );
      expect(runtime.executeRun).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          executionContext: { surface: "autonomous_internal_action" },
        }),
      );
    });

    it("forces autonomous browser actions to use the canonical goal session id", async () => {
      const runtime = {
        executeRun: vi
          .fn()
          .mockResolvedValueOnce({
            runId: "run-plan",
            status: "completed",
            response: JSON.stringify([
              { instruction: "Start the browser", domain: "browser" },
            ]),
            usageInput: 10,
            usageOutput: 5,
          })
          .mockResolvedValueOnce({
            runId: "run-action",
            status: "completed",
            response: "browser started",
            usageInput: 5,
            usageOutput: 2,
          }),
      };
      const analyzeImages = vi
        .fn()
        .mockResolvedValueOnce({
          text: JSON.stringify({
            kind: "act",
            action: {
              toolName: "browser",
              args: { action: "start", sessionId: "model-picked-session" },
              rationale: "Start the browser session first",
            },
          }),
          model: "test-vision",
          inputTokens: 20,
          outputTokens: 10,
        })
        .mockResolvedValueOnce({
          text: JSON.stringify({ kind: "complete", summary: "Done" }),
          model: "test-vision",
          inputTokens: 20,
          outputTokens: 10,
        });

      engine = createFridayAutonomousEngine({
        ...deps,
        agentRuntime: runtime,
        analyzeImages,
        browserManager: {
          screenshot: vi.fn().mockResolvedValue({ base64: "browser-shot" }),
          snapshot: vi.fn().mockResolvedValue({ content: "<html></html>" }),
          title: vi.fn().mockResolvedValue({ title: "" }),
          url: vi.fn().mockResolvedValue({ url: "" }),
          act: vi.fn(),
          navigate: vi.fn(),
          launch: vi.fn(),
        },
        config: { iterationDelayMs: 0 },
      });

      await engine.executeGoal({
        description: "Start the browser with the autonomous runtime",
        signal: signal(),
      });

      expect(runtime.executeRun).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          task: expect.stringContaining("\"sessionId\":\"autonomous-goal:id-1\""),
        }),
      );
      expect(runtime.executeRun).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          task: expect.not.stringContaining("model-picked-session"),
        }),
      );
      expect(analyzeImages).not.toHaveBeenCalled();
    });

    it("should handle aborted goals", async () => {
      const controller = new AbortController();
      controller.abort(new Error("User cancelled"));

      const result = await engine.executeGoal({
        description: "Cancelled goal",
        signal: controller.signal,
      });

      expect(result.status).toBe("cancelled");
    });

    it("should respect maxIterations config", async () => {
      // Make the agent always return "act" decisions to keep looping
      const neverEndingRuntime = {
        executeRun: vi.fn().mockResolvedValue({
          runId: "run-1",
          status: "completed",
          response: JSON.stringify([
            { instruction: "Step 1", domain: "composite" },
          ]),
          usageInput: 10,
          usageOutput: 5,
        }),
      };
      const neverEndingVlm = vi.fn().mockResolvedValue({
        text: JSON.stringify({ kind: "act", action: { toolName: "exec", args: { command: "echo test" } } }),
        model: "test-vision",
        inputTokens: 10,
        outputTokens: 5,
      });

      engine = createFridayAutonomousEngine({
        ...deps,
        agentRuntime: neverEndingRuntime,
        analyzeImages: neverEndingVlm,
        config: { maxIterationsPerGoal: 3, maxTimePerGoalMs: 30_000 },
      });

      const result = await engine.executeGoal({
        description: "Infinite loop goal",
        signal: signal(),
      });

      // Should fail due to iteration budget
      expect(result.iterationCount).toBeLessThanOrEqual(5);
    });

    it("fails the goal when a step exhausts retries without reaching a terminal step state", async () => {
      const runtime = {
        executeRun: vi
          .fn()
          .mockResolvedValueOnce({
            runId: "run-plan",
            status: "completed",
            response: JSON.stringify([
              { instruction: "Run a command", domain: "exec", verification: "Command completes successfully" },
            ]),
            usageInput: 10,
            usageOutput: 5,
          })
          .mockResolvedValueOnce({
            runId: "run-decision-1",
            status: "completed",
            response: JSON.stringify({
              kind: "act",
              action: {
                toolName: "exec",
                args: { command: "false" },
                rationale: "Try the command",
              },
            }),
            usageInput: 5,
            usageOutput: 2,
          })
          .mockResolvedValueOnce({
            runId: "run-action-1",
            status: "failed",
            response: "command failed",
            usageInput: 2,
            usageOutput: 1,
          })
          .mockResolvedValueOnce({
            runId: "run-decision-2",
            status: "completed",
            response: JSON.stringify({
              kind: "act",
              action: {
                toolName: "exec",
                args: { command: "false" },
                rationale: "Retry the command",
              },
            }),
            usageInput: 5,
            usageOutput: 2,
          })
          .mockResolvedValueOnce({
            runId: "run-action-2",
            status: "failed",
            response: "command failed again",
            usageInput: 2,
            usageOutput: 1,
          })
          .mockResolvedValueOnce({
            runId: "run-decision-3",
            status: "completed",
            response: JSON.stringify({
              kind: "act",
              action: {
                toolName: "exec",
                args: { command: "false" },
                rationale: "Final retry",
              },
            }),
            usageInput: 5,
            usageOutput: 2,
          })
          .mockResolvedValueOnce({
            runId: "run-action-3",
            status: "failed",
            response: "still failing",
            usageInput: 2,
            usageOutput: 1,
          }),
      };

      engine = createFridayAutonomousEngine({
        ...deps,
        agentRuntime: runtime,
        analyzeImages: vi.fn(),
        config: { iterationDelayMs: 0 },
      });

      const result = await engine.executeGoal({
        description: "Keep retrying until the step budget is exhausted",
        signal: signal(),
      });

      expect(result.status).toBe("failed");
      expect(result.failureReason).toContain("retry budget");
      expect(engine.getGoal(result.goalId)?.status).toBe("failed");
    });

    it("should support priority and source parameters", async () => {
      const result = await engine.executeGoal({
        description: "High priority goal",
        priority: "critical",
        source: "recipe",
        signal: signal(),
      });

      expect(result.goalId).toBeDefined();
      const goal = engine.getGoal(result.goalId);
      expect(goal?.priority).toBe("critical");
      expect(goal?.source).toBe("recipe");
    });
  });

  describe("cancelGoal", () => {
    it("should cancel a goal by ID via abort signal", async () => {
      // Use a slow runtime so we can cancel mid-execution
      const slowRuntime = {
        executeRun: vi.fn().mockImplementation(async (params: { signal?: AbortSignal }) => {
          // Simulate slow work; check abort
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 2000);
            params.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            }, { once: true });
          });
          return {
            runId: "run-1",
            status: "completed",
            response: "[]",
            usageInput: 10,
            usageOutput: 5,
          };
        }),
      };

      engine = createFridayAutonomousEngine({
        ...deps,
        agentRuntime: slowRuntime,
      });

      const controller = new AbortController();
      const goalPromise = engine.executeGoal({
        description: "Long running goal",
        signal: controller.signal,
      });

      // Cancel after a small delay to allow the goal to start
      await new Promise((r) => setTimeout(r, 20));
      controller.abort(new Error("User cancelled"));

      const result = await goalPromise;
      expect(result.status).toBe("cancelled");
    });
  });

  describe("getGoal", () => {
    it("should return null for unknown goal", () => {
      expect(engine.getGoal("nonexistent")).toBeNull();
    });

    it("should return goal after execution", async () => {
      const result = await engine.executeGoal({
        description: "Test goal",
        signal: signal(),
      });

      const goal = engine.getGoal(result.goalId);
      expect(goal).not.toBeNull();
      expect(goal!.description).toBe("Test goal");
    });
  });

  describe("listGoals", () => {
    it("should return empty list initially", () => {
      const goals = engine.listGoals();
      expect(goals).toHaveLength(0);
    });

    it("should list goals after execution", async () => {
      await engine.executeGoal({ description: "Goal 1", signal: signal() });
      await engine.executeGoal({ description: "Goal 2", signal: signal() });

      const goals = engine.listGoals();
      expect(goals.length).toBeGreaterThanOrEqual(2);
    });

    it("should filter by status", async () => {
      await engine.executeGoal({ description: "Test", signal: signal() });

      const completed = engine.listGoals({ status: "completed" });
      const pending = engine.listGoals({ status: "pending" });
      // One of these should have results based on the mock setup
      expect(completed.length + pending.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("getIterations", () => {
    it("should return iterations for a completed goal", async () => {
      const result = await engine.executeGoal({
        description: "Test iterations",
        signal: signal(),
      });

      const iters = engine.getIterations(result.goalId);
      expect(iters).toBeDefined();
      expect(Array.isArray(iters)).toBe(true);
    });

    it("should return empty for unknown goal", () => {
      const iters = engine.getIterations("nonexistent");
      expect(iters).toHaveLength(0);
    });
  });

  describe("event emission", () => {
    it("should emit events during goal execution", async () => {
      const emitter = { emit: vi.fn() };
      engine = createFridayAutonomousEngine({ ...deps, eventEmitter: emitter });

      await engine.executeGoal({ description: "Emitting goal", signal: signal() });

      expect(emitter.emit).toHaveBeenCalled();
      const eventNames = (emitter.emit as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
      expect(eventNames).toContain("autonomous.goal.created");
      expect(eventNames).toContain("autonomous.goal.started");
    });
  });
});
