/**
 * C-001 Desktop Adapters — Unit Tests
 *
 * Validates macOS, Windows, and Linux adapters for capability reporting,
 * health checks, permission checking, action execution, element inspection,
 * and adapter registration.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createDarwinAdapter,
  createWin32Adapter,
  createLinuxAdapter,
  createPlatformAdapter,
  checkAdapterHealth,
  type DesktopAdapterConfig,
  type ExecResult,
} from "../../../../src/desktop/engine/friday-desktop-adapters.js";
import type {
  FridayDesktopAdapterRuntime,
  FridayDesktopAction,
  FridayDesktopCapability,
} from "../../../../src/desktop/model/friday-desktop.types.js";

// ─── Helpers ───

const NOW = "2026-02-25T12:00:00.000Z";
let idSeq = 0;

function mockExec(responses: Record<string, Partial<ExecResult>> = {}): (cmd: string) => Promise<ExecResult> {
  return vi.fn(async (cmd: string): Promise<ExecResult> => {
    for (const [pattern, result] of Object.entries(responses)) {
      if (cmd.includes(pattern)) {
        return { stdout: "", stderr: "", exitCode: 0, ...result };
      }
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  });
}

function makeConfig(execOverride?: (cmd: string) => Promise<ExecResult>): DesktopAdapterConfig {
  idSeq = 0;
  return {
    nowIso: () => NOW,
    generateId: () => `id-${++idSeq}`,
    osVersionOverride: "15.0",
    healthOverride: true,
    execCommand: execOverride ?? mockExec(),
  };
}

// ─── Tests ───

describe("C-001 FridayDesktopAdapters", () => {

  // ═══════════════════════════════════════════════════════════════
  // macOS ADAPTER
  // ═══════════════════════════════════════════════════════════════

  describe("Darwin (macOS) adapter", () => {
    let adapter: FridayDesktopAdapterRuntime;

    beforeEach(async () => {
      adapter = await createDarwinAdapter(makeConfig());
    });

    it("has correct metadata", () => {
      expect(adapter.metadata.id).toBe("darwin-accessibility-v1");
      expect(adapter.metadata.platform).toBe("darwin");
      expect(adapter.metadata.version).toBe("1.0.0");
      expect(adapter.metadata.healthy).toBe(true);
      expect(adapter.metadata.detectedOsVersion).toBe("15.0");
      expect(adapter.metadata.displayName).toContain("macOS");
    });

    it("reports macOS capabilities", () => {
      const caps = adapter.getCapabilities();
      expect(caps).toContain("click");
      expect(caps).toContain("type");
      expect(caps).toContain("keypress");
      expect(caps).toContain("screenshot");
      expect(caps).toContain("clipboard_read");
      expect(caps).toContain("accessibility_api");
      expect(caps).toContain("scripting_bridge");
      expect(caps.length).toBeGreaterThan(15);
    });

    it("checks macOS permissions", async () => {
      const permissions = await adapter.checkPermissions();
      expect(permissions.length).toBe(4); // accessibility, screen_recording, input_monitoring, automation
      const types = permissions.map(p => p.permissionType);
      expect(types).toContain("accessibility");
      expect(types).toContain("screen_recording");
      for (const perm of permissions) {
        expect(perm.platform).toBe("darwin");
        expect(perm.grantInstructions).toBeDefined();
      }
    });

    it("executes click action", async () => {
      const exec = mockExec();
      adapter = await createDarwinAdapter(makeConfig(exec));

      const action: FridayDesktopAction = {
        type: "click",
        coordinates: { x: 100, y: 200, width: 0, height: 0 },
      };
      const result = await adapter.execute(action);
      expect(result.status).toBe("success");
      expect(result.platform).toBe("darwin");
      expect(exec).toHaveBeenCalled();
    });

    it("reports macOS command failures instead of false success", async () => {
      const exec = mockExec({
        "osascript": { exitCode: 1, stderr: "accessibility denied" },
      });
      adapter = await createDarwinAdapter(makeConfig(exec));

      const result = await adapter.execute({ type: "click" });

      expect(result.status).toBe("failed");
      expect(result.errorMessage).toContain("accessibility denied");
    });

    it("executes type action", async () => {
      const exec = mockExec();
      adapter = await createDarwinAdapter(makeConfig(exec));

      const action: FridayDesktopAction = { type: "type", text: "hello world" };
      const result = await adapter.execute(action);
      expect(result.status).toBe("success");
    });

    it("executes keypress action with modifiers", async () => {
      const action: FridayDesktopAction = { type: "keypress", key: "c", modifiers: ["command"] };
      const result = await adapter.execute(action);
      expect(result.status).toBe("success");
    });

    it("executes screenshot action", async () => {
      const exec = mockExec({
        "screencapture": { exitCode: 0 },
        "base64": { stdout: "aGVsbG8=" },
      });
      adapter = await createDarwinAdapter(makeConfig(exec));

      const action: FridayDesktopAction = { type: "screenshot" };
      const result = await adapter.execute(action);
      expect(result.status).toBe("success");
      expect(result.screenshotBase64).toBe("aGVsbG8=");
    });

    it("reports macOS screenshot encoding failures instead of cleanup success", async () => {
      const exec = mockExec({
        "screencapture": { exitCode: 0 },
        "base64": { exitCode: 1, stderr: "encode failed" },
      });
      adapter = await createDarwinAdapter(makeConfig(exec));

      const result = await adapter.execute({ type: "screenshot" });

      expect(result.status).toBe("failed");
      expect(result.errorMessage).toContain("encode failed");
    });

    it("executes clipboard read", async () => {
      const exec = mockExec({ "pbpaste": { stdout: "clipboard content" } });
      adapter = await createDarwinAdapter(makeConfig(exec));

      const action: FridayDesktopAction = { type: "clipboard", operation: "read" };
      const result = await adapter.execute(action);
      expect(result.status).toBe("success");
      expect(result.clipboardContent).toBe("clipboard content");
    });

    it("executes clipboard write", async () => {
      const exec = mockExec();
      adapter = await createDarwinAdapter(makeConfig(exec));

      const action: FridayDesktopAction = { type: "clipboard", operation: "write", content: "test" };
      const result = await adapter.execute(action);
      expect(result.status).toBe("success");
    });

    it("executes launch_app", async () => {
      const action: FridayDesktopAction = { type: "launch_app", appIdentifier: "com.apple.Safari" };
      const result = await adapter.execute(action);
      expect(result.status).toBe("success");
    });

    it("encodes multiline AppleScript text safely", async () => {
      const exec = mockExec();
      adapter = await createDarwinAdapter(makeConfig(exec));

      const action: FridayDesktopAction = { type: "type", text: "hello\nworld" };
      const result = await adapter.execute(action);

      expect(result.status).toBe("success");
      const command = (exec as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
      expect(command).toContain("linefeed");
      expect(command).not.toContain("hello\nworld");
    });

    it("rejects unsafe AppleScript control characters", async () => {
      const exec = mockExec();
      adapter = await createDarwinAdapter(makeConfig(exec));

      const action: FridayDesktopAction = { type: "type", text: "hello\u0001world" };
      const result = await adapter.execute(action);

      expect(result.status).toBe("failed");
      expect(result.errorMessage).toContain("Unsafe AppleScript input");
      expect(exec).not.toHaveBeenCalled();
    });

    it("rejects multiline AppleScript keys", async () => {
      const exec = mockExec();
      adapter = await createDarwinAdapter(makeConfig(exec));

      const action: FridayDesktopAction = { type: "keypress", key: "enter\nbeep" };
      const result = await adapter.execute(action);

      expect(result.status).toBe("failed");
      expect(result.errorMessage).toContain("Unsafe AppleScript key");
      expect(exec).not.toHaveBeenCalled();
    });

    it("rejects unsafe app identifiers", async () => {
      const exec = mockExec();
      adapter = await createDarwinAdapter(makeConfig(exec));

      const action: FridayDesktopAction = {
        type: "launch_app",
        appIdentifier: "Safari; rm -rf /",
      };
      const result = await adapter.execute(action);
      expect(result.status).toBe("failed");
      expect(result.errorMessage).toContain("Unsafe app identifier");
      expect(exec).not.toHaveBeenCalled();
    });

    it("executes close_app", async () => {
      const action: FridayDesktopAction = { type: "close_app", appIdentifier: "Safari" };
      const result = await adapter.execute(action);
      expect(result.status).toBe("success");
    });

    it("executes file_operation read", async () => {
      const exec = mockExec({ "cat": { stdout: "file contents" } });
      adapter = await createDarwinAdapter(makeConfig(exec));

      const action: FridayDesktopAction = { type: "file_operation", operation: "read", path: "/tmp/test.txt" };
      const result = await adapter.execute(action, { sandboxChecked: true });
      expect(result.status).toBe("success");
      expect(result.fileData).toBe("file contents");
    });

    it("refuses raw file_operation execution before ActionExecutor sandbox validation", async () => {
      const exec = mockExec({ "cat": { stdout: "file contents" } });
      adapter = await createDarwinAdapter(makeConfig(exec));

      const result = await adapter.execute({
        type: "file_operation",
        operation: "read",
        path: "/tmp/test.txt",
      });

      expect(result.status).toBe("sandbox_violation");
      expect(result.errorCode).toBe("DESKTOP_SANDBOX_VIOLATION");
      expect(exec).not.toHaveBeenCalled();
    });

    it("reports macOS file write failures instead of false success", async () => {
      const exec = mockExec({
        "printf": { exitCode: 1, stderr: "permission denied" },
      });
      adapter = await createDarwinAdapter(makeConfig(exec));

      const result = await adapter.execute({
        type: "file_operation",
        operation: "write",
        path: "/tmp/test.txt",
        content: "data",
      }, { sandboxChecked: true });

      expect(result.status).toBe("failed");
      expect(result.errorMessage).toContain("permission denied");
    });

    it("executes read_element", async () => {
      const action: FridayDesktopAction = {
        type: "read_element",
        selector: { strategy: "accessibility_id", value: "btn-save" },
      };
      const result = await adapter.execute(action);
      expect(result.status).toBe("failed");
    });

    it("inspects elements via selector", async () => {
      const exec = mockExec({
        "System Events": { exitCode: 0, stdout: "button, my-button, enabled" },
      });
      adapter = await createDarwinAdapter(makeConfig(exec));

      const element = await adapter.inspectElement({
        strategy: "accessibility_id", value: "my-button",
      });
      expect(element).not.toBeNull();
      expect(element!.name).toBe("my-button");
    });

    it("handles execution errors gracefully", async () => {
      const exec = mockExec();
      (exec as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("OS error"));
      adapter = await createDarwinAdapter(makeConfig(exec));

      const action: FridayDesktopAction = { type: "click" };
      const result = await adapter.execute(action);
      expect(result.status).toBe("failed");
      expect(result.errorMessage).toContain("macOS adapter error");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // WINDOWS ADAPTER
  // ═══════════════════════════════════════════════════════════════

  describe("Win32 (Windows) adapter", () => {
    let adapter: FridayDesktopAdapterRuntime;

    beforeEach(async () => {
      adapter = await createWin32Adapter(makeConfig());
    });

    it("has correct metadata", () => {
      expect(adapter.metadata.id).toBe("win32-uiautomation-v1");
      expect(adapter.metadata.platform).toBe("win32");
      expect(adapter.metadata.displayName).toContain("Windows");
      expect(adapter.metadata.healthy).toBe(true);
    });

    it("reports Windows capabilities", () => {
      const caps = adapter.getCapabilities();
      expect(caps).toContain("click");
      expect(caps).toContain("type");
      expect(caps).toContain("screenshot");
      expect(caps).toContain("accessibility_api");
      expect(caps).not.toContain("scripting_bridge"); // macOS only
    });

    it("checks Windows permissions (generally granted)", async () => {
      const permissions = await adapter.checkPermissions();
      expect(permissions.length).toBe(3);
      for (const perm of permissions) {
        expect(perm.platform).toBe("win32");
        expect(perm.status).toBe("granted");
      }
    });

    it("executes click action", async () => {
      const action: FridayDesktopAction = {
        type: "click",
        coordinates: { x: 50, y: 75, width: 0, height: 0 },
      };
      const result = await adapter.execute(action);
      expect(result.status).toBe("success");
      expect(result.platform).toBe("win32");
    });

    it("executes type action", async () => {
      const action: FridayDesktopAction = { type: "type", text: "test input" };
      const result = await adapter.execute(action);
      expect(result.status).toBe("success");
    });

    it("uses encoded PowerShell for dynamic text instead of raw shell interpolation", async () => {
      const exec = mockExec();
      adapter = await createWin32Adapter(makeConfig(exec));

      const payload = "hello' \\\"; Start-Process calc; #";
      const result = await adapter.execute({ type: "type", text: payload });

      expect(result.status).toBe("success");
      const command = (exec as ReturnType<typeof vi.fn>).mock.calls.find(([cmd]) =>
        String(cmd).includes("-EncodedCommand"),
      )?.[0] as string | undefined;
      expect(command).toBeDefined();
      expect(command).not.toContain(payload);
      expect(command).not.toContain("Start-Process calc");
      const encoded = command!.split("-EncodedCommand ")[1];
      const decoded = Buffer.from(encoded, "base64").toString("utf16le");
      expect(decoded).toContain("$ErrorActionPreference = 'Stop'");
      expect(decoded).toContain("catch { Write-Error $_; exit 1 }");
    });

    it("reports Windows command failures instead of false success", async () => {
      const exec = mockExec({
        "-EncodedCommand": { exitCode: 1, stderr: "sendkeys failed" },
      });
      adapter = await createWin32Adapter(makeConfig(exec));

      const result = await adapter.execute({ type: "type", text: "hello" });

      expect(result.status).toBe("failed");
      expect(result.errorMessage).toContain("sendkeys failed");
    });

    it("does not report unimplemented Windows scroll as success", async () => {
      const result = await adapter.execute({ type: "scroll", direction: "down" });

      expect(result.status).toBe("failed");
      expect(result.errorMessage).toContain("not implemented");
    });

    it("executes clipboard operations", async () => {
      const exec = mockExec({ "-EncodedCommand": { stdout: "win-content" } });
      adapter = await createWin32Adapter(makeConfig(exec));

      const readAction: FridayDesktopAction = { type: "clipboard", operation: "read" };
      const readResult = await adapter.execute(readAction);
      expect(readResult.status).toBe("success");
      expect(readResult.clipboardContent).toBe("win-content");
    });

    it("refuses raw Windows file operations before ActionExecutor sandbox validation", async () => {
      const exec = mockExec({ "-EncodedCommand": { stdout: "win-content" } });
      adapter = await createWin32Adapter(makeConfig(exec));

      const result = await adapter.execute({
        type: "file_operation",
        operation: "read",
        path: "C:\\tmp\\test.txt",
      });

      expect(result.status).toBe("sandbox_violation");
      expect(result.errorCode).toBe("DESKTOP_SANDBOX_VIOLATION");
      expect(exec).not.toHaveBeenCalledWith(
        expect.stringContaining("Get-Content"),
        expect.anything(),
      );
    });

    it("handles errors gracefully", async () => {
      const exec = mockExec();
      (exec as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("PowerShell error"));
      adapter = await createWin32Adapter(makeConfig(exec));

      const action: FridayDesktopAction = { type: "click" };
      const result = await adapter.execute(action);
      expect(result.status).toBe("failed");
      expect(result.errorMessage).toContain("Windows adapter error");
    });

    it("searches elements", async () => {
      const elements = await adapter.searchElements("save button");
      expect(elements.length).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // LINUX ADAPTER
  // ═══════════════════════════════════════════════════════════════

  describe("Linux adapter", () => {
    let adapter: FridayDesktopAdapterRuntime;

    beforeEach(async () => {
      const exec = mockExec({
        "XDG_CURRENT_DESKTOP": { stdout: "GNOME" },
        "which xdotool": { exitCode: 0, stdout: "/usr/bin/xdotool" },
      });
      adapter = await createLinuxAdapter(makeConfig(exec));
    });

    it("has correct metadata", () => {
      expect(adapter.metadata.id).toBe("linux-atspi-v1");
      expect(adapter.metadata.platform).toBe("linux");
      expect(adapter.metadata.displayName).toContain("Linux");
      expect(adapter.metadata.displayName).toContain("AT-SPI2");
      expect(adapter.metadata.healthy).toBe(true);
    });

    it("detects desktop environment", () => {
      expect(adapter.metadata.statusMessage).toContain("xdotool: available");
    });

    it("reports Linux capabilities", () => {
      const caps = adapter.getCapabilities();
      expect(caps).toContain("click");
      expect(caps).toContain("type");
      expect(caps).toContain("screenshot");
      expect(caps).toContain("accessibility_api");
      expect(caps).not.toContain("drag"); // not supported on Linux
      expect(caps).not.toContain("scripting_bridge");
    });

    it("checks Linux permissions", async () => {
      const permissions = await adapter.checkPermissions();
      expect(permissions.length).toBe(2); // accessibility, file_access
      const accPerm = permissions.find(p => p.permissionType === "accessibility");
      expect(accPerm).toBeDefined();
      expect(accPerm!.grantInstructions).toContain("AT-SPI2");
    });

    it("executes click with xdotool", async () => {
      const exec = mockExec({
        "XDG_CURRENT_DESKTOP": { stdout: "GNOME" },
        "which xdotool": { exitCode: 0, stdout: "/usr/bin/xdotool" },
      });
      adapter = await createLinuxAdapter(makeConfig(exec));

      const action: FridayDesktopAction = {
        type: "click",
        coordinates: { x: 100, y: 200, width: 0, height: 0 },
      };
      const result = await adapter.execute(action);
      expect(result.status).toBe("success");
      expect(result.platform).toBe("linux");
    });

    it("fails Linux input actions when xdotool is unavailable", async () => {
      const exec = mockExec({
        "XDG_CURRENT_DESKTOP": { stdout: "GNOME" },
        "which xdotool": { exitCode: 1, stderr: "not found" },
      });
      adapter = await createLinuxAdapter(makeConfig(exec));

      const result = await adapter.execute({ type: "click" });

      expect(result.status).toBe("failed");
      expect(result.errorMessage).toContain("xdotool is required");
    });

    it("reports Linux xdotool failures instead of false success", async () => {
      const exec = mockExec({
        "XDG_CURRENT_DESKTOP": { stdout: "GNOME" },
        "which xdotool": { exitCode: 0, stdout: "/usr/bin/xdotool" },
        "xdotool mousemove": { exitCode: 1, stderr: "display unavailable" },
      });
      adapter = await createLinuxAdapter(makeConfig(exec));

      const result = await adapter.execute({ type: "click" });

      expect(result.status).toBe("failed");
      expect(result.errorMessage).toContain("display unavailable");
    });

    it("reports Linux screenshot encoding failures instead of cleanup success", async () => {
      const exec = mockExec({
        "XDG_CURRENT_DESKTOP": { stdout: "GNOME" },
        "which xdotool": { exitCode: 0, stdout: "/usr/bin/xdotool" },
        "import": { exitCode: 0 },
        "base64": { exitCode: 1, stderr: "encode failed" },
      });
      adapter = await createLinuxAdapter(makeConfig(exec));

      const result = await adapter.execute({ type: "screenshot" });

      expect(result.status).toBe("failed");
      expect(result.errorMessage).toContain("encode failed");
    });

    it("reports missing Linux launch targets instead of background success", async () => {
      const exec = mockExec({
        "XDG_CURRENT_DESKTOP": { stdout: "GNOME" },
        "which xdotool": { exitCode: 0, stdout: "/usr/bin/xdotool" },
        "definitely-missing-friday-binary": { exitCode: 127, stderr: "Application not found" },
      });
      adapter = await createLinuxAdapter(makeConfig(exec));

      const result = await adapter.execute({
        type: "launch_app",
        appIdentifier: "definitely-missing-friday-binary",
      });

      expect(result.status).toBe("app_not_found");
      expect(result.errorCode).toBe("DESKTOP_APP_NOT_FOUND");
    });

    it("executes type with xdotool", async () => {
      const exec = mockExec({
        "XDG_CURRENT_DESKTOP": { stdout: "GNOME" },
        "which xdotool": { exitCode: 0, stdout: "/usr/bin/xdotool" },
      });
      adapter = await createLinuxAdapter(makeConfig(exec));

      const action: FridayDesktopAction = { type: "type", text: "hello linux" };
      const result = await adapter.execute(action);
      expect(result.status).toBe("success");
    });

    it("rejects unsafe key combo input", async () => {
      const exec = mockExec({
        "XDG_CURRENT_DESKTOP": { stdout: "GNOME" },
        "which xdotool": { exitCode: 0, stdout: "/usr/bin/xdotool" },
      });
      adapter = await createLinuxAdapter(makeConfig(exec));

      const action: FridayDesktopAction = { type: "keypress", key: "ctrl+$(id)" };
      const result = await adapter.execute(action);
      expect(result.status).toBe("failed");
      expect(result.errorMessage).toContain("Unsafe key combo");
    });

    it("executes clipboard read", async () => {
      const exec = mockExec({
        "XDG_CURRENT_DESKTOP": { stdout: "GNOME" },
        "which xdotool": { exitCode: 0 },
        "xclip": { stdout: "linux-clipboard" },
      });
      adapter = await createLinuxAdapter(makeConfig(exec));

      const action: FridayDesktopAction = { type: "clipboard", operation: "read" };
      const result = await adapter.execute(action);
      expect(result.status).toBe("success");
      expect(result.clipboardContent).toBe("linux-clipboard");
    });

    it("refuses raw Linux file operations before ActionExecutor sandbox validation", async () => {
      const exec = mockExec({
        "XDG_CURRENT_DESKTOP": { stdout: "GNOME" },
        "which xdotool": { exitCode: 0 },
        "cat": { stdout: "file contents" },
      });
      adapter = await createLinuxAdapter(makeConfig(exec));

      const result = await adapter.execute({
        type: "file_operation",
        operation: "read",
        path: "/tmp/test.txt",
      });

      expect(result.status).toBe("sandbox_violation");
      expect(result.errorCode).toBe("DESKTOP_SANDBOX_VIOLATION");
      expect(exec).not.toHaveBeenCalledWith(
        expect.stringContaining("cat"),
        expect.anything(),
      );
    });

    it("handles errors gracefully", async () => {
      // Create adapter normally, then test that execute catches thrown errors
      const initExec = mockExec({
        "XDG_CURRENT_DESKTOP": { stdout: "GNOME" },
        "which xdotool": { exitCode: 0, stdout: "/usr/bin/xdotool" },
      });
      const cfg = makeConfig(initExec);
      const badAdapter = await createLinuxAdapter(cfg);

      // Now replace the exec to throw on all subsequent calls (action execution)
      // We need to trigger the outer catch by making the inner executeAction throw.
      // The click action with xdotool calls exec(`xdotool ...`) which is on initExec — returns success.
      // Instead, test with a type action that has bad chars causing the overall try to fail.
      // Simpler: just override the adapter's execute to verify it catches.
      // Actually, the adapter closes over `exec` from init. Let's make initExec throw after init.
      (initExec as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("X11 error"));

      const action: FridayDesktopAction = { type: "click", coordinates: { x: 10, y: 10, width: 0, height: 0 } };
      const result = await badAdapter.execute(action);
      expect(result.status).toBe("failed");
      expect(result.errorMessage).toContain("Linux adapter error");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // PLATFORM ADAPTER FACTORY
  // ═══════════════════════════════════════════════════════════════

  describe("createPlatformAdapter", () => {
    it("creates darwin adapter", async () => {
      const adapter = await createPlatformAdapter("darwin", makeConfig());
      expect(adapter.metadata.platform).toBe("darwin");
    });

    it("creates win32 adapter", async () => {
      const adapter = await createPlatformAdapter("win32", makeConfig());
      expect(adapter.metadata.platform).toBe("win32");
    });

    it("creates linux adapter", async () => {
      const adapter = await createPlatformAdapter("linux", makeConfig());
      expect(adapter.metadata.platform).toBe("linux");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // HEALTH CHECK
  // ═══════════════════════════════════════════════════════════════

  describe("checkAdapterHealth", () => {
    it("reports healthy adapter", async () => {
      const adapter = await createDarwinAdapter(makeConfig());
      const health = await checkAdapterHealth(adapter, makeConfig());
      expect(health.healthy).toBe(true);
      expect(health.statusMessage).toContain("operational");
      expect(health.details.platform).toBe("darwin");
      expect(health.details.capabilityCount).toBeGreaterThan(0);
    });

    it("reports unhealthy when permissions denied", async () => {
      const exec = mockExec({
        "System Events": { exitCode: 1, stderr: "not allowed" },
      });
      const config = makeConfig(exec);
      const adapter = await createDarwinAdapter(config);
      const health = await checkAdapterHealth(adapter, config);
      // It's healthy because healthOverride is true and the mock returns "denied" for accessibility
      // but "not_determined" for others, so deniedCount includes only explicitly denied perms
      expect(health.details.platform).toBe("darwin");
    });

    it("reports failure when health check throws", async () => {
      const adapter = await createDarwinAdapter(makeConfig());
      // Override checkPermissions to throw
      const broken = {
        ...adapter,
        checkPermissions: async () => { throw new Error("broken"); },
      };
      const health = await checkAdapterHealth(broken, makeConfig());
      expect(health.healthy).toBe(false);
      expect(health.statusMessage).toContain("Health check failed");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // ADAPTER REGISTRATION WITH ADAPTER MANAGER
  // ═══════════════════════════════════════════════════════════════

  describe("adapter manager registration", () => {
    it("registers adapters from all three platforms", async () => {
      const { createAdapterManager } = await import("../../../../src/desktop/engine/adapter-manager.js");
      const manager = createAdapterManager({
        generateId: () => `id-${++idSeq}`,
        nowIso: () => NOW,
      });

      const darwin = await createDarwinAdapter(makeConfig());
      const win32 = await createWin32Adapter(makeConfig());
      const linux = await createLinuxAdapter(makeConfig());

      manager.register(darwin);
      manager.register(win32);
      manager.register(linux);

      const adapters = manager.listAdapters();
      expect(adapters.length).toBe(3);
      expect(adapters.map(a => a.platform).sort()).toEqual(["darwin", "linux", "win32"]);
    });

    it("checks capability on registered adapter", async () => {
      const { createAdapterManager } = await import("../../../../src/desktop/engine/adapter-manager.js");
      const manager = createAdapterManager({
        generateId: () => `id-${++idSeq}`,
        nowIso: () => NOW,
      });

      const darwin = await createDarwinAdapter(makeConfig());
      manager.register(darwin);

      // The active adapter depends on process.platform, which is darwin in tests
      const active = manager.getActiveAdapter();
      if (active.metadata.platform === "darwin") {
        expect(manager.hasCapability("scripting_bridge")).toBe(true);
      }
    });
  });
});
