import { describe, it, expect } from "vitest";

import { FridayDomainError } from "#errors";
import { createDesktopSessionManager } from "../../../../src/desktop/engine/session-manager.js";
import type {
  DesktopSessionManager,
  SessionManagerConfig,
} from "../../../../src/desktop/engine/session-manager.js";
import type {
  FridayDesktopAction,
  FridayDesktopActionResult,
  FridayDesktopAdapter,
  FridayDesktopAdapterRuntime,
  FridayDesktopCapability,
  FridayDesktopElement,
  FridayDesktopElementSelector,
  FridayDesktopPermission,
} from "../../../../src/desktop/model/friday-desktop.types.js";

/**
 * TS Runtime Retirement — METHOD-level fail-closed guard for the desktop
 * RECORDING lifecycle + replay (route-only-guard defect fix, A3 HOLE 1).
 *
 * The desktop recording lifecycle was ROUTE-only-retired (friday-desktop-routes
 * fail-closes desktop.recordings.start/.stop/.pause/.resume/.list/.get/.steps/
 * .replay/.delete via throwRetiredDesktopRecording before the route calls the
 * service). The session-manager recording methods themselves —
 * `startRecording` / `stopRecording` / `pauseRecording` / `resumeRecording` /
 * `deleteRecording` / `replayRecording` (the latter re-drives the OS actuator to
 * replay recorded steps) — had NO method guard, so the off-route caller (the
 * agent desktop tool: start_recording → startRecording, stop_recording →
 * stopRecording) reaches them directly, bypassing the route fence. This is a
 * SEPARATE retired family (TS_RUNTIME_DESKTOP_RECORDING_RETIRED, flag
 * allowTestOnlyDesktopRecordingExecution) from the action actuator.
 *
 * These tests prove the guard now lives on the METHOD:
 *   - default/live config (flag unset) fails closed with 503 fail_closed;
 *   - the guard fires BEFORE ensureConnected / getRecordingEngine / any
 *     side-effect (no recording is ever started, even on a connected session);
 *   - with the explicit test-oracle flag enabled the legacy path proceeds;
 *   - read-shaped getters stay live (separation from the mutating lifecycle).
 */

const NOW = "2026-06-12T00:00:00.000Z";
const RETIRED_CODE = "TS_RUNTIME_DESKTOP_RECORDING_RETIRED";

function makeSpyAdapter(): { adapter: FridayDesktopAdapterRuntime } {
  const capabilities: FridayDesktopCapability[] = [
    "click", "type", "keypress", "scroll", "drag", "screenshot", "read_element",
  ];
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
  const adapter: FridayDesktopAdapterRuntime = {
    metadata,
    async execute(action: FridayDesktopAction): Promise<FridayDesktopActionResult> {
      return {
        id: "result-1",
        action,
        status: "success",
        platform,
        durationMs: 1,
        startedAt: NOW,
        completedAt: NOW,
      };
    },
    async inspectElement(_selector: FridayDesktopElementSelector): Promise<FridayDesktopElement | null> {
      return null;
    },
    async searchElements(): Promise<FridayDesktopElement[]> {
      return [];
    },
    getCapabilities(): FridayDesktopCapability[] { return [...capabilities]; },
    async checkPermissions(): Promise<FridayDesktopPermission[]> { return []; },
  };
  return { adapter };
}

let idCounter = 0;

function buildSession(
  flags?: Pick<SessionManagerConfig, "allowTestOnlyDesktopRecordingExecution">,
): DesktopSessionManager {
  const { adapter } = makeSpyAdapter();
  const config: SessionManagerConfig = {
    generateId: () => `id-${++idCounter}`,
    nowIso: () => NOW,
    principalId: "user-1",
    ...(flags ?? {}),
  };
  const session = createDesktopSessionManager(config);
  // Connect + register a working adapter so the ONLY thing that can stop the
  // recording lifecycle is the method-head retirement guard.
  session.connect();
  session.registerAdapter(adapter);
  return session;
}

function expectRetired(caught: unknown): void {
  expect(caught).toBeInstanceOf(FridayDomainError);
  expect(caught).toMatchObject({ code: RETIRED_CODE, httpStatus: 503 });
  expect((caught as FridayDomainError).details).toMatchObject({ classification: "fail_closed" });
}

describe("DesktopSessionManager TS-retirement method guard (recording lifecycle + replay)", () => {
  it("startRecording fails closed by default (503) BEFORE any recording is started", () => {
    const session = buildSession();
    let caught: unknown;
    try {
      session.startRecording({ name: "agent recording" });
    } catch (error) {
      caught = error;
    }
    expectRetired(caught);
    // No recording was created: guard-before-side-effect proven (read stays live).
    expect(session.listRecordings()).toHaveLength(0);
  });

  it("stopRecording fails closed by default (503)", () => {
    const session = buildSession();
    let caught: unknown;
    try {
      session.stopRecording("any-recording-id");
    } catch (error) {
      caught = error;
    }
    expectRetired(caught);
  });

  it("pauseRecording fails closed by default (503)", () => {
    const session = buildSession();
    let caught: unknown;
    try {
      session.pauseRecording("any-recording-id");
    } catch (error) {
      caught = error;
    }
    expectRetired(caught);
  });

  it("resumeRecording fails closed by default (503)", () => {
    const session = buildSession();
    let caught: unknown;
    try {
      session.resumeRecording("any-recording-id");
    } catch (error) {
      caught = error;
    }
    expectRetired(caught);
  });

  it("deleteRecording fails closed by default (503)", () => {
    const session = buildSession();
    let caught: unknown;
    try {
      session.deleteRecording("any-recording-id");
    } catch (error) {
      caught = error;
    }
    expectRetired(caught);
  });

  it("replayRecording fails closed by default (503) BEFORE re-driving the OS actuator", async () => {
    const session = buildSession();
    let caught: unknown;
    try {
      await session.replayRecording("any-recording-id");
    } catch (error) {
      caught = error;
    }
    expectRetired(caught);
  });

  it("with the test-oracle flag set, the intended-live recording lifecycle proceeds", () => {
    const session = buildSession({ allowTestOnlyDesktopRecordingExecution: true });
    const recording = session.startRecording({ name: "live recording" });
    expect(recording.state).toBe("recording");
    expect(session.listRecordings()).toHaveLength(1);
    const stopped = session.stopRecording(recording.id);
    expect(stopped.state).toBe("stopped");
    expect(session.deleteRecording(recording.id)).toBe(true);
  });
});
