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
 * TS Runtime Retirement — METHOD-level fail-closed guard for the desktop OS
 * actuator (route-only-guard defect fix).
 *
 * The desktop action surface was ROUTE-only-retired (friday-desktop-routes
 * fail-closes desktop.actions.execute / .cancel / .log before the route calls
 * the service). The session-manager methods themselves —
 * `executeAction` (arbitrary OS-level click/type/keypress/drag/launch_app/
 * close_app/clipboard/file-ops), `cancelAction`, and `getActionLog` — had NO
 * method guard, so off-route callers (agent desktop tool, autonomous engine,
 * skill desktop helper) reach the live OS actuator/audit directly, bypassing
 * the route fence.
 *
 * These tests prove the guard now lives on the METHOD:
 *   - default/live config (flag unset) fails closed with 503 fail_closed;
 *   - the guard fires BEFORE ensureConnected / adapter-lookup / any side-effect
 *     (the adapter's execute() is never reached, even on a connected session);
 *   - with the explicit test-oracle flag enabled the legacy path proceeds.
 */

const NOW = "2026-06-12T00:00:00.000Z";
const RETIRED_CODE = "TS_RUNTIME_DESKTOP_ACTION_EXECUTION_RETIRED";

/** Adapter that records whether its actuator `execute()` was ever reached. */
function makeSpyAdapter(): { adapter: FridayDesktopAdapterRuntime; executeCalls: FridayDesktopAction[] } {
  const executeCalls: FridayDesktopAction[] = [];
  const capabilities: FridayDesktopCapability[] = [
    "click", "type", "keypress", "scroll", "drag", "screenshot",
    "read_element", "launch_app", "close_app", "clipboard_read", "clipboard_write",
    "file_read", "file_write", "file_move", "file_copy", "file_delete", "file_list", "file_stat",
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
      executeCalls.push(action);
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
  return { adapter, executeCalls };
}

let idCounter = 0;

function buildSession(
  flags?: Pick<SessionManagerConfig, "allowTestOnlyDesktopActionExecution">,
): { session: DesktopSessionManager; executeCalls: FridayDesktopAction[] } {
  const { adapter, executeCalls } = makeSpyAdapter();
  const config: SessionManagerConfig = {
    generateId: () => `id-${++idCounter}`,
    nowIso: () => NOW,
    principalId: "user-1",
    ...(flags ?? {}),
  };
  const session = createDesktopSessionManager(config);
  // Connect + register a working adapter so the ONLY thing that can stop the
  // actuator is the method-head retirement guard (not a NOT_INITIALIZED /
  // no-adapter error). This proves the guard fires BEFORE adapter dispatch.
  session.connect();
  session.registerAdapter(adapter);
  return { session, executeCalls };
}

describe("DesktopSessionManager TS-retirement method guard (executeAction / cancelAction / getActionLog)", () => {
  it("executeAction fails closed by default (503) BEFORE the adapter is dispatched — zero OS side-effect", async () => {
    const { session, executeCalls } = buildSession();

    let caught: unknown;
    try {
      await session.executeAction({ type: "click" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FridayDomainError);
    expect(caught).toMatchObject({
      code: RETIRED_CODE,
      httpStatus: 503,
    });
    expect((caught as FridayDomainError).details).toMatchObject({ classification: "fail_closed" });
    // The actuator was NEVER reached: guard-before-side-effect proven.
    expect(executeCalls).toHaveLength(0);
  });

  it("cancelAction fails closed by default (503)", () => {
    const { session } = buildSession();

    let caught: unknown;
    try {
      session.cancelAction("any-action-id");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FridayDomainError);
    expect(caught).toMatchObject({
      code: RETIRED_CODE,
      httpStatus: 503,
    });
    expect((caught as FridayDomainError).details).toMatchObject({ classification: "fail_closed" });
  });

  it("getActionLog fails closed by default (503)", () => {
    const { session } = buildSession();

    let caught: unknown;
    try {
      session.getActionLog();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FridayDomainError);
    expect(caught).toMatchObject({
      code: RETIRED_CODE,
      httpStatus: 503,
    });
  });

  it("with the test-oracle flag set, the intended-live path proceeds (execute, cancel, log)", async () => {
    const { session, executeCalls } = buildSession({ allowTestOnlyDesktopActionExecution: true });

    const result = await session.executeAction({ type: "click" });
    expect(result.status).toBe("success");
    expect(executeCalls).toHaveLength(1);

    // cancel returns a boolean (false for an unknown id), not a throw.
    expect(session.cancelAction("unknown-action-id")).toBe(false);
    // getActionLog reads the one executed action.
    expect(session.getActionLog()).toHaveLength(1);
  });
});
