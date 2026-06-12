import { FridayDomainError } from "#errors";

/**
 * Desktop Session Manager — Orchestrates the desktop control runtime lifecycle.
 *
 * Top-level facade that wires together all engine components (adapter manager,
 * permission guard, element inspector, action executor, recording engine).
 * Provides connect/disconnect semantics, session-scoped state, and a unified
 * API surface for callers (agent runtime, workflow runtime, API layer).
 *
 * @module desktop/engine/session-manager
 */

import type {
  FridayDesktopAction,
  FridayDesktopActionResult,
  FridayDesktopAdapterRuntime,
  FridayDesktopCapability,
  FridayDesktopElement,
  FridayDesktopElementSelector,
  FridayDesktopEngineConfig,
  FridayDesktopPermission,
  FridayDesktopPlatform,
  FridayDesktopPolicy,
  FridayDesktopRecording,
  FridayDesktopRecordingStep,
  ISODateTime,
  UUID,
} from "../model/friday-desktop.types.js";

import { FRIDAY_DESKTOP_ENGINE_DEFAULTS } from "../model/friday-desktop.types.js";

import type { AdapterManager } from "./adapter-manager.js";
import { createAdapterManager } from "./adapter-manager.js";
import type { PermissionGuard, PermissionPromptResolver } from "./permission-guard.js";
import { createPermissionGuard } from "./permission-guard.js";
import type { ElementInspector } from "./element-inspector.js";
import { createElementInspector } from "./element-inspector.js";
import type { ActionExecutor, ExecuteActionOptions } from "./action-executor.js";
import { createActionExecutor } from "./action-executor.js";
import type {
  RecordingEngine,
  ReplayActionExecutor,
  ReplayOptions,
  ReplayResult,
  StartRecordingOptions,
} from "./recording-engine.js";
import { createRecordingEngine } from "./recording-engine.js";

// ─── Public Types ───

/** Session state. */
export type DesktopSessionState = "disconnected" | "connected";

/** Configuration for session manager creation. */
export interface SessionManagerConfig {
  readonly generateId: FridayDesktopEngineConfig["generateId"];
  readonly nowIso: FridayDesktopEngineConfig["nowIso"];
  readonly principalId: string;
  readonly defaultActionTimeoutMs?: number;
  readonly maxConcurrentActions?: number;
  readonly permissionPromptTimeoutMs?: number;
  readonly sandboxAllowedRoots?: readonly string[];
  readonly promptResolver?: PermissionPromptResolver;
  /**
   * Test-oracle only: allows the legacy TypeScript desktop ACTION sink +
   * control/audit surfaces (`executeAction` — arbitrary OS-level click/type/
   * keypress/drag/launch_app/close_app/clipboard/file-ops — plus `cancelAction`
   * and `getActionLog`) in isolated test/validation harnesses. The HTTP route is
   * already retired (`TS_RUNTIME_DESKTOP_ACTION_EXECUTION_RETIRED`) but consumed
   * ONLY at the route, so non-route callers (agent desktop tool, autonomy engine,
   * skill desktop helper) reach these methods directly. Default/live runtime must
   * leave this unset so the actuator + its control/audit surfaces fail closed for
   * ALL callers. Mirrors the route's `allowTestOnlyDesktopActionExecution` flag.
   */
  readonly allowTestOnlyDesktopActionExecution?: boolean;
}

/** Session metadata. */
export interface DesktopSessionInfo {
  readonly sessionId: UUID;
  readonly state: DesktopSessionState;
  readonly platform: FridayDesktopPlatform | null;
  readonly principalId: string;
  readonly connectedAt: ISODateTime | null;
}

/** Desktop session manager interface. */
export interface DesktopSessionManager {
  /** Connect the session, initializing all engine components. */
  connect(): DesktopSessionInfo;

  /** Disconnect the session, stopping any active recordings. */
  disconnect(): DesktopSessionInfo;

  /** Get the current session info. */
  getSessionInfo(): DesktopSessionInfo;

  /** Check if the session is connected. */
  isConnected(): boolean;

  // ─── Adapter Management ───

  /** Get the adapter manager. */
  getAdapterManager(): AdapterManager;

  /** Register a platform adapter. */
  registerAdapter(adapter: FridayDesktopAdapterRuntime): void;

  // ─── Action Execution ───

  /** Execute a desktop action through the full pipeline. */
  executeAction(
    action: FridayDesktopAction,
    options?: ExecuteActionOptions,
  ): Promise<FridayDesktopActionResult>;

  /** Cancel a running action. */
  cancelAction(actionId: UUID): boolean;

  /** Get the action execution log. */
  getActionLog(): readonly FridayDesktopActionResult[];

  // ─── Element Inspection ───

  /** Inspect a UI element by selector. */
  inspectElement(
    selector: FridayDesktopElementSelector,
  ): Promise<FridayDesktopElement | null>;

  /** Search for elements by text query. */
  searchElements(
    query: string,
    appBundleId?: string,
  ): Promise<readonly FridayDesktopElement[]>;

  // ─── Permissions ───

  /** Check OS permissions for the active adapter. */
  checkPermissions(): Promise<readonly FridayDesktopPermission[]>;

  /** Load policies into the permission guard. */
  loadPolicies(policies: readonly FridayDesktopPolicy[]): void;

  // ─── Recording ───

  /** Start a new recording. */
  startRecording(options: StartRecordingOptions): FridayDesktopRecording;

  /** Stop an active recording. */
  stopRecording(recordingId: UUID): FridayDesktopRecording;

  /** Pause an active recording. */
  pauseRecording(recordingId: UUID): FridayDesktopRecording;

  /** Resume a paused recording. */
  resumeRecording(recordingId: UUID): FridayDesktopRecording;

  /** Get a recording by ID. */
  getRecording(recordingId: UUID): FridayDesktopRecording | null;

  /** Get recording steps. */
  getRecordingSteps(recordingId: UUID): readonly FridayDesktopRecordingStep[];

  /** List all recordings. */
  listRecordings(): readonly FridayDesktopRecording[];

  /** Delete a recording. */
  deleteRecording(recordingId: UUID): boolean;

  /** Replay a stopped recording. */
  replayRecording(recordingId: UUID, options?: ReplayOptions): Promise<ReplayResult>;
}

// ─── Factory ───

/** Create a desktop session manager. */
export function createDesktopSessionManager(
  config: SessionManagerConfig,
): DesktopSessionManager {
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

  const sessionId = config.generateId();
  let state: DesktopSessionState = "disconnected";
  let connectedAt: ISODateTime | null = null;

  // Subsystems
  const adapterManager = createAdapterManager({
    generateId: config.generateId,
    nowIso: config.nowIso,
  });

  const permissionGuard = createPermissionGuard({
    generateId: config.generateId,
    nowIso: config.nowIso,
    permissionPromptTimeoutMs:
      config.permissionPromptTimeoutMs ?? FRIDAY_DESKTOP_ENGINE_DEFAULTS.permissionPromptTimeoutMs,
    promptResolver: config.promptResolver,
    principalId: config.principalId,
  });

  const elementInspector = createElementInspector({
    generateId: config.generateId,
    nowIso: config.nowIso,
  });

  const actionExecutor = createActionExecutor({
    generateId: config.generateId,
    nowIso: config.nowIso,
    defaultActionTimeoutMs:
      config.defaultActionTimeoutMs ?? FRIDAY_DESKTOP_ENGINE_DEFAULTS.defaultActionTimeoutMs,
    maxConcurrentActions:
      config.maxConcurrentActions ?? FRIDAY_DESKTOP_ENGINE_DEFAULTS.maxConcurrentActions,
    sandboxAllowedRoots: config.sandboxAllowedRoots,
  });

  let recordingEngine: RecordingEngine | null = null;
  /** Active recording ID (at most one recording is active at a time). */
  let activeRecordingId: UUID | null = null;

  function ensureConnected(): void {
    if (state !== "connected") {
      throw new FridayDomainError("NOT_INITIALIZED", "Desktop session is not connected", { httpStatus: 503 });
    }
  }

  // ─── TS Runtime Retirement: METHOD-level fail-closed guard ───
  // Phase 3 (route-only-guard defect): the desktop action surface was
  // ROUTE-only-retired (friday-desktop-routes fail-closes
  // desktop.actions.execute / .cancel / .log before the route calls the
  // service). The session-manager methods themselves (`executeAction`,
  // `cancelAction`, `getActionLog`) had NO method guard, so off-route callers —
  // the agent desktop tool (handleExecute/handleScreenshot), the autonomous
  // engine (captureDesktopScreenshot), and the skill desktop helper
  // (executeAction/getActionLog) — reach the live OS actuator/audit directly,
  // bypassing the route fence. Guarding at the method head fails ALL non-route
  // callers closed BEFORE ensureConnected / adapter-lookup / any side-effect,
  // unless the explicit test-oracle `allowTestOnlyDesktopActionExecution` flag is
  // set. Never default this flag on in production. Recording lifecycle/replay,
  // element inspection, and permissions are SEPARATE retired families and are
  // NOT covered here.
  function assertDesktopActionExecutionAllowed(): void {
    if (config.allowTestOnlyDesktopActionExecution !== true) {
      throw new FridayDomainError(
        "TS_RUNTIME_DESKTOP_ACTION_EXECUTION_RETIRED",
        "Desktop action execution is fail-closed while runtime ownership is being moved out of TypeScript.",
        {
          httpStatus: 503,
          details: {
            classification: "fail_closed",
            replacement: "rust_owned_desktop_action_execution_entrypoint_required",
          },
        },
      );
    }
  }

  function getRecordingEngine(): RecordingEngine {
    if (!recordingEngine) {
      const platform = adapterManager.getDetectedPlatform() ?? "darwin";
      recordingEngine = createRecordingEngine({
        generateId: config.generateId,
        nowIso: config.nowIso,
        platform,
        principalId: config.principalId,
      });
    }
    return recordingEngine;
  }

  function buildSessionInfo(): DesktopSessionInfo {
    return toFrozenSnapshot({
      sessionId,
      state,
      platform: adapterManager.getDetectedPlatform(),
      principalId: config.principalId,
      connectedAt,
    });
  }

  return {
    connect(): DesktopSessionInfo {
      if (state === "connected") return buildSessionInfo();
      state = "connected";
      connectedAt = config.nowIso();
      return buildSessionInfo();
    },

    disconnect(): DesktopSessionInfo {
      if (state === "disconnected") return buildSessionInfo();

      // Stop all active/paused recordings before disconnecting.
      if (recordingEngine) {
        const recordings = recordingEngine.listRecordings();
        for (const recording of recordings) {
          if (recording.state === "recording" || recording.state === "paused") {
            recordingEngine.stop(recording.id);
          }
        }
        activeRecordingId = null;
      }

      state = "disconnected";
      connectedAt = null;
      return buildSessionInfo();
    },

    getSessionInfo(): DesktopSessionInfo {
      return buildSessionInfo();
    },

    isConnected(): boolean {
      return state === "connected";
    },

    // ─── Adapter Management ───

    getAdapterManager(): AdapterManager {
      return adapterManager;
    },

    registerAdapter(adapter: FridayDesktopAdapterRuntime): void {
      adapterManager.register(adapter);
    },

    // ─── Action Execution ───

    async executeAction(
      action: FridayDesktopAction,
      options?: ExecuteActionOptions,
    ): Promise<FridayDesktopActionResult> {
      assertDesktopActionExecutionAllowed();
      ensureConnected();
      const adapter = adapterManager.getActiveAdapter();

      // Integrate recording: capture step if recording is active
      const captureOptions: ExecuteActionOptions = {
        ...options,
        onStepCaptured: (result) => {
          options?.onStepCaptured?.(result);
          if (activeRecordingId && recordingEngine) {
            const rec = recordingEngine.getRecording(activeRecordingId);
            if (rec?.state === "recording") {
              recordingEngine.captureStep(
                activeRecordingId,
                action,
                result,
                result.targetElement,
              );
            }
          }
        },
      };

      return actionExecutor.execute(
        action,
        adapter,
        permissionGuard,
        elementInspector,
        captureOptions,
      );
    },

    cancelAction(actionId: UUID): boolean {
      assertDesktopActionExecutionAllowed();
      return actionExecutor.cancel(actionId);
    },

    getActionLog(): readonly FridayDesktopActionResult[] {
      assertDesktopActionExecutionAllowed();
      return toFrozenSnapshot(actionExecutor.getActionLog());
    },

    // ─── Element Inspection ───

    async inspectElement(
      selector: FridayDesktopElementSelector,
    ): Promise<FridayDesktopElement | null> {
      ensureConnected();
      const adapter = adapterManager.getActiveAdapter();
      return elementInspector.resolve(selector, adapter);
    },

    async searchElements(
      query: string,
      appBundleId?: string,
    ): Promise<readonly FridayDesktopElement[]> {
      ensureConnected();
      const adapter = adapterManager.getActiveAdapter();
      return elementInspector.search(query, adapter, appBundleId);
    },

    // ─── Permissions ───

    async checkPermissions(): Promise<readonly FridayDesktopPermission[]> {
      ensureConnected();
      const adapter = adapterManager.getActiveAdapter();
      return adapter.checkPermissions();
    },

    loadPolicies(policies: readonly FridayDesktopPolicy[]): void {
      permissionGuard.loadPolicies(policies);
    },

    // ─── Recording ───

    startRecording(options: StartRecordingOptions): FridayDesktopRecording {
      ensureConnected();
      const engine = getRecordingEngine();
      const activeRecordings = engine
        .listRecordings()
        .filter((recording) => recording.state === "recording" || recording.state === "paused");

      if (activeRecordings.length > 0) {
        throw new FridayDomainError("VALIDATION_ERROR", "A recording is already active; stop it before starting a new recording", { httpStatus: 400 });
      }

      const recording = engine.start(options);
      activeRecordingId = recording.id;
      return recording;
    },

    stopRecording(recordingId: UUID): FridayDesktopRecording {
      ensureConnected();
      const engine = getRecordingEngine();
      const result = engine.stop(recordingId);
      if (activeRecordingId === recordingId) {
        activeRecordingId = null;
      }
      return result;
    },

    pauseRecording(recordingId: UUID): FridayDesktopRecording {
      ensureConnected();
      return getRecordingEngine().pause(recordingId);
    },

    resumeRecording(recordingId: UUID): FridayDesktopRecording {
      ensureConnected();
      return getRecordingEngine().resume(recordingId);
    },

    getRecording(recordingId: UUID): FridayDesktopRecording | null {
      return getRecordingEngine().getRecording(recordingId);
    },

    getRecordingSteps(recordingId: UUID): readonly FridayDesktopRecordingStep[] {
      return getRecordingEngine().getSteps(recordingId);
    },

    listRecordings(): readonly FridayDesktopRecording[] {
      return getRecordingEngine().listRecordings();
    },

    deleteRecording(recordingId: UUID): boolean {
      const engine = getRecordingEngine();
      if (activeRecordingId === recordingId) {
        activeRecordingId = null;
      }
      return engine.deleteRecording(recordingId);
    },

    async replayRecording(recordingId: UUID, options?: ReplayOptions): Promise<ReplayResult> {
      ensureConnected();
      const engine = getRecordingEngine();
      const adapter = adapterManager.getActiveAdapter();

      const executor: ReplayActionExecutor = async (action) => {
        return actionExecutor.execute(
          action,
          adapter,
          permissionGuard,
          elementInspector,
        );
      };

      return engine.replay(recordingId, executor, options);
    },
  };
}
