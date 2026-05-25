import { describe, it, expect, vi } from "vitest";
import { createFridayAgentDesktopTool } from "../../../../src/agent/tools/friday-agent-desktop-tool.js";
import type { DesktopSessionManager } from "../../../../src/desktop/engine/session-manager.js";
import type { FridayDesktopAction } from "../../../../src/desktop/model/friday-desktop.types.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function mockActionResult(overrides?: Record<string, unknown>) {
  return {
    id: "result-001",
    action: { type: "click" } as FridayDesktopAction,
    status: "success" as const,
    platform: "darwin" as const,
    durationMs: 42,
    startedAt: "2026-02-25T10:00:00Z",
    completedAt: "2026-02-25T10:00:00Z",
    ...overrides,
  };
}

function mockElement(overrides?: Record<string, unknown>) {
  return {
    elementId: "el-001",
    role: "button",
    name: "OK",
    enabled: true,
    focused: false,
    visible: true,
    bounds: { x: 10, y: 20, width: 100, height: 30 },
    appBundleId: "com.example.app",
    displayIndex: 0,
    childCount: 0,
    platformAttributes: {},
    ...overrides,
  };
}

function mockRecording(overrides?: Record<string, unknown>) {
  return {
    id: "rec-001",
    name: "Test Recording",
    state: "recording" as const,
    platform: "darwin" as const,
    parameters: {},
    tags: [],
    stepCount: 0,
    createdBy: "agent",
    createdAt: "2026-02-25T10:00:00Z",
    updatedAt: "2026-02-25T10:00:00Z",
    ...overrides,
  };
}

function mockPermission(overrides?: Record<string, unknown>) {
  return {
    permissionType: "accessibility" as const,
    status: "granted" as const,
    platform: "darwin" as const,
    grantInstructions: "Go to System Preferences > Privacy > Accessibility",
    checkedAt: "2026-02-25T10:00:00Z",
    ...overrides,
  };
}

function mockSessionInfo(overrides?: Record<string, unknown>) {
  return {
    sessionId: "sess-001",
    state: "connected" as const,
    platform: "darwin" as const,
    principalId: "agent:main",
    connectedAt: "2026-02-25T10:00:00Z",
    ...overrides,
  };
}

function createMockSessionManager(overrides?: Partial<DesktopSessionManager>): DesktopSessionManager {
  return {
    connect: vi.fn().mockReturnValue(mockSessionInfo()),
    disconnect: vi.fn().mockReturnValue(mockSessionInfo({ state: "disconnected" })),
    getSessionInfo: vi.fn().mockReturnValue(mockSessionInfo()),
    isConnected: vi.fn().mockReturnValue(true),
    getAdapterManager: vi.fn(),
    registerAdapter: vi.fn(),
    executeAction: vi.fn().mockResolvedValue(mockActionResult()),
    cancelAction: vi.fn().mockReturnValue(true),
    getActionLog: vi.fn().mockReturnValue([]),
    inspectElement: vi.fn().mockResolvedValue(mockElement()),
    searchElements: vi.fn().mockResolvedValue([mockElement()]),
    checkPermissions: vi.fn().mockResolvedValue([mockPermission()]),
    loadPolicies: vi.fn(),
    startRecording: vi.fn().mockReturnValue(mockRecording()),
    stopRecording: vi.fn().mockReturnValue(mockRecording({ state: "stopped", stoppedAt: "2026-02-25T10:01:00Z" })),
    pauseRecording: vi.fn(),
    resumeRecording: vi.fn(),
    getRecording: vi.fn(),
    getRecordingSteps: vi.fn().mockReturnValue([]),
    listRecordings: vi.fn().mockReturnValue([]),
    deleteRecording: vi.fn(),
    replayRecording: vi.fn(),
    ...overrides,
  } as unknown as DesktopSessionManager;
}

// ─── Tests ───

describe("createFridayAgentDesktopTool", () => {
  it("returns a tool with name 'desktop'", () => {
    const sm = createMockSessionManager();
    const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
    expect(tool.name).toBe("desktop");
    expect(tool.parameters.required).toEqual(["action"]);
  });

  it("rejects invalid action", async () => {
    const sm = createMockSessionManager();
    const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
    const result = await tool.execute({ action: "invalid_action" }, signal());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid action");
  });

  // ─── session_info ───

  describe("session_info", () => {
    it("returns session info without requiring connection", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      const result = await tool.execute({ action: "session_info" }, signal());
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content);
      expect(data.sessionId).toBe("sess-001");
      expect(data.state).toBe("connected");
      expect(data.platform).toBe("darwin");
    });
  });

  // ─── connection guard ───

  describe("connection guard", () => {
    it("returns error when session is disconnected for execute", async () => {
      const sm = createMockSessionManager({ isConnected: vi.fn().mockReturnValue(false) });
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      const result = await tool.execute(
        { action: "execute", actionType: "click", x: 10, y: 20 },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("not connected");
    });

    it("returns error when session is disconnected for screenshot", async () => {
      const sm = createMockSessionManager({ isConnected: vi.fn().mockReturnValue(false) });
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      const result = await tool.execute({ action: "screenshot" }, signal());
      expect(result.isError).toBe(true);
      expect(result.content).toContain("not connected");
    });

    it("returns error when session is disconnected for check_permissions", async () => {
      const sm = createMockSessionManager({ isConnected: vi.fn().mockReturnValue(false) });
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      const result = await tool.execute({ action: "check_permissions" }, signal());
      expect(result.isError).toBe(true);
      expect(result.content).toContain("not connected");
    });
  });

  // ─── execute: click ───

  describe("execute: click", () => {
    it("executes click with coordinates", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      const result = await tool.execute(
        { action: "execute", actionType: "click", x: 100, y: 200 },
        signal(),
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content);
      expect(data.status).toBe("success");
      expect(data.actionId).toBe("result-001");

      const call = (sm.executeAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe("click");
      expect(call.coordinates).toEqual({ x: 100, y: 200, width: 1, height: 1 });
    });

    it("executes click with selector", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      await tool.execute(
        { action: "execute", actionType: "click", strategy: "accessibility_id", selectorValue: "btn-ok" },
        signal(),
      );
      const call = (sm.executeAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe("click");
      expect(call.selector).toEqual({ strategy: "accessibility_id", value: "btn-ok" });
    });

    it("passes button and clickType", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      await tool.execute(
        { action: "execute", actionType: "click", x: 10, y: 20, button: "right", clickType: "double" },
        signal(),
      );
      const call = (sm.executeAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.button).toBe("right");
      expect(call.clickType).toBe("double");
    });

    it("passes modifiers", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      await tool.execute(
        { action: "execute", actionType: "click", x: 10, y: 20, modifiers: ["shift", "meta"] },
        signal(),
      );
      const call = (sm.executeAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.modifiers).toEqual(["shift", "meta"]);
    });

    it("filters invalid modifiers", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      await tool.execute(
        { action: "execute", actionType: "click", x: 10, y: 20, modifiers: ["shift", "invalid", "alt"] },
        signal(),
      );
      const call = (sm.executeAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.modifiers).toEqual(["shift", "alt"]);
    });

    it("returns permission prompt and decision evidence from the agent execute facade", async () => {
      const sm = createMockSessionManager({
        executeAction: vi.fn().mockResolvedValue(
          mockActionResult({
            status: "permission_denied_user",
            errorCode: "DESKTOP_PERMISSION_DENIED_USER",
            errorMessage: "Action denied by user: too risky",
            matchedPolicyRuleId: "critical-click-rule",
            permissionPrompt: {
              id: "prompt-1",
              actionType: "click",
              action: { type: "click" },
              riskLevel: "critical",
              policyRuleId: "critical-click-rule",
              reason: "Action 'click' classified as critical risk",
              timeoutMs: 5000,
              createdAt: "2026-02-25T10:00:00Z",
              expiresAt: "2026-02-25T10:00:05Z",
            },
            permissionDecisionId: "decision-1",
            permissionDecision: {
              id: "decision-1",
              promptId: "prompt-1",
              actionType: "click",
              riskLevel: "critical",
              decision: "denied",
              decidedBy: "user-1",
              rationale: "too risky",
              createdAt: "2026-02-25T10:00:00Z",
            },
          }),
        ),
      });
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      const result = await tool.execute(
        { action: "execute", actionType: "click", x: 10, y: 20 },
        signal(),
      );

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content);
      expect(data.status).toBe("permission_denied_user");
      expect(data.matchedPolicyRuleId).toBe("critical-click-rule");
      expect(data.permissionPrompt).toMatchObject({
        id: "prompt-1",
        riskLevel: "critical",
      });
      expect(data.permissionDecisionId).toBe("decision-1");
      expect(data.permissionDecision).toMatchObject({
        id: "decision-1",
        promptId: "prompt-1",
        decision: "denied",
      });
    });
  });

  // ─── execute: type ───

  describe("execute: type", () => {
    it("types text", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      await tool.execute(
        { action: "execute", actionType: "type", text: "Hello World" },
        signal(),
      );
      const call = (sm.executeAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe("type");
      expect(call.text).toBe("Hello World");
    });

    it("requires text param", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      const result = await tool.execute(
        { action: "execute", actionType: "type" },
        signal(),
      );
      expect(result.isError).toBe(true);
    });
  });

  // ─── execute: keypress ───

  describe("execute: keypress", () => {
    it("presses a key with modifiers", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      await tool.execute(
        { action: "execute", actionType: "keypress", text: "c", modifiers: ["command"] },
        signal(),
      );
      const call = (sm.executeAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe("keypress");
      expect(call.key).toBe("c");
      expect(call.modifiers).toEqual(["command"]);
    });
  });

  // ─── execute: scroll ───

  describe("execute: scroll", () => {
    it("scrolls with direction and amount", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      await tool.execute(
        { action: "execute", actionType: "scroll", direction: "up", amount: 5 },
        signal(),
      );
      const call = (sm.executeAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe("scroll");
      expect(call.direction).toBe("up");
      expect(call.amount).toBe(5);
    });

    it("defaults to direction down, amount 3", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      await tool.execute(
        { action: "execute", actionType: "scroll" },
        signal(),
      );
      const call = (sm.executeAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.direction).toBe("down");
      expect(call.amount).toBe(3);
    });
  });

  // ─── execute: drag ───

  describe("execute: drag", () => {
    it("drags from start to end coordinates", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      await tool.execute(
        { action: "execute", actionType: "drag", startX: 10, startY: 20, endX: 100, endY: 200 },
        signal(),
      );
      const call = (sm.executeAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe("drag");
      expect(call.from).toEqual({ x: 10, y: 20, width: 1, height: 1 });
      expect(call.to).toEqual({ x: 100, y: 200, width: 1, height: 1 });
    });
  });

  // ─── execute: screenshot ───

  describe("execute: screenshot (via execute)", () => {
    it("captures screenshot with format", async () => {
      const sm = createMockSessionManager({
        executeAction: vi.fn().mockResolvedValue(
          mockActionResult({ action: { type: "screenshot" }, screenshotBase64: "iVBOR..." }),
        ),
      });
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      const result = await tool.execute(
        { action: "execute", actionType: "screenshot", format: "png" },
        signal(),
      );
      const data = JSON.parse(result.content);
      expect(data.screenshotBase64).toBe("iVBOR...");
    });
  });

  // ─── execute: launch_app / close_app ───

  describe("execute: launch_app / close_app", () => {
    it("launches an app", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      await tool.execute(
        { action: "execute", actionType: "launch_app", text: "com.apple.Safari" },
        signal(),
      );
      const call = (sm.executeAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe("launch_app");
      expect(call.appIdentifier).toBe("com.apple.Safari");
    });

    it("closes an app", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      await tool.execute(
        { action: "execute", actionType: "close_app", text: "com.apple.Safari" },
        signal(),
      );
      const call = (sm.executeAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe("close_app");
      expect(call.appIdentifier).toBe("com.apple.Safari");
    });
  });

  // ─── execute: clipboard ───

  describe("execute: clipboard", () => {
    it("reads clipboard", async () => {
      const sm = createMockSessionManager({
        executeAction: vi.fn().mockResolvedValue(
          mockActionResult({ action: { type: "clipboard" }, clipboardContent: "pasted" }),
        ),
      });
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      const result = await tool.execute(
        { action: "execute", actionType: "clipboard", operation: "read" },
        signal(),
      );
      const data = JSON.parse(result.content);
      expect(data.clipboardContent).toBe("pasted");

      const call = (sm.executeAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.operation).toBe("read");
    });

    it("writes to clipboard", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      await tool.execute(
        { action: "execute", actionType: "clipboard", operation: "write", content: "copy me" },
        signal(),
      );
      const call = (sm.executeAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe("clipboard");
      expect(call.operation).toBe("write");
      expect(call.content).toBe("copy me");
    });

    it("clears clipboard", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      await tool.execute(
        { action: "execute", actionType: "clipboard", operation: "clear" },
        signal(),
      );
      const call = (sm.executeAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.operation).toBe("clear");
    });
  });

  // ─── execute: file_operation ───

  describe("execute: file_operation", () => {
    it("reads a file", async () => {
      const sm = createMockSessionManager({
        executeAction: vi.fn().mockResolvedValue(
          mockActionResult({ action: { type: "file_operation" }, fileData: "contents" }),
        ),
      });
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      const result = await tool.execute(
        { action: "execute", actionType: "file_operation", path: "/tmp/test.txt", operation: "read" },
        signal(),
      );
      const data = JSON.parse(result.content);
      expect(data.fileData).toBe("contents");
    });

    it("writes a file", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      await tool.execute(
        { action: "execute", actionType: "file_operation", path: "/tmp/out.txt", operation: "write", content: "data" },
        signal(),
      );
      const call = (sm.executeAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.operation).toBe("write");
      expect(call.content).toBe("data");
    });

    it("lists a directory", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      await tool.execute(
        { action: "execute", actionType: "file_operation", path: "/tmp", operation: "list" },
        signal(),
      );
      const call = (sm.executeAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.operation).toBe("list");
      expect(call.path).toBe("/tmp");
    });

    it("copies a file", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      await tool.execute(
        { action: "execute", actionType: "file_operation", path: "/tmp/a.txt", operation: "copy", destinationPath: "/tmp/b.txt" },
        signal(),
      );
      const call = (sm.executeAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.operation).toBe("copy");
      expect(call.destinationPath).toBe("/tmp/b.txt");
    });

    it("stats a file", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      await tool.execute(
        { action: "execute", actionType: "file_operation", path: "/tmp/test.txt", operation: "stat" },
        signal(),
      );
      const call = (sm.executeAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.operation).toBe("stat");
    });

    it("defaults file operation to read", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      await tool.execute(
        { action: "execute", actionType: "file_operation", path: "/tmp/test.txt" },
        signal(),
      );
      const call = (sm.executeAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.operation).toBe("read");
    });

    // ─── B4 defense-in-depth: parse-time path safety ───
    //
    // The action-executor sandbox is the authoritative protection. This
    // parse-time check is a quick reject for the most obvious attack
    // shapes. These tests lock in the parse-time rejection set so future
    // edits don't silently widen it.

    it("B4 parse-time reject: '..' traversal in path returns Invalid action", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      const result = await tool.execute(
        { action: "execute", actionType: "file_operation", path: "../etc/passwd", operation: "read" },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(sm.executeAction).not.toHaveBeenCalled();
    });

    it("B4 parse-time reject: absolute POSIX system paths under /etc/, /proc/, /sys/, /dev/, /boot/, /root/", async () => {
      const sensitivePaths = [
        "/etc/passwd",
        "/etc/shadow",
        "/proc/self/mem",
        "/sys/firmware/dmi/tables/smbios_entry_point",
        "/dev/sda",
        "/boot/grub/grub.cfg",
        "/root/.ssh/authorized_keys",
      ];
      for (const p of sensitivePaths) {
        const sm = createMockSessionManager();
        const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
        const result = await tool.execute(
          { action: "execute", actionType: "file_operation", path: p, operation: "read" },
          signal(),
        );
        expect(result.isError, `should reject ${p}`).toBe(true);
        expect(sm.executeAction, `should not call executeAction for ${p}`).not.toHaveBeenCalled();
      }
    });

    it("B4 parse-time reject: Windows system paths (case-insensitive)", async () => {
      const sensitivePaths = [
        "C:\\Windows\\System32\\config\\SAM",
        "c:\\windows\\system32\\config\\sam",
        "C:\\Program Files\\Common Files\\something.exe",
        "C:\\Program Files (x86)\\foo\\bar.dll",
        "C:\\ProgramData\\Microsoft\\Crypto\\RSA",
      ];
      for (const p of sensitivePaths) {
        const sm = createMockSessionManager();
        const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
        const result = await tool.execute(
          { action: "execute", actionType: "file_operation", path: p, operation: "read" },
          signal(),
        );
        expect(result.isError, `should reject ${p}`).toBe(true);
        expect(sm.executeAction, `should not call executeAction for ${p}`).not.toHaveBeenCalled();
      }
    });

    it("B4 parse-time reject: null byte in path", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      const result = await tool.execute(
        { action: "execute", actionType: "file_operation", path: "/tmp/safe\0/../etc/passwd", operation: "read" },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(sm.executeAction).not.toHaveBeenCalled();
    });

    it("B4 parse-time accepts legitimate user paths (regression — no over-blocking)", async () => {
      const legitimatePaths = [
        "/tmp/notes.txt",
        "/home/jarvis/project/file.md",
        "/Users/jarvis/Desktop/document.pdf",
        "C:\\Users\\Jarvis\\Documents\\file.txt",
        "subdir/file.txt", // relative
      ];
      for (const p of legitimatePaths) {
        const sm = createMockSessionManager();
        const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
        const result = await tool.execute(
          { action: "execute", actionType: "file_operation", path: p, operation: "read" },
          signal(),
        );
        // Should NOT be a parse-time error — the action should reach
        // executeAction (which the mock accepts).
        expect(result.isError, `should NOT reject legitimate path ${p}`).toBeUndefined();
        expect(sm.executeAction, `should call executeAction for ${p}`).toHaveBeenCalled();
      }
    });

    it("B4 parse-time reject: move destinationPath also checked", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      const result = await tool.execute(
        {
          action: "execute",
          actionType: "file_operation",
          path: "/tmp/safe.txt",
          operation: "move",
          destinationPath: "/etc/passwd",
        },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(sm.executeAction).not.toHaveBeenCalled();
    });

    it("B4 parse-time reject: copy destinationPath also checked", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      const result = await tool.execute(
        {
          action: "execute",
          actionType: "file_operation",
          path: "/tmp/safe.txt",
          operation: "copy",
          destinationPath: "/proc/self/mem",
        },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(sm.executeAction).not.toHaveBeenCalled();
    });
  });

  // ─── execute: read_element ───

  describe("execute: read_element", () => {
    it("reads an element by accessibility_id", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      await tool.execute(
        { action: "execute", actionType: "read_element", strategy: "role_and_name", selectorValue: "OK" },
        signal(),
      );
      const call = (sm.executeAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe("read_element");
      expect(call.selector.strategy).toBe("role_and_name");
      expect(call.selector.value).toBe("OK");
    });
  });

  // ─── execute: invalid actionType ───

  describe("execute: invalid actionType", () => {
    it("returns error for unknown actionType", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      const result = await tool.execute(
        { action: "execute", actionType: "nonexistent" },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Invalid or incomplete actionType");
    });
  });

  // ─── screenshot action ───

  describe("screenshot", () => {
    it("captures a screenshot", async () => {
      const sm = createMockSessionManager({
        executeAction: vi.fn().mockResolvedValue(
          mockActionResult({
            action: { type: "screenshot" },
            screenshotBase64: "iVBOR...",
          }),
        ),
      });
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      const result = await tool.execute({ action: "screenshot" }, signal());
      const data = JSON.parse(result.content);
      expect(data.screenshotBase64).toBe("iVBOR...");
      expect(data.status).toBe("success");
    });

    it("returns error on screenshot failure", async () => {
      const sm = createMockSessionManager({
        executeAction: vi.fn().mockResolvedValue(
          mockActionResult({ status: "failed", errorMessage: "No display found" }),
        ),
      });
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      const result = await tool.execute({ action: "screenshot" }, signal());
      expect(result.isError).toBe(true);
      expect(result.content).toContain("No display found");
    });

    it("passes displayIndex and format", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      await tool.execute(
        { action: "screenshot", displayIndex: 1, format: "jpeg" },
        signal(),
      );
      const call = (sm.executeAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.type).toBe("screenshot");
      expect(call.displayIndex).toBe(1);
      expect(call.format).toBe("jpeg");
    });
  });

  // ─── inspect_element ───

  describe("inspect_element", () => {
    it("returns element data when found", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      const result = await tool.execute(
        { action: "inspect_element", strategy: "accessibility_id", selectorValue: "btn-ok" },
        signal(),
      );
      const data = JSON.parse(result.content);
      expect(data.found).toBe(true);
      expect(data.element.role).toBe("button");
      expect(data.element.name).toBe("OK");
    });

    it("returns found=false when element not found", async () => {
      const sm = createMockSessionManager({
        inspectElement: vi.fn().mockResolvedValue(null),
      });
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      const result = await tool.execute(
        { action: "inspect_element", strategy: "accessibility_id", selectorValue: "nonexistent" },
        signal(),
      );
      const data = JSON.parse(result.content);
      expect(data.found).toBe(false);
      expect(data.element).toBeNull();
    });

    it("passes appBundleId to selector", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      await tool.execute(
        {
          action: "inspect_element",
          strategy: "role_and_name",
          selectorValue: "Submit",
          appBundleId: "com.example.app",
        },
        signal(),
      );
      const call = (sm.inspectElement as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.strategy).toBe("role_and_name");
      expect(call.value).toBe("Submit");
      expect(call.appBundleId).toBe("com.example.app");
    });
  });

  // ─── search_elements ───

  describe("search_elements", () => {
    it("searches for elements by query", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      const result = await tool.execute(
        { action: "search_elements", query: "Submit" },
        signal(),
      );
      const data = JSON.parse(result.content);
      expect(data.query).toBe("Submit");
      expect(data.count).toBe(1);
      expect(data.elements).toHaveLength(1);
    });

    it("passes appBundleId to search", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      await tool.execute(
        { action: "search_elements", query: "OK", appBundleId: "com.example.app" },
        signal(),
      );
      const calls = (sm.searchElements as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][0]).toBe("OK");
      expect(calls[0][1]).toBe("com.example.app");
    });
  });

  // ─── start_recording / stop_recording ───

  describe("start_recording / stop_recording", () => {
    it("starts a recording with name", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      const result = await tool.execute(
        { action: "start_recording", recordingName: "My Flow" },
        signal(),
      );
      const data = JSON.parse(result.content);
      expect(data.recordingId).toBe("rec-001");
      expect(data.state).toBe("recording");
      expect(data.createdAt).toBeTruthy();
    });

    it("uses default name when recordingName omitted", async () => {
      const sm = createMockSessionManager();
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      await tool.execute({ action: "start_recording" }, signal());
      const call = (sm.startRecording as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.name).toBe("Agent Recording");
    });

    it("stops a recording and returns step count", async () => {
      const sm = createMockSessionManager({
        getRecordingSteps: vi.fn().mockReturnValue([
          { id: "step-1", recordingId: "rec-001", stepIndex: 0, action: { type: "click" }, parameterBindings: {}, timestamp: "2026-02-25T10:00:00Z" },
          { id: "step-2", recordingId: "rec-001", stepIndex: 1, action: { type: "type" }, parameterBindings: {}, timestamp: "2026-02-25T10:00:01Z" },
        ]),
      });
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      const result = await tool.execute(
        { action: "stop_recording", recordingId: "rec-001" },
        signal(),
      );
      const data = JSON.parse(result.content);
      expect(data.recordingId).toBe("rec-001");
      expect(data.state).toBe("stopped");
      expect(data.stepCount).toBe(2);
      expect(data.stoppedAt).toBeTruthy();
    });
  });

  // ─── check_permissions ───

  describe("check_permissions", () => {
    it("returns permission list", async () => {
      const sm = createMockSessionManager({
        checkPermissions: vi.fn().mockResolvedValue([
          mockPermission(),
          mockPermission({ permissionType: "screen_recording", status: "denied" }),
        ]),
      });
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      const result = await tool.execute({ action: "check_permissions" }, signal());
      const data = JSON.parse(result.content);
      expect(data.permissions).toHaveLength(2);
      expect(data.permissions[0].type).toBe("accessibility");
      expect(data.permissions[0].status).toBe("granted");
      expect(data.permissions[1].status).toBe("denied");
    });
  });

  // ─── error handling ───

  describe("error handling", () => {
    it("catches thrown errors and returns errorResult", async () => {
      const sm = createMockSessionManager({
        executeAction: vi.fn().mockRejectedValue(new Error("Adapter crashed")),
      });
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      const result = await tool.execute(
        { action: "execute", actionType: "click", x: 10, y: 20 },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Adapter crashed");
    });

    it("detects abort errors", async () => {
      const sm = createMockSessionManager({
        executeAction: vi.fn().mockRejectedValue(new Error("The operation was aborted")),
      });
      const tool = createFridayAgentDesktopTool({ desktopSessionManager: sm });
      const result = await tool.execute(
        { action: "execute", actionType: "click", x: 10, y: 20 },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("aborted");
    });
  });

  // ─── tool registry wiring ───

  describe("tool registry wiring", () => {
    it("registers desktop tool when desktopSessionManager is provided", async () => {
      const { createFridayAgentToolRegistry } = await import(
        "../../../../src/agent/tools/friday-agent-tool-registry.js"
      );
      const sm = createMockSessionManager();
      const tools = createFridayAgentToolRegistry({ desktopSessionManager: sm });
      const desktopTool = tools.find((t: { name: string }) => t.name === "desktop");
      expect(desktopTool).toBeDefined();
      expect(desktopTool!.name).toBe("desktop");
    });

    it("does not register desktop tool when desktopSessionManager is absent", async () => {
      const { createFridayAgentToolRegistry } = await import(
        "../../../../src/agent/tools/friday-agent-tool-registry.js"
      );
      const tools = createFridayAgentToolRegistry({});
      const desktopTool = tools.find((t: { name: string }) => t.name === "desktop");
      expect(desktopTool).toBeUndefined();
    });
  });
});

// ─── Skill Desktop Helper ───

describe("createFridaySkillDesktopHelper", () => {
  it("creates a helper with all expected methods", async () => {
    const { createFridaySkillDesktopHelper } = await import(
      "../../../../src/skills/executor/friday-skill-desktop-helper.js"
    );
    const sm = createMockSessionManager();
    const helper = createFridaySkillDesktopHelper({ desktopSessionManager: sm });

    expect(typeof helper.executeAction).toBe("function");
    expect(typeof helper.inspectElement).toBe("function");
    expect(typeof helper.searchElements).toBe("function");
    expect(typeof helper.checkPermissions).toBe("function");
    expect(typeof helper.getActionLog).toBe("function");
    expect(typeof helper.isConnected).toBe("function");
  });

  it("delegates executeAction to session manager", async () => {
    const { createFridaySkillDesktopHelper } = await import(
      "../../../../src/skills/executor/friday-skill-desktop-helper.js"
    );
    const sm = createMockSessionManager();
    const helper = createFridaySkillDesktopHelper({ desktopSessionManager: sm });

    const action: FridayDesktopAction = { type: "screenshot" };
    await helper.executeAction(action);
    expect(sm.executeAction).toHaveBeenCalledWith(action);
  });

  it("delegates inspectElement to session manager", async () => {
    const { createFridaySkillDesktopHelper } = await import(
      "../../../../src/skills/executor/friday-skill-desktop-helper.js"
    );
    const sm = createMockSessionManager();
    const helper = createFridaySkillDesktopHelper({ desktopSessionManager: sm });

    const selector = { strategy: "accessibility_id" as const, value: "btn" };
    await helper.inspectElement(selector);
    expect(sm.inspectElement).toHaveBeenCalledWith(selector);
  });

  it("delegates searchElements to session manager", async () => {
    const { createFridaySkillDesktopHelper } = await import(
      "../../../../src/skills/executor/friday-skill-desktop-helper.js"
    );
    const sm = createMockSessionManager();
    const helper = createFridaySkillDesktopHelper({ desktopSessionManager: sm });

    await helper.searchElements("OK", "com.example.app");
    expect(sm.searchElements).toHaveBeenCalledWith("OK", "com.example.app");
  });

  it("throws when session is not connected", async () => {
    const { createFridaySkillDesktopHelper } = await import(
      "../../../../src/skills/executor/friday-skill-desktop-helper.js"
    );
    const sm = createMockSessionManager({ isConnected: vi.fn().mockReturnValue(false) });
    const helper = createFridaySkillDesktopHelper({ desktopSessionManager: sm });

    await expect(helper.executeAction({ type: "screenshot" })).rejects.toThrow("not connected");
    await expect(helper.inspectElement({ strategy: "accessibility_id", value: "x" })).rejects.toThrow("not connected");
    await expect(helper.searchElements("x")).rejects.toThrow("not connected");
    await expect(helper.checkPermissions()).rejects.toThrow("not connected");
  });

  it("returns action log without connection check", async () => {
    const { createFridaySkillDesktopHelper } = await import(
      "../../../../src/skills/executor/friday-skill-desktop-helper.js"
    );
    const sm = createMockSessionManager({
      isConnected: vi.fn().mockReturnValue(false),
      getActionLog: vi.fn().mockReturnValue([mockActionResult()]),
    });
    const helper = createFridaySkillDesktopHelper({ desktopSessionManager: sm });

    const log = helper.getActionLog();
    expect(log).toHaveLength(1);
  });

  it("reports connection status", async () => {
    const { createFridaySkillDesktopHelper } = await import(
      "../../../../src/skills/executor/friday-skill-desktop-helper.js"
    );
    const sm = createMockSessionManager();
    const helper = createFridaySkillDesktopHelper({ desktopSessionManager: sm });
    expect(helper.isConnected()).toBe(true);
  });
});
