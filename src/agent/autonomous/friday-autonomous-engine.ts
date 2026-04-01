/**
 * Autonomous Perception-Action Loop Engine.
 *
 * Implements the core "observe → reason → act → verify" loop that enables
 * Friday to autonomously complete goals by controlling the desktop and browser.
 *
 * This is the "conductor" that orchestrates desktop control, browser automation,
 * and image analysis primitives into goal-driven autonomous task completion.
 *
 * @module agent/autonomous
 */

import { FridayDomainError } from "#errors";

import type {
  CreateFridayAutonomousEngineDeps,
  FridayAutonomousActionResult,
  FridayAutonomousDecision,
  FridayAutonomousEngine,
  FridayAutonomousEngineConfig,
  FridayAutonomousGoal,
  FridayAutonomousGoalListFilters,
  FridayAutonomousGoalParams,
  FridayAutonomousGoalResult,
  FridayAutonomousGoalStatus,
  FridayAutonomousIteration,
  FridayAutonomousObservation,
  FridayAutonomousStep,
  FridayAutonomousStepStatus,
  FridayAutonomousVerificationCheck,
  ISODateTime,
  UUID,
} from "./friday-autonomous.types.js";
import { FRIDAY_AUTONOMOUS_DEFAULT_CONFIG } from "./friday-autonomous.types.js";

// ─── Constants ───

const PLANNING_PROMPT_PREFIX = `You are an autonomous agent that can control a computer. You must decompose this goal into concrete, actionable steps.

For each step, specify:
- instruction: what to do (human-readable)
- domain: "desktop" | "browser" | "exec" | "file" | "composite"
- verification: how to verify it worked

Return a JSON array of steps. Example:
[
  { "instruction": "Open Chrome browser", "domain": "desktop", "verification": "Chrome window is visible" },
  { "instruction": "Navigate to discord.com/developers", "domain": "browser", "verification": "URL contains discord.com/developers" }
]

Goal: `;

const DECISION_PROMPT_PREFIX = `You are an autonomous agent controlling a computer. Based on your observations, decide what to do next.

Current goal: {goal}
Current step: {step}
Step {stepIndex} of {totalSteps}

Your observations are attached as images and/or text below.

Respond with a JSON object with one of these formats:
- {"kind": "act", "action": {"toolName": "...", "args": {...}, "rationale": "..."}} — execute a tool action
- {"kind": "verify", "checks": [{"type": "visual", "description": "...", "expected": "..."}]} — verify current state
- {"kind": "replan", "reason": "...", "newSteps": ["step1", "step2"]} — re-plan remaining steps
- {"kind": "delegate", "subGoalDescription": "..."} — delegate to a sub-goal
- {"kind": "ask_user", "question": "..."} — ask the user for input
- {"kind": "abort", "reason": "..."} — give up
- {"kind": "complete", "summary": "..."} — goal is complete

Observations:
`;

const VERIFICATION_PROMPT_PREFIX = `You are verifying whether a computer automation step succeeded.

Step instruction: {instruction}
Expected outcome: {expected}

Look at the screenshot/observations and determine if the step succeeded.
Respond with JSON: {"passed": true/false, "actual": "description of what you see"}

Observations:
`;

// ─── Factory ───

export function createFridayAutonomousEngine(
  deps: CreateFridayAutonomousEngineDeps,
): FridayAutonomousEngine {
  const {
    agentRuntime,
    analyzeImages,
    desktopSessionManager,
    browserManager,
    idGenerator,
    nowIso,
    eventEmitter,
  } = deps;

  const config: FridayAutonomousEngineConfig = {
    ...FRIDAY_AUTONOMOUS_DEFAULT_CONFIG,
    ...deps.config,
  };

  // ─── In-memory state ───
  const goals = new Map<UUID, FridayAutonomousGoal>();
  const steps = new Map<UUID, FridayAutonomousStep>();
  const iterations = new Map<UUID, FridayAutonomousIteration[]>();
  const abortControllers = new Map<UUID, AbortController>();

  // ─── Emit helper ───
  function emit(event: string, payload: Record<string, unknown>): void {
    eventEmitter?.emit(event as never, payload);
  }

  // ─── Perception helpers ───

  async function captureDesktopScreenshot(signal: AbortSignal): Promise<string | null> {
    if (!desktopSessionManager?.isConnected()) return null;
    try {
      const result = await desktopSessionManager.executeAction({ type: "screenshot" });
      if (result.status === "failed") return null;
      return result.screenshotBase64 ?? null;
    } catch (err) {
      console.warn("[friday][autonomous-engine] desktop screenshot failed:", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  async function captureBrowserScreenshot(sessionId: string, signal: AbortSignal): Promise<string | null> {
    if (!browserManager) return null;
    try {
      const result = await browserManager.screenshot(sessionId);
      return result.base64;
    } catch (err) {
      console.warn("[friday][autonomous-engine] browser screenshot failed:", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  async function captureBrowserSnapshot(sessionId: string, signal: AbortSignal): Promise<string | null> {
    if (!browserManager) return null;
    try {
      const result = await browserManager.snapshot(sessionId);
      return result.content;
    } catch (err) {
      console.warn("[friday][autonomous-engine] browser snapshot failed:", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  async function captureDesktopElements(query: string, signal: AbortSignal): Promise<string | null> {
    if (!desktopSessionManager?.isConnected()) return null;
    try {
      const elements = await desktopSessionManager.searchElements(query);
      return JSON.stringify(elements, null, 2);
    } catch (err) {
      console.warn("[friday][autonomous-engine] desktop element search failed:", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /**
   * Gather observations about the current environment state.
   */
  async function gatherObservations(
    stepId: UUID,
    domain: string,
    signal: AbortSignal,
  ): Promise<FridayAutonomousObservation[]> {
    const obs: FridayAutonomousObservation[] = [];

    if (config.screenshotBeforeDecision) {
      if (domain === "desktop" || domain === "composite") {
        const screenshot = await captureDesktopScreenshot(signal);
        if (screenshot) {
          obs.push({
            id: idGenerator(),
            stepId,
            source: "screenshot",
            timestamp: nowIso(),
            screenshotBase64: screenshot,
          });
        }
      }
      if (domain === "browser" || domain === "composite") {
        const screenshot = await captureBrowserScreenshot("default", signal);
        if (screenshot) {
          obs.push({
            id: idGenerator(),
            stepId,
            source: "screenshot",
            timestamp: nowIso(),
            screenshotBase64: screenshot,
          });
        }
      }
    }

    if (config.structuredSnapshotBeforeDecision) {
      if (domain === "browser" || domain === "composite") {
        const snapshot = await captureBrowserSnapshot("default", signal);
        if (snapshot) {
          obs.push({
            id: idGenerator(),
            stepId,
            source: "dom_snapshot",
            timestamp: nowIso(),
            structuredData: snapshot,
          });
        }
      }
    }

    return obs;
  }

  /**
   * Use VLM to analyze observations and decide what to do.
   */
  async function analyzeAndDecide(
    goal: FridayAutonomousGoal,
    step: FridayAutonomousStep,
    observations: readonly FridayAutonomousObservation[],
    timezone: string | undefined,
    principalId: string | undefined,
    tenantContext: FridayAutonomousGoalParams["tenantContext"],
    signal: AbortSignal,
  ): Promise<{
    reasoning: string;
    decision: FridayAutonomousDecision;
    usageInput: number;
    usageOutput: number;
  }> {
    // Build the prompt
    const goalSteps = goal.stepIds.map((id) => steps.get(id)).filter(Boolean);
    const prompt = DECISION_PROMPT_PREFIX
      .replace("{goal}", goal.description)
      .replace("{step}", step.instruction)
      .replace("{stepIndex}", String(step.index + 1))
      .replace("{totalSteps}", String(goalSteps.length));

    // Collect images for VLM
    const images: { type: "base64" | "url"; data?: string; mimeType?: string }[] = [];
    let textContext = "";

    for (const obs of observations) {
      if (obs.screenshotBase64) {
        images.push({ type: "base64", data: obs.screenshotBase64, mimeType: "image/png" });
      }
      if (obs.structuredData) {
        textContext += `\n--- ${obs.source} ---\n${obs.structuredData}\n`;
      }
      if (obs.textContent) {
        textContext += `\n--- ${obs.source} ---\n${obs.textContent}\n`;
      }
    }

    const fullPrompt = prompt + textContext;

    if (images.length > 0) {
      // Use VLM for visual + text analysis
      const result = await analyzeImages(
        {
          prompt: fullPrompt,
          images,
          model: config.vlmModel,
          detail: "high",
          maxTokens: 2048,
        },
        signal,
      );

      const parsed = parseDecisionResponse(result.text);
      return {
        reasoning: result.text,
        decision: parsed,
        usageInput: result.inputTokens ?? 0,
        usageOutput: result.outputTokens ?? 0,
      };
    }

    // Text-only fallback via agent runtime
    const result = await agentRuntime.executeRun({
      task: fullPrompt,
      sessionKey: `autonomous-${goal.id}`,
      timezone,
      principalId,
      tenantContext,
      timeoutMs: 30_000,
      signal,
    });

    const parsed = parseDecisionResponse(result.response);
    return {
      reasoning: result.response,
      decision: parsed,
      usageInput: result.usageInput,
      usageOutput: result.usageOutput,
    };
  }

  /**
   * Parse the LLM's JSON response into a typed decision.
   */
  function parseDecisionResponse(raw: string): FridayAutonomousDecision {
    try {
      // Extract JSON from the response (may be wrapped in markdown code blocks)
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { kind: "abort", reason: `Could not parse decision from LLM response: ${raw.slice(0, 200)}` };
      }
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

      const kind = parsed.kind as string;
      switch (kind) {
        case "act":
          return {
            kind: "act",
            action: {
              toolName: (parsed.action as Record<string, unknown>)?.toolName as string ?? "unknown",
              args: (parsed.action as Record<string, unknown>)?.args as Record<string, unknown> ?? {},
              rationale: (parsed.action as Record<string, unknown>)?.rationale as string | undefined,
            },
          };
        case "verify":
          return {
            kind: "verify",
            checks: ((parsed.checks as unknown[]) ?? []).map((c) => {
              const check = c as Record<string, unknown>;
              return {
                type: (check.type as string ?? "visual") as FridayAutonomousVerificationCheck["type"],
                description: check.description as string ?? "",
                expected: check.expected as string | undefined,
              };
            }),
          };
        case "replan":
          return {
            kind: "replan",
            reason: parsed.reason as string ?? "",
            newSteps: (parsed.newSteps as string[]) ?? [],
          };
        case "delegate":
          return { kind: "delegate", subGoalDescription: parsed.subGoalDescription as string ?? "" };
        case "ask_user":
          return { kind: "ask_user", question: parsed.question as string ?? "" };
        case "abort":
          return { kind: "abort", reason: parsed.reason as string ?? "" };
        case "complete":
          return { kind: "complete", summary: parsed.summary as string ?? "" };
        default:
          return { kind: "abort", reason: `Unknown decision kind: ${kind}` };
      }
    } catch (err) {
      return { kind: "abort", reason: `Failed to parse decision: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * Execute a decided action using the agent runtime.
   */
  async function executeAction(
    decision: Extract<FridayAutonomousDecision, { kind: "act" }>,
    domain: string,
    timezone: string | undefined,
    principalId: string | undefined,
    tenantContext: FridayAutonomousGoalParams["tenantContext"],
    signal: AbortSignal,
  ): Promise<FridayAutonomousActionResult> {
    const { action } = decision;
    const startedAt = Date.now();

    try {
      // Use agent runtime to execute the tool call
      const result = await agentRuntime.executeRun({
        task: `Execute the following tool call and return the result:\nTool: ${action.toolName}\nArguments: ${JSON.stringify(action.args)}\n\nRationale: ${action.rationale ?? "N/A"}`,
        sessionKey: `autonomous-action-${idGenerator()}`,
        timezone,
        principalId,
        tenantContext,
        timeoutMs: 60_000,
        signal,
      });

      // Capture post-action screenshot for verification
      let screenshotAfter: string | undefined;
      if (domain === "desktop" || domain === "composite") {
        screenshotAfter = (await captureDesktopScreenshot(signal)) ?? undefined;
      } else if (domain === "browser") {
        screenshotAfter = (await captureBrowserScreenshot("default", signal)) ?? undefined;
      }

      return {
        success: result.status === "completed",
        toolName: action.toolName,
        output: result.response,
        screenshotAfter,
      };
    } catch (err) {
      return {
        success: false,
        toolName: action.toolName,
        output: "",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Verify a step using VLM analysis of the current state.
   */
  async function verifyStep(
    step: FridayAutonomousStep,
    observations: readonly FridayAutonomousObservation[],
    timezone: string | undefined,
    principalId: string | undefined,
    tenantContext: FridayAutonomousGoalParams["tenantContext"],
    signal: AbortSignal,
  ): Promise<{ passed: boolean; actual: string }> {
    if (!step.verification) {
      // No verification defined — assume success
      return { passed: true, actual: "No verification criteria defined" };
    }

    const prompt = VERIFICATION_PROMPT_PREFIX
      .replace("{instruction}", step.instruction)
      .replace("{expected}", step.verification.expected ?? step.verification.description);

    const images: { type: "base64"; data: string; mimeType: string }[] = [];
    let textContext = "";

    for (const obs of observations) {
      if (obs.screenshotBase64) {
        images.push({ type: "base64", data: obs.screenshotBase64, mimeType: "image/png" });
      }
      if (obs.structuredData) {
        textContext += `\n${obs.structuredData}\n`;
      }
      if (obs.textContent) {
        textContext += `\n${obs.textContent}\n`;
      }
    }

    try {
      if (images.length > 0) {
        const result = await analyzeImages(
          {
            prompt: prompt + textContext,
            images,
            model: config.vlmModel,
            detail: "high",
            maxTokens: 512,
          },
          signal,
        );

        const jsonMatch = result.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as { passed?: boolean; actual?: string };
          return {
            passed: parsed.passed === true,
            actual: parsed.actual ?? result.text,
          };
        }
        return { passed: false, actual: result.text };
      }

      // Text-only fallback
      const result = await agentRuntime.executeRun({
        task: prompt + textContext,
        timezone,
        principalId,
        tenantContext,
        timeoutMs: 30_000,
        signal,
      });

      const jsonMatch = result.response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as { passed?: boolean; actual?: string };
        return {
          passed: parsed.passed === true,
          actual: parsed.actual ?? result.response,
        };
      }
      return { passed: false, actual: result.response };
    } catch (err) {
      console.warn("[friday][autonomous-engine] verification failed:", err instanceof Error ? err.message : String(err));
      return { passed: false, actual: "Verification failed due to error" };
    }
  }

  /**
   * Plan step decomposition for a goal.
   */
  async function planGoal(
    goal: FridayAutonomousGoal,
    timezone: string | undefined,
    principalId: string | undefined,
    tenantContext: FridayAutonomousGoalParams["tenantContext"],
    signal: AbortSignal,
  ): Promise<FridayAutonomousStep[]> {
    // If recipe context provides step hints, use those directly
    if (goal.source === "recipe" && (goal as unknown as { recipeContext?: { stepHints?: string[] } }).recipeContext?.stepHints) {
      // Not reachable via the public interface type but kept for future recipe integration
    }

    const planResult = await agentRuntime.executeRun({
      task: PLANNING_PROMPT_PREFIX + goal.description,
      sessionKey: `autonomous-plan-${goal.id}`,
      timezone,
      principalId,
      tenantContext,
      timeoutMs: 60_000,
      signal,
    });

    const plannedSteps = parsePlanResponse(planResult.response, goal.id);
    return plannedSteps;
  }

  /**
   * Parse the planning LLM response into steps.
   */
  function parsePlanResponse(raw: string, goalId: UUID): FridayAutonomousStep[] {
    try {
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        // Single-step fallback
        return [createStep(goalId, 0, "Execute the goal directly", "composite")];
      }

      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        instruction?: string;
        domain?: string;
        verification?: string;
      }>;

      return parsed.map((item, index) =>
        createStep(
          goalId,
          index,
          item.instruction ?? `Step ${index + 1}`,
          (item.domain ?? "composite") as FridayAutonomousStep["domain"],
          item.verification,
        ),
      );
    } catch (err) {
      console.warn("[friday][autonomous-engine] plan decomposition failed:", err instanceof Error ? err.message : String(err));
      return [createStep(goalId, 0, "Execute the goal directly", "composite")];
    }
  }

  function createStep(
    goalId: UUID,
    index: number,
    instruction: string,
    domain: FridayAutonomousStep["domain"],
    verificationDesc?: string,
  ): FridayAutonomousStep {
    const step: FridayAutonomousStep = {
      id: idGenerator(),
      goalId,
      index,
      status: "pending",
      domain,
      instruction,
      verification: verificationDesc
        ? { type: "llm_judge", description: verificationDesc }
        : undefined,
      maxRetries: config.maxRetriesPerStep,
      retryCount: 0,
      observations: [],
    };
    steps.set(step.id, step);
    return step;
  }

  /**
   * Update a goal in the in-memory store.
   */
  function updateGoal(goalId: UUID, updates: Partial<FridayAutonomousGoal>): FridayAutonomousGoal {
    const current = goals.get(goalId);
    if (!current) throw new FridayDomainError("NOT_FOUND", `Goal ${goalId} not found`, { httpStatus: 404 });
    const updated = { ...current, ...updates } as FridayAutonomousGoal;
    goals.set(goalId, updated);
    return updated;
  }

  /**
   * Update a step in the in-memory store.
   */
  function updateStep(stepId: UUID, updates: Partial<FridayAutonomousStep>): FridayAutonomousStep {
    const current = steps.get(stepId);
    if (!current) throw new FridayDomainError("NOT_FOUND", `Step ${stepId} not found`, { httpStatus: 404 });
    const updated = { ...current, ...updates } as FridayAutonomousStep;
    steps.set(stepId, updated);
    return updated;
  }

  // ─── Main execution loop ───

  async function runGoal(
    goal: FridayAutonomousGoal,
    timezone: string | undefined,
    principalId: string | undefined,
    tenantContext: FridayAutonomousGoalParams["tenantContext"],
    signal: AbortSignal,
  ): Promise<FridayAutonomousGoalResult> {
    const startedAt = Date.now();
    let totalUsageInput = 0;
    let totalUsageOutput = 0;
    let currentGoal = goal;
    const goalIterations: FridayAutonomousIteration[] = [];

    try {
      // ─── Phase 1: Planning ───
      currentGoal = updateGoal(goal.id, { status: "planning", startedAt: nowIso() });
      emit("autonomous.goal.started", { goalId: goal.id, description: goal.description });

      const plannedSteps = await planGoal(currentGoal, timezone, principalId, tenantContext, signal);
      const stepIds = plannedSteps.map((s) => s.id);
      currentGoal = updateGoal(goal.id, {
        status: "executing",
        stepIds,
        currentStepIndex: 0,
      });

      // ─── Phase 2: Step-by-step execution ───
      for (let si = 0; si < stepIds.length; si++) {
        if (signal.aborted) break;

        const stepId = stepIds[si];
        let currentStep = steps.get(stepId)!;
        currentGoal = updateGoal(goal.id, { currentStepIndex: si });

        updateStep(stepId, { status: "executing", startedAt: nowIso() });
        emit("autonomous.step.started", { goalId: goal.id, stepId, instruction: currentStep.instruction });

        let stepCompleted = false;
        let stepRetries = 0;

        while (!stepCompleted && stepRetries < currentStep.maxRetries) {
          if (signal.aborted) break;

          // Check iteration budget
          const iterIndex = goalIterations.length;
          if (iterIndex >= currentGoal.maxIterations) {
            updateStep(stepId, {
              status: "failed",
              completedAt: nowIso(),
              failureReason: "Iteration budget exhausted",
            });
            emit("autonomous.step.failed", { goalId: goal.id, stepId, reason: "Iteration budget exhausted" });
            break;
          }

          // Check time budget
          if (Date.now() - startedAt > currentGoal.timeoutMs) {
            updateStep(stepId, {
              status: "failed",
              completedAt: nowIso(),
              failureReason: "Time budget exhausted",
            });
            emit("autonomous.step.failed", { goalId: goal.id, stepId, reason: "Time budget exhausted" });
            break;
          }

          // ─── Observe ───
          const observations = await gatherObservations(stepId, currentStep.domain, signal);
          for (const obs of observations) {
            emit("autonomous.observation.captured", { goalId: goal.id, stepId, source: obs.source });
          }

          // ─── Reason + Decide ───
          emit("autonomous.iteration.started", { goalId: goal.id, stepId, index: iterIndex });
          const iterStartedAt = Date.now();

          const { reasoning, decision, usageInput, usageOutput } = await analyzeAndDecide(
            currentGoal,
            currentStep,
            observations,
            timezone,
            principalId,
            tenantContext,
            signal,
          );
          totalUsageInput += usageInput;
          totalUsageOutput += usageOutput;

          emit("autonomous.decision.made", { goalId: goal.id, stepId, kind: decision.kind });

          // ─── Act on decision ───
          let actionResult: FridayAutonomousActionResult | undefined;

          switch (decision.kind) {
            case "act": {
              actionResult = await executeAction(decision, currentStep.domain, timezone, principalId, tenantContext, signal);
              emit("autonomous.action.executed", {
                goalId: goal.id,
                stepId,
                toolName: actionResult.toolName,
                success: actionResult.success,
              });

              if (!actionResult.success) {
                stepRetries++;
                updateStep(stepId, { retryCount: stepRetries });
              }
              break;
            }

            case "verify": {
              // Capture fresh observations for verification
              const verifyObs = await gatherObservations(stepId, currentStep.domain, signal);
              const verifyResult = await verifyStep(currentStep, verifyObs, timezone, principalId, tenantContext, signal);
              emit("autonomous.verification.completed", {
                goalId: goal.id,
                stepId,
                passed: verifyResult.passed,
              });

              if (verifyResult.passed) {
                stepCompleted = true;
                updateStep(stepId, { status: "completed", completedAt: nowIso() });
                emit("autonomous.step.completed", { goalId: goal.id, stepId });
              } else {
                stepRetries++;
                updateStep(stepId, { retryCount: stepRetries });
              }
              break;
            }

            case "complete": {
              stepCompleted = true;
              updateStep(stepId, { status: "completed", completedAt: nowIso() });
              emit("autonomous.step.completed", { goalId: goal.id, stepId });
              break;
            }

            case "replan": {
              // Replace remaining steps with new ones
              const newStepObjects = decision.newSteps.map((instruction, idx) =>
                createStep(goal.id, si + 1 + idx, instruction, "composite"),
              );
              const newStepIds = [...stepIds.slice(0, si + 1), ...newStepObjects.map((s) => s.id)];
              currentGoal = updateGoal(goal.id, { stepIds: newStepIds });
              stepCompleted = true;
              updateStep(stepId, { status: "completed", completedAt: nowIso() });
              break;
            }

            case "delegate": {
              // Spawn a sub-goal
              const subResult = await runGoal(
                createGoalRecord({
                  description: decision.subGoalDescription,
                  source: "assistant",
                  parentGoalId: goal.id,
                }),
                timezone,
                principalId,
                tenantContext,
                signal,
              );
              totalUsageInput += subResult.usageInput;
              totalUsageOutput += subResult.usageOutput;

              if (subResult.status === "completed") {
                stepCompleted = true;
                updateStep(stepId, { status: "completed", completedAt: nowIso() });
              } else {
                stepRetries++;
                updateStep(stepId, { retryCount: stepRetries });
              }
              break;
            }

            case "ask_user": {
              // For now, we cannot block for user input in the autonomous loop.
              // Mark as needing attention and move on.
              updateStep(stepId, {
                status: "failed",
                completedAt: nowIso(),
                failureReason: `User input required: ${decision.question}`,
              });
              emit("autonomous.step.failed", {
                goalId: goal.id,
                stepId,
                reason: `User input required: ${decision.question}`,
              });
              stepCompleted = true; // Exit step loop (failed)
              break;
            }

            case "abort": {
              updateStep(stepId, {
                status: "failed",
                completedAt: nowIso(),
                failureReason: decision.reason,
              });
              emit("autonomous.step.failed", { goalId: goal.id, stepId, reason: decision.reason });

              const durationMs = Date.now() - startedAt;
              currentGoal = updateGoal(goal.id, {
                status: "failed",
                completedAt: nowIso(),
                failureReason: decision.reason,
                iterationCount: goalIterations.length,
              });
              emit("autonomous.goal.failed", { goalId: goal.id, reason: decision.reason });

              return {
                goalId: goal.id,
                status: "failed",
                summary: `Goal aborted: ${decision.reason}`,
                failureReason: decision.reason,
                iterationCount: goalIterations.length,
                durationMs,
                usageInput: totalUsageInput,
                usageOutput: totalUsageOutput,
              };
            }
          }

          // Record the iteration
          const iteration: FridayAutonomousIteration = {
            id: idGenerator(),
            goalId: goal.id,
            stepId,
            index: iterIndex,
            timestamp: nowIso(),
            observations,
            reasoning,
            decision,
            result: actionResult,
            durationMs: Date.now() - iterStartedAt,
            usageInput,
            usageOutput,
          };
          goalIterations.push(iteration);
          emit("autonomous.iteration.completed", { goalId: goal.id, stepId, index: iterIndex });

          // Delay between iterations
          if (config.iterationDelayMs > 0 && !stepCompleted) {
            await delay(config.iterationDelayMs, signal);
          }
        }

        // If step wasn't completed after retries, check if we should continue
        currentStep = steps.get(stepId)!;
        if (currentStep.status === "failed") {
          // Step failed after all retries — fail the goal
          const durationMs = Date.now() - startedAt;
          currentGoal = updateGoal(goal.id, {
            status: "failed",
            completedAt: nowIso(),
            failureReason: currentStep.failureReason ?? "Step failed after retries",
            iterationCount: goalIterations.length,
          });
          emit("autonomous.goal.failed", {
            goalId: goal.id,
            reason: currentStep.failureReason,
          });

          return {
            goalId: goal.id,
            status: "failed",
            summary: `Failed at step ${si + 1}: ${currentStep.instruction}`,
            failureReason: currentStep.failureReason,
            iterationCount: goalIterations.length,
            durationMs,
            usageInput: totalUsageInput,
            usageOutput: totalUsageOutput,
          };
        }
      }

      // ─── Phase 3: Goal verification ───
      if (signal.aborted) {
        const durationMs = Date.now() - startedAt;
        currentGoal = updateGoal(goal.id, {
          status: "cancelled",
          completedAt: nowIso(),
          iterationCount: goalIterations.length,
        });
        emit("autonomous.goal.cancelled", { goalId: goal.id });

        return {
          goalId: goal.id,
          status: "cancelled",
          summary: "Goal cancelled by signal",
          iterationCount: goalIterations.length,
          durationMs,
          usageInput: totalUsageInput,
          usageOutput: totalUsageOutput,
        };
      }

      // All steps completed successfully
      const durationMs = Date.now() - startedAt;
      currentGoal = updateGoal(goal.id, {
        status: "completed",
        completedAt: nowIso(),
        iterationCount: goalIterations.length,
      });
      emit("autonomous.goal.completed", { goalId: goal.id, durationMs });

      return {
        goalId: goal.id,
        status: "completed",
        summary: `Goal completed in ${goalIterations.length} iterations across ${stepIds.length} steps`,
        iterationCount: goalIterations.length,
        durationMs,
        usageInput: totalUsageInput,
        usageOutput: totalUsageOutput,
      };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const reason = err instanceof Error ? err.message : String(err);

      if (reason.includes("aborted") || reason.includes("abort")) {
        currentGoal = updateGoal(goal.id, {
          status: "cancelled",
          completedAt: nowIso(),
          iterationCount: goalIterations.length,
        });
        emit("autonomous.goal.cancelled", { goalId: goal.id });

        return {
          goalId: goal.id,
          status: "cancelled",
          summary: "Goal cancelled",
          iterationCount: goalIterations.length,
          durationMs,
          usageInput: totalUsageInput,
          usageOutput: totalUsageOutput,
        };
      }

      currentGoal = updateGoal(goal.id, {
        status: "failed",
        completedAt: nowIso(),
        failureReason: reason,
        iterationCount: goalIterations.length,
      });
      emit("autonomous.goal.failed", { goalId: goal.id, reason });

      return {
        goalId: goal.id,
        status: "failed",
        summary: `Goal failed: ${reason}`,
        failureReason: reason,
        iterationCount: goalIterations.length,
        durationMs,
        usageInput: totalUsageInput,
        usageOutput: totalUsageOutput,
      };
    } finally {
      // Store iterations for observability
      iterations.set(goal.id, goalIterations);
      abortControllers.delete(goal.id);
    }
  }

  function createGoalRecord(params: {
    description: string;
    source?: string;
    priority?: string;
    parentGoalId?: UUID;
    config?: Partial<FridayAutonomousEngineConfig>;
    successCriteria?: readonly FridayAutonomousVerificationCheck[];
  }): FridayAutonomousGoal {
    const goalConfig = { ...config, ...params.config };
    const goal: FridayAutonomousGoal = {
      id: idGenerator(),
      status: "pending",
      priority: (params.priority ?? "normal") as FridayAutonomousGoal["priority"],
      source: (params.source ?? "user") as FridayAutonomousGoal["source"],
      description: params.description,
      successCriteria: params.successCriteria,
      maxIterations: goalConfig.maxIterationsPerGoal,
      timeoutMs: goalConfig.maxTimePerGoalMs,
      iterationCount: 0,
      stepIds: [],
      currentStepIndex: 0,
      parentGoalId: params.parentGoalId,
      createdAt: nowIso(),
    };
    goals.set(goal.id, goal);
    emit("autonomous.goal.created", { goalId: goal.id, description: goal.description });
    return goal;
  }

  // ─── Public interface ───

  return {
    async executeGoal(params: FridayAutonomousGoalParams): Promise<FridayAutonomousGoalResult> {
      const goal = createGoalRecord({
        description: params.description,
        source: params.source,
        priority: params.priority,
        parentGoalId: params.parentGoalId,
        config: params.config,
        successCriteria: params.successCriteria,
      });

      const abortController = new AbortController();
      abortControllers.set(goal.id, abortController);

      // Wire external signal with cleanup to prevent listener accumulation
      let externalSignalCleanup: (() => void) | undefined;
      if (params.signal) {
        if (params.signal.aborted) {
          abortController.abort(params.signal.reason);
        } else {
          const handler = () => {
            abortController.abort(params.signal!.reason);
          };
          params.signal.addEventListener("abort", handler, { once: true });
          externalSignalCleanup = () => {
            params.signal!.removeEventListener("abort", handler);
          };
        }
      }

      try {
        return await runGoal(goal, params.timezone, params.principalId, params.tenantContext, abortController.signal);
      } finally {
        externalSignalCleanup?.();
      }
    },

    cancelGoal(goalId: UUID): void {
      const controller = abortControllers.get(goalId);
      if (controller) {
        controller.abort(new Error("Goal cancelled by user"));
      }
      const goal = goals.get(goalId);
      if (goal && !isTerminal(goal.status)) {
        updateGoal(goalId, { status: "cancelled", completedAt: nowIso() });
        emit("autonomous.goal.cancelled", { goalId });
      }
    },

    getGoal(goalId: UUID): FridayAutonomousGoal | null {
      return goals.get(goalId) ?? null;
    },

    listGoals(filters?: FridayAutonomousGoalListFilters): readonly FridayAutonomousGoal[] {
      let result = Array.from(goals.values());
      if (filters?.status) result = result.filter((g) => g.status === filters.status);
      if (filters?.source) result = result.filter((g) => g.source === filters.source);
      if (filters?.parentGoalId) result = result.filter((g) => g.parentGoalId === filters.parentGoalId);
      if (filters?.limit) result = result.slice(0, filters.limit);
      return result;
    },

    getIterations(goalId: UUID): readonly FridayAutonomousIteration[] {
      return iterations.get(goalId) ?? [];
    },
  };
}

// ─── Helpers ───

function isTerminal(status: FridayAutonomousGoalStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
