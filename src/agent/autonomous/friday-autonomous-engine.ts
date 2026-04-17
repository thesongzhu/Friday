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

import * as fs from "node:fs";

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
  FridayAutonomousResumeGoalParams,
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
Decide only from the provided observations and context.
Do not execute tools yourself in this reasoning step.
Return JSON only with no markdown fences and no prose.

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
Return JSON only with no markdown fences and no prose.
Respond with JSON: {"passed": true/false, "actual": "description of what you see"}

Observations:
`;

const FILE_STATE_OBSERVATION_PREFIX = "FILE_STATE: ";
const FILE_OBSERVATION_MAX_BYTES = 16_384;

type FridayAutonomousPlannedStepDraft = {
  instruction?: string;
  domain?: string;
  verification?: string;
};

function buildAutonomousSessionKey(scope: "decision" | "action" | "plan", id: string): string {
  return `autonomous:${scope}:${id}`;
}

function buildAutonomousBrowserSessionId(goalId: UUID): string {
  return `autonomous-goal:${goalId}`;
}

function appendObservations(
  existing: readonly FridayAutonomousObservation[],
  incoming: readonly FridayAutonomousObservation[],
): FridayAutonomousObservation[] {
  if (incoming.length === 0) {
    return [...existing];
  }
  return [...existing, ...incoming];
}

function extractFirstUrl(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const match = text.match(/https?:\/\/[^\s)"'`]+/i);
  return match?.[0];
}

function extractLastBrowserUrl(step: FridayAutonomousStep): string | undefined {
  const plannedUrl = typeof step.plannedAction?.args?.url === "string"
    ? step.plannedAction.args.url.trim()
    : undefined;
  if (plannedUrl) {
    return plannedUrl;
  }

  for (let index = step.observations.length - 1; index >= 0; index -= 1) {
    const obs = step.observations[index];
    const text = obs.textContent?.trim();
    if (!text) continue;
    if (text.startsWith("PAGE_URL:")) {
      const candidate = text.slice("PAGE_URL:".length).trim();
      if (candidate) {
        return candidate;
      }
    }
    const embeddedUrl = extractFirstUrl(text);
    if (embeddedUrl) {
      return embeddedUrl;
    }
  }

  return extractFirstUrl(step.instruction);
}

function fallbackNarrativeDecision(raw: string): FridayAutonomousDecision | null {
  const normalized = raw.trim();
  if (!normalized) {
    return null;
  }

  const successSignal = /(?:\bcompleted\b|\bsuccessfully\b|\bverified\b|完成|成功|已验证|验证通过|任务完成)/i.test(normalized);
  const evidenceSignalCount = [
    /https?:\/\//i,
    /\btitle\b/i,
    /\burl\b/i,
    /\bheading\b/i,
    /页面标题|标题|网址|链接|页面/i,
  ].reduce((count, pattern) => count + (pattern.test(normalized) ? 1 : 0), 0);

  if (successSignal && evidenceSignalCount >= 2) {
    return { kind: "complete", summary: normalized.slice(0, 1_200) };
  }

  return null;
}

export function buildDeterministicBrowserBootstrapDecision(
  step: FridayAutonomousStep,
  observations: readonly FridayAutonomousObservation[],
): FridayAutonomousDecision | null {
  if (step.domain !== "browser" || observations.length > 0) {
    return null;
  }

  const plannedUrl = extractLastBrowserUrl(step);
  if (plannedUrl) {
    return {
      kind: "act",
      action: {
        toolName: "browser",
        args: {
          action: "open",
          url: plannedUrl,
        },
        rationale: "Open the target page first so browser observations become available.",
      },
    };
  }

  if (/\b(?:launch|start|open)\b[\s\S]{0,24}\bbrowser\b/i.test(step.instruction)) {
    return {
      kind: "act",
      action: {
        toolName: "browser",
        args: {
          action: "start",
        },
        rationale: "Start the browser session before collecting observations.",
      },
    };
  }

  return null;
}

export function trimImplicitEvidenceReportStep(
  goalDescription: string,
  plannedSteps: readonly FridayAutonomousPlannedStepDraft[],
): FridayAutonomousPlannedStepDraft[] {
  if (plannedSteps.length === 0) {
    return [];
  }

  const goalText = goalDescription.trim().toLowerCase();
  const userExplicitlyRequestedReport =
    /\b(report|summary|document|write|save|export|artifact|markdown|json|file)\b/i.test(goalText);
  if (userExplicitlyRequestedReport) {
    return [...plannedSteps];
  }

  const lastStep = plannedSteps.at(-1);
  const lastStepText = `${lastStep?.instruction ?? ""} ${lastStep?.verification ?? ""}`.trim().toLowerCase();
  const looksLikeImplicitReportStep =
    /\b(?:compile|summari[sz]e|create|assemble|prepare|generate)\b/i.test(lastStepText)
    && /\b(?:report|summary)\b/i.test(lastStepText)
    && /\b(?:title|url|screenshot|content|evidence)\b/i.test(lastStepText);

  if (!looksLikeImplicitReportStep) {
    return [...plannedSteps];
  }

  return plannedSteps.slice(0, -1);
}

// ─── Factory ───

export function createFridayAutonomousEngine(
  deps: CreateFridayAutonomousEngineDeps,
): FridayAutonomousEngine {
  const {
    agentRuntime,
    toolExecutor,
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

  const persistence = deps.persistence;

  // ─── In-memory state (L1 cache — SQLite is L2 via write-through) ───
  const goals = new Map<UUID, FridayAutonomousGoal>();
  const steps = new Map<UUID, FridayAutonomousStep>();
  const iterations = new Map<UUID, FridayAutonomousIteration[]>();
  const abortControllers = new Map<UUID, AbortController>();
  const restartInterruptedAt = nowIso();

  // ─── Startup recovery: load non-terminal goals from SQLite ───
  if (persistence) {
    try {
      const activeGoals = persistence.sqlite.withReadConnection((db) =>
        persistence.repository.listActiveGoals(db),
      );
      for (const goal of activeGoals) {
        const goalSteps = persistence.sqlite.withReadConnection((db) =>
          persistence.repository.getStepsByGoalId(db, goal.id),
        );
        const goalIters = persistence.sqlite.withReadConnection((db) =>
          persistence.repository.getIterationsByGoalId(db, goal.id),
        );
        if (goal.status === "executing" || goal.status === "planning" || goal.status === "verifying") {
          const recovery = classifyRestartRecovery(goal, goalSteps);
          const interruptedGoal: FridayAutonomousGoal = {
            ...goal,
            status: recovery.goalStatus,
            failureReason: recovery.reason,
            completedAt: recovery.goalStatus === "interrupted_nonrecoverable" ? restartInterruptedAt : undefined,
          };
          goals.set(goal.id, interruptedGoal);
          persistence.sqlite.withWriteTransaction((db) =>
            persistence.repository.updateGoal(db, goal.id, {
              status: recovery.goalStatus,
              failureReason: recovery.reason,
              completedAt: interruptedGoal.completedAt,
            }),
          );
          for (const step of goalSteps) {
            const patch = classifyRestartedStep(step, recovery.goalStatus, recovery.reason, restartInterruptedAt);
            if (!patch) {
              steps.set(step.id, step);
              continue;
            }
            steps.set(step.id, { ...step, ...patch });
            persistence.sqlite.withWriteTransaction((db) =>
              persistence.repository.updateStep(db, step.id, patch),
            );
          }
          if (goalIters.length > 0) iterations.set(goal.id, goalIters);
        } else {
          // Pending goals: rehydrate into cache for potential re-execution
          goals.set(goal.id, goal);
          for (const step of goalSteps) steps.set(step.id, step);
          if (goalIters.length > 0) iterations.set(goal.id, goalIters);
        }
      }
    } catch {
      // Non-fatal: if recovery fails, engine starts with empty state (same as before persistence)
    }
  }

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

  async function captureBrowserTitle(sessionId: string, signal: AbortSignal): Promise<string | null> {
    if (!browserManager?.title) return null;
    try {
      const result = await browserManager.title(sessionId);
      const title = result.title.trim();
      return title.length > 0 ? title : null;
    } catch (err) {
      console.warn("[friday][autonomous-engine] browser title failed:", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  async function captureBrowserUrl(
    sessionId: string,
    signal: AbortSignal,
    options?: { suppressMissingSessionWarning?: boolean },
  ): Promise<string | null> {
    if (!browserManager?.url) return null;
    try {
      const result = await browserManager.url(sessionId);
      const url = result.url.trim();
      return url.length > 0 ? url : null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const expectedMissingSession =
        options?.suppressMissingSessionWarning === true
        && /session\b[\s\S]{0,24}\bnot found/i.test(message);
      if (!expectedMissingSession) {
        console.warn("[friday][autonomous-engine] browser url failed:", message);
      }
      return null;
    }
  }

  async function ensureBrowserSessionForStep(
    step: FridayAutonomousStep,
    browserSessionId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (step.domain !== "browser") {
      return false;
    }

    const existingUrl = await captureBrowserUrl(browserSessionId, signal, {
      suppressMissingSessionWarning: true,
    });
    if (existingUrl) {
      return true;
    }

    if (!browserManager?.launch) {
      return false;
    }

    const resumeUrl = extractLastBrowserUrl(step);
    if (!resumeUrl) {
      return false;
    }

    try {
      await browserManager.launch(browserSessionId);
      await browserManager.navigate(browserSessionId, resumeUrl);
      return true;
    } catch (err) {
      console.warn("[friday][autonomous-engine] browser session recovery failed:", err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  async function collectBrowserCheckpointObservations(
    stepId: UUID,
    browserSessionId: string,
    signal: AbortSignal,
  ): Promise<FridayAutonomousObservation[]> {
    const checkpoint: FridayAutonomousObservation[] = [];

    const screenshot = await captureBrowserScreenshot(browserSessionId, signal);
    if (screenshot) {
      checkpoint.push({
        id: idGenerator(),
        stepId,
        source: "screenshot",
        timestamp: nowIso(),
        screenshotBase64: screenshot,
      });
    }

    const snapshot = await captureBrowserSnapshot(browserSessionId, signal);
    if (snapshot) {
      checkpoint.push({
        id: idGenerator(),
        stepId,
        source: "dom_snapshot",
        timestamp: nowIso(),
        structuredData: snapshot,
      });
    }

    const title = await captureBrowserTitle(browserSessionId, signal);
    if (title) {
      checkpoint.push({
        id: idGenerator(),
        stepId,
        source: "tool_result",
        timestamp: nowIso(),
        textContent: `PAGE_TITLE: ${title}`,
      });
    }

    const url = await captureBrowserUrl(browserSessionId, signal);
    if (url) {
      checkpoint.push({
        id: idGenerator(),
        stepId,
        source: "tool_result",
        timestamp: nowIso(),
        textContent: `PAGE_URL: ${url}`,
      });
    }

    return checkpoint;
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

  function extractAbsolutePathsFromText(text: string | undefined): string[] {
    if (typeof text !== "string" || text.trim().length === 0) {
      return [];
    }

    const matches = new Set<string>();
    const quotedPattern = /["'](\/[^"'\\]*(?:\\.[^"'\\]*)*)["']/g;
    let quotedMatch: RegExpExecArray | null;
    while ((quotedMatch = quotedPattern.exec(text)) !== null) {
      matches.add(quotedMatch[1]);
    }

    const barePattern = /(^|\s)(\/[^\s"'`<>]+)/g;
    let bareMatch: RegExpExecArray | null;
    while ((bareMatch = barePattern.exec(text)) !== null) {
      matches.add(bareMatch[2].replace(/[),.;:!?]+$/, ""));
    }

    return [...matches];
  }

  function collectReferencedFilePaths(step: FridayAutonomousStep): string[] {
    const strings: string[] = [
      step.instruction,
      step.verification?.description ?? "",
      step.verification?.expected ?? "",
    ];

    for (const value of Object.values(step.plannedAction?.args ?? {})) {
      if (typeof value === "string") {
        strings.push(value);
      }
    }

    const paths = new Set<string>();
    for (const value of strings) {
      for (const filePath of extractAbsolutePathsFromText(value)) {
        paths.add(filePath);
      }
    }
    return [...paths];
  }

  function normalizeAutonomousActionArgs(
    toolName: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (toolName === "write" || toolName === "read" || toolName === "edit") {
      const normalizedArgs: Record<string, unknown> = { ...args };
      if (typeof normalizedArgs.path !== "string") {
        if (typeof normalizedArgs.filePath === "string") {
          normalizedArgs.path = normalizedArgs.filePath;
        } else if (typeof normalizedArgs.file_path === "string") {
          normalizedArgs.path = normalizedArgs.file_path;
        }
      }
      if (
        toolName === "write"
        && typeof normalizedArgs.content !== "string"
        && typeof normalizedArgs.text === "string"
      ) {
        normalizedArgs.content = normalizedArgs.text;
      }
      return normalizedArgs;
    }

    if (toolName === "browser") {
      const normalizedArgs: Record<string, unknown> = { ...args };
      if (typeof normalizedArgs.action !== "string" || normalizedArgs.action.trim().length === 0) {
        if (typeof normalizedArgs.url === "string" && normalizedArgs.url.trim().length > 0) {
          normalizedArgs.action = "open";
        } else if (
          typeof normalizedArgs.act === "string"
          || typeof normalizedArgs.selector === "string"
          || typeof normalizedArgs.elementId === "string"
        ) {
          normalizedArgs.action = "act";
        }
      }
      return normalizedArgs;
    }

    return args;
  }

  function parseFileStateObservations(
    observations: readonly FridayAutonomousObservation[],
  ): Array<{
    path: string;
    exists: boolean;
    isFile: boolean;
    isDirectory: boolean;
    size: number;
    content?: string;
    error?: string;
  }> {
    const states: Array<{
      path: string;
      exists: boolean;
      isFile: boolean;
      isDirectory: boolean;
      size: number;
      content?: string;
      error?: string;
    }> = [];

    for (const observation of observations) {
      const text = observation.textContent;
      if (typeof text !== "string" || !text.startsWith(FILE_STATE_OBSERVATION_PREFIX)) {
        continue;
      }
      try {
        const parsed = JSON.parse(text.slice(FILE_STATE_OBSERVATION_PREFIX.length)) as {
          path?: string;
          exists?: boolean;
          isFile?: boolean;
          isDirectory?: boolean;
          size?: number;
          content?: string;
          error?: string;
        };
        if (typeof parsed.path !== "string" || parsed.path.length === 0) {
          continue;
        }
        states.push({
          path: parsed.path,
          exists: parsed.exists === true,
          isFile: parsed.isFile === true,
          isDirectory: parsed.isDirectory === true,
          size: typeof parsed.size === "number" ? parsed.size : 0,
          content: typeof parsed.content === "string" ? parsed.content : undefined,
          error: typeof parsed.error === "string" ? parsed.error : undefined,
        });
      } catch {
        continue;
      }
    }

    return states;
  }

  function collectInspectionFilePaths(step: FridayAutonomousStep): string[] {
    const directPaths = collectReferencedFilePaths(step);
    if (directPaths.length > 0) {
      return directPaths;
    }

    if (step.domain !== "file" && step.domain !== "exec" && step.domain !== "composite") {
      return directPaths;
    }

    const goal = goals.get(step.goalId);
    if (!goal) {
      return directPaths;
    }

    const inferredPaths = new Set<string>();
    for (let index = step.index - 1; index >= 0; index -= 1) {
      const priorStepId = goal.stepIds[index];
      if (!priorStepId) {
        continue;
      }

      const priorStep = steps.get(priorStepId);
      if (!priorStep) {
        continue;
      }

      for (const filePath of collectReferencedFilePaths(priorStep)) {
        inferredPaths.add(filePath);
      }

      const normalizedActionArgs = priorStep.plannedAction
        ? normalizeAutonomousActionArgs(priorStep.plannedAction.toolName, priorStep.plannedAction.args)
        : null;
      if (normalizedActionArgs && typeof normalizedActionArgs.path === "string") {
        inferredPaths.add(normalizedActionArgs.path);
      }

      for (const state of parseFileStateObservations(priorStep.observations)) {
        inferredPaths.add(state.path);
      }

      if (inferredPaths.size > 0) {
        break;
      }
    }

    return [...inferredPaths];
  }

  function shouldInspectFileState(step: FridayAutonomousStep): boolean {
    if (step.domain === "file" || step.domain === "exec") {
      return true;
    }
    if (step.domain !== "composite") {
      return false;
    }
    if (step.plannedAction?.toolName === "exec" || step.plannedAction?.toolName === "file") {
      return true;
    }
    return collectInspectionFilePaths(step).length > 0;
  }

  function captureFileStateObservations(step: FridayAutonomousStep): FridayAutonomousObservation[] {
    const observations: FridayAutonomousObservation[] = [];

    for (const filePath of collectInspectionFilePaths(step)) {
      let exists = false;
      let isFile = false;
      let isDirectory = false;
      let size = 0;
      let content: string | undefined;
      let errorMessage: string | undefined;

      try {
        const stat = fs.statSync(filePath);
        exists = true;
        isFile = stat.isFile();
        isDirectory = stat.isDirectory();
        size = stat.size;
        if (isFile && stat.size <= FILE_OBSERVATION_MAX_BYTES) {
          content = fs.readFileSync(filePath, "utf8");
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
          errorMessage = err instanceof Error ? err.message : String(err);
        }
      }

      observations.push({
        id: idGenerator(),
        stepId: step.id,
        source: errorMessage ? "error" : "tool_result",
        timestamp: nowIso(),
        textContent: `${FILE_STATE_OBSERVATION_PREFIX}${JSON.stringify({
          path: filePath,
          exists,
          isFile,
          isDirectory,
          size,
          content,
          error: errorMessage,
        })}`,
      });
    }

    return observations;
  }

  function extractExpectedFileContent(step: FridayAutonomousStep): string | undefined {
    const texts = [
      step.verification?.expected,
      step.verification?.description,
      step.instruction,
    ];
    const patterns = [
      /exact text ["']([^"']+)["']/i,
      /contains(?: the)?(?: exact)? text ["']([^"']+)["']/i,
      /content(?:s)? (?:is|are) ["']([^"']+)["']/i,
    ];
    for (const text of texts) {
      if (typeof text !== "string") {
        continue;
      }
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match?.[1]) {
          return match[1];
        }
      }
    }
    return undefined;
  }

  function tryDeterministicFileVerification(
    step: FridayAutonomousStep,
    observations: readonly FridayAutonomousObservation[],
  ): { passed: boolean; actual: string } | null {
    const states = parseFileStateObservations(observations);
    if (states.length === 0) {
      return null;
    }

    const referencedPaths = collectInspectionFilePaths(step);
    const relevantStates = referencedPaths.length > 0
      ? states.filter((state) => referencedPaths.includes(state.path))
      : states;
    if (relevantStates.length === 0) {
      return null;
    }

    const expectedContent = extractExpectedFileContent(step);
    if (typeof expectedContent === "string") {
      const matchingState = relevantStates.find((state) => state.exists && state.isFile && state.content === expectedContent);
      if (matchingState) {
        return {
          passed: true,
          actual: `Verified file ${matchingState.path} contains expected text.`,
        };
      }
      return {
        passed: false,
        actual: `Expected file content ${JSON.stringify(expectedContent)} not observed in ${JSON.stringify(relevantStates)}`,
      };
    }

    const existingState = relevantStates.find((state) => state.exists);
    if (existingState) {
      return {
        passed: true,
        actual: `Verified file path ${existingState.path} exists.`,
      };
    }

    return {
      passed: false,
      actual: `Expected referenced file to exist, but observed ${JSON.stringify(relevantStates)}`,
    };
  }

  function buildDeterministicFileDecision(
    step: FridayAutonomousStep,
    observations: readonly FridayAutonomousObservation[],
  ): FridayAutonomousDecision | null {
    if (observations.length === 0 || (step.domain !== "file" && step.domain !== "composite")) {
      return null;
    }

    const deterministicVerification = tryDeterministicFileVerification(step, observations);
    if (!deterministicVerification) {
      return null;
    }

    if (deterministicVerification.passed) {
      return {
        kind: "verify",
        checks: [
          {
            type: "file_exists",
            description: step.verification?.description ?? deterministicVerification.actual,
            expected: step.verification?.expected,
            passed: true,
            actual: deterministicVerification.actual,
          },
        ],
      };
    }

    if (step.plannedAction?.toolName === "write") {
      const normalizedArgs = normalizeAutonomousActionArgs("write", step.plannedAction.args);
      if (typeof normalizedArgs.path === "string" && typeof normalizedArgs.content === "string") {
        return {
          kind: "act",
          action: {
            toolName: "write",
            args: normalizedArgs,
            rationale:
              step.plannedAction.rationale
              ?? "Retry the planned file write because the observed file state does not match the expected verification state.",
          },
        };
      }
    }

    const referencedPaths = collectInspectionFilePaths(step);
    const expectedContent = extractExpectedFileContent(step);
    const filePath = referencedPaths.length === 1 ? referencedPaths[0] : undefined;
    const instructionText = [
      step.instruction,
      step.verification?.description ?? "",
      step.verification?.expected ?? "",
    ].join("\n");
    if (
      filePath
      && typeof expectedContent === "string"
      && /\b(create|write|save)\b/i.test(instructionText)
    ) {
      return {
        kind: "act",
        action: {
          toolName: "write",
          args: {
            path: filePath,
            content: expectedContent,
          },
          rationale: "Retry the deterministic file write because the expected file state is still missing.",
        },
      };
    }

    if (step.verification) {
      return {
        kind: "verify",
        checks: [
          {
            type: "file_exists",
            description: step.verification.description,
            expected: step.verification.expected,
            passed: false,
            actual: deterministicVerification.actual,
          },
        ],
      };
    }

    return null;
  }

  function buildDeterministicFileBootstrapDecision(
    step: FridayAutonomousStep,
    observations: readonly FridayAutonomousObservation[],
  ): FridayAutonomousDecision | null {
    if (observations.length > 0 || (step.domain !== "file" && step.domain !== "composite")) {
      return null;
    }

    if (step.plannedAction?.toolName === "write") {
      const normalizedArgs = normalizeAutonomousActionArgs("write", step.plannedAction.args);
      if (typeof normalizedArgs.path === "string" && typeof normalizedArgs.content === "string") {
        return {
          kind: "act",
          action: {
            toolName: "write",
            args: normalizedArgs,
            rationale: step.plannedAction.rationale ?? "Replay the previously planned file write action.",
          },
        };
      }
    }

    const referencedPaths = collectInspectionFilePaths(step);
    const expectedContent = extractExpectedFileContent(step);
    const filePath = referencedPaths.length === 1 ? referencedPaths[0] : undefined;
    if (!filePath || typeof expectedContent !== "string") {
      return null;
    }

    const instructionText = [
      step.instruction,
      step.verification?.description ?? "",
      step.verification?.expected ?? "",
    ].join("\n");
    if (!/\b(create|write|save)\b/i.test(instructionText)) {
      return null;
    }

    return {
      kind: "act",
      action: {
        toolName: "write",
        args: {
          path: filePath,
          content: expectedContent,
        },
        rationale: "Bootstrap the deterministic file write action before requesting another model decision.",
      },
    };
  }

  /**
   * Gather observations about the current environment state.
   */
  async function gatherObservations(
    step: FridayAutonomousStep,
    browserSessionId: string,
    signal: AbortSignal,
  ): Promise<FridayAutonomousObservation[]> {
    const { id: stepId, domain } = step;
    const obs: FridayAutonomousObservation[] = [];
    let browserReady = false;

    if (domain === "browser") {
      browserReady = await ensureBrowserSessionForStep(step, browserSessionId, signal);
    } else if (domain === "composite") {
      browserReady = (await captureBrowserUrl(browserSessionId, signal, {
        suppressMissingSessionWarning: true,
      })) !== null;
    }

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
      if ((domain === "browser" || domain === "composite") && browserReady) {
        const screenshot = await captureBrowserScreenshot(browserSessionId, signal);
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
      if ((domain === "browser" || domain === "composite") && browserReady) {
        const snapshot = await captureBrowserSnapshot(browserSessionId, signal);
        if (snapshot) {
          obs.push({
            id: idGenerator(),
            stepId,
            source: "dom_snapshot",
            timestamp: nowIso(),
            structuredData: snapshot,
          });
        }
        const title = await captureBrowserTitle(browserSessionId, signal);
        if (title) {
          obs.push({
            id: idGenerator(),
            stepId,
            source: "tool_result",
            timestamp: nowIso(),
            textContent: `PAGE_TITLE: ${title}`,
          });
        }
        const url = await captureBrowserUrl(browserSessionId, signal);
        if (url) {
          obs.push({
            id: idGenerator(),
            stepId,
            source: "tool_result",
            timestamp: nowIso(),
            textContent: `PAGE_URL: ${url}`,
          });
        }
      }
    }

    if (shouldInspectFileState(step)) {
      obs.push(...captureFileStateObservations(step));
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
    providerId: string | undefined,
    model: string | undefined,
    signal: AbortSignal,
  ): Promise<{
    reasoning: string;
    decision: FridayAutonomousDecision;
    usageInput: number;
    usageOutput: number;
  }> {
    const deterministicFileDecision = buildDeterministicFileDecision(step, observations);
    if (deterministicFileDecision) {
      return {
        reasoning: "Deterministic file decision",
        decision: deterministicFileDecision,
        usageInput: 0,
        usageOutput: 0,
      };
    }

    const bootstrapDecision = buildDeterministicBrowserBootstrapDecision(step, observations);
    if (bootstrapDecision) {
      return {
        reasoning: "Deterministic browser bootstrap",
        decision: bootstrapDecision,
        usageInput: 0,
        usageOutput: 0,
      };
    }

    const fileBootstrapDecision = buildDeterministicFileBootstrapDecision(step, observations);
    if (fileBootstrapDecision) {
      return {
        reasoning: "Deterministic file bootstrap",
        decision: fileBootstrapDecision,
        usageInput: 0,
        usageOutput: 0,
      };
    }

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
          providerId,
          model: config.vlmModel ?? model,
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
      sessionKey: buildAutonomousSessionKey("decision", goal.id),
      providerId,
      model,
      timezone,
      principalId,
      tenantContext,
      constraints: {
        readOnly: true,
        operationalMode: "plan",
      },
      executionContext: {
        surface: "autonomous_internal_decision",
      },
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
        return fallbackNarrativeDecision(raw)
          ?? { kind: "abort", reason: `Could not parse decision from LLM response: ${raw.slice(0, 200)}` };
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
      return fallbackNarrativeDecision(raw)
        ?? { kind: "abort", reason: `Failed to parse decision: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * Execute a decided action using the agent runtime.
   */
  async function executeAction(
    decision: Extract<FridayAutonomousDecision, { kind: "act" }>,
    domain: string,
    browserSessionId: string,
    timezone: string | undefined,
    principalId: string | undefined,
    tenantContext: FridayAutonomousGoalParams["tenantContext"],
    providerId: string | undefined,
    model: string | undefined,
    signal: AbortSignal,
  ): Promise<FridayAutonomousActionResult> {
    const { action } = decision;
    const startedAt = Date.now();
    const normalizedArgs = normalizeAutonomousActionArgs(action.toolName, action.args);
    const actionArgs = action.toolName === "browser"
      ? {
          ...normalizedArgs,
          sessionId: browserSessionId,
        }
      : normalizedArgs;

    try {
      const directToolResult = toolExecutor
        ? await toolExecutor(action.toolName, actionArgs, signal)
        : null;
      const result = directToolResult
        ? null
        : await agentRuntime.executeRun({
            task: `Execute the following tool call and return the result:\nTool: ${action.toolName}\nArguments: ${JSON.stringify(actionArgs)}\n\nRationale: ${action.rationale ?? "N/A"}`,
            sessionKey: buildAutonomousSessionKey("action", idGenerator()),
            providerId,
            model,
            timezone,
            principalId,
            tenantContext,
            timeoutMs: 60_000,
            signal,
            executionContext: {
              surface: "autonomous_internal_action",
            },
          });

      // Capture post-action screenshot for verification
      let screenshotAfter: string | undefined;
      let browserTitle: string | undefined;
      let browserUrl: string | undefined;
      if (domain === "desktop" || domain === "composite") {
        screenshotAfter = (await captureDesktopScreenshot(signal)) ?? undefined;
      } else if (domain === "browser") {
        screenshotAfter = (await captureBrowserScreenshot(browserSessionId, signal)) ?? undefined;
        browserTitle = (await captureBrowserTitle(browserSessionId, signal)) ?? undefined;
        browserUrl = (await captureBrowserUrl(browserSessionId, signal)) ?? undefined;
      }

      return {
        success: directToolResult ? directToolResult.isError !== true : result!.status === "completed",
        toolName: action.toolName,
        output: directToolResult ? directToolResult.content : result!.response,
        screenshotAfter,
        browserTitle,
        browserUrl,
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
    providerId: string | undefined,
    model: string | undefined,
    signal: AbortSignal,
  ): Promise<{ passed: boolean; actual: string }> {
    if (!step.verification) {
      // No verification defined — assume success
      return { passed: true, actual: "No verification criteria defined" };
    }

    const deterministicFile = tryDeterministicFileVerification(step, observations);
    if (deterministicFile) {
      return deterministicFile;
    }

    const deterministic = tryDeterministicBrowserVerification(step, observations);
    if (deterministic) {
      return deterministic;
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
            providerId,
            model: config.vlmModel ?? model,
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
        providerId,
        model,
        timezone,
        principalId,
        tenantContext,
        executionContext: {
          surface: "autonomous_internal_verify",
        },
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

  async function runStepVerification(
    goalId: UUID,
    step: FridayAutonomousStep,
    timezone: string | undefined,
    principalId: string | undefined,
    tenantContext: FridayAutonomousGoalParams["tenantContext"],
    providerId: string | undefined,
    model: string | undefined,
    signal: AbortSignal,
  ): Promise<{ step: FridayAutonomousStep; passed: boolean }> {
    const browserSessionId = buildAutonomousBrowserSessionId(goalId);
    updateGoal(goalId, { status: "verifying" });
    const verifyingStep = updateStep(step.id, {
      status: "verifying",
      failureReason: undefined,
    });

    const verifyObs = await gatherObservations(verifyingStep, browserSessionId, signal);
    const verifyResult = await verifyStep(
      verifyingStep,
      verifyObs,
      timezone,
      principalId,
      tenantContext,
      providerId,
      model,
      signal,
    );

    emit("autonomous.verification.completed", {
      goalId,
      stepId: step.id,
      passed: verifyResult.passed,
    });

    updateGoal(goalId, { status: "executing" });

    if (verifyResult.passed) {
      return {
        step: updateStep(step.id, {
          status: "completed",
          completedAt: nowIso(),
          failureReason: undefined,
        }),
        passed: true,
      };
    }

    return {
      step: updateStep(step.id, {
        status: "executing",
        completedAt: undefined,
        failureReason: verifyResult.actual || "Verification failed",
      }),
      passed: false,
    };
  }

  /**
   * Plan step decomposition for a goal.
   */
  async function planGoal(
    goal: FridayAutonomousGoal,
    timezone: string | undefined,
    principalId: string | undefined,
    tenantContext: FridayAutonomousGoalParams["tenantContext"],
    providerId: string | undefined,
    model: string | undefined,
    signal: AbortSignal,
  ): Promise<FridayAutonomousStep[]> {
    // If recipe context provides step hints, use those directly
    if (goal.source === "recipe" && (goal as unknown as { recipeContext?: { stepHints?: string[] } }).recipeContext?.stepHints) {
      // Not reachable via the public interface type but kept for future recipe integration
    }

    const planResult = await agentRuntime.executeRun({
      task: PLANNING_PROMPT_PREFIX + goal.description,
      sessionKey: buildAutonomousSessionKey("plan", goal.id),
      providerId,
      model,
      timezone,
      principalId,
      tenantContext,
      constraints: {
        readOnly: true,
        operationalMode: "plan",
      },
      executionContext: {
        surface: "autonomous_internal_plan",
      },
      timeoutMs: 60_000,
      signal,
    });

    const plannedSteps = parsePlanResponse(planResult.response, goal.id, goal.description);
    return plannedSteps;
  }

  /**
   * Parse the planning LLM response into steps.
   */
  function parsePlanResponse(raw: string, goalId: UUID, goalDescription: string): FridayAutonomousStep[] {
    try {
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return [createFallbackStep(goalId, goalDescription)];
      }

      const parsed = JSON.parse(jsonMatch[0]) as FridayAutonomousPlannedStepDraft[];
      const normalized = trimImplicitEvidenceReportStep(goalDescription, parsed);

      return normalized.map((item, index) =>
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
      return [createFallbackStep(goalId, goalDescription)];
    }
  }

  function createFallbackStep(goalId: UUID, goalDescription: string): FridayAutonomousStep {
    const normalizedGoal = goalDescription.trim();
    const browserLikeGoal = /(https?:\/\/|www\.|浏览器|browser|navigate|open .*https?:\/\/)/i.test(normalizedGoal);
    const verificationLikeGoal = /(verify|verification|title|heading|确认|验证|标题|heading)/i.test(normalizedGoal);
    return createStep(
      goalId,
      0,
      normalizedGoal.length > 0 ? normalizedGoal : "Execute the goal directly",
      browserLikeGoal ? "browser" : "composite",
      verificationLikeGoal ? normalizedGoal : undefined,
    );
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
    if (persistence) {
      try { persistence.sqlite.withWriteTransaction((db) => persistence.repository.createStep(db, step)); } catch { /* non-fatal */ }
    }
    return step;
  }

  /**
   * Update a goal in the in-memory store (write-through to SQLite).
   */
  function updateGoal(goalId: UUID, updates: Partial<FridayAutonomousGoal>): FridayAutonomousGoal {
    const current = goals.get(goalId);
    if (!current) throw new FridayDomainError("NOT_FOUND", `Goal ${goalId} not found`, { httpStatus: 404 });
    const updated = { ...current, ...updates } as FridayAutonomousGoal;
    goals.set(goalId, updated);
    if (persistence) {
      try { persistence.sqlite.withWriteTransaction((db) => persistence.repository.updateGoal(db, goalId, updates)); } catch { /* non-fatal */ }
    }
    return updated;
  }

  /**
   * Update a step in the in-memory store (write-through to SQLite).
   */
  function updateStep(stepId: UUID, updates: Partial<FridayAutonomousStep>): FridayAutonomousStep {
    const current = steps.get(stepId);
    if (!current) throw new FridayDomainError("NOT_FOUND", `Step ${stepId} not found`, { httpStatus: 404 });
    const updated = { ...current, ...updates } as FridayAutonomousStep;
    steps.set(stepId, updated);
    if (persistence) {
      try { persistence.sqlite.withWriteTransaction((db) => persistence.repository.updateStep(db, stepId, updates)); } catch { /* non-fatal */ }
    }
    return updated;
  }

  // ─── Main execution loop ───

  async function runGoal(
    goal: FridayAutonomousGoal,
    timezone: string | undefined,
    principalId: string | undefined,
    tenantContext: FridayAutonomousGoalParams["tenantContext"],
    providerId: string | undefined,
    model: string | undefined,
    signal: AbortSignal,
  ): Promise<FridayAutonomousGoalResult> {
    const startedAt = Date.now();
    const browserSessionId = buildAutonomousBrowserSessionId(goal.id);
    let totalUsageInput = 0;
    let totalUsageOutput = 0;
    let currentGoal = goal;
    const goalIterations: FridayAutonomousIteration[] = [];

    try {
      const resumeFromExistingPlan =
        (goal.status === "interrupted_recoverable" || goal.status === "resumed")
        && goal.stepIds.length > 0
        && goal.stepIds.every((stepId) => steps.has(stepId));

      if (goal.status === "interrupted_recoverable" || goal.status === "resumed") {
        currentGoal = updateGoal(goal.id, {
          status: "resumed",
          completedAt: undefined,
          failureReason: undefined,
        });
        emit("autonomous.goal.resumed", { goalId: goal.id, description: goal.description });
      }

      // ─── Phase 1: Planning ───
      currentGoal = updateGoal(goal.id, {
        status: "planning",
        startedAt: currentGoal.startedAt ?? nowIso(),
        completedAt: undefined,
        failureReason: undefined,
      });
      emit("autonomous.goal.started", { goalId: goal.id, description: goal.description });

      const stepIds = resumeFromExistingPlan
        ? [...currentGoal.stepIds]
        : (await planGoal(currentGoal, timezone, principalId, tenantContext, providerId, model, signal))
          .map((step) => step.id);
      const startingStepIndex = resumeFromExistingPlan ? currentGoal.currentStepIndex : 0;
      currentGoal = updateGoal(goal.id, {
        status: "executing",
        stepIds,
        currentStepIndex: startingStepIndex,
      });

      // ─── Phase 2: Step-by-step execution ───
      for (let si = startingStepIndex; si < stepIds.length; si++) {
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
          const observations = await gatherObservations(currentStep, browserSessionId, signal);
          currentStep = updateStep(stepId, {
            observations: appendObservations(currentStep.observations, observations),
          });
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
            providerId,
            model,
            signal,
          );
          totalUsageInput += usageInput;
          totalUsageOutput += usageOutput;

          emit("autonomous.decision.made", { goalId: goal.id, stepId, kind: decision.kind });

          // ─── Act on decision ───
          let actionResult: FridayAutonomousActionResult | undefined;

          switch (decision.kind) {
            case "act": {
              currentStep = updateStep(stepId, {
                plannedAction: decision.action,
              });
              actionResult = await executeAction(decision, currentStep.domain, browserSessionId, timezone, principalId, tenantContext, providerId, model, signal);
              if (actionResult.success && currentStep.domain === "browser") {
                const checkpointObservations = await collectBrowserCheckpointObservations(stepId, browserSessionId, signal);
                if (checkpointObservations.length > 0) {
                  currentStep = updateStep(stepId, {
                    observations: appendObservations(currentStep.observations, checkpointObservations),
                  });
                }
              }
              emit("autonomous.action.executed", {
                goalId: goal.id,
                stepId,
                toolName: actionResult.toolName,
                success: actionResult.success,
              });

              if (!actionResult.success) {
                stepRetries++;
                updateStep(stepId, { retryCount: stepRetries });
              } else if (currentStep.verification) {
                const verification = await runStepVerification(
                  goal.id,
                  currentStep,
                  timezone,
                  principalId,
                  tenantContext,
                  providerId,
                  model,
                  signal,
                );
                if (verification.passed) {
                  stepCompleted = true;
                  emit("autonomous.step.completed", { goalId: goal.id, stepId });
                } else {
                  stepRetries++;
                  updateStep(stepId, { retryCount: stepRetries });
                }
              }
              break;
            }

            case "verify": {
              const verification = await runStepVerification(
                goal.id,
                currentStep,
                timezone,
                principalId,
                tenantContext,
                providerId,
                model,
                signal,
              );

              if (verification.passed) {
                stepCompleted = true;
                emit("autonomous.step.completed", { goalId: goal.id, stepId });
              } else {
                stepRetries++;
                updateStep(stepId, { retryCount: stepRetries });
              }
              break;
            }

            case "complete": {
              if (currentStep.verification) {
                const verification = await runStepVerification(
                  goal.id,
                  currentStep,
                  timezone,
                  principalId,
                  tenantContext,
                  providerId,
                  model,
                  signal,
                );
                if (!verification.passed) {
                  stepRetries++;
                  currentStep = updateStep(stepId, { retryCount: stepRetries });
                  break;
                }
              }
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
                providerId,
                model,
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
          if (persistence) {
            try { persistence.sqlite.withWriteTransaction((db) => persistence.repository.appendIteration(db, iteration)); } catch { /* non-fatal */ }
          }
          emit("autonomous.iteration.completed", { goalId: goal.id, stepId, index: iterIndex });

          // Delay between iterations
          if (config.iterationDelayMs > 0 && !stepCompleted) {
            await delay(config.iterationDelayMs, signal);
          }
        }

        // If step wasn't completed after retries, check if we should continue
        currentStep = steps.get(stepId)!;
        if (
          !stepCompleted
          && !signal.aborted
          && currentStep.status !== "failed"
          && stepRetries >= currentStep.maxRetries
        ) {
          currentStep = updateStep(stepId, {
            status: "failed",
            completedAt: nowIso(),
            failureReason: currentStep.failureReason ?? "Step failed after retry budget was exhausted",
          });
          emit("autonomous.step.failed", {
            goalId: goal.id,
            stepId,
            reason: currentStep.failureReason,
          });
        }

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
      if (browserManager?.close) {
        try {
          await browserManager.close(browserSessionId);
        } catch (err) {
          console.warn("[friday][autonomous-engine] browser session cleanup failed:", err instanceof Error ? err.message : String(err));
        }
      }
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
    if (persistence) {
      try { persistence.sqlite.withWriteTransaction((db) => persistence.repository.createGoal(db, goal)); } catch { /* non-fatal */ }
    }
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
        return await runGoal(
          goal,
          params.timezone,
          params.principalId,
          params.tenantContext,
          params.providerId,
          params.model,
          abortController.signal,
        );
      } finally {
        externalSignalCleanup?.();
      }
    },

    async resumeGoal(params: FridayAutonomousResumeGoalParams): Promise<FridayAutonomousGoalResult> {
      const storedGoal = goals.get(params.goalId)
        ?? (persistence
          ? persistence.sqlite.withReadConnection((db) => persistence.repository.getGoal(db, params.goalId))
          : null);

      if (!storedGoal) {
        throw new Error(`Goal "${params.goalId}" not found.`);
      }
      if (storedGoal.status === "completed" || storedGoal.status === "failed" || storedGoal.status === "cancelled") {
        throw new Error(`Goal "${params.goalId}" is already terminal (${storedGoal.status}).`);
      }
      if (storedGoal.status === "interrupted_nonrecoverable") {
        throw new Error(
          `Goal "${params.goalId}" cannot be resumed safely: ${storedGoal.failureReason ?? "missing resumable checkpoint"}`,
        );
      }

      const resumableGoal =
        storedGoal.status === "pending" || storedGoal.status === "interrupted_recoverable" || storedGoal.status === "resumed"
          ? storedGoal
          : { ...storedGoal, status: "interrupted_recoverable" as const };
      goals.set(resumableGoal.id, resumableGoal);
      if (persistence) {
        try {
          const persistedSteps = persistence.sqlite.withReadConnection((db) =>
            persistence.repository.getStepsByGoalId(db, resumableGoal.id),
          );
          for (const persistedStep of persistedSteps) {
            steps.set(persistedStep.id, persistedStep);
          }

          const persistedIterations = persistence.sqlite.withReadConnection((db) =>
            persistence.repository.getIterationsByGoalId(db, resumableGoal.id),
          );
          if (persistedIterations.length > 0) {
            iterations.set(resumableGoal.id, persistedIterations);
          } else {
            iterations.delete(resumableGoal.id);
          }
        } catch {
          // Non-fatal: fall back to the in-memory view if persistence rehydration fails.
        }
      }

      const abortController = new AbortController();
      abortControllers.set(resumableGoal.id, abortController);

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
        return await runGoal(
          resumableGoal,
          params.timezone,
          params.principalId,
          params.tenantContext,
          params.providerId,
          params.model,
          abortController.signal,
        );
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
      const cached = goals.get(goalId);
      if (cached) return cached;
      if (!persistence) return null;
      try {
        return persistence.sqlite.withReadConnection((db) => persistence.repository.getGoal(db, goalId));
      } catch { return null; }
    },

    listGoals(filters?: FridayAutonomousGoalListFilters): readonly FridayAutonomousGoal[] {
      if (!persistence) {
        let result = Array.from(goals.values());
        if (filters?.status) result = result.filter((g) => g.status === filters.status);
        if (filters?.source) result = result.filter((g) => g.source === filters.source);
        if (filters?.parentGoalId) result = result.filter((g) => g.parentGoalId === filters.parentGoalId);
        if (filters?.limit) result = result.slice(0, filters.limit);
        return result;
      }
      // Merge SQLite + Map (Map values are more recent)
      const merged = new Map<UUID, FridayAutonomousGoal>();
      try {
        const dbGoals = persistence.sqlite.withReadConnection((db) => persistence.repository.listGoals(db, filters));
        for (const g of dbGoals) merged.set(g.id, g);
      } catch { /* fall back to Map only */ }
      for (const [id, g] of goals) merged.set(id, g);
      let result = Array.from(merged.values());
      if (filters?.status) result = result.filter((g) => g.status === filters.status);
      if (filters?.source) result = result.filter((g) => g.source === filters.source);
      if (filters?.parentGoalId) result = result.filter((g) => g.parentGoalId === filters.parentGoalId);
      if (filters?.limit) result = result.slice(0, filters.limit);
      return result;
    },

    getIterations(goalId: UUID): readonly FridayAutonomousIteration[] {
      const cached = iterations.get(goalId);
      if (cached && cached.length > 0) return cached;
      if (!persistence) return [];
      try {
        return persistence.sqlite.withReadConnection((db) => persistence.repository.getIterationsByGoalId(db, goalId));
      } catch { return []; }
    },
  };
}

// ─── Helpers ───

function isTerminal(status: FridayAutonomousGoalStatus): boolean {
  return status === "completed"
    || status === "failed"
    || status === "cancelled"
    || status === "interrupted_nonrecoverable";
}

function classifyRestartRecovery(
  goal: FridayAutonomousGoal,
  goalSteps: readonly FridayAutonomousStep[],
): { goalStatus: FridayAutonomousGoalStatus; reason: string } {
  if (goal.status === "planning") {
    return {
      goalStatus: "interrupted_recoverable",
      reason: "Interrupted by process restart before action execution; plan can be rebuilt safely.",
    };
  }

  const hasActiveExecution = goalSteps.some((step) => step.status === "executing");
  if (goal.status === "executing" && hasActiveExecution) {
    return {
      goalStatus: "interrupted_nonrecoverable",
      reason: "Interrupted by process restart during active tool execution; safe resume checkpoint unavailable.",
    };
  }

  return {
    goalStatus: "interrupted_recoverable",
    reason: "Interrupted by process restart after a resumable checkpoint; verification or planning can be replayed.",
  };
}

function classifyRestartedStep(
  step: FridayAutonomousStep,
  goalStatus: FridayAutonomousGoalStatus,
  reason: string,
  interruptedAt: string,
): Partial<FridayAutonomousStep> | null {
  if (
    step.status === "completed"
    || step.status === "failed"
    || step.status === "skipped"
    || step.status === "interrupted_nonrecoverable"
  ) {
    return null;
  }

  if (goalStatus === "interrupted_nonrecoverable") {
    return {
      status: step.status === "pending" ? "skipped" : "interrupted_nonrecoverable",
      failureReason: reason,
      completedAt: interruptedAt,
    };
  }

  if (goalStatus === "interrupted_recoverable" || goalStatus === "resumed") {
    return {
      status: "interrupted_recoverable",
      failureReason: reason,
      completedAt: undefined,
    };
  }

  return null;
}

function tryDeterministicBrowserVerification(
  step: FridayAutonomousStep,
  observations: readonly FridayAutonomousObservation[],
): { passed: boolean; actual: string } | null {
  if ((step.domain !== "browser" && step.domain !== "composite") || !step.verification) {
    return null;
  }

  const title = observations
    .map((obs) => obs.textContent)
    .find((value): value is string => typeof value === "string" && value.startsWith("PAGE_TITLE: "))
    ?.slice("PAGE_TITLE: ".length)
    .trim();
  const url = observations
    .map((obs) => obs.textContent)
    .find((value): value is string => typeof value === "string" && value.startsWith("PAGE_URL: "))
    ?.slice("PAGE_URL: ".length)
    .trim();
  const headings = observations.flatMap((obs) =>
    typeof obs.structuredData === "string"
      ? Array.from(obs.structuredData.matchAll(/heading "([^"]+)"/g), (match) => match[1]?.trim() ?? "").filter(Boolean)
      : [],
  );
  const snapshotText = observations
    .map((obs) => obs.structuredData ?? obs.textContent ?? "")
    .filter((value) => value.length > 0)
    .join("\n");

  const verificationText = [
    step.verification.expected,
    step.verification.description,
    step.instruction,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ");

  const checks: { label: string; passed: boolean; actual: string }[] = [];

  const titleContains = extractVerificationNeedle(verificationText, /(?:page\s+)?title\s+(?:should\s+)?contain(?:s)?\s+/i);
  if (titleContains && title && isExplicitVerificationNeedle(titleContains)) {
    checks.push({
      label: "title_contains",
      passed: title.toLowerCase().includes(titleContains.toLowerCase()),
      actual: `title=${title}`,
    });
  }

  const titleEquals = extractVerificationNeedle(
    verificationText,
    /(?:page\s+)?title\s+(?:should\s+)?(?:be|is|equals?|exactly)\s+/i,
  );
  if (titleEquals && title && isExplicitVerificationNeedle(titleEquals)) {
    checks.push({
      label: "title_equals",
      passed: title.toLowerCase() === titleEquals.toLowerCase(),
      actual: `title=${title}`,
    });
  }

  const urlContains = extractVerificationUrlNeedle(verificationText, /url\s+(?:should\s+)?contain(?:s)?\s+/i);
  if (urlContains && url && isExplicitVerificationNeedle(urlContains)) {
    const normalizedUrl = normalizeComparableUrl(url);
    const normalizedNeedle = normalizeComparableUrl(urlContains);
    checks.push({
      label: "url_contains",
      passed: normalizedUrl.toLowerCase().includes(normalizedNeedle.toLowerCase()),
      actual: `url=${url}`,
    });
  }

  const urlEquals = extractVerificationUrlNeedle(
    verificationText,
    /url\s+(?:should\s+)?(?:match(?:es)?|equal(?:s)?|be|is|exactly)\s+/i,
  );
  if (urlEquals && url && isExplicitVerificationNeedle(urlEquals)) {
    checks.push({
      label: "url_equals",
      passed: normalizeComparableUrl(url).toLowerCase() === normalizeComparableUrl(urlEquals).toLowerCase(),
      actual: `url=${url}`,
    });
  }

  const headingContains = extractVerificationNeedle(verificationText, /heading\s+(?:should\s+)?contain(?:s)?\s+/i);
  if (headingContains && isExplicitVerificationNeedle(headingContains)) {
    const haystacks = headings.length > 0 ? headings : [snapshotText];
    checks.push({
      label: "heading_contains",
      passed: haystacks.some((value) => value.toLowerCase().includes(headingContains.toLowerCase())),
      actual: headings.length > 0 ? `headings=${headings.join(" | ")}` : snapshotText.slice(0, 200),
    });
  }

  const headingEquals = extractVerificationNeedle(
    verificationText,
    /heading\s+(?:should\s+)?(?:be|is|equals?|exactly)\s+/i,
  );
  if (headingEquals && isExplicitVerificationNeedle(headingEquals)) {
    checks.push({
      label: "heading_equals",
      passed: headings.some((value) => value.toLowerCase() === headingEquals.toLowerCase()),
      actual: headings.length > 0 ? `headings=${headings.join(" | ")}` : "headings=<missing>",
    });
  }

  if (/\bheading\b[\s\S]{0,24}\bvisible\b/i.test(verificationText)) {
    checks.push({
      label: "heading_visible",
      passed: headings.length > 0,
      actual: headings.length > 0 ? `headings=${headings.join(" | ")}` : "headings=<missing>",
    });
  }

  if (checks.length === 0) {
    return null;
  }

  return {
    passed: checks.every((check) => check.passed),
    actual: checks.map((check) => `${check.label}:${check.actual}`).join("; "),
  };
}

function extractVerificationNeedle(text: string, pattern: RegExp): string | null {
  const match = pattern.exec(text);
  if (!match) {
    return null;
  }
  const remainder = text.slice(match.index + match[0].length);
  const cleaned = remainder
    .split(/\b(?:before|after|while|then)\b/i, 1)[0]
    .split(/[.,;\n]/, 1)[0]
    .trim()
    .replace(/^["'`“”]+|["'`“”]+$/g, "")
    .replace(/\s+$/, "")
    .replace(/\s+\band\b\s+(?=(?:the\s+)?(?:url|title|heading|page|link)\b)[\s\S]*$/i, "");
  return cleaned.length > 0 ? cleaned : null;
}

function extractVerificationUrlNeedle(text: string, pattern: RegExp): string | null {
  const match = pattern.exec(text);
  if (!match) {
    return null;
  }
  const remainder = text.slice(match.index + match[0].length).trim();
  const explicitUrl = extractFirstUrl(remainder);
  if (explicitUrl) {
    return explicitUrl;
  }
  return extractVerificationNeedle(text, pattern);
}

function normalizeComparableUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const parsed = new URL(trimmed);
    const isDefaultPort =
      (parsed.protocol === "https:" && parsed.port === "443")
      || (parsed.protocol === "http:" && parsed.port === "80");
    const port = parsed.port.length > 0 && !isDefaultPort ? `:${parsed.port}` : "";
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.protocol}//${parsed.hostname}${port}${pathname}${parsed.search}`;
  } catch {
    return trimmed.replace(/\/$/, "");
  }
}

function isExplicitVerificationNeedle(needle: string): boolean {
  const normalized = needle.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }

  return !/^(?:extracted?|recorded|captured|retrieved|obtained|confirmed|available|loaded|visible)(?:\b|$)/i.test(normalized);
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
