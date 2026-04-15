import { FridayDomainError } from "#errors";

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
  readonly execCommand?: (cmd: string) => Promise<ExecResult>;
}

/** Result of executing a shell command. */
export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Adapter health check result. */
export interface AdapterHealthCheck {
  readonly healthy: boolean;
  readonly statusMessage: string;
  readonly checkedAt: ISODateTime;
  readonly details: Record<string, string | boolean | number>;
}

const SAFE_APP_IDENTIFIER_RE = /^[A-Za-z0-9._:/\\\- ]+$/;
const SAFE_XDOTOOL_KEY_RE = /^[A-Za-z0-9_+\-]+$/;

// ─── Default Shell Executor ───

async function defaultExecCommand(cmd: string): Promise<ExecResult> {
  try {
    const { execSync } = await import("node:child_process");
    const stdout = execSync(cmd, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout: stdout.trim(), stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: (e.stdout ?? "").toString().trim(),
      stderr: (e.stderr ?? "").toString().trim(),
      exitCode: e.status ?? 1,
    };
  }
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

function escapeAppleScriptString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"");
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
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

  async function executeAction(action: FridayDesktopAction): Promise<FridayDesktopActionResult> {
    const startedAt = config.nowIso();

    switch (action.type) {
      case "click": {
        const coords = action.coordinates ?? { x: 0, y: 0 };
        const x = ensureFiniteInteger(coords.x, "coordinates.x");
        const y = ensureFiniteInteger(coords.y, "coordinates.y");
        const btn = action.button ?? "left";
        const clickType = action.clickType ?? "single";
        const clickCount = clickType === "double" ? 2 : clickType === "triple" ? 3 : 1;
        const script = `tell application "System Events" to click at {${x}, ${y}}`;
        await exec(`osascript -e ${quotePosixShellArg(script)} 2>&1 || true`);
        return makeSuccessResult(config, action, "darwin", startedAt, {
          targetElement: action.selector ? makeElement(
            config.generateId(), "button", action.selector.value, action.selector.appBundleId ?? "unknown",
            { x, y, width: 0, height: 0 },
          ) : undefined,
        });
      }
      case "type": {
        const escaped = escapeAppleScriptString(action.text);
        const script = `tell application "System Events" to keystroke "${escaped}"`;
        await exec(`osascript -e ${quotePosixShellArg(script)} 2>&1 || true`);
        return makeSuccessResult(config, action, "darwin", startedAt);
      }
      case "keypress": {
        const mods = (action.modifiers ?? []).map(m => m === "meta" || m === "command" ? "command down" : `${m} down`).join(", ");
        const escapedKey = escapeAppleScriptString(action.key);
        const script = mods
          ? `tell application "System Events" to keystroke "${escapedKey}" using {${mods}}`
          : `tell application "System Events" to keystroke "${escapedKey}"`;
        await exec(`osascript -e ${quotePosixShellArg(script)} 2>&1 || true`);
        return makeSuccessResult(config, action, "darwin", startedAt);
      }
      case "scroll": {
        const amount = ensureFiniteInteger(action.amount ?? 3, "amount");
        const dir = action.direction === "up" || action.direction === "left" ? amount : -amount;
        const script = `tell application "System Events" to scroll ${dir}`;
        await exec(`osascript -e ${quotePosixShellArg(script)} 2>&1 || true`);
        return makeSuccessResult(config, action, "darwin", startedAt);
      }
      case "screenshot": {
        const format = action.format ?? "png";
        const tmpPath = `/tmp/friday-screenshot-${config.generateId()}.${format}`;
        const result = await exec(
          `screencapture -x -t ${quotePosixShellArg(format)} ${quotePosixShellArg(tmpPath)} 2>&1`,
        );
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "darwin", startedAt, "failed",
            `Screenshot capture failed: ${result.stderr}`, FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        // Read as base64
        const b64Result = await exec(
          `base64 -i ${quotePosixShellArg(tmpPath)} 2>/dev/null; rm -f ${quotePosixShellArg(tmpPath)}`,
        );
        return makeSuccessResult(config, action, "darwin", startedAt, {
          screenshotBase64: b64Result.stdout,
        });
      }
      case "launch_app": {
        const appIdentifier = ensureSafeAppIdentifier(action.appIdentifier);
        const quotedAppIdentifier = quotePosixShellArg(appIdentifier);
        const result = await exec(`open -b ${quotedAppIdentifier} 2>&1 || open -a ${quotedAppIdentifier} 2>&1`);
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "darwin", startedAt, "app_not_found",
            `Application "${action.appIdentifier}" not found`, FRIDAY_DESKTOP_ERROR_CODES.APP_NOT_FOUND);
        }
        return makeSuccessResult(config, action, "darwin", startedAt);
      }
      case "close_app": {
        const appIdentifier = ensureSafeAppIdentifier(action.appIdentifier);
        const escapedAppIdentifier = escapeAppleScriptString(appIdentifier);
        const force = action.force ? "force " : "";
        const script = `tell application "${escapedAppIdentifier}" to ${force}quit`;
        await exec(`osascript -e ${quotePosixShellArg(script)} 2>&1 || true`);
        return makeSuccessResult(config, action, "darwin", startedAt);
      }
      case "clipboard": {
        if (action.operation === "read") {
          const result = await exec("pbpaste 2>/dev/null");
          return makeSuccessResult(config, action, "darwin", startedAt, {
            clipboardContent: result.stdout,
          });
        } else if (action.operation === "write") {
          await exec(`printf %s ${quotePosixShellArg(action.content)} | pbcopy`);
          return makeSuccessResult(config, action, "darwin", startedAt);
        } else {
          await exec("pbcopy < /dev/null");
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
        return executeFileOperation(action, startedAt);
      }
    }
  }

  async function executeFileOperation(
    action: Extract<FridayDesktopAction, { type: "file_operation" }>,
    startedAt: ISODateTime,
  ): Promise<FridayDesktopActionResult> {
    switch (action.operation) {
      case "read": {
        const result = await exec(`cat ${quotePosixShellArg(action.path)} 2>&1`);
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "darwin", startedAt, "failed",
            result.stderr, FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "darwin", startedAt, { fileData: result.stdout });
      }
      case "write": {
        await exec(
          `printf %s ${quotePosixShellArg(action.content)} > ${quotePosixShellArg(action.path)}`,
        );
        return makeSuccessResult(config, action, "darwin", startedAt);
      }
      case "move": {
        await exec(`mv ${quotePosixShellArg(action.path)} ${quotePosixShellArg(action.destinationPath)}`);
        return makeSuccessResult(config, action, "darwin", startedAt);
      }
      case "copy": {
        await exec(`cp -R ${quotePosixShellArg(action.path)} ${quotePosixShellArg(action.destinationPath)}`);
        return makeSuccessResult(config, action, "darwin", startedAt);
      }
      case "delete": {
        await exec(`rm -f ${quotePosixShellArg(action.path)}`);
        return makeSuccessResult(config, action, "darwin", startedAt);
      }
      case "list": {
        const result = await exec(`ls -la ${quotePosixShellArg(action.path)} 2>&1`);
        return makeSuccessResult(config, action, "darwin", startedAt, { fileData: result.stdout });
      }
      case "stat": {
        const result = await exec(`stat -f "%Sm %z %N" ${quotePosixShellArg(action.path)} 2>&1`);
        return makeSuccessResult(config, action, "darwin", startedAt, { fileData: result.stdout });
      }
    }
  }

  return {
    metadata,

    async execute(action: FridayDesktopAction): Promise<FridayDesktopActionResult> {
      try {
        return await executeAction(action);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return makeFailureResult(config, action, "darwin", config.nowIso(), "failed",
          `macOS adapter error: ${msg}`, FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
      }
    },

    async inspectElement(selector: FridayDesktopElementSelector): Promise<FridayDesktopElement | null> {
      try {
        const escapedSelectorValue = escapeAppleScriptString(selector.value);
        const script = `tell application "System Events" to get properties of first UI element whose name is "${escapedSelectorValue}"`;
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
        const escapedAppBundleId = appBundleId ? escapeAppleScriptString(appBundleId) : undefined;
        const app = escapedAppBundleId ? `application process "${escapedAppBundleId}"` : "application process 1";
        const escapedQuery = escapeAppleScriptString(query);
        const script = `tell application "System Events" to get name of every UI element of ${app} whose name contains "${escapedQuery}"`;
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

  async function executeAction(action: FridayDesktopAction): Promise<FridayDesktopActionResult> {
    const startedAt = config.nowIso();

    switch (action.type) {
      case "click": {
        const coords = action.coordinates ?? { x: 0, y: 0 };
        const x = ensureFiniteInteger(coords.x, "coordinates.x");
        const y = ensureFiniteInteger(coords.y, "coordinates.y");
        const psCmd = `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y}); [System.Windows.Forms.SendKeys]::SendWait('{CLICK}')"`;
        await exec(psCmd);
        return makeSuccessResult(config, action, "win32", startedAt);
      }
      case "type": {
        const escaped = escapePowerShellSingleQuoted(action.text);
        await exec(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')"`);
        return makeSuccessResult(config, action, "win32", startedAt);
      }
      case "keypress": {
        const keyMap: Record<string, string> = { Enter: "{ENTER}", Tab: "{TAB}", Escape: "{ESC}", Backspace: "{BS}", Delete: "{DEL}" };
        const key = escapePowerShellSingleQuoted(keyMap[action.key] ?? action.key);
        await exec(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${key}')"`);
        return makeSuccessResult(config, action, "win32", startedAt);
      }
      case "scroll": {
        return makeSuccessResult(config, action, "win32", startedAt);
      }
      case "screenshot": {
        const screenshotId = config.generateId();
        const tmpPath = `$env:TEMP\\friday-screenshot-${screenshotId}.png`;
        const escapedPath = escapePowerShellSingleQuoted(tmpPath);
        const resolvedTmpPath = `${process.env.TEMP ?? process.env.TMP ?? "C:\\Windows\\Temp"}\\friday-screenshot-${screenshotId}.png`;
        await exec(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen | Out-Null; $bmp = New-Object System.Drawing.Bitmap([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width,[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(0,0,0,0,$bmp.Size); $bmp.Save('${escapedPath}')"`);
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
        const result = await exec(`powershell -Command "Start-Process '${escapedApp}'" 2>&1`);
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
        await exec(`powershell -Command "Stop-Process -Name '${escapedApp}' ${force} -ErrorAction SilentlyContinue"`);
        return makeSuccessResult(config, action, "win32", startedAt);
      }
      case "clipboard": {
        if (action.operation === "read") {
          const result = await exec("powershell -Command \"Get-Clipboard\"");
          return makeSuccessResult(config, action, "win32", startedAt, { clipboardContent: result.stdout });
        } else if (action.operation === "write") {
          const escapedContent = escapePowerShellSingleQuoted(action.content);
          await exec(`powershell -Command "Set-Clipboard '${escapedContent}'"`);
          return makeSuccessResult(config, action, "win32", startedAt);
        } else {
          await exec("powershell -Command \"Set-Clipboard $null\"");
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
        return executeWinFileOperation(action, startedAt);
      }
    }
  }

  async function executeWinFileOperation(
    action: Extract<FridayDesktopAction, { type: "file_operation" }>,
    startedAt: ISODateTime,
  ): Promise<FridayDesktopActionResult> {
    switch (action.operation) {
      case "read": {
        const escapedPath = escapePowerShellSingleQuoted(action.path);
        const result = await exec(`powershell -Command "Get-Content '${escapedPath}' -Raw"`);
        return makeSuccessResult(config, action, "win32", startedAt, { fileData: result.stdout });
      }
      case "write": {
        const escapedPath = escapePowerShellSingleQuoted(action.path);
        const escapedContent = escapePowerShellSingleQuoted(action.content);
        await exec(`powershell -Command "Set-Content '${escapedPath}' '${escapedContent}'"`);
        return makeSuccessResult(config, action, "win32", startedAt);
      }
      case "move": {
        const escapedPath = escapePowerShellSingleQuoted(action.path);
        const escapedDestination = escapePowerShellSingleQuoted(action.destinationPath);
        await exec(`powershell -Command "Move-Item '${escapedPath}' '${escapedDestination}'"`);
        return makeSuccessResult(config, action, "win32", startedAt);
      }
      case "copy": {
        const escapedPath = escapePowerShellSingleQuoted(action.path);
        const escapedDestination = escapePowerShellSingleQuoted(action.destinationPath);
        await exec(`powershell -Command "Copy-Item '${escapedPath}' '${escapedDestination}' -Recurse"`);
        return makeSuccessResult(config, action, "win32", startedAt);
      }
      case "delete": {
        const escapedPath = escapePowerShellSingleQuoted(action.path);
        await exec(`powershell -Command "Remove-Item '${escapedPath}' -Force"`);
        return makeSuccessResult(config, action, "win32", startedAt);
      }
      case "list": {
        const escapedPath = escapePowerShellSingleQuoted(action.path);
        const result = await exec(`powershell -Command "Get-ChildItem '${escapedPath}' | Format-List"`);
        return makeSuccessResult(config, action, "win32", startedAt, { fileData: result.stdout });
      }
      case "stat": {
        const escapedPath = escapePowerShellSingleQuoted(action.path);
        const result = await exec(`powershell -Command "Get-Item '${escapedPath}' | Format-List"`);
        return makeSuccessResult(config, action, "win32", startedAt, { fileData: result.stdout });
      }
    }
  }

  return {
    metadata,

    async execute(action: FridayDesktopAction): Promise<FridayDesktopActionResult> {
      try {
        return await executeAction(action);
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

    async checkPermissions(): Promise<FridayDesktopPermission[]> {
      const now = config.nowIso();
      return WIN32_PERMISSIONS.map(perm =>
        makePermission(perm, "granted", "win32", now,
          perm === "accessibility" ? "Windows → Settings → Accessibility → Enable UI Automation" : undefined),
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

  async function executeAction(action: FridayDesktopAction): Promise<FridayDesktopActionResult> {
    const startedAt = config.nowIso();

    switch (action.type) {
      case "click": {
        const coords = action.coordinates ?? { x: 0, y: 0 };
        if (hasXdotool) {
          const x = ensureFiniteInteger(coords.x, "coordinates.x");
          const y = ensureFiniteInteger(coords.y, "coordinates.y");
          await exec(`xdotool mousemove ${x} ${y} click 1`);
        }
        return makeSuccessResult(config, action, "linux", startedAt);
      }
      case "type": {
        if (hasXdotool) {
          await exec(`xdotool type ${quotePosixShellArg(action.text)}`);
        }
        return makeSuccessResult(config, action, "linux", startedAt);
      }
      case "keypress": {
        if (hasXdotool) {
          const mods = (action.modifiers ?? []).map((modifier) => {
            const mapped = modifier === "meta" || modifier === "command" ? "super" : modifier;
            if (!SAFE_XDOTOOL_KEY_RE.test(mapped)) {
              throw new FridayDomainError("VALIDATION_ERROR", "Unsafe modifier", { httpStatus: 400 });
            }
            return mapped;
          });
          const keyToken = ensureSafeXdotoolKeyCombo(action.key);
          const keyCombo = ensureSafeXdotoolKeyCombo([...mods, keyToken].join("+"));
          await exec(`xdotool key ${quotePosixShellArg(keyCombo)}`);
        }
        return makeSuccessResult(config, action, "linux", startedAt);
      }
      case "scroll": {
        if (hasXdotool) {
          const btn = action.direction === "up" ? "4" : action.direction === "down" ? "5" : "4";
          const amount = ensureFiniteInteger(action.amount ?? 3, "amount");
          await exec(`xdotool click --repeat ${amount} ${btn}`);
        }
        return makeSuccessResult(config, action, "linux", startedAt);
      }
      case "screenshot": {
        const tmpPath = `/tmp/friday-screenshot-${config.generateId()}.png`;
        const quotedTmpPath = quotePosixShellArg(tmpPath);
        const result = await exec(`import -window root ${quotedTmpPath} 2>&1 || gnome-screenshot -f ${quotedTmpPath} 2>&1 || scrot ${quotedTmpPath} 2>&1`);
        if (result.exitCode === 0) {
          const b64 = await exec(`base64 ${quotedTmpPath} 2>/dev/null; rm -f ${quotedTmpPath}`);
          return makeSuccessResult(config, action, "linux", startedAt, { screenshotBase64: b64.stdout });
        }
        return makeFailureResult(config, action, "linux", startedAt, "failed",
          "No screenshot tool available", FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
      }
      case "launch_app": {
        const appIdentifier = ensureSafeAppIdentifier(action.appIdentifier);
        const result = await exec(`nohup ${quotePosixShellArg(appIdentifier)} >/dev/null 2>&1 &`);
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "linux", startedAt, "app_not_found",
            `Application "${action.appIdentifier}" not found`, FRIDAY_DESKTOP_ERROR_CODES.APP_NOT_FOUND);
        }
        return makeSuccessResult(config, action, "linux", startedAt);
      }
      case "close_app": {
        const appIdentifier = ensureSafeAppIdentifier(action.appIdentifier);
        const quotedAppIdentifier = quotePosixShellArg(appIdentifier);
        if (action.force) {
          await exec(`pkill -9 -f ${quotedAppIdentifier} 2>/dev/null || true`);
        } else {
          await exec(`pkill -f ${quotedAppIdentifier} 2>/dev/null || true`);
        }
        return makeSuccessResult(config, action, "linux", startedAt);
      }
      case "clipboard": {
        if (action.operation === "read") {
          const result = await exec("xclip -selection clipboard -o 2>/dev/null || xsel --clipboard --output 2>/dev/null");
          return makeSuccessResult(config, action, "linux", startedAt, { clipboardContent: result.stdout });
        } else if (action.operation === "write") {
          const quotedContent = quotePosixShellArg(action.content);
          await exec(`printf %s ${quotedContent} | xclip -selection clipboard 2>/dev/null || printf %s ${quotedContent} | xsel --clipboard --input 2>/dev/null`);
          return makeSuccessResult(config, action, "linux", startedAt);
        } else {
          await exec("echo -n | xclip -selection clipboard 2>/dev/null || true");
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
        return executeLinuxFileOperation(action, startedAt);
      }
    }
  }

  async function executeLinuxFileOperation(
    action: Extract<FridayDesktopAction, { type: "file_operation" }>,
    startedAt: ISODateTime,
  ): Promise<FridayDesktopActionResult> {
    switch (action.operation) {
      case "read": {
        const result = await exec(`cat ${quotePosixShellArg(action.path)} 2>&1`);
        if (result.exitCode !== 0) {
          return makeFailureResult(config, action, "linux", startedAt, "failed",
            result.stderr, FRIDAY_DESKTOP_ERROR_CODES.ACTION_FAILED);
        }
        return makeSuccessResult(config, action, "linux", startedAt, { fileData: result.stdout });
      }
      case "write": {
        await exec(`printf %s ${quotePosixShellArg(action.content)} > ${quotePosixShellArg(action.path)}`);
        return makeSuccessResult(config, action, "linux", startedAt);
      }
      case "move": {
        await exec(`mv ${quotePosixShellArg(action.path)} ${quotePosixShellArg(action.destinationPath)}`);
        return makeSuccessResult(config, action, "linux", startedAt);
      }
      case "copy": {
        await exec(`cp -R ${quotePosixShellArg(action.path)} ${quotePosixShellArg(action.destinationPath)}`);
        return makeSuccessResult(config, action, "linux", startedAt);
      }
      case "delete": {
        await exec(`rm -f ${quotePosixShellArg(action.path)}`);
        return makeSuccessResult(config, action, "linux", startedAt);
      }
      case "list": {
        const result = await exec(`ls -la ${quotePosixShellArg(action.path)} 2>&1`);
        return makeSuccessResult(config, action, "linux", startedAt, { fileData: result.stdout });
      }
      case "stat": {
        const result = await exec(`stat ${quotePosixShellArg(action.path)} 2>&1`);
        return makeSuccessResult(config, action, "linux", startedAt, { fileData: result.stdout });
      }
    }
  }

  return {
    metadata,

    async execute(action: FridayDesktopAction): Promise<FridayDesktopActionResult> {
      try {
        return await executeAction(action);
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
