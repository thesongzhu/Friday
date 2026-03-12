import { describe, it, expect, beforeEach } from "vitest";
import { createDesktopSessionManager } from "../../../../src/desktop/engine/session-manager.js";
import type { DesktopSessionManager } from "../../../../src/desktop/engine/session-manager.js";
import type {
  FridayDesktopAction,
  FridayDesktopActionResult,
  FridayDesktopAdapter,
  FridayDesktopAdapterRuntime,
  FridayDesktopCapability,
  FridayDesktopElement,
  FridayDesktopElementSelector,
  FridayDesktopPermission,
  FridayDesktopPolicy,
} from "../../../../src/desktop/model/friday-desktop.types.js";

// ─── Fixtures ───

const NOW = "2026-02-24T12:00:00.000Z";
let idCounter = 0;

function makeConfig() {
  return {
    generateId: () => `id-${++idCounter}`,
    nowIso: () => NOW,
    principalId: "user-1",
  };
}

function makeMockAdapter(
  capabilities: FridayDesktopCapability[] = [
    "click", "type", "keypress", "scroll", "drag", "screenshot",
    "read_element", "launch_app", "close_app", "clipboard_read", "clipboard_write",
    "file_read", "file_write", "file_move", "file_copy", "file_delete", "file_list", "file_stat",
  ],
): FridayDesktopAdapterRuntime {
  const platform = process.platform as "darwin" | "win32" | "linux";
  const metadata: FridayDesktopAdapter = {
    id: `${platform}-adapter-v1`,
    platform,
    displayName: `${platform} Adapter`,
    version: "1.0.0",
    capabilities,
    supportedOsVersions: ">=14.0",
    detectedOsVersion: "15.0",
    healthy: true,
    statusMessage: "Ready",
    initializedAt: NOW,
  };
  return {
    metadata,
    async execute(action: FridayDesktopAction): Promise<FridayDesktopActionResult> {
      return {
        id: `result-${++idCounter}`,
        action,
        status: "success",
        platform,
        durationMs: 10,
        startedAt: NOW,
        completedAt: NOW,
      };
    },
    async inspectElement(selector: FridayDesktopElementSelector): Promise<FridayDesktopElement | null> {
      return {
        elementId: "el-1",
        role: "button",
        name: "Test",
        enabled: true,
        focused: false,
        visible: true,
        bounds: { x: 0, y: 0, width: 100, height: 30 },
        appBundleId: selector.appBundleId ?? "com.test",
        displayIndex: 0,
        childCount: 0,
        platformAttributes: {},
      };
    },
    async searchElements(): Promise<FridayDesktopElement[]> {
      return [{
        elementId: "el-2",
        role: "textField",
        name: "Search",
        enabled: true,
        focused: false,
        visible: true,
        bounds: { x: 10, y: 10, width: 200, height: 25 },
        appBundleId: "com.test",
        displayIndex: 0,
        childCount: 0,
        platformAttributes: {},
      }];
    },
    getCapabilities(): FridayDesktopCapability[] { return [...capabilities]; },
    async checkPermissions(): Promise<FridayDesktopPermission[]> { return []; },
  };
}

// ─── Tests ───

describe("DesktopSessionManager", () => {
  let session: DesktopSessionManager;

  beforeEach(() => {
    idCounter = 0;
    session = createDesktopSessionManager(makeConfig());
  });

  describe("connect / disconnect", () => {
    it("starts disconnected", () => {
      expect(session.isConnected()).toBe(false);
      expect(session.getSessionInfo().state).toBe("disconnected");
    });

    it("connects successfully", () => {
      const info = session.connect();

      expect(info.state).toBe("connected");
      expect(info.principalId).toBe("user-1");
      expect(info.connectedAt).toBe(NOW);
      expect(session.isConnected()).toBe(true);
    });

    it("is idempotent when already connected", () => {
      session.connect();
      const info = session.connect();

      expect(info.state).toBe("connected");
    });

    it("disconnects successfully", () => {
      session.connect();
      const info = session.disconnect();

      expect(info.state).toBe("disconnected");
      expect(info.connectedAt).toBeNull();
      expect(session.isConnected()).toBe(false);
    });

    it("is idempotent when already disconnected", () => {
      const info = session.disconnect();
      expect(info.state).toBe("disconnected");
    });
  });

  describe("action execution", () => {
    it("throws when not connected", async () => {
      await expect(
        session.executeAction({ type: "click" }),
      ).rejects.toThrow("not connected");
    });

    it("executes action when connected with registered adapter", async () => {
      session.connect();
      session.registerAdapter(makeMockAdapter());

      const result = await session.executeAction({ type: "click" });
      expect(result.status).toBe("success");
    });

    it("records actions in the log", async () => {
      session.connect();
      session.registerAdapter(makeMockAdapter());

      await session.executeAction({ type: "click" });
      await session.executeAction({ type: "type", text: "hi" });

      expect(session.getActionLog()).toHaveLength(2);
    });
  });

  describe("element inspection", () => {
    it("throws when not connected", async () => {
      await expect(
        session.inspectElement({ strategy: "accessibility_id", value: "btn" }),
      ).rejects.toThrow("not connected");
    });

    it("inspects element when connected", async () => {
      session.connect();
      session.registerAdapter(makeMockAdapter());

      const el = await session.inspectElement(
        { strategy: "accessibility_id", value: "btn" },
      );
      expect(el).not.toBeNull();
      expect(el!.role).toBe("button");
    });

    it("searches elements", async () => {
      session.connect();
      session.registerAdapter(makeMockAdapter());

      const results = await session.searchElements("Search");
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe("permissions", () => {
    it("checks OS permissions", async () => {
      session.connect();
      session.registerAdapter(makeMockAdapter());

      const perms = await session.checkPermissions();
      expect(Array.isArray(perms)).toBe(true);
    });

    it("loads policies", () => {
      const policy: FridayDesktopPolicy = {
        id: "p-1",
        name: "Test",
        enabled: true,
        priority: 1,
        rules: [],
        createdBy: "admin",
        etag: "e-1",
        createdAt: NOW,
        updatedAt: NOW,
      };

      // Should not throw
      session.loadPolicies([policy]);
    });
  });

  describe("recording integration", () => {
    it("starts and stops a recording", () => {
      session.connect();
      session.registerAdapter(makeMockAdapter());

      const rec = session.startRecording({ name: "Test Rec" });
      expect(rec.state).toBe("recording");

      const stopped = session.stopRecording(rec.id);
      expect(stopped.state).toBe("stopped");
    });

    it("rejects starting a second active recording", () => {
      session.connect();
      session.registerAdapter(makeMockAdapter());

      session.startRecording({ name: "Active 1" });
      expect(() => session.startRecording({ name: "Active 2" })).toThrow(
        "already active",
      );
    });

    it("captures actions into the active recording", async () => {
      session.connect();
      session.registerAdapter(makeMockAdapter());

      const rec = session.startRecording({ name: "Capture Test" });
      await session.executeAction({ type: "click" });
      await session.executeAction({ type: "type", text: "hello" });

      const steps = session.getRecordingSteps(rec.id);
      expect(steps).toHaveLength(2);
      expect(steps[0].action.type).toBe("click");
      expect(steps[1].action.type).toBe("type");
    });

    it("pauses and resumes recording", () => {
      session.connect();
      session.registerAdapter(makeMockAdapter());

      const rec = session.startRecording({ name: "P/R Test" });
      const paused = session.pauseRecording(rec.id);
      expect(paused.state).toBe("paused");

      const resumed = session.resumeRecording(rec.id);
      expect(resumed.state).toBe("recording");
    });

    it("does not capture steps when recording is paused", async () => {
      session.connect();
      session.registerAdapter(makeMockAdapter());

      const rec = session.startRecording({ name: "Paused Capture" });
      await session.executeAction({ type: "click" }); // captured
      session.pauseRecording(rec.id);
      await session.executeAction({ type: "type", text: "not captured" }); // not captured

      const steps = session.getRecordingSteps(rec.id);
      expect(steps).toHaveLength(1);
    });

    it("stops active recording on disconnect", () => {
      session.connect();
      session.registerAdapter(makeMockAdapter());

      const rec = session.startRecording({ name: "Auto-stop" });
      session.disconnect();

      const updated = session.getRecording(rec.id)!;
      expect(updated.state).toBe("stopped");
    });

    it("stops paused recordings on disconnect", () => {
      session.connect();
      session.registerAdapter(makeMockAdapter());

      const rec = session.startRecording({ name: "Paused Auto-stop" });
      session.pauseRecording(rec.id);
      session.disconnect();

      const updated = session.getRecording(rec.id)!;
      expect(updated.state).toBe("stopped");
    });

    it("lists and deletes recordings", () => {
      session.connect();
      session.registerAdapter(makeMockAdapter());

      const r1 = session.startRecording({ name: "R1" });
      session.stopRecording(r1.id);
      const r2 = session.startRecording({ name: "R2" });
      session.stopRecording(r2.id);

      expect(session.listRecordings()).toHaveLength(2);

      const recs = session.listRecordings();
      session.deleteRecording(recs[0].id);
      expect(session.listRecordings()).toHaveLength(1);
    });

    it("replays a stopped recording", async () => {
      session.connect();
      session.registerAdapter(makeMockAdapter());

      const rec = session.startRecording({ name: "Replay Test" });
      await session.executeAction({ type: "click" });
      session.stopRecording(rec.id);

      const result = await session.replayRecording(rec.id);
      expect(result.allSucceeded).toBe(true);
      expect(result.successCount).toBe(1);
    });
  });

  describe("adapter management", () => {
    it("exposes the adapter manager", () => {
      const mgr = session.getAdapterManager();
      expect(mgr).toBeDefined();
      expect(mgr.listAdapters()).toEqual([]);
    });
  });

  describe("cancel action", () => {
    it("delegates to action executor", () => {
      expect(session.cancelAction("action-1")).toBe(false);
    });
  });
});
