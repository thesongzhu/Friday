/**
 * Action Executor — Desktop action dispatch, validation, and lifecycle.
 *
 * Orchestrates the full action execution pipeline:
 * 1. Validates the action payload
 * 2. Enforces sandbox boundaries for filesystem actions
 * 3. Checks permissions via the Permission Guard (OS → Policy → Human)
 * 4. Resolves target elements via the Element Inspector (if selector-based)
 * 5. Delegates to the platform adapter for execution
 * 6. Records execution results to the action log
 * 7. Forwards captured actions to the Recording Engine (if active)
 *
 * Supports concurrency limiting, timeout enforcement, and action cancellation.
 *
 * @module desktop/engine/action-executor
 */

import { lstat, realpath } from "node:fs/promises";
import * as path from "node:path";

import type {
  FridayDesktopAction,
  FridayDesktopActionResult,
  FridayDesktopActionStatus,
  FridayDesktopAdapterRuntime,
  FridayDesktopElement,
  FridayDesktopEngineConfig,
  ISODateTime,
  UUID,
} from "../model/friday-desktop.types.js";

import {
  FRIDAY_DESKTOP_ACTION_TYPES,
  FRIDAY_DESKTOP_CLIPBOARD_OPERATIONS,
  FRIDAY_DESKTOP_ERROR_CODES,
  FRIDAY_DESKTOP_FILE_OPERATIONS,
} from "../model/friday-desktop.types.js";

import type { PermissionCheckResult, PermissionGuard } from "./permission-guard.js";
import type { ElementInspector } from "./element-inspector.js";

// ─── Public Types ───

/** Configuration for action executor creation. */
export interface ActionExecutorConfig {
  readonly generateId: FridayDesktopEngineConfig["generateId"];
  readonly nowIso: FridayDesktopEngineConfig["nowIso"];
  readonly defaultActionTimeoutMs: number;
  readonly maxConcurrentActions: number;
  /** Absolute or relative roots that file actions are allowed to touch. */
  readonly sandboxAllowedRoots?: readonly string[];
}

/** Execution options for a single action. */
export interface ExecuteActionOptions {
  /** Optional caller-supplied action ID to support cancellation by ID. */
  readonly actionId?: UUID;
  /** Timeout override in milliseconds. */
  readonly timeoutMs?: number;
  /** Callback invoked when a step is captured (for recording integration). */
  readonly onStepCaptured?: (result: FridayDesktopActionResult) => void;
}

/** Action executor interface. */
export interface ActionExecutor {
  /** Execute a single desktop action through the full pipeline. */
  execute(
    action: FridayDesktopAction,
    adapter: FridayDesktopAdapterRuntime,
    permissionGuard: PermissionGuard,
    elementInspector: ElementInspector,
    options?: ExecuteActionOptions,
  ): Promise<FridayDesktopActionResult>;

  /** Cancel a running action by result ID. Returns true when cancellation is requested. */
  cancel(actionId: UUID): boolean;

  /** Get the number of currently running actions. */
  getRunningCount(): number;

  /** Get all completed action results (audit log). */
  getActionLog(): readonly FridayDesktopActionResult[];
}

// ─── Helpers ───

const ACTION_TIMEOUT_SIGNAL = "desktop-action-timeout-signal";
const ACTION_ABORT_SIGNAL = "desktop-action-abort-signal";
const PATH_TRAVERSAL_SEGMENT = "..";

interface SandboxCheckResult {
  readonly allowed: boolean;
  readonly normalizedPath?: string;
  readonly message?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
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

function extractSelector(action: FridayDesktopAction) {
  switch (action.type) {
    case "click":
    case "type":
    case "keypress":
    case "scroll":
    case "screenshot":
    case "read_element":
      return action.selector ?? null;
    case "drag":
    case "launch_app":
    case "close_app":
    case "clipboard":
    case "file_operation":
      return null;
    default:
      return null;
  }
}

function validateAction(action: FridayDesktopAction): string | null {
  if (!action || typeof action !== "object") {
    return "Action must be a non-null object";
  }
  if (!(FRIDAY_DESKTOP_ACTION_TYPES as readonly string[]).includes((action as { type?: string }).type ?? "")) {
    return `Unknown action type: '${(action as { type?: string }).type}'`;
  }

  switch (action.type) {
    case "click":
      return null;
    case "type":
      if (!isNonEmptyString(action.text)) {
        return "Type action requires non-empty 'text' field";
      }
      return null;
    case "keypress":
      if (!isNonEmptyString(action.key)) {
        return "Keypress action requires non-empty 'key' field";
      }
      return null;
    case "scroll":
      if (!action.direction) {
        return "Scroll action requires 'direction' field";
      }
      return null;
    case "drag":
      if (!action.from || !action.to) {
        return "Drag action requires 'from' and 'to' fields";
      }
      return null;
    case "screenshot":
      return null;
    case "read_element":
      if (!action.selector) {
        return "ReadElement action requires 'selector' field";
      }
      return null;
    case "launch_app":
    case "close_app":
      if (!isNonEmptyString(action.appIdentifier)) {
        return `${action.type} action requires non-empty 'appIdentifier' field`;
      }
      return null;
    case "clipboard":
      if (!(FRIDAY_DESKTOP_CLIPBOARD_OPERATIONS as readonly string[]).includes(action.operation)) {
        return "Clipboard action requires valid 'operation' field";
      }
      if (action.operation === "write" && !isNonEmptyString(action.content)) {
        return "Clipboard write action requires non-empty 'content' field";
      }
      return null;
    case "file_operation":
      if (!(FRIDAY_DESKTOP_FILE_OPERATIONS as readonly string[]).includes(action.operation)) {
        return "FileOperation action requires valid 'operation' field";
      }
      if (!isNonEmptyString(action.path)) {
        return "FileOperation action requires non-empty 'path' field";
      }
      if (action.operation === "write" && !isNonEmptyString(action.content)) {
        return "FileOperation write action requires non-empty 'content' field";
      }
      if (
        (action.operation === "move" || action.operation === "copy")
        && !isNonEmptyString(action.destinationPath)
      ) {
        return `FileOperation ${action.operation} action requires non-empty 'destinationPath' field`;
      }
      return null;
    default:
      return "Unknown action type";
  }
}

function mapPermissionDenialToStatus(denialCode?: string): FridayDesktopActionStatus {
  if (denialCode === FRIDAY_DESKTOP_ERROR_CODES.PERMISSION_DENIED_OS) {
    return "permission_denied_os";
  }
  if (denialCode === FRIDAY_DESKTOP_ERROR_CODES.PERMISSION_DENIED_POLICY) {
    return "permission_denied_policy";
  }
  if (denialCode === FRIDAY_DESKTOP_ERROR_CODES.UNSUPPORTED_CAPABILITY) {
    return "unsupported_capability";
  }
  return "permission_denied_user";
}

function extractSandboxPaths(action: FridayDesktopAction): readonly string[] {
  if (action.type !== "file_operation") {
    return [];
  }

  if (action.operation === "move" || action.operation === "copy") {
    return [action.path, action.destinationPath];
  }

  return [action.path];
}

function containsTraversalSegment(rawPath: string): boolean {
  const segments = rawPath.split(/[\\/]+/g);
  return segments.includes(PATH_TRAVERSAL_SEGMENT);
}

function normalizePathForComparison(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isPathWithinRoot(targetPath: string, rootPath: string): boolean {
  const normalizedTarget = normalizePathForComparison(targetPath);
  const normalizedRoot = normalizePathForComparison(rootPath);
  const relative = path.relative(normalizedRoot, normalizedTarget);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isPathWithinAnyRoot(targetPath: string, rootPaths: readonly string[]): boolean {
  return rootPaths.some((root) => isPathWithinRoot(targetPath, root));
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function findClosestExistingPath(
  normalizedPath: string,
): Promise<{ readonly existingPath: string; readonly remainder: readonly string[] }> {
  let current = path.resolve(normalizedPath);
  const remainder: string[] = [];

  while (true) {
    try {
      await lstat(current);
      return { existingPath: current, remainder };
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") {
        throw error;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return { existingPath: current, remainder };
      }

      remainder.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function resolveRealSandboxPath(normalizedPath: string): Promise<string> {
  const { existingPath, remainder } = await findClosestExistingPath(normalizedPath);
  const existingRealPath = await realpath(existingPath);

  if (remainder.length === 0) {
    return path.resolve(existingRealPath);
  }

  return path.resolve(existingRealPath, ...remainder);
}

async function evaluateSandboxBoundary(
  action: FridayDesktopAction,
  allowedRoots: readonly string[],
): Promise<SandboxCheckResult> {
  const sandboxPaths = extractSandboxPaths(action);
  if (sandboxPaths.length === 0) {
    return { allowed: true };
  }

  let realAllowedRoots: readonly string[] = [];
  try {
    realAllowedRoots = await Promise.all(
      allowedRoots.map(async (rootPath) => {
        const normalizedRoot = path.resolve(rootPath);
        try {
          return await resolveRealSandboxPath(normalizedRoot);
        } catch (err) {
          console.warn("[friday][action-executor] sandbox path resolution failed:", err instanceof Error ? err.message : String(err));
          return normalizedRoot;
        }
      }),
    );
  } catch (error) {
    return {
      allowed: false,
      message: `Unable to resolve sandbox roots: ${String(error)}`,
    };
  }

  for (const rawPath of sandboxPaths) {
    if (containsTraversalSegment(rawPath)) {
      return {
        allowed: false,
        normalizedPath: path.resolve(rawPath),
        message: "Path traversal segment is not allowed",
      };
    }

    const normalizedPath = path.resolve(rawPath);
    if (!isPathWithinAnyRoot(normalizedPath, allowedRoots)) {
      return {
        allowed: false,
        normalizedPath,
        message: "Path is outside configured sandbox roots",
      };
    }

    let realPath: string;
    try {
      realPath = await resolveRealSandboxPath(normalizedPath);
    } catch (error) {
      return {
        allowed: false,
        normalizedPath,
        message: `Unable to validate sandbox path: ${String(error)}`,
      };
    }

    if (!isPathWithinAnyRoot(realPath, realAllowedRoots)) {
      return {
        allowed: false,
        normalizedPath,
        message: "Path escapes sandbox roots via symbolic link",
      };
    }
  }

  return { allowed: true };
}

async function executeWithTimeoutAndCancellation(
  adapter: FridayDesktopAdapterRuntime,
  action: FridayDesktopAction,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<FridayDesktopActionResult> {
  return new Promise<FridayDesktopActionResult>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(ACTION_ABORT_SIGNAL));
      return;
    }

    const onAbort = () => {
      cleanup();
      reject(new Error(ACTION_ABORT_SIGNAL));
    };

    const timeoutHandle = setTimeout(() => {
      cleanup();
      reject(new Error(ACTION_TIMEOUT_SIGNAL));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeoutHandle);
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });

    void adapter.execute(action).then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function isTimeoutSignalError(error: unknown): boolean {
  return error instanceof Error && error.message === ACTION_TIMEOUT_SIGNAL;
}

function isAbortSignalError(error: unknown): boolean {
  return error instanceof Error && error.message === ACTION_ABORT_SIGNAL;
}

// ─── Factory ───

/** Create an action executor instance. */
export function createActionExecutor(config: ActionExecutorConfig): ActionExecutor {
  const actionLog: FridayDesktopActionResult[] = [];
  const inFlightActions = new Map<UUID, AbortController>();
  const sandboxAllowedRoots =
    config.sandboxAllowedRoots && config.sandboxAllowedRoots.length > 0
      ? config.sandboxAllowedRoots.map((root) => path.resolve(root))
      : [path.resolve(process.cwd())];

  let runningCount = 0;

  function reserveExecutionSlot(): boolean {
    if (runningCount >= config.maxConcurrentActions) {
      return false;
    }
    runningCount += 1;
    return true;
  }

  function releaseExecutionSlot(): void {
    runningCount = Math.max(0, runningCount - 1);
  }

  function emitResult(
    result: FridayDesktopActionResult,
    onStepCaptured?: ExecuteActionOptions["onStepCaptured"],
  ): FridayDesktopActionResult {
    actionLog.push(result);
    onStepCaptured?.(result);
    return result;
  }

  function makeErrorResult(
    actionId: UUID,
    action: FridayDesktopAction,
    platform: FridayDesktopActionResult["platform"],
    status: FridayDesktopActionStatus,
    errorMessage: string,
    errorCode: FridayDesktopActionResult["errorCode"],
    startedAt: ISODateTime,
    targetElement?: FridayDesktopElement,
    permissionResult?: PermissionCheckResult,
  ): FridayDesktopActionResult {
    const now = config.nowIso();
    const durationMs = new Date(now).getTime() - new Date(startedAt).getTime();
    return {
      id: actionId,
      action,
      status,
      platform,
      errorMessage,
      errorCode,
      targetElement,
      matchedPolicyRuleId: permissionResult?.matchedRule?.id,
      permissionDecisionId: permissionResult?.decision?.id,
      durationMs: Math.max(0, durationMs),
      startedAt,
      completedAt: now,
    };
  }

  return {
    async execute(
      action: FridayDesktopAction,
      adapter: FridayDesktopAdapterRuntime,
      permissionGuard: PermissionGuard,
      elementInspector: ElementInspector,
      options?: ExecuteActionOptions,
    ): Promise<FridayDesktopActionResult> {
      const startedAt = config.nowIso();
      const platform = adapter.metadata.platform;
      const onStepCaptured = options?.onStepCaptured;
      const actionId = options?.actionId ?? config.generateId();
      const timeoutMs = options?.timeoutMs ?? config.defaultActionTimeoutMs;

      if (!isNonEmptyString(actionId)) {
        return emitResult(
          makeErrorResult(
            config.generateId(),
            action,
            platform,
            "failed",
            "Action ID must be a non-empty string",
            FRIDAY_DESKTOP_ERROR_CODES.VALIDATION_FAILED,
            startedAt,
          ),
          onStepCaptured,
        );
      }

      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return emitResult(
          makeErrorResult(
            actionId,
            action,
            platform,
            "failed",
            "Timeout must be a positive number",
            FRIDAY_DESKTOP_ERROR_CODES.VALIDATION_FAILED,
            startedAt,
          ),
          onStepCaptured,
        );
      }

      const validationError = validateAction(action);
      if (validationError) {
        return emitResult(
          makeErrorResult(
            actionId,
            action,
            platform,
            "failed",
            validationError,
            FRIDAY_DESKTOP_ERROR_CODES.VALIDATION_FAILED,
            startedAt,
          ),
          onStepCaptured,
        );
      }

      if (!reserveExecutionSlot()) {
        return emitResult(
          makeErrorResult(
            actionId,
            action,
            platform,
            "failed",
            "Maximum concurrent action limit reached",
            FRIDAY_DESKTOP_ERROR_CODES.CONCURRENT_LIMIT,
            startedAt,
          ),
          onStepCaptured,
        );
      }

      if (inFlightActions.has(actionId)) {
        releaseExecutionSlot();
        return emitResult(
          makeErrorResult(
            actionId,
            action,
            platform,
            "failed",
            `Action ID '${actionId}' is already in-flight`,
            FRIDAY_DESKTOP_ERROR_CODES.VALIDATION_FAILED,
            startedAt,
          ),
          onStepCaptured,
        );
      }

      const abortController = new AbortController();
      inFlightActions.set(actionId, abortController);

      let permissionResult: PermissionCheckResult | undefined;
      let targetElement: FridayDesktopElement | undefined;

      try {
        const sandboxResult = await evaluateSandboxBoundary(action, sandboxAllowedRoots);
        if (!sandboxResult.allowed) {
          const message = sandboxResult.message ?? "Action violates sandbox boundaries";
          return emitResult(
            makeErrorResult(
              actionId,
              action,
              platform,
              "sandbox_violation",
              sandboxResult.normalizedPath ? `${message}: ${sandboxResult.normalizedPath}` : message,
              FRIDAY_DESKTOP_ERROR_CODES.SANDBOX_VIOLATION,
              startedAt,
            ),
            onStepCaptured,
          );
        }

        permissionResult = await permissionGuard.check(action, adapter);
        if (!permissionResult.allowed) {
          return emitResult(
            makeErrorResult(
              actionId,
              action,
              platform,
              mapPermissionDenialToStatus(permissionResult.denialCode),
              permissionResult.denialMessage ?? "Permission denied",
              permissionResult.denialCode ?? FRIDAY_DESKTOP_ERROR_CODES.PERMISSION_DENIED_POLICY,
              startedAt,
              undefined,
              permissionResult,
            ),
            onStepCaptured,
          );
        }

        const selector = extractSelector(action);
        if (selector) {
          const inspectResult = await elementInspector.inspect(selector, adapter);
          if (inspectResult.element) {
            targetElement = inspectResult.element;
          } else if (action.type === "read_element") {
            return emitResult(
              makeErrorResult(
                actionId,
                action,
                platform,
                "element_not_found",
                "Target element not found",
                FRIDAY_DESKTOP_ERROR_CODES.ELEMENT_NOT_FOUND,
                startedAt,
                undefined,
                permissionResult,
              ),
              onStepCaptured,
            );
          }
        }

        const adapterResult = await executeWithTimeoutAndCancellation(
          adapter,
          action,
          timeoutMs,
          abortController.signal,
        );

        return emitResult(
          {
            ...adapterResult,
            id: actionId,
            action,
            platform,
            targetElement: targetElement ?? adapterResult.targetElement,
            matchedPolicyRuleId: permissionResult.matchedRule?.id,
            permissionDecisionId: permissionResult.decision?.id,
          },
          onStepCaptured,
        );
      } catch (error) {
        const isTimeout = isTimeoutSignalError(error);
        const isCancelled = isAbortSignalError(error) || abortController.signal.aborted;
        const status: FridayDesktopActionStatus = isCancelled
          ? "cancelled"
          : isTimeout
            ? "timeout"
            : "failed";
        const errorCode = isCancelled
          ? FRIDAY_DESKTOP_ERROR_CODES.ACTION_CANCELLED
          : isTimeout
            ? FRIDAY_DESKTOP_ERROR_CODES.ACTION_TIMEOUT
            : FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED;
        const errorMessage = isCancelled
          ? "Action cancelled"
          : isTimeout
            ? "Action execution timed out"
            : String(error);

        return emitResult(
          makeErrorResult(
            actionId,
            action,
            platform,
            status,
            errorMessage,
            errorCode,
            startedAt,
            targetElement,
            permissionResult,
          ),
          onStepCaptured,
        );
      } finally {
        inFlightActions.delete(actionId);
        releaseExecutionSlot();
      }
    },

    cancel(actionId: UUID): boolean {
      const controller = inFlightActions.get(actionId);
      if (!controller) {
        return false;
      }

      inFlightActions.delete(actionId);
      controller.abort();
      return true;
    },

    getRunningCount(): number {
      return runningCount;
    },

    getActionLog(): readonly FridayDesktopActionResult[] {
      return toFrozenSnapshot(actionLog);
    },
  };
}
