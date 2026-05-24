import { FridayDomainError } from "#errors";
import {
  toAppleScriptIdentifierLiteral,
  toAppleScriptStringLiteral,
} from "../../system/friday-applescript.js";

/**
 * C-001 Real Desktop Adapters — macOS, Windows, and Linux implementations
 * of the FridayDesktopAdapterRuntime interface.
 *
 * Each adapter provides:
 * - Platform-specific action execution via native APIs
 * - UI element inspection and search via accessibility frameworks
 * - Capability reporting based on detected OS version and features
 * - OS-level permission checking (accessibility, screen recording, etc.)
 * - Health monitoring and status reporting
 *
 * Platform API Strategy:
 * - macOS (darwin): Accessibility API via `osascript` / CoreGraphics
 * - Windows (win32): UI Automation via PowerShell / native bindings
 * - Linux: AT-SPI2 / xdotool / D-Bus
 *
 * @module desktop/engine
 */

import type {
  FridayDesktopAction,
  FridayDesktopActionResult,
  FridayDesktopActionStatus,
  FridayDesktopAdapter,
  FridayDesktopAdapterExecuteOptions,
  FridayDesktopAdapterRuntime,
  FridayDesktopBounds,
  FridayDesktopCapability,
  FridayDesktopElement,
  FridayDesktopElementSelector,
  FridayDesktopOsPermissionStatus,
  FridayDesktopOsPermissionType,
  FridayDesktopPermission,
  FridayDesktopPlatform,
  ISODateTime,
} from "../model/friday-desktop.types.js";

import { FRIDAY_DESKTOP_ERROR_CODES } from "../model/friday-desktop.types.js";

// ─── Shared Types ───

/** Configuration for adapter creation. */
export interface DesktopAdapterConfig {
  /** Clock function. */
  readonly nowIso: () => ISODateTime;
  /** ID generator. */
  readonly generateId: () => string;
  /** Optional override for OS version detection (testing). */
  readonly osVersionOverride?: string;
  /** Optional override for health status (testing). */
  readonly healthOverride?: boolean;
  /** Optional shell executor for OS commands (testing/DI). */
  readonly execCommand?: (cmd: string, options?: ExecCommandOptions) => Promise<ExecResult>;
}

/** Result of executing a shell command. */
export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type ExecCommandOptions = FridayDesktopAdapterExecuteOptions;

/** Adapter health check result. */
export interface AdapterHealthCheck {
  readonly healthy: boolean;
  readonly statusMessage: string;
  readonly checkedAt: ISODateTime;
  readonly details: Record<string, string | boolean | number>;
}

const SAFE_APP_IDENTIFIER_RE = /^[A-Za-z0-9._:/\\\- ]+$/;
const SAFE_XDOTOOL_KEY_RE = /^[A-Za-z0-9_+\-]+$/;

function makeUncheckedFileOperationResult(
  config: DesktopAdapterConfig,
  action: Extract<FridayDesktopAction, { type: "file_operation" }>,
  platform: FridayDesktopPlatform,
  startedAt: ISODateTime,
): FridayDesktopActionResult {
  return makeFailureResult(
    config,
    action,
    platform,
    startedAt,
    "sandbox_violation",
    "File operations must be executed through ActionExecutor sandbox validation",
    FRIDAY_DESKTOP_ERROR_CODES.SANDBOX_VIOLATION,
  );
}

// ─── Default Shell Executor ───

async function defaultExecCommand(cmd: string, options: ExecCommandOptions = {}): Promise<ExecResult> {
  const { spawn } = await import("node:child_process");
  return new Promise<ExecResult>((resolve) => {
    if (options.signal?.aborted) {
      resolve({ stdout: "", stderr: "Command aborted before start", exitCode: 130 });
      return;
    }

    const child = spawn(cmd, {
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      options.signal?.removeEventListener("abort", abort);
      resolve({
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
        exitCode: result.exitCode,
      });
    };

    const killChild = () => {
      if (child.killed) return;
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
          return;
        } catch {
          // Fall back to killing the shell child below.
        }
      }
      child.kill("SIGTERM");
    };

    const abort = () => {
      killChild();
      finish({ stdout, stderr: stderr || "Command aborted", exitCode: 130 });
    };

    const timeoutHandle = setTimeout(() => {
      killChild();
      finish({ stdout, stderr: stderr || "Command timed out", exitCode: 124 });
    }, 5000);

    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish({ stdout, stderr: error.message, exitCode: 1 }));
    child.on("close", (code, signal) => {
      finish({
        stdout,
        stderr: signal ? (stderr || `Command terminated by ${signal}`) : stderr,
        exitCode: code ?? (signal ? 130 : 1),
      });
    });
  });
}

// ─── OS Version Detection ───

async function detectOsVersion(
  platform: FridayDesktopPlatform,
  exec: (cmd: string) => Promise<ExecResult>,
): Promise<string> {
  try {
    switch (platform) {
      case "darwin": {
        const result = await exec("sw_vers -productVersion");
        return result.exitCode === 0 ? result.stdout : "unknown";
      }
      case "win32": {
        const result = await exec("powershell -Command \"[System.Environment]::OSVersion.Version.ToString()\"");
        return result.exitCode === 0 ? result.stdout : "unknown";
      }
      case "linux": {
        const result = await exec("uname -r");
        return result.exitCode === 0 ? result.stdout : "unknown";
      }
    }
  } catch (err) {
    console.warn("[friday][desktop-adapters] detect-os-version:", err instanceof Error ? err.message : String(err));
    return "unknown";
  }
}

// ─── Action Execution Helpers ───

function makeSuccessResult(
  config: DesktopAdapterConfig,
  action: FridayDesktopAction,
  platform: FridayDesktopPlatform,
  startedAt: ISODateTime,
  extras?: Partial<FridayDesktopActionResult>,
): FridayDesktopActionResult {
  const completedAt = config.nowIso();
  const start = new Date(startedAt).getTime();
  const end = new Date(completedAt).getTime();
  return {
    id: config.generateId(),
    action,
    status: "success" as FridayDesktopActionStatus,
    platform,
    durationMs: end - start,
    startedAt,
    completedAt,
    ...extras,
  };
}

function makeFailureResult(
  config: DesktopAdapterConfig,
  action: FridayDesktopAction,
  platform: FridayDesktopPlatform,
  startedAt: ISODateTime,
  status: FridayDesktopActionStatus,
  errorMessage: string,
  errorCode?: string,
): FridayDesktopActionResult {
  const completedAt = config.nowIso();
  const start = new Date(startedAt).getTime();
  const end = new Date(completedAt).getTime();
  return {
    id: config.generateId(),
    action,
    status,
    platform,
    errorMessage,
    errorCode: errorCode as FridayDesktopActionResult["errorCode"],
    durationMs: end - start,
    startedAt,
    completedAt,
  };
}

function makePermission(
  permissionType: FridayDesktopOsPermissionType,
  status: FridayDesktopOsPermissionStatus,
  platform: FridayDesktopPlatform,
  checkedAt: ISODateTime,
  grantInstructions?: string,
): FridayDesktopPermission {
  return { permissionType, status, platform, grantInstructions, checkedAt };
}

function makeElement(
  elementId: string,
  role: string,
  name: string,
  appBundleId: string,
  bounds: FridayDesktopBounds,
  overrides?: Partial<FridayDesktopElement>,
): FridayDesktopElement {
  return {
    elementId,
    role,
    name,
    enabled: true,
    focused: false,
    visible: true,
    bounds,
    appBundleId,
    displayIndex: 0,
    childCount: 0,
    platformAttributes: {},
    ...overrides,
  };
}

function quotePosixShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

function toPowerShellEncodedCommand(script: string): string {
  const failClosedScript = `$ErrorActionPreference = 'Stop'; try { ${script}; if (-not $?) { exit 1 }; exit 0 } catch { Write-Error $_; exit 1 }`;
  const encoded = Buffer.from(failClosedScript, "utf16le").toString("base64");
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

function makeCommandFailureMessage(prefix: string, result: ExecResult): string {
  const detail = result.stderr || result.stdout || `exit code ${result.exitCode}`;
  return `${prefix}: ${detail}`;
}

async function runRequiredCommand(
  exec: (cmd: string, options?: ExecCommandOptions) => Promise<ExecResult>,
  cmd: string,
  signal: AbortSignal | undefined,
): Promise<ExecResult> {
  const result = await exec(cmd, { signal });
  return result;
}

function ensureFiniteInteger(value: number, fieldName: string): number {
  if (!Number.isFinite(value)) {
    throw new FridayDomainError("VALIDATION_ERROR", `Invalid ${fieldName}: must be a finite number`, { httpStatus: 400 });
  }
  return Math.trunc(value);
}

function ensureSafeAppIdentifier(value: string): string {
  if (value.length > 256 || !SAFE_APP_IDENTIFIER_RE.test(value)) {
    throw new FridayDomainError("VALIDATION_ERROR", "Unsafe app identifier", { httpStatus: 400 });
  }
  return value;
}

function ensureSafeXdotoolKeyCombo(value: string): string {
  if (!SAFE_XDOTOOL_KEY_RE.test(value)) {
    throw new FridayDomainError("VALIDATION_ERROR", "Unsafe key combo", { httpStatus: 400 });
  }
  return value;
}

// ═══════════════════════════════════════════════════════════════════════
// macOS ADAPTER
// ═══════════════════════════════════════════════════════════════════════

/** macOS adapter capabilities. */
const DARWIN_CAPABILITIES: readonly FridayDesktopCapability[] = [
  "click", "type", "keypress", "scroll", "drag",
  "screenshot", "read_element", "launch_app", "close_app",
  "clipboard_read", "clipboard_write",
  "file_read", "file_write", "file_move", "file_copy", "file_delete", "file_list", "file_stat",
  "element_search", "element_tree",
  "multi_monitor", "accessibility_api", "scripting_bridge",
];

/** macOS required permissions. */
const DARWIN_PERMISSIONS: readonly FridayDesktopOsPermissionType[] = [
  "accessibility", "screen_recording", "input_monitoring", "automation",
];

export async function createDarwinAdapter(
  config: DesktopAdapterConfig,
): Promise<FridayDesktopAdapterRuntime> {
  const exec = config.execCommand ?? defaultExecCommand;
  const osVersion = config.osVersionOverride ?? await detectOsVersion("darwin", exec);
  const healthy = config.healthOverride ?? true;
  const initTime = config.nowIso();

  const metadata: FridayDesktopAdapter = {
    id: "darwin-accessibility-v1",
    platform: "darwin",
    displayName: "macOS Accessibility Adapter",
    version: "1.0.0",
    capabilities: [...DARWIN_CAPABILITIES],
    supportedOsVersions: ">=13.0",
    detectedOsVersion: osVersion,
    healthy,
    statusMessage: healthy ? "Ready — Accessibility API available" : "Accessibility permission not granted",
    initializedAt: initTime,
  };

  async function executeAction(
    action: FridayDesktopAction,
    options: ExecCommandOptions = {},
  ): Promise<FridayDesktopActionResult> {
    const startedAt = config.nowIso();
    if (action.type === "file_operation" && options.sandboxChecked !== true) {
      return makeUncheckedFileOperationResult(config, action, "darwin", startedAt);
    }

    switch (action.type) {
      case "click": {
        const coords = action.coordinates ?? { x: 0, y: 0 };
        const x = ensureFiniteInteger(coords.x, "coordinates.x");
        const y = ensureFiniteInteger(coords.y, "coordinates.y");
        const btn = action.button ?? "left";
        const clickType = action.clickType ?? "single";
        const clickCount = clickType === "double" ? 2 : clickType === "triple" ? 3 : 1;
        const script = `tell application "System Events" to click at {${x}, ${y}}`;
        const result = await runRequiredCommand(exec, `osascript -e ${quotePosixShellArg(script)} 2>&1`, options.signal);
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "darwin", startedAt, "failed",
            makeCommandFailureMessage("macOS click failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "darwin", startedAt, {
          targetElement: action.selector ? makeElement(
            config.generateId(), "button", action.selector.value, action.selector.appBundleId ?? "unknown",
            { x, y, width: 0, height: 0 },
          ) : undefined,
        });
      }
      case "type": {
        const script = `tell application "System Events" to keystroke ${toAppleScriptStringLiteral(action.text)}`;
        const result = await runRequiredCommand(exec, `osascript -e ${quotePosixShellArg(script)} 2>&1`, options.signal);
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "darwin", startedAt, "failed",
            makeCommandFailureMessage("macOS type failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "darwin", startedAt);
      }
      case "keypress": {
        const mods = (action.modifiers ?? []).map(m => m === "meta" || m === "command" ? "command down" : `${m} down`).join(", ");
        const script = mods
          ? `tell application "System Events" to keystroke ${toAppleScriptIdentifierLiteral(action.key, "key")} using {${mods}}`
          : `tell application "System Events" to keystroke ${toAppleScriptIdentifierLiteral(action.key, "key")}`;
        const result = await runRequiredCommand(exec, `osascript -e ${quotePosixShellArg(script)} 2>&1`, options.signal);
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "darwin", startedAt, "failed",
            makeCommandFailureMessage("macOS keypress failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "darwin", startedAt);
      }
      case "scroll": {
        const amount = ensureFiniteInteger(action.amount ?? 3, "amount");
        const dir = action.direction === "up" || action.direction === "left" ? amount : -amount;
        const script = `tell application "System Events" to scroll ${dir}`;
        const result = await runRequiredCommand(exec, `osascript -e ${quotePosixShellArg(script)} 2>&1`, options.signal);
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "darwin", startedAt, "failed",
            makeCommandFailureMessage("macOS scroll failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "darwin", startedAt);
      }
      case "screenshot": {
        const format = action.format ?? "png";
        const tmpPath = `/tmp/friday-screenshot-${config.generateId()}.${format}`;
        const result = await exec(
          `screencapture -x -t ${quotePosixShellArg(format)} ${quotePosixShellArg(tmpPath)} 2>&1`,
          { signal: options.signal },
        );
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "darwin", startedAt, "failed",
            `Screenshot capture failed: ${result.stderr}`, FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        // Read as base64
        const b64Result = await exec(
          `base64 -i ${quotePosixShellArg(tmpPath)} 2>/dev/null; status=$?; rm -f ${quotePosixShellArg(tmpPath)}; exit $status`,
          { signal: options.signal },
        );
        if (b64Result.exitCode !== 0) {
          return makeFailureResult(config, action, "darwin", startedAt, "failed",
            makeCommandFailureMessage("Screenshot encoding failed", b64Result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "darwin", startedAt, {
          screenshotBase64: b64Result.stdout,
        });
      }
      case "launch_app": {
        const appIdentifier = ensureSafeAppIdentifier(action.appIdentifier);
        const quotedAppIdentifier = quotePosixShellArg(appIdentifier);
        const result = await exec(`open -b ${quotedAppIdentifier} 2>&1 || open -a ${quotedAppIdentifier} 2>&1`, { signal: options.signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "darwin", startedAt, "app_not_found",
            `Application "${action.appIdentifier}" not found`, FRIDAY_DESKTOP_ERROR_CODES.APP_NOT_FOUND);
        }
        return makeSuccessResult(config, action, "darwin", startedAt);
      }
      case "close_app": {
        const appIdentifier = ensureSafeAppIdentifier(action.appIdentifier);
        const force = action.force ? "force " : "";
        const script = `tell application ${toAppleScriptIdentifierLiteral(appIdentifier, "app identifier")} to ${force}quit`;
        const result = await runRequiredCommand(exec, `osascript -e ${quotePosixShellArg(script)} 2>&1`, options.signal);
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "darwin", startedAt, "failed",
            makeCommandFailureMessage("macOS close_app failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "darwin", startedAt);
      }
      case "clipboard": {
        if (action.operation === "read") {
          const result = await exec("pbpaste 2>/dev/null", { signal: options.signal });
          if (result.exitCode !== 0) {
            return makeFailureResult(config, action, "darwin", startedAt, "failed",
              makeCommandFailureMessage("Clipboard read failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
          }
          return makeSuccessResult(config, action, "darwin", startedAt, {
            clipboardContent: result.stdout,
          });
        } else if (action.operation === "write") {
          const result = await exec(`printf %s ${quotePosixShellArg(action.content)} | pbcopy`, { signal: options.signal });
          if (result.exitCode !== 0) {
            return makeFailureResult(config, action, "darwin", startedAt, "failed",
              makeCommandFailureMessage("Clipboard write failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
          }
          return makeSuccessResult(config, action, "darwin", startedAt);
        } else {
          const result = await exec("pbcopy < /dev/null", { signal: options.signal });
          if (result.exitCode !== 0) {
            return makeFailureResult(config, action, "darwin", startedAt, "failed",
              makeCommandFailureMessage("Clipboard clear failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
          }
          return makeSuccessResult(config, action, "darwin", startedAt);
        }
      }
      case "read_element": {
        return makeFailureResult(config, action, "darwin", startedAt, "failed",
          "read_element is not implemented for macOS; use inspectElement or searchElements instead",
          FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
      }
      case "drag": {
        return makeFailureResult(config, action, "darwin", startedAt, "failed",
          "drag is not implemented for macOS",
          FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
      }
      case "file_operation": {
        return executeFileOperation(action, startedAt, options.signal);
      }
    }
  }

  async function executeFileOperation(
    action: Extract<FridayDesktopAction, { type: "file_operation" }>,
    startedAt: ISODateTime,
    signal?: AbortSignal,
  ): Promise<FridayDesktopActionResult> {
    switch (action.operation) {
      case "read": {
        const result = await exec(`cat ${quotePosixShellArg(action.path)} 2>&1`, { signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "darwin", startedAt, "failed",
            result.stderr, FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "darwin", startedAt, { fileData: result.stdout });
      }
      case "write": {
        const result = await exec(
          `printf %s ${quotePosixShellArg(action.content)} > ${quotePosixShellArg(action.path)}`,
          { signal },
        );
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "darwin", startedAt, "failed",
            makeCommandFailureMessage("File write failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "darwin", startedAt);
      }
      case "move": {
        const result = await exec(`mv ${quotePosixShellArg(action.path)} ${quotePosixShellArg(action.destinationPath)}`, { signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "darwin", startedAt, "failed",
            makeCommandFailureMessage("File move failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "darwin", startedAt);
      }
      case "copy": {
        const result = await exec(`cp -R ${quotePosixShellArg(action.path)} ${quotePosixShellArg(action.destinationPath)}`, { signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "darwin", startedAt, "failed",
            makeCommandFailureMessage("File copy failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "darwin", startedAt);
      }
      case "delete": {
        const result = await exec(`rm -f ${quotePosixShellArg(action.path)}`, { signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "darwin", startedAt, "failed",
            makeCommandFailureMessage("File delete failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "darwin", startedAt);
      }
      case "list": {
        const result = await exec(`ls -la ${quotePosixShellArg(action.path)} 2>&1`, { signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "darwin", startedAt, "failed",
            makeCommandFailureMessage("File list failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "darwin", startedAt, { fileData: result.stdout });
      }
      case "stat": {
        const result = await exec(`stat -f "%Sm %z %N" ${quotePosixShellArg(action.path)} 2>&1`, { signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "darwin", startedAt, "failed",
            makeCommandFailureMessage("File stat failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "darwin", startedAt, { fileData: result.stdout });
      }
    }
  }

  return {
    metadata,

    async execute(action: FridayDesktopAction, options?: ExecCommandOptions): Promise<FridayDesktopActionResult> {
      try {
        return await executeAction(action, options);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return makeFailureResult(config, action, "darwin", config.nowIso(), "failed",
          `macOS adapter error: ${msg}`, FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
      }
    },

    async inspectElement(selector: FridayDesktopElementSelector): Promise<FridayDesktopElement | null> {
      try {
        const script = `tell application "System Events" to get properties of first UI element whose name is ${toAppleScriptIdentifierLiteral(selector.value, "selector")}`;
        const result = await exec(`osascript -e ${quotePosixShellArg(script)} 2>&1`);
        if (result.exitCode !== 0 || !result.stdout) return null;
        return makeElement(
          config.generateId(), "unknown", selector.value,
          selector.appBundleId ?? "unknown",
          { x: 0, y: 0, width: 0, height: 0 },
        );
      } catch (err) {
        console.warn("[friday][desktop-adapters] darwin-inspectElement:", err instanceof Error ? err.message : String(err));
        return null;
      }
    },

    async searchElements(query: string, appBundleId?: string): Promise<FridayDesktopElement[]> {
      try {
        const app = appBundleId
          ? `application process ${toAppleScriptIdentifierLiteral(appBundleId, "app identifier")}`
          : "application process 1";
        const script = `tell application "System Events" to get name of every UI element of ${app} whose name contains ${toAppleScriptIdentifierLiteral(query, "query")}`;
        const result = await exec(`osascript -e ${quotePosixShellArg(script)} 2>&1`);
        if (result.exitCode !== 0 || !result.stdout) return [];
        const names = result.stdout.split(", ").filter(Boolean);
        return names.map(name => makeElement(
          config.generateId(), "unknown", name.trim(),
          appBundleId ?? "unknown",
          { x: 0, y: 0, width: 0, height: 0 },
        ));
      } catch (err) {
        console.warn("[friday][desktop-adapters] darwin-searchElements:", err instanceof Error ? err.message : String(err));
        return [];
      }
    },

    getCapabilities(): FridayDesktopCapability[] {
      return [...DARWIN_CAPABILITIES];
    },

    async checkPermissions(): Promise<FridayDesktopPermission[]> {
      const now = config.nowIso();
      const permissions: FridayDesktopPermission[] = [];

      for (const perm of DARWIN_PERMISSIONS) {
        let status: FridayDesktopOsPermissionStatus = "not_determined";
        let instructions: string | undefined;

        switch (perm) {
          case "accessibility":
            try {
              const result = await exec("osascript -e 'tell application \"System Events\" to get name of first process' 2>&1");
              status = result.exitCode === 0 ? "granted" : "denied";
            } catch (err) { console.warn("[friday][desktop-adapters] darwin-check-accessibility:", err instanceof Error ? err.message : String(err)); status = "denied"; }
            instructions = "System Settings → Privacy & Security → Accessibility → Enable Friday";
            break;
          case "screen_recording":
            instructions = "System Settings → Privacy & Security → Screen Recording → Enable Friday";
            status = "not_determined";
            break;
          case "input_monitoring":
            instructions = "System Settings → Privacy & Security → Input Monitoring → Enable Friday";
            status = "not_determined";
            break;
          case "automation":
            instructions = "System Settings → Privacy & Security → Automation → Enable Friday";
            status = "not_determined";
            break;
        }

        permissions.push(makePermission(perm, status, "darwin", now, instructions));
      }
      return permissions;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// WINDOWS ADAPTER
// ═══════════════════════════════════════════════════════════════════════

const WIN32_CAPABILITIES: readonly FridayDesktopCapability[] = [
  "click", "type", "keypress", "scroll", "drag",
  "screenshot", "read_element", "launch_app", "close_app",
  "clipboard_read", "clipboard_write",
  "file_read", "file_write", "file_move", "file_copy", "file_delete", "file_list", "file_stat",
  "element_search", "element_tree",
  "multi_monitor", "accessibility_api",
];

const WIN32_PERMISSIONS: readonly FridayDesktopOsPermissionType[] = [
  "accessibility", "automation", "input_monitoring",
];

export async function createWin32Adapter(
  config: DesktopAdapterConfig,
): Promise<FridayDesktopAdapterRuntime> {
  const exec = config.execCommand ?? defaultExecCommand;
  const osVersion = config.osVersionOverride ?? await detectOsVersion("win32", exec);
  const healthy = config.healthOverride ?? true;
  const initTime = config.nowIso();

  const metadata: FridayDesktopAdapter = {
    id: "win32-uiautomation-v1",
    platform: "win32",
    displayName: "Windows UI Automation Adapter",
    version: "1.0.0",
    capabilities: [...WIN32_CAPABILITIES],
    supportedOsVersions: ">=10.0",
    detectedOsVersion: osVersion,
    healthy,
    statusMessage: healthy ? "Ready — UI Automation available" : "UI Automation not available",
    initializedAt: initTime,
  };

  async function executeAction(
    action: FridayDesktopAction,
    options: ExecCommandOptions = {},
  ): Promise<FridayDesktopActionResult> {
    const startedAt = config.nowIso();
    if (action.type === "file_operation" && options.sandboxChecked !== true) {
      return makeUncheckedFileOperationResult(config, action, "win32", startedAt);
    }

    switch (action.type) {
      case "click": {
        const coords = action.coordinates ?? { x: 0, y: 0 };
        const x = ensureFiniteInteger(coords.x, "coordinates.x");
        const y = ensureFiniteInteger(coords.y, "coordinates.y");
        const psCmd = toPowerShellEncodedCommand(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y}); [System.Windows.Forms.SendKeys]::SendWait('{CLICK}')`);
        const result = await exec(psCmd, { signal: options.signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "win32", startedAt, "failed",
            makeCommandFailureMessage("Windows click failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "win32", startedAt);
      }
      case "type": {
        const escaped = escapePowerShellSingleQuoted(action.text);
        const result = await exec(toPowerShellEncodedCommand(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`), { signal: options.signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "win32", startedAt, "failed",
            makeCommandFailureMessage("Windows type failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "win32", startedAt);
      }
      case "keypress": {
        const keyMap: Record<string, string> = { Enter: "{ENTER}", Tab: "{TAB}", Escape: "{ESC}", Backspace: "{BS}", Delete: "{DEL}" };
        const key = escapePowerShellSingleQuoted(keyMap[action.key] ?? action.key);
        const result = await exec(toPowerShellEncodedCommand(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${key}')`), { signal: options.signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "win32", startedAt, "failed",
            makeCommandFailureMessage("Windows keypress failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "win32", startedAt);
      }
      case "scroll": {
        return makeFailureResult(config, action, "win32", startedAt, "failed",
          "Windows scroll is not implemented by this adapter", FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
      }
      case "screenshot": {
        const screenshotId = config.generateId();
        const tmpPath = `$env:TEMP\\friday-screenshot-${screenshotId}.png`;
        const escapedPath = escapePowerShellSingleQuoted(tmpPath);
        const resolvedTmpPath = `${process.env.TEMP ?? process.env.TMP ?? "C:\\Windows\\Temp"}\\friday-screenshot-${screenshotId}.png`;
        const capture = await exec(toPowerShellEncodedCommand(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen | Out-Null; $bmp = New-Object System.Drawing.Bitmap([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width,[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(0,0,0,0,$bmp.Size); $bmp.Save('${escapedPath}')`), { signal: options.signal });
        if (capture.exitCode !== 0) {
          return makeFailureResult(config, action, "win32", startedAt, "failed",
            makeCommandFailureMessage("Windows screenshot failed", capture), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        try {
          const fs = await import("node:fs");
          const base64 = fs.readFileSync(resolvedTmpPath).toString("base64");
          fs.unlinkSync(resolvedTmpPath);
          return makeSuccessResult(config, action, "win32", startedAt, { screenshotBase64: base64 });
        } catch (readErr) {
          return makeFailureResult(config, action, "win32", startedAt, "failed",
            `Screenshot captured but could not read file: ${readErr instanceof Error ? readErr.message : String(readErr)}`,
            FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
      }
      case "launch_app": {
        const appIdentifier = ensureSafeAppIdentifier(action.appIdentifier);
        const escapedApp = escapePowerShellSingleQuoted(appIdentifier);
        const result = await exec(toPowerShellEncodedCommand(`Start-Process '${escapedApp}'`), { signal: options.signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "win32", startedAt, "app_not_found",
            `Application "${action.appIdentifier}" not found`, FRIDAY_DESKTOP_ERROR_CODES.APP_NOT_FOUND);
        }
        return makeSuccessResult(config, action, "win32", startedAt);
      }
      case "close_app": {
        const appIdentifier = ensureSafeAppIdentifier(action.appIdentifier);
        const escapedApp = escapePowerShellSingleQuoted(appIdentifier);
        const force = action.force ? "-Force" : "";
        const result = await exec(toPowerShellEncodedCommand(`Stop-Process -Name '${escapedApp}' ${force} -ErrorAction Stop`), { signal: options.signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "win32", startedAt, "failed",
            makeCommandFailureMessage("Windows close_app failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "win32", startedAt);
      }
      case "clipboard": {
        if (action.operation === "read") {
          const result = await exec(toPowerShellEncodedCommand("Get-Clipboard"), { signal: options.signal });
          if (result.exitCode !== 0) {
            return makeFailureResult(config, action, "win32", startedAt, "failed",
              makeCommandFailureMessage("Clipboard read failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
          }
          return makeSuccessResult(config, action, "win32", startedAt, { clipboardContent: result.stdout });
        } else if (action.operation === "write") {
          const escapedContent = escapePowerShellSingleQuoted(action.content);
          const result = await exec(toPowerShellEncodedCommand(`Set-Clipboard '${escapedContent}'`), { signal: options.signal });
          if (result.exitCode !== 0) {
            return makeFailureResult(config, action, "win32", startedAt, "failed",
              makeCommandFailureMessage("Clipboard write failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
          }
          return makeSuccessResult(config, action, "win32", startedAt);
        } else {
          const result = await exec(toPowerShellEncodedCommand("Set-Clipboard $null"), { signal: options.signal });
          if (result.exitCode !== 0) {
            return makeFailureResult(config, action, "win32", startedAt, "failed",
              makeCommandFailureMessage("Clipboard clear failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
          }
          return makeSuccessResult(config, action, "win32", startedAt);
        }
      }
      case "read_element": {
        return makeFailureResult(config, action, "win32", startedAt, "failed",
          "read_element is not implemented for Windows; use inspectElement or searchElements instead",
          FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
      }
      case "drag":
        return makeFailureResult(config, action, "win32", startedAt, "failed",
          "drag is not implemented for Windows",
          FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
      case "file_operation": {
        return executeWinFileOperation(action, startedAt, options.signal);
      }
    }
  }

  async function executeWinFileOperation(
    action: Extract<FridayDesktopAction, { type: "file_operation" }>,
    startedAt: ISODateTime,
    signal?: AbortSignal,
  ): Promise<FridayDesktopActionResult> {
    switch (action.operation) {
      case "read": {
        const escapedPath = escapePowerShellSingleQuoted(action.path);
        const result = await exec(toPowerShellEncodedCommand(`Get-Content '${escapedPath}' -Raw`), { signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "win32", startedAt, "failed",
            makeCommandFailureMessage("File read failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "win32", startedAt, { fileData: result.stdout });
      }
      case "write": {
        const escapedPath = escapePowerShellSingleQuoted(action.path);
        const escapedContent = escapePowerShellSingleQuoted(action.content);
        const result = await exec(toPowerShellEncodedCommand(`Set-Content '${escapedPath}' '${escapedContent}'`), { signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "win32", startedAt, "failed",
            makeCommandFailureMessage("File write failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "win32", startedAt);
      }
      case "move": {
        const escapedPath = escapePowerShellSingleQuoted(action.path);
        const escapedDestination = escapePowerShellSingleQuoted(action.destinationPath);
        const result = await exec(toPowerShellEncodedCommand(`Move-Item '${escapedPath}' '${escapedDestination}'`), { signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "win32", startedAt, "failed",
            makeCommandFailureMessage("File move failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "win32", startedAt);
      }
      case "copy": {
        const escapedPath = escapePowerShellSingleQuoted(action.path);
        const escapedDestination = escapePowerShellSingleQuoted(action.destinationPath);
        const result = await exec(toPowerShellEncodedCommand(`Copy-Item '${escapedPath}' '${escapedDestination}' -Recurse`), { signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "win32", startedAt, "failed",
            makeCommandFailureMessage("File copy failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "win32", startedAt);
      }
      case "delete": {
        const escapedPath = escapePowerShellSingleQuoted(action.path);
        const result = await exec(toPowerShellEncodedCommand(`Remove-Item '${escapedPath}' -Force`), { signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "win32", startedAt, "failed",
            makeCommandFailureMessage("File delete failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "win32", startedAt);
      }
      case "list": {
        const escapedPath = escapePowerShellSingleQuoted(action.path);
        const result = await exec(toPowerShellEncodedCommand(`Get-ChildItem '${escapedPath}' | Format-List`), { signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "win32", startedAt, "failed",
            makeCommandFailureMessage("File list failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "win32", startedAt, { fileData: result.stdout });
      }
      case "stat": {
        const escapedPath = escapePowerShellSingleQuoted(action.path);
        const result = await exec(toPowerShellEncodedCommand(`Get-Item '${escapedPath}' | Format-List`), { signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "win32", startedAt, "failed",
            makeCommandFailureMessage("File stat failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "win32", startedAt, { fileData: result.stdout });
      }
    }
  }

  return {
    metadata,

    async execute(action: FridayDesktopAction, options?: ExecCommandOptions): Promise<FridayDesktopActionResult> {
      try {
        return await executeAction(action, options);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return makeFailureResult(config, action, "win32", config.nowIso(), "failed",
          `Windows adapter error: ${msg}`, FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
      }
    },

    async inspectElement(_selector: FridayDesktopElementSelector): Promise<FridayDesktopElement | null> {
      // Windows UI Automation inspection is not yet implemented
      return null;
    },

    async searchElements(_query: string, _appBundleId?: string): Promise<FridayDesktopElement[]> {
      // Windows UI Automation search is not yet implemented
      return [];
    },

    getCapabilities(): FridayDesktopCapability[] {
      return [...WIN32_CAPABILITIES];
    },

    // B1 truth-labeling: previously every win32 permission was reported as
    // `"granted"` without any actual platform check. That's a fake-capability —
    // the adapter has no UIAutomation/COM probe wired up yet, so the truthful
    // state is `"not_determined"` until a real probe lands. Each permission
    // carries an actionable instruction so an operator can verify in Windows
    // Settings.
    async checkPermissions(): Promise<FridayDesktopPermission[]> {
      const now = config.nowIso();
      const winInstructions: Readonly<Record<FridayDesktopOsPermissionType, string | undefined>> = {
        accessibility: "Windows → Settings → Accessibility → Enable UI Automation",
        automation: "Windows → Settings → Privacy & security → App permissions → Automation tools",
        input_monitoring: "Windows → Settings → Privacy & security → Input monitoring (no per-app gate; runtime input hooks may still fail)",
        // Permission types not used by win32 — fields kept for the Record completeness.
        screen_recording: undefined,
        file_access: undefined,
      };
      return WIN32_PERMISSIONS.map((perm) =>
        makePermission(perm, "not_determined", "win32", now, winInstructions[perm]),
      );
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// LINUX ADAPTER
// ═══════════════════════════════════════════════════════════════════════

const LINUX_CAPABILITIES: readonly FridayDesktopCapability[] = [
  "click", "type", "keypress", "scroll",
  "screenshot", "read_element", "launch_app", "close_app",
  "clipboard_read", "clipboard_write",
  "file_read", "file_write", "file_move", "file_copy", "file_delete", "file_list", "file_stat",
  "element_search",
  "accessibility_api",
];

const LINUX_PERMISSIONS: readonly FridayDesktopOsPermissionType[] = [
  "accessibility", "file_access",
];

export async function createLinuxAdapter(
  config: DesktopAdapterConfig,
): Promise<FridayDesktopAdapterRuntime> {
  const exec = config.execCommand ?? defaultExecCommand;
  const osVersion = config.osVersionOverride ?? await detectOsVersion("linux", exec);
  const healthy = config.healthOverride ?? true;
  const initTime = config.nowIso();

  // Detect desktop environment
  let desktopEnv = "unknown";
  try {
    const deResult = await exec("echo $XDG_CURRENT_DESKTOP 2>/dev/null || echo unknown");
    desktopEnv = deResult.stdout || "unknown";
  } catch (err) { /* keep unknown */ console.warn("[friday][desktop-adapters] detect-desktop-env:", err instanceof Error ? err.message : String(err)); }

  // Check for xdotool
  let hasXdotool = false;
  try {
    const xdResult = await exec("which xdotool 2>/dev/null");
    hasXdotool = xdResult.exitCode === 0;
  } catch (err) { /* not available */ console.warn("[friday][desktop-adapters] detect-xdotool:", err instanceof Error ? err.message : String(err)); }

  const metadata: FridayDesktopAdapter = {
    id: "linux-atspi-v1",
    platform: "linux",
    displayName: `Linux AT-SPI2 Adapter (${desktopEnv})`,
    version: "1.0.0",
    capabilities: [...LINUX_CAPABILITIES],
    supportedOsVersions: ">=5.0",
    detectedOsVersion: osVersion,
    healthy,
    statusMessage: healthy
      ? `Ready — ${desktopEnv} desktop, xdotool: ${hasXdotool ? "available" : "not found"}`
      : "AT-SPI2 accessibility not available",
    initializedAt: initTime,
  };

  async function executeAction(
    action: FridayDesktopAction,
    options: ExecCommandOptions = {},
  ): Promise<FridayDesktopActionResult> {
    const startedAt = config.nowIso();
    if (action.type === "file_operation" && options.sandboxChecked !== true) {
      return makeUncheckedFileOperationResult(config, action, "linux", startedAt);
    }

    switch (action.type) {
      case "click": {
        const coords = action.coordinates ?? { x: 0, y: 0 };
        if (!hasXdotool) {
          return makeFailureResult(config, action, "linux", startedAt, "failed",
            "xdotool is required for Linux click actions", FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        const x = ensureFiniteInteger(coords.x, "coordinates.x");
        const y = ensureFiniteInteger(coords.y, "coordinates.y");
        const result = await exec(`xdotool mousemove ${x} ${y} click 1`, { signal: options.signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "linux", startedAt, "failed",
            makeCommandFailureMessage("Linux click failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "linux", startedAt);
      }
      case "type": {
        if (!hasXdotool) {
          return makeFailureResult(config, action, "linux", startedAt, "failed",
            "xdotool is required for Linux type actions", FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        const result = await exec(`xdotool type ${quotePosixShellArg(action.text)}`, { signal: options.signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "linux", startedAt, "failed",
            makeCommandFailureMessage("Linux type failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "linux", startedAt);
      }
      case "keypress": {
        if (!hasXdotool) {
          return makeFailureResult(config, action, "linux", startedAt, "failed",
            "xdotool is required for Linux keypress actions", FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        const mods = (action.modifiers ?? []).map((modifier) => {
          const mapped = modifier === "meta" || modifier === "command" ? "super" : modifier;
          if (!SAFE_XDOTOOL_KEY_RE.test(mapped)) {
            throw new FridayDomainError("VALIDATION_ERROR", "Unsafe modifier", { httpStatus: 400 });
          }
          return mapped;
        });
        const keyToken = ensureSafeXdotoolKeyCombo(action.key);
        const keyCombo = ensureSafeXdotoolKeyCombo([...mods, keyToken].join("+"));
        const result = await exec(`xdotool key ${quotePosixShellArg(keyCombo)}`, { signal: options.signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "linux", startedAt, "failed",
            makeCommandFailureMessage("Linux keypress failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "linux", startedAt);
      }
      case "scroll": {
        if (!hasXdotool) {
          return makeFailureResult(config, action, "linux", startedAt, "failed",
            "xdotool is required for Linux scroll actions", FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        const btn = action.direction === "up" ? "4" : action.direction === "down" ? "5" : "4";
        const amount = ensureFiniteInteger(action.amount ?? 3, "amount");
        const result = await exec(`xdotool click --repeat ${amount} ${btn}`, { signal: options.signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "linux", startedAt, "failed",
            makeCommandFailureMessage("Linux scroll failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "linux", startedAt);
      }
      case "screenshot": {
        const tmpPath = `/tmp/friday-screenshot-${config.generateId()}.png`;
        const quotedTmpPath = quotePosixShellArg(tmpPath);
        const result = await exec(`import -window root ${quotedTmpPath} 2>&1 || gnome-screenshot -f ${quotedTmpPath} 2>&1 || scrot ${quotedTmpPath} 2>&1`, { signal: options.signal });
        if (result.exitCode === 0) {
          const b64 = await exec(`base64 ${quotedTmpPath} 2>/dev/null; status=$?; rm -f ${quotedTmpPath}; exit $status`, { signal: options.signal });
          if (b64.exitCode !== 0) {
            return makeFailureResult(config, action, "linux", startedAt, "failed",
              makeCommandFailureMessage("Screenshot encoding failed", b64), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
          }
          return makeSuccessResult(config, action, "linux", startedAt, { screenshotBase64: b64.stdout });
        }
        return makeFailureResult(config, action, "linux", startedAt, "failed",
          "No screenshot tool available", FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
      }
      case "launch_app": {
        const appIdentifier = ensureSafeAppIdentifier(action.appIdentifier);
        const quotedAppIdentifier = quotePosixShellArg(appIdentifier);
        const result = await exec(
          `if command -v -- ${quotedAppIdentifier} >/dev/null 2>&1 || [ -x ${quotedAppIdentifier} ]; then nohup ${quotedAppIdentifier} >/dev/null 2>&1 & else echo ${quotePosixShellArg(`Application not found: ${appIdentifier}`)} >&2; exit 127; fi`,
          { signal: options.signal },
        );
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "linux", startedAt, "app_not_found",
            `Application "${action.appIdentifier}" not found`, FRIDAY_DESKTOP_ERROR_CODES.APP_NOT_FOUND);
        }
        return makeSuccessResult(config, action, "linux", startedAt);
      }
      case "close_app": {
        const appIdentifier = ensureSafeAppIdentifier(action.appIdentifier);
        const quotedAppIdentifier = quotePosixShellArg(appIdentifier);
        const result = action.force
          ? await exec(`pkill -9 -f ${quotedAppIdentifier} 2>&1`, { signal: options.signal })
          : await exec(`pkill -f ${quotedAppIdentifier} 2>&1`, { signal: options.signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "linux", startedAt, "failed",
            makeCommandFailureMessage("Linux close_app failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "linux", startedAt);
      }
      case "clipboard": {
        if (action.operation === "read") {
          const result = await exec("xclip -selection clipboard -o 2>/dev/null || xsel --clipboard --output 2>/dev/null", { signal: options.signal });
          if (result.exitCode !== 0) {
            return makeFailureResult(config, action, "linux", startedAt, "failed",
              makeCommandFailureMessage("Clipboard read failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
          }
          return makeSuccessResult(config, action, "linux", startedAt, { clipboardContent: result.stdout });
        } else if (action.operation === "write") {
          const quotedContent = quotePosixShellArg(action.content);
          const result = await exec(`printf %s ${quotedContent} | xclip -selection clipboard 2>/dev/null || printf %s ${quotedContent} | xsel --clipboard --input 2>/dev/null`, { signal: options.signal });
          if (result.exitCode !== 0) {
            return makeFailureResult(config, action, "linux", startedAt, "failed",
              makeCommandFailureMessage("Clipboard write failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
          }
          return makeSuccessResult(config, action, "linux", startedAt);
        } else {
          const result = await exec("echo -n | xclip -selection clipboard 2>/dev/null", { signal: options.signal });
          if (result.exitCode !== 0) {
            return makeFailureResult(config, action, "linux", startedAt, "failed",
              makeCommandFailureMessage("Clipboard clear failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
          }
          return makeSuccessResult(config, action, "linux", startedAt);
        }
      }
      case "read_element": {
        return makeFailureResult(config, action, "linux", startedAt, "failed",
          "read_element is not implemented for Linux; use inspectElement or searchElements instead",
          FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
      }
      case "drag":
        return makeFailureResult(config, action, "linux", startedAt, "failed",
          "drag is not implemented for Linux",
          FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
      case "file_operation": {
        // Linux file operations are the same as macOS (POSIX)
        return executeLinuxFileOperation(action, startedAt, options.signal);
      }
    }
  }

  async function executeLinuxFileOperation(
    action: Extract<FridayDesktopAction, { type: "file_operation" }>,
    startedAt: ISODateTime,
    signal?: AbortSignal,
  ): Promise<FridayDesktopActionResult> {
    switch (action.operation) {
      case "read": {
        const result = await exec(`cat ${quotePosixShellArg(action.path)} 2>&1`, { signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "linux", startedAt, "failed",
            result.stderr, FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "linux", startedAt, { fileData: result.stdout });
      }
      case "write": {
        const result = await exec(`printf %s ${quotePosixShellArg(action.content)} > ${quotePosixShellArg(action.path)}`, { signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "linux", startedAt, "failed",
            makeCommandFailureMessage("File write failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "linux", startedAt);
      }
      case "move": {
        const result = await exec(`mv ${quotePosixShellArg(action.path)} ${quotePosixShellArg(action.destinationPath)}`, { signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "linux", startedAt, "failed",
            makeCommandFailureMessage("File move failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "linux", startedAt);
      }
      case "copy": {
        const result = await exec(`cp -R ${quotePosixShellArg(action.path)} ${quotePosixShellArg(action.destinationPath)}`, { signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "linux", startedAt, "failed",
            makeCommandFailureMessage("File copy failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "linux", startedAt);
      }
      case "delete": {
        const result = await exec(`rm -f ${quotePosixShellArg(action.path)}`, { signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "linux", startedAt, "failed",
            makeCommandFailureMessage("File delete failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "linux", startedAt);
      }
      case "list": {
        const result = await exec(`ls -la ${quotePosixShellArg(action.path)} 2>&1`, { signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "linux", startedAt, "failed",
            makeCommandFailureMessage("File list failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "linux", startedAt, { fileData: result.stdout });
      }
      case "stat": {
        const result = await exec(`stat ${quotePosixShellArg(action.path)} 2>&1`, { signal });
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "linux", startedAt, "failed",
            makeCommandFailureMessage("File stat failed", result), FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "linux", startedAt, { fileData: result.stdout });
      }
    }
  }

  return {
    metadata,

    async execute(action: FridayDesktopAction, options?: ExecCommandOptions): Promise<FridayDesktopActionResult> {
      try {
        return await executeAction(action, options);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return makeFailureResult(config, action, "linux", config.nowIso(), "failed",
          `Linux adapter error: ${msg}`, FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
      }
    },

    async inspectElement(_selector: FridayDesktopElementSelector): Promise<FridayDesktopElement | null> {
      // Linux AT-SPI2 element inspection is not yet implemented
      return null;
    },

    async searchElements(_query: string, _appBundleId?: string): Promise<FridayDesktopElement[]> {
      // Linux AT-SPI2 element search is not yet implemented
      return [];
    },

    getCapabilities(): FridayDesktopCapability[] {
      return [...LINUX_CAPABILITIES];
    },

    async checkPermissions(): Promise<FridayDesktopPermission[]> {
      const now = config.nowIso();
      const permissions: FridayDesktopPermission[] = [];

      for (const perm of LINUX_PERMISSIONS) {
        let status: FridayDesktopOsPermissionStatus = "not_determined";
        let instructions: string | undefined;

        switch (perm) {
          case "accessibility": {
            try {
              const result = await exec("dbus-send --session --dest=org.a11y.Bus --print-reply /org/a11y/bus org.freedesktop.DBus.Peer.Ping 2>/dev/null");
              status = result.exitCode === 0 ? "granted" : "not_determined";
            } catch (err) { console.warn("[friday][desktop-adapters] linux-check-accessibility:", err instanceof Error ? err.message : String(err)); status = "not_determined"; }
            instructions = "Enable AT-SPI2: gsettings set org.gnome.desktop.interface toolkit-accessibility true";
            break;
          }
          case "file_access":
            status = "granted"; // POSIX file permissions
            instructions = "File access is managed by POSIX file permissions.";
            break;
        }

        permissions.push(makePermission(perm, status, "linux", now, instructions));
      }
      return permissions;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// ADAPTER REGISTRATION HELPER
// ═══════════════════════════════════════════════════════════════════════

/** Create the platform adapter for the current (or specified) platform. */
export async function createPlatformAdapter(
  platform: FridayDesktopPlatform,
  config: DesktopAdapterConfig,
): Promise<FridayDesktopAdapterRuntime> {
  switch (platform) {
    case "darwin": return createDarwinAdapter(config);
    case "win32": return createWin32Adapter(config);
    case "linux": return createLinuxAdapter(config);
  }
}

/** Perform a health check on an adapter. */
export async function checkAdapterHealth(
  adapter: FridayDesktopAdapterRuntime,
  config: DesktopAdapterConfig,
): Promise<AdapterHealthCheck> {
  const now = config.nowIso();
  try {
    const capabilities = adapter.getCapabilities();
    const permissions = await adapter.checkPermissions();
    const grantedCount = permissions.filter(p => p.status === "granted").length;
    const deniedCount = permissions.filter(p => p.status === "denied").length;

    const healthy = adapter.metadata.healthy && deniedCount === 0;
    return {
      healthy,
      statusMessage: healthy
        ? `Adapter operational: ${capabilities.length} capabilities, ${grantedCount}/${permissions.length} permissions granted`
        : `Adapter degraded: ${deniedCount} permissions denied`,
      checkedAt: now,
      details: {
        platform: adapter.metadata.platform,
        adapterVersion: adapter.metadata.version,
        osVersion: adapter.metadata.detectedOsVersion,
        capabilityCount: capabilities.length,
        permissionsGranted: grantedCount,
        permissionsDenied: deniedCount,
        permissionsTotal: permissions.length,
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      healthy: false,
      statusMessage: `Health check failed: ${msg}`,
      checkedAt: now,
      details: { platform: adapter.metadata.platform, error: msg },
    };
  }
}
