import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { createActionExecutor } from "../../../../src/desktop/engine/action-executor.js";
import type { ActionExecutor } from "../../../../src/desktop/engine/action-executor.js";
import { createElementInspector } from "../../../../src/desktop/engine/element-inspector.js";
import type { ElementInspector } from "../../../../src/desktop/engine/element-inspector.js";
import { createPermissionGuard } from "../../../../src/desktop/engine/permission-guard.js";
import type { PermissionGuard } from "../../../../src/desktop/engine/permission-guard.js";
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

// ─── Fixtures ───

const NOW = "2026-02-24T12:00:00.000Z";
let idCounter = 0;

function makeConfig() {
  return {
    generateId: () => `id-${++idCounter}`,
    nowIso: () => NOW,
  };
}

function makeSuccessResult(
  action: FridayDesktopAction,
  platform: FridayDesktopAdapter["platform"],
): FridayDesktopActionResult {
  return {
    id: `adapter-result-${++idCounter}`,
    action,
    status: "success",
    platform,
    durationMs: 10,
    startedAt: NOW,
    completedAt: NOW,
  };
}

interface MockAdapterOptions {
  readonly capabilities?: readonly FridayDesktopCapability[];
  readonly permissions?: readonly FridayDesktopPermission[];
  readonly execute?: (action: FridayDesktopAction) => Promise<FridayDesktopActionResult>;
  readonly inspectElement?: (
    selector: FridayDesktopElementSelector,
  ) => Promise<FridayDesktopElement | null>;
}

function makeMockAdapter(options: MockAdapterOptions = {}): FridayDesktopAdapterRuntime {
  const platform = "darwin" as const;
  const capabilities = options.capabilities ?? [
    "click",
    "type",
    "keypress",
    "scroll",
    "drag",
    "screenshot",
    "read_element",
    "launch_app",
    "close_app",
    "clipboard_read",
    "clipboard_write",
    "file_read",
    "file_write",
    "file_move",
    "file_copy",
    "file_delete",
    "file_list",
    "file_stat",
  ];
  const permissions = options.permissions ?? [];

  const metadata: FridayDesktopAdapter = {
    id: "darwin-adapter-v1",
    platform,
    displayName: "macOS Adapter",
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
      if (options.execute) {
        return options.execute(action);
      }
      return makeSuccessResult(action, platform);
    },
    async inspectElement(selector: FridayDesktopElementSelector): Promise<FridayDesktopElement | null> {
      if (options.inspectElement) {
        return options.inspectElement(selector);
      }
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
      return [];
    },
    getCapabilities(): FridayDesktopCapability[] {
      return [...capabilities];
    },
    async checkPermissions(): Promise<FridayDesktopPermission[]> {
      return [...permissions];
    },
  };
}

function makeGuard(): PermissionGuard {
  return createPermissionGuard({
    generateId: () => `id-${++idCounter}`,
    nowIso: () => NOW,
    permissionPromptTimeoutMs: 5000,
    principalId: "user-1",
  });
}

function makeInspector(): ElementInspector {
  return createElementInspector(makeConfig());
}

function makeExecutor(overrides: Partial<Parameters<typeof createActionExecutor>[0]> = {}): ActionExecutor {
  return createActionExecutor({
    ...makeConfig(),
    defaultActionTimeoutMs: 10_000,
    maxConcurrentActions: 1,
    ...overrides,
  });
}

// ─── Tests ───

describe("ActionExecutor", () => {
  let executor: ActionExecutor;
  let adapter: FridayDesktopAdapterRuntime;
  let guard: PermissionGuard;
  let inspector: ElementInspector;

  beforeEach(() => {
    idCounter = 0;
    executor = makeExecutor();
    adapter = makeMockAdapter();
    guard = makeGuard();
    inspector = makeInspector();
  });

  describe("runtime validation", () => {
    it("rejects unknown action types", async () => {
      const result = await executor.execute(
        { type: "invalid_action" } as any,
        adapter,
        guard,
        inspector,
      );

      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("DESKTOP_VALIDATION_FAILED");
    });

    it("rejects clipboard write without content", async () => {
      const result = await executor.execute(
        { type: "clipboard", operation: "write" } as any,
        adapter,
        guard,
        inspector,
      );

      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("DESKTOP_VALIDATION_FAILED");
      expect(result.errorMessage).toContain("content");
    });

    it("rejects file write without content", async () => {
      const result = await executor.execute(
        { type: "file_operation", operation: "write", path: "/safe/test.txt" } as any,
        adapter,
        guard,
        inspector,
      );

      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("DESKTOP_VALIDATION_FAILED");
    });

    it("rejects file move without destinationPath", async () => {
      const result = await executor.execute(
        { type: "file_operation", operation: "move", path: "/safe/a.txt" } as any,
        adapter,
        guard,
        inspector,
      );

      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("DESKTOP_VALIDATION_FAILED");
      expect(result.errorMessage).toContain("destinationPath");
    });

    it("rejects file copy without destinationPath", async () => {
      const result = await executor.execute(
        { type: "file_operation", operation: "copy", path: "/safe/a.txt" } as any,
        adapter,
        guard,
        inspector,
      );

      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("DESKTOP_VALIDATION_FAILED");
      expect(result.errorMessage).toContain("destinationPath");
    });
  });

  describe("sandbox enforcement", () => {
    it("returns sandbox_violation for paths outside allowed roots", async () => {
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), "desktop-sandbox-"));
      try {
        const constrainedExecutor = makeExecutor({ sandboxAllowedRoots: [tempRoot] });
        const result = await constrainedExecutor.execute(
          {
            type: "file_operation",
            operation: "read",
            path: path.join(tempRoot, "..", "outside.txt"),
          },
          adapter,
          guard,
          inspector,
          { actionId: "outside-path" },
        );

        expect(result.status).toBe("sandbox_violation");
        expect(result.errorCode).toBe("DESKTOP_SANDBOX_VIOLATION");
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    });

    it("allows paths inside configured sandbox roots", async () => {
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), "desktop-sandbox-"));
      try {
        const constrainedExecutor = makeExecutor({ sandboxAllowedRoots: [tempRoot] });
        const result = await constrainedExecutor.execute(
          {
            type: "file_operation",
            operation: "read",
            path: path.join(tempRoot, "inside.txt"),
          },
          adapter,
          guard,
          inspector,
          { actionId: "inside-path" },
        );

        expect(result.status).toBe("success");
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    });

    it("blocks symlink escapes outside the sandbox", async () => {
      if (process.platform === "win32") {
        return;
      }

      const baseDir = await mkdtemp(path.join(os.tmpdir(), "desktop-sandbox-link-"));
      const allowedDir = path.join(baseDir, "allowed");
      const outsideDir = path.join(baseDir, "outside");
      const linkDir = path.join(allowedDir, "linked-outside");

      try {
        await mkdir(allowedDir, { recursive: true });
        await mkdir(outsideDir, { recursive: true });
        await symlink(outsideDir, linkDir, "dir");

        const constrainedExecutor = makeExecutor({ sandboxAllowedRoots: [allowedDir] });
        const result = await constrainedExecutor.execute(
          {
            type: "file_operation",
            operation: "read",
            path: path.join(linkDir, "secret.txt"),
          },
          adapter,
          guard,
          inspector,
          { actionId: "symlink-escape" },
        );

        expect(result.status).toBe("sandbox_violation");
        expect(result.errorCode).toBe("DESKTOP_SANDBOX_VIOLATION");
      } finally {
        await rm(baseDir, { recursive: true, force: true });
      }
    });
  });

  describe("concurrency control", () => {
    it("reserves execution slots before await and enforces hard cap in Promise.all races", async () => {
      let releaseFirstExecution: (() => void) | null = null;
      const firstExecutionGate = new Promise<void>((resolve) => {
        releaseFirstExecution = resolve;
      });

      let executionCallCount = 0;
      const raceAdapter = makeMockAdapter({
        execute: async (action) => {
          executionCallCount += 1;
          if (executionCallCount === 1) {
            await firstExecutionGate;
          }
          return makeSuccessResult(action, "darwin");
        },
      });

      const firstPromise = executor.execute(
        { type: "click" },
        raceAdapter,
        guard,
        inspector,
        { actionId: "race-1" },
      );

      await Promise.resolve();

      const [secondResult, thirdResult] = await Promise.all([
        executor.execute({ type: "click" }, raceAdapter, guard, inspector, { actionId: "race-2" }),
        executor.execute({ type: "click" }, raceAdapter, guard, inspector, { actionId: "race-3" }),
      ]);

      expect(secondResult.errorCode).toBe("DESKTOP_CONCURRENT_LIMIT");
      expect(thirdResult.errorCode).toBe("DESKTOP_CONCURRENT_LIMIT");

      releaseFirstExecution?.();
      const firstResult = await firstPromise;
      expect(firstResult.status).toBe("success");
    });
  });

  describe("cancellation", () => {
    it("cancels a real in-flight action by caller-provided action ID", async () => {
      const hangingAdapter = makeMockAdapter({
        execute: async () =>
          new Promise<FridayDesktopActionResult>(() => {
            // Keep pending; cancellation should interrupt via AbortSignal race.
          }),
      });

      const executionPromise = executor.execute(
        { type: "click" },
        hangingAdapter,
        guard,
        inspector,
        { actionId: "cancel-me", timeoutMs: 30_000 },
      );

      await Promise.resolve();
      expect(executor.cancel("cancel-me")).toBe(true);

      const result = await executionPromise;
      expect(result.status).toBe("cancelled");
      expect(result.errorCode).toBe("DESKTOP_ACTION_CANCELLED");
      expect(executor.cancel("cancel-me")).toBe(false);
    });

    it("returns false for unknown action IDs", () => {
      expect(executor.cancel("missing-action")).toBe(false);
    });
  });

  describe("pre-execution failure logging", () => {
    it("logs failures when permission check throws", async () => {
      const throwingGuard: PermissionGuard = {
        async check(): Promise<any> {
          throw new Error("permission check exploded");
        },
        loadPolicies(): void {},
        getPolicies(): readonly any[] {
          return [];
        },
        recordDecision(): void {},
        getDecisions(): readonly any[] {
          return [];
        },
      };

      const result = await executor.execute(
        { type: "click" },
        adapter,
        throwingGuard,
        inspector,
        { actionId: "perm-throw" },
      );

      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("DESKTOP_ACTION_FAILED");
      expect(executor.getActionLog()).toHaveLength(1);
      expect(executor.getActionLog()[0].id).toBe("perm-throw");
    });

    it("logs failures when element inspection throws", async () => {
      const throwingInspector: ElementInspector = {
        async inspect(): Promise<any> {
          throw new Error("inspect exploded");
        },
        async search(): Promise<readonly FridayDesktopElement[]> {
          return [];
        },
        async resolve(): Promise<FridayDesktopElement | null> {
          return null;
        },
      };

      const result = await executor.execute(
        { type: "click", selector: { strategy: "accessibility_id", value: "btn-1" } },
        adapter,
        guard,
        throwingInspector,
        { actionId: "inspect-throw" },
      );

      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("DESKTOP_ACTION_FAILED");
      expect(executor.getActionLog()).toHaveLength(1);
      expect(executor.getActionLog()[0].id).toBe("inspect-throw");
    });
  });

  describe("action log snapshots", () => {
    it("returns deep-cloned frozen logs that cannot mutate internal state", async () => {
      await executor.execute(
        { type: "click" },
        adapter,
        guard,
        inspector,
        { actionId: "immutable-log" },
      );

      const logSnapshot = executor.getActionLog() as FridayDesktopActionResult[] & {
        push: (...args: FridayDesktopActionResult[]) => number;
      };

      expect(Object.isFrozen(logSnapshot)).toBe(true);
      expect(Object.isFrozen(logSnapshot[0])).toBe(true);
      expect(Object.isFrozen(logSnapshot[0].action)).toBe(true);
      expect(() => {
        logSnapshot.push(makeSuccessResult({ type: "click" }, "darwin"));
      }).toThrow();

      const freshSnapshot = executor.getActionLog();
      expect(freshSnapshot).toHaveLength(1);
      expect(freshSnapshot[0].action.type).toBe("click");
    });
  });
});
