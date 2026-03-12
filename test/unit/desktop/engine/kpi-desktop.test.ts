import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, it, expect, beforeEach } from "vitest";

import { createActionExecutor } from "../../../../src/desktop/engine/action-executor.js";
import { createElementInspector } from "../../../../src/desktop/engine/element-inspector.js";
import { createPermissionGuard } from "../../../../src/desktop/engine/permission-guard.js";
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

const NOW = "2026-02-24T12:00:00.000Z";
let idCounter = 0;

function makeConfig() {
  return {
    generateId: () => `id-${++idCounter}`,
    nowIso: () => NOW,
  };
}

function makeMockAdapter(
  capabilities: readonly FridayDesktopCapability[] = [
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
  ],
  permissions: readonly FridayDesktopPermission[] = [],
): FridayDesktopAdapterRuntime {
  const metadata: FridayDesktopAdapter = {
    id: "darwin-adapter-v1",
    platform: "darwin",
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
      return {
        id: `result-${++idCounter}`,
        action,
        status: "success",
        platform: "darwin",
        durationMs: 5,
        startedAt: NOW,
        completedAt: NOW,
      };
    },
    async inspectElement(selector: FridayDesktopElementSelector): Promise<FridayDesktopElement | null> {
      return {
        elementId: "el-1",
        role: "button",
        name: "KPI Element",
        enabled: true,
        focused: false,
        visible: true,
        bounds: { x: 0, y: 0, width: 100, height: 30 },
        appBundleId: selector.appBundleId ?? "com.supported.app",
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

describe("Desktop KPI mapping", () => {
  beforeEach(() => {
    idCounter = 0;
  });

  it("KPI: desktop action success rate stays above 95% for supported app actions", async () => {
    const executor = createActionExecutor({
      ...makeConfig(),
      defaultActionTimeoutMs: 10_000,
      maxConcurrentActions: 1,
    });
    const guard = createPermissionGuard({
      ...makeConfig(),
      permissionPromptTimeoutMs: 5000,
      principalId: "kpi-user",
    });
    const inspector = createElementInspector(makeConfig());
    const adapter = makeMockAdapter();

    const totalActions = 100;
    let successCount = 0;

    for (let i = 0; i < totalActions; i += 1) {
      const result = await executor.execute(
        {
          type: "click",
          selector: {
            strategy: "accessibility_id",
            value: `supported-btn-${i}`,
            appBundleId: "com.supported.app",
          },
        },
        adapter,
        guard,
        inspector,
        { actionId: `kpi-success-${i}` },
      );

      if (result.status === "success") {
        successCount += 1;
      }
    }

    const successRate = successCount / totalActions;
    expect(successRate).toBeGreaterThan(0.95);
  });

  it("KPI: unsafe desktop actions are blocked at a 100% rate", async () => {
    const allowedRoot = await mkdtemp(path.join(os.tmpdir(), "desktop-kpi-safe-"));
    try {
      const executor = createActionExecutor({
        ...makeConfig(),
        defaultActionTimeoutMs: 10_000,
        maxConcurrentActions: 10,
        sandboxAllowedRoots: [allowedRoot],
      });
      const guard = createPermissionGuard({
        ...makeConfig(),
        permissionPromptTimeoutMs: 5000,
        principalId: "kpi-user",
      });
      const inspector = createElementInspector(makeConfig());
      const adapter = makeMockAdapter();

      const unsafeActions: FridayDesktopAction[] = [
        {
          type: "file_operation",
          operation: "read",
          path: path.join(allowedRoot, "..", "outside-a.txt"),
        },
        {
          type: "file_operation",
          operation: "write",
          path: path.join(allowedRoot, "..", "outside-b.txt"),
          content: "unsafe",
        },
        {
          type: "file_operation",
          operation: "delete",
          path: path.join(allowedRoot, "..", "outside-c.txt"),
        },
      ];

      const results = await Promise.all(
        unsafeActions.map((action, index) =>
          executor.execute(action, adapter, guard, inspector, {
            actionId: `kpi-unsafe-${index}`,
          })),
      );

      const blockedCount = results.filter((result) => result.status === "sandbox_violation").length;
      expect(blockedCount).toBe(unsafeActions.length);
    } finally {
      await rm(allowedRoot, { recursive: true, force: true });
    }
  });

  it("KPI: human-confirm overrides are logged at a 100% rate", async () => {
    const executor = createActionExecutor({
      ...makeConfig(),
      defaultActionTimeoutMs: 10_000,
      maxConcurrentActions: 20,
    });
    const guard = createPermissionGuard({
      ...makeConfig(),
      permissionPromptTimeoutMs: 5000,
      principalId: "kpi-user",
      promptResolver: async () => ({
        decision: "approved",
        rationale: "KPI override approval",
      }),
    });
    const inspector = createElementInspector(makeConfig());
    const adapter = makeMockAdapter();

    const policy: FridayDesktopPolicy = {
      id: "critical-policy",
      name: "Critical click confirmation",
      enabled: true,
      priority: 100,
      rules: [
        {
          id: "critical-click-rule",
          policyId: "critical-policy",
          actionType: "click",
          appFilter: "*",
          riskLevel: "critical",
          decision: "allow",
          engineDelegate: false,
          priority: 0,
          createdAt: NOW,
        },
      ],
      createdBy: "admin",
      etag: "etag-1",
      createdAt: NOW,
      updatedAt: NOW,
    };
    guard.loadPolicies([policy]);

    const totalActions = 20;
    const results = await Promise.all(
      Array.from({ length: totalActions }, (_, index) =>
        executor.execute(
          { type: "click" },
          adapter,
          guard,
          inspector,
          { actionId: `kpi-confirm-${index}` },
        )),
    );

    const loggedOverrides = results.filter((result) => Boolean(result.permissionDecisionId)).length;
    expect(loggedOverrides).toBe(totalActions);
    expect(guard.getDecisions()).toHaveLength(totalActions);
  });
});
