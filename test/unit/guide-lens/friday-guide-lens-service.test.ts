import { describe, expect, it, vi } from "vitest";
import { createFridayGuideLensService } from "../../../src/guide-lens/index.js";
import type { FridaySystemSnapshot } from "../../../src/system/model/friday-system.types.js";

const nowIso = () => "2026-04-28T09:00:00.000Z";

function idGenerator() {
  let count = 0;
  return () => `id-${++count}`;
}

function systemSnapshot(): FridaySystemSnapshot {
  return {
    capturedAt: nowIso(),
    platform: "darwin",
    workspaceRoot: "/tmp/friday",
    apps: [{
      id: "app:browser",
      name: "Safari",
      bundleId: "com.apple.Safari",
      running: true,
      frontmost: true,
    }],
    windows: [{
      id: "window:1",
      appId: "app:browser",
      title: "Provider setup",
      focused: true,
      bounds: { x: 100, y: 80, width: 900, height: 700 },
    }],
    notifications: [],
    permissions: [],
    mountedRoots: [],
    frontmostAppId: "app:browser",
    frontmostWindowId: "window:1",
    health: {
      status: "healthy",
      safeMode: false,
      desktopConnected: true,
      companionConnected: true,
      reasons: [],
      updatedAt: nowIso(),
    },
    companion: {
      id: "companion",
      platform: "darwin",
      runtimeKind: "swift_app",
      connected: true,
      transport: { mode: "unix_socket", protocol: "jsonrpc-2.0", authenticated: true },
      launchAtLoginEnabled: true,
      panicHotkey: "cmd+shift+escape",
      safeMode: false,
      overlayVisible: false,
      lastHeartbeatAt: nowIso(),
      capabilities: {
        surfaces: {
          launchAtLogin: true,
          menuBar: true,
          overlay: true,
          globalHotkey: true,
          windowInventory: true,
          notificationIntake: true,
          screenCapture: true,
        },
        actions: {
          snapshot: "supported",
          launch_app: "supported",
          focus: "supported",
          open_url: "supported",
          open_project: "supported",
          handoff_to_browser: "supported",
          handoff_to_terminal: "supported",
          arrange_windows: "supported",
          notification_list: "supported",
          read_notification: "supported",
          notification_act: "supported",
          recover_ui: "supported",
        },
      },
      permissions: [],
    },
    controlLease: null,
    approvalsSummary: { total: 0, highRiskAllowed: 0 },
    remoteDevicesSummary: { total: 0, active: 0 },
    remoteSessionsSummary: { total: 0, active: 0 },
  };
}

describe("createFridayGuideLensService", () => {
  it("builds a compact redacted UI map from text and system state", async () => {
    const apiKey = ["sk", "examplevalue1234567890"].join("-");
    const service = createFridayGuideLensService({
      idGenerator: idGenerator(),
      nowIso,
      systemService: { getState: vi.fn().mockResolvedValue(systemSnapshot()) },
    });

    const result = await service.captureSnapshot({
      visibleText: `OpenAI API key: ${apiKey}\nContinue`,
      elements: [{
        id: "continue-button",
        role: "button",
        label: "Continue",
        bounds: { x: 420, y: 560, width: 140, height: 40 },
        source: "accessibility",
        confidence: 0.93,
        interactable: true,
      }],
    });

    expect(result.uiMap.visibleText).toContain("[api_key:redacted]");
    expect(result.uiMap.redactions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "api_key", count: 1 }),
    ]));
    expect(result.uiMap.elements.some((element) => element.id === "continue-button")).toBe(true);
    expect(result.uiMap.parserStats.tokenEstimate).toBeGreaterThan(0);
    expect(result.uiMap.parserStats.tokenEstimate).toBeLessThan(5000);
  });

  it("resolves a target and sends a native blue focus overlay command", async () => {
    const showGuideOverlay = vi.fn().mockResolvedValue({ visible: true, changedAt: nowIso() });
    const service = createFridayGuideLensService({
      idGenerator: idGenerator(),
      nowIso,
      companionBridge: {
        captureSnapshot: vi.fn().mockResolvedValue({ apps: [], windows: [], notifications: [] }),
        showGuideOverlay,
        clearGuideOverlay: vi.fn(),
        setOverlayVisible: vi.fn(),
      },
    });
    const { session } = await service.captureSnapshot({
      elements: [{
        id: "save",
        role: "button",
        label: "Save",
        bounds: { x: 700, y: 610, width: 96, height: 36 },
        source: "accessibility",
        confidence: 0.96,
        interactable: true,
      }],
    });

    const resolution = await service.resolveTarget({
      sessionId: session.id,
      instruction: "Save",
    });

    expect(resolution.status).toBe("resolved");
    expect(resolution.overlay.dimBackground).toBe(false);
    expect(resolution.overlay.focusColor).toBe("blue");
    expect(resolution.overlay.clickThrough).toBe(true);
    expect(showGuideOverlay).toHaveBeenCalledWith(expect.objectContaining({
      mode: "focus_frame",
      targetElementId: "save",
    }));
  });

  it("rejects mutating instructions in Guide Mode", () => {
    const service = createFridayGuideLensService({
      idGenerator: idGenerator(),
      nowIso,
    });

    expect(() => service.assertReadOnlyAction("click the Continue button")).toThrow("only observe and guide");
  });

  it("loads and saves Guide Lens preferences through the UI preference store", () => {
    let persisted: unknown;
    const first = createFridayGuideLensService({
      idGenerator: idGenerator(),
      nowIso,
      preferenceStore: {
        load: () => undefined,
        save: (preferences) => {
          persisted = structuredClone(preferences);
        },
      },
    });

    first.updateAvatar({ kind: "local_image", localPath: "/tmp/alice.png", sizePx: 72 });

    const second = createFridayGuideLensService({
      idGenerator: idGenerator(),
      nowIso,
      preferenceStore: {
        load: () => persisted as never,
        save: (preferences) => {
          persisted = structuredClone(preferences);
        },
      },
    });

    expect(second.getState().preferences.avatar).toEqual(expect.objectContaining({
      kind: "local_image",
      localPath: "/tmp/alice.png",
      sizePx: 72,
    }));
  });

  it("runs optional parser adapters with redacted snapshot input", async () => {
    const parserKey = ["sk", "parsersecretvalue1234567890"].join("-");
    const parse = vi.fn().mockResolvedValue({
      provider: "omniparser",
      used: true,
      latencyMs: 42,
      visibleText: "Authorize",
      elements: [{
        id: "parser-authorize",
        role: "button",
        label: "Authorize",
        bounds: { x: 520, y: 520, width: 128, height: 38 },
        source: "parser",
        confidence: 0.88,
        interactable: true,
      }],
    });
    const service = createFridayGuideLensService({
      idGenerator: idGenerator(),
      nowIso,
      parserAdapter: { parse },
      defaultPreferences: { parserProvider: "omniparser" },
    });

    const result = await service.captureSnapshot({
      visibleText: `API key: ${parserKey}`,
    });

    expect(parse).toHaveBeenCalledWith(expect.objectContaining({
      provider: "omniparser",
      snapshot: expect.objectContaining({
        visibleText: expect.stringContaining("[api_key:redacted]"),
      }),
    }));
    expect(result.uiMap.parserStats).toEqual(expect.objectContaining({
      provider: "omniparser",
      used: true,
      latencyMs: 42,
    }));
    expect(result.uiMap.elements.some((element) => element.id === "parser-authorize")).toBe(true);
  });

  it("minimizes sensitive screen text before optional parser adapters", async () => {
    const parse = vi.fn().mockResolvedValue({
      provider: "omniparser",
      used: true,
      latencyMs: 17,
      visibleText: "Authorize",
      elements: [],
    });
    const service = createFridayGuideLensService({
      idGenerator: idGenerator(),
      nowIso,
      parserAdapter: { parse },
      defaultPreferences: { parserProvider: "omniparser" },
    });

    await service.captureSnapshot({
      visibleText: [
        "Customer: Jane Doe",
        "Email: jane.doe@example.com",
        "Phone: +1 (415) 555-0199",
        "Shipping address: 1 Market St, San Francisco, CA 94105",
        "Order #FR-123456",
        "Project Apollo renewal terms",
        "Internal Q3 roadmap",
        "Authorize",
      ].join("\n"),
      screenshotText: [
        "Account ID: acct_live_123456789 for jane.doe@example.com",
        "Patient: Jane Doe DOB 01/02/1990 MRN A1234567",
        "Full name: Jane Doe",
      ].join("\n"),
      elements: [{
        id: "customer-email",
        role: "text",
        label: "Jane Doe jane.doe@example.com",
        text: "Patient Jane Doe DOB 01/02/1990",
        description: "Ship to 1 Market St, San Francisco, CA 94105",
        source: "accessibility",
        confidence: 0.91,
        interactable: false,
      }],
    });

    const parserSnapshot = parse.mock.calls[0]?.[0].snapshot;
    const serialized = JSON.stringify(parserSnapshot);

    expect(serialized).toContain("[sensitive_text:redacted]");
    expect(serialized).toContain("Authorize");
    expect(serialized).not.toContain("jane.doe@example.com");
    expect(serialized).not.toContain("+1 (415) 555-0199");
    expect(serialized).not.toContain("1 Market St");
    expect(serialized).not.toContain("Jane Doe");
    expect(serialized).not.toContain("FR-123456");
    expect(serialized).not.toContain("Project Apollo");
    expect(serialized).not.toContain("Internal Q3");
    expect(serialized).not.toContain("01/02/1990");
    expect(serialized).not.toContain("A1234567");
    expect(parserSnapshot.elements?.[0]?.metadata).toBeUndefined();
  });

  it("analyzes screenshots and only asks chatbox when intent is unclear", async () => {
    const service = createFridayGuideLensService({
      idGenerator: idGenerator(),
      nowIso,
    });

    const clear = await service.analyzeScreenshot({
      screenshotText: "Screen Recording permission is required in System Settings",
    });
    const unknown = await service.analyzeScreenshot({
      screenshotText: "Dashboard",
    });

    expect(clear.intent).toBe("permission");
    expect(clear.needsChatbox).toBe(false);
    expect(unknown.needsChatbox).toBe(true);
  });
});
