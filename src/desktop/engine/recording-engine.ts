import { FridayDomainError } from "#errors";

/**
 * Recording Engine — Record and replay desktop interaction sequences.
 *
 * Manages the recording lifecycle (idle → recording ↔ paused → stopped)
 * with strict state transition enforcement. Captures actions as parameterized
 * steps, persists recordings in-memory, and supports sequential replay
 * through the full permission/execution pipeline.
 *
 * @module desktop/engine/recording-engine
 */

import type {
  FridayDesktopAction,
  FridayDesktopActionResult,
  FridayDesktopAdapterRuntime,
  FridayDesktopElement,
  FridayDesktopEngineConfig,
  FridayDesktopPlatform,
  FridayDesktopRecording,
  FridayDesktopRecordingParameterEntry,
  FridayDesktopRecordingParameterMap,
  FridayDesktopRecordingState,
  FridayDesktopRecordingStep,
  ISODateTime,
  UUID,
} from "../model/friday-desktop.types.js";

import {
  FRIDAY_DESKTOP_ERROR_CODES,
  FRIDAY_DESKTOP_RECORDING_STATE_TRANSITIONS,
} from "../model/friday-desktop.types.js";

// ─── Public Types ───

/** Configuration for recording engine creation. */
export interface RecordingEngineConfig {
  readonly generateId: FridayDesktopEngineConfig["generateId"];
  readonly nowIso: FridayDesktopEngineConfig["nowIso"];
  readonly platform: FridayDesktopPlatform;
  readonly principalId: string;
}

/** Options for starting a new recording. */
export interface StartRecordingOptions {
  readonly name: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly tenantId?: string;
}

/** Options for replaying a recording. */
export interface ReplayOptions {
  /** Parameter values for replay (name → value). */
  readonly parameters?: Readonly<Record<string, string>>;
  /** Whether to stop on first step failure. */
  readonly stopOnFailure?: boolean;
}

/** Result of a single replayed step. */
export interface ReplayStepResult {
  readonly stepIndex: number;
  readonly stepId: UUID;
  readonly result: FridayDesktopActionResult;
}

/** Result of a full recording replay. */
export interface ReplayResult {
  readonly recordingId: UUID;
  readonly stepResults: readonly ReplayStepResult[];
  readonly allSucceeded: boolean;
  readonly successCount: number;
  readonly failureCount: number;
  readonly skippedCount: number;
  readonly totalDurationMs: number;
}

/** Callback for executing a single action during replay. */
export type ReplayActionExecutor = (
  action: FridayDesktopAction,
) => Promise<FridayDesktopActionResult>;

/** Recording engine interface. */
export interface RecordingEngine {
  /** Start a new recording. Returns the created recording. */
  start(options: StartRecordingOptions): FridayDesktopRecording;

  /** Stop an active recording. */
  stop(recordingId: UUID): FridayDesktopRecording;

  /** Pause an active recording. */
  pause(recordingId: UUID): FridayDesktopRecording;

  /** Resume a paused recording. */
  resume(recordingId: UUID): FridayDesktopRecording;

  /** Capture an action step into the active recording. */
  captureStep(
    recordingId: UUID,
    action: FridayDesktopAction,
    result?: FridayDesktopActionResult,
    element?: FridayDesktopElement,
    parameterBindings?: Readonly<Record<string, string>>,
  ): FridayDesktopRecordingStep;

  /** Get a recording by ID. */
  getRecording(recordingId: UUID): FridayDesktopRecording | null;

  /** Get all steps for a recording. */
  getSteps(recordingId: UUID): readonly FridayDesktopRecordingStep[];

  /** List all recordings. */
  listRecordings(): readonly FridayDesktopRecording[];

  /** Delete a recording and its steps. Returns true if deleted. */
  deleteRecording(recordingId: UUID): boolean;

  /** Replay a stopped recording through the given executor. */
  replay(
    recordingId: UUID,
    executor: ReplayActionExecutor,
    options?: ReplayOptions,
  ): Promise<ReplayResult>;

  /** Add a parameter definition to a recording. */
  addParameter(
    recordingId: UUID,
    name: string,
    entry: FridayDesktopRecordingParameterEntry,
  ): FridayDesktopRecording;
}

// ─── Helpers ───

function isValidTransition(
  from: FridayDesktopRecordingState,
  to: FridayDesktopRecordingState,
): boolean {
  return FRIDAY_DESKTOP_RECORDING_STATE_TRANSITIONS[from].includes(to);
}

function deepClone<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
  } else {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return Object.freeze(value);
}

function toFrozenSnapshot<T>(value: T): Readonly<T> {
  return deepFreeze(deepClone(value));
}

function applyParameterSubstitutions(
  action: FridayDesktopAction,
  parameters: FridayDesktopRecordingParameterMap,
  values: Readonly<Record<string, string>>,
  bindings: Readonly<Record<string, string>>,
): FridayDesktopAction {
  // Use explicit bindings when present; otherwise fall back to parameter map substitution.
  const hasBindings = Object.keys(bindings).length > 0;
  const json = JSON.stringify(action);
  const substituted = json.replace(/\{\{(\w+)\}\}/g, (match, paramName) => {
    if (hasBindings && !Object.hasOwn(bindings, paramName)) {
      return match;
    }
    if (Object.hasOwn(values, paramName)) return values[paramName];
    const paramDef = parameters[paramName];
    if (paramDef?.defaultValue !== undefined) return paramDef.defaultValue;
    if (Object.hasOwn(bindings, paramName)) return bindings[paramName];
    return match;
  });
  return JSON.parse(substituted) as FridayDesktopAction;
}

// ─── Factory ───

/** Create a recording engine instance. */
export function createRecordingEngine(config: RecordingEngineConfig): RecordingEngine {
  const recordings = new Map<UUID, FridayDesktopRecording>();
  const steps = new Map<UUID, FridayDesktopRecordingStep[]>();

  function transitionState(
    recordingId: UUID,
    targetState: FridayDesktopRecordingState,
  ): FridayDesktopRecording {
    const recording = recordings.get(recordingId);
    if (!recording) {
      throw new FridayDomainError("NOT_FOUND", `${FRIDAY_DESKTOP_ERROR_CODES.RECORDING_NOT_FOUND}: Recording '${recordingId}' not found`, { httpStatus: 404 });
    }

    if (!isValidTransition(recording.state, targetState)) {
      throw new FridayDomainError("VALIDATION_ERROR", `${FRIDAY_DESKTOP_ERROR_CODES.RECORDING_INVALID_STATE}: Cannot transition from '${recording.state}' to '${targetState}'`, { httpStatus: 400 });
    }

    const now = config.nowIso();
    const updated: FridayDesktopRecording = {
      ...recording,
      state: targetState,
      updatedAt: now,
      ...(targetState === "stopped" ? { stoppedAt: now } : {}),
    };

    recordings.set(recordingId, updated);
    return updated;
  }

  return {
    start(options: StartRecordingOptions): FridayDesktopRecording {
      const id = config.generateId();
      const now = config.nowIso();

      const recording: FridayDesktopRecording = {
        id,
        name: options.name,
        description: options.description,
        state: "recording",
        platform: config.platform,
        parameters: {},
        tags: options.tags ?? [],
        stepCount: 0,
        createdBy: config.principalId,
        tenantId: options.tenantId,
        createdAt: now,
        updatedAt: now,
      };

      recordings.set(id, recording);
      steps.set(id, []);
      return recording;
    },

    stop(recordingId: UUID): FridayDesktopRecording {
      return transitionState(recordingId, "stopped");
    },

    pause(recordingId: UUID): FridayDesktopRecording {
      return transitionState(recordingId, "paused");
    },

    resume(recordingId: UUID): FridayDesktopRecording {
      return transitionState(recordingId, "recording");
    },

    captureStep(
      recordingId: UUID,
      action: FridayDesktopAction,
      result?: FridayDesktopActionResult,
      element?: FridayDesktopElement,
      parameterBindings?: Readonly<Record<string, string>>,
    ): FridayDesktopRecordingStep {
      const recording = recordings.get(recordingId);
      if (!recording) {
        throw new FridayDomainError("NOT_FOUND", `${FRIDAY_DESKTOP_ERROR_CODES.RECORDING_NOT_FOUND}: Recording '${recordingId}' not found`, { httpStatus: 404 });
      }
      if (recording.state !== "recording") {
        throw new FridayDomainError("VALIDATION_ERROR", `${FRIDAY_DESKTOP_ERROR_CODES.RECORDING_INVALID_STATE}: Recording is '${recording.state}', expected 'recording'`, { httpStatus: 400 });
      }

      const recordingSteps = steps.get(recordingId)!;
      const stepIndex = recordingSteps.length;

      const step: FridayDesktopRecordingStep = {
        id: config.generateId(),
        recordingId,
        stepIndex,
        action,
        result,
        element,
        parameterBindings: { ...(parameterBindings ?? {}) },
        timestamp: config.nowIso(),
        durationMs: result?.durationMs,
      };

      recordingSteps.push(step);

      // Update step count on the recording
      const updated: FridayDesktopRecording = {
        ...recording,
        stepCount: recordingSteps.length,
        updatedAt: config.nowIso(),
      };
      recordings.set(recordingId, updated);

      return step;
    },

    getRecording(recordingId: UUID): FridayDesktopRecording | null {
      const recording = recordings.get(recordingId);
      if (!recording) {
        return null;
      }
      return toFrozenSnapshot(recording);
    },

    getSteps(recordingId: UUID): readonly FridayDesktopRecordingStep[] {
      return toFrozenSnapshot(steps.get(recordingId) ?? []);
    },

    listRecordings(): readonly FridayDesktopRecording[] {
      return toFrozenSnapshot(Array.from(recordings.values()));
    },

    deleteRecording(recordingId: UUID): boolean {
      const existed = recordings.delete(recordingId);
      steps.delete(recordingId);
      return existed;
    },

    async replay(
      recordingId: UUID,
      executor: ReplayActionExecutor,
      options?: ReplayOptions,
    ): Promise<ReplayResult> {
      const recording = recordings.get(recordingId);
      if (!recording) {
        throw new FridayDomainError("NOT_FOUND", `${FRIDAY_DESKTOP_ERROR_CODES.RECORDING_NOT_FOUND}: Recording '${recordingId}' not found`, { httpStatus: 404 });
      }
      if (recording.state !== "stopped") {
        throw new FridayDomainError("VALIDATION_ERROR", `${FRIDAY_DESKTOP_ERROR_CODES.RECORDING_INVALID_STATE}: Recording must be stopped for replay, current state: '${recording.state}'`, { httpStatus: 400 });
      }

      const recordingSteps = steps.get(recordingId) ?? [];
      const paramValues = options?.parameters ?? {};
      const stopOnFailure = options?.stopOnFailure ?? true;

      const stepResults: ReplayStepResult[] = [];
      let successCount = 0;
      let failureCount = 0;
      let skippedCount = 0;
      const replayStart = Date.now();

      for (const step of recordingSteps) {
        if (stopOnFailure && failureCount > 0) {
          skippedCount++;
          continue;
        }

        const substitutedAction = applyParameterSubstitutions(
          step.action,
          recording.parameters,
          paramValues,
          step.parameterBindings,
        );

        const result = await executor(substitutedAction);
        stepResults.push({
          stepIndex: step.stepIndex,
          stepId: step.id,
          result,
        });

        if (result.status === "success") {
          successCount++;
        } else {
          failureCount++;
        }
      }

      return {
        recordingId,
        stepResults,
        allSucceeded: failureCount === 0 && skippedCount === 0,
        successCount,
        failureCount,
        skippedCount,
        totalDurationMs: Date.now() - replayStart,
      };
    },

    addParameter(
      recordingId: UUID,
      name: string,
      entry: FridayDesktopRecordingParameterEntry,
    ): FridayDesktopRecording {
      const recording = recordings.get(recordingId);
      if (!recording) {
        throw new FridayDomainError("NOT_FOUND", `${FRIDAY_DESKTOP_ERROR_CODES.RECORDING_NOT_FOUND}: Recording '${recordingId}' not found`, { httpStatus: 404 });
      }

      const updated: FridayDesktopRecording = {
        ...recording,
        parameters: { ...recording.parameters, [name]: entry },
        updatedAt: config.nowIso(),
      };
      recordings.set(recordingId, updated);
      return updated;
    },
  };
}
