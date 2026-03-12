import { describe, it, expect, beforeEach } from "vitest";
import { createPermissionGuard } from "../../../../src/desktop/engine/permission-guard.js";
import type { PermissionGuard } from "../../../../src/desktop/engine/permission-guard.js";
import type {
  FridayDesktopAction,
  FridayDesktopAdapterRuntime,
  FridayDesktopAdapter,
  FridayDesktopActionResult,
  FridayDesktopCapability,
  FridayDesktopElement,
  FridayDesktopPermission,
  FridayDesktopPolicy,
  FridayDesktopPolicyRule,
} from "../../../../src/desktop/model/friday-desktop.types.js";

// ─── Fixtures ───

const NOW = "2026-02-24T12:00:00.000Z";
let idCounter = 0;

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    generateId: () => `id-${++idCounter}`,
    nowIso: () => NOW,
    permissionPromptTimeoutMs: 5000,
    principalId: "user-1",
    ...overrides,
  };
}

function makeMockAdapter(
  capabilities: FridayDesktopCapability[] = [
    "click",
    "type",
    "screenshot",
    "read_element",
    "scroll",
    "keypress",
    "drag",
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
  permissions: FridayDesktopPermission[] = [],
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
      return { id: "r-1", action, status: "success", platform: "darwin", durationMs: 5, startedAt: NOW, completedAt: NOW };
    },
    async inspectElement(): Promise<FridayDesktopElement | null> { return null; },
    async searchElements(): Promise<FridayDesktopElement[]> { return []; },
    getCapabilities(): FridayDesktopCapability[] { return [...capabilities]; },
    async checkPermissions(): Promise<FridayDesktopPermission[]> { return permissions; },
  };
}

function makePolicy(rules: Partial<FridayDesktopPolicyRule>[]): FridayDesktopPolicy {
  return {
    id: `policy-${++idCounter}`,
    name: "Test Policy",
    enabled: true,
    priority: 10,
    rules: rules.map((r, i) => ({
      id: `rule-${++idCounter}`,
      policyId: "policy-1",
      actionType: r.actionType ?? "click",
      appFilter: r.appFilter ?? "*",
      elementFilter: r.elementFilter,
      riskLevel: r.riskLevel ?? "low",
      decision: r.decision ?? "allow",
      engineDelegate: r.engineDelegate ?? false,
      priority: r.priority ?? i,
      createdAt: NOW,
      ...r,
    })) as FridayDesktopPolicyRule[],
    createdBy: "admin",
    etag: "etag-1",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

// ─── Tests ───

describe("PermissionGuard", () => {
  let guard: PermissionGuard;

  beforeEach(() => {
    idCounter = 0;
    guard = createPermissionGuard(makeConfig());
  });

  describe("OS permission check (Layer 1)", () => {
    it("denies when OS permission is denied", async () => {
      const adapter = makeMockAdapter(["click"], [
        {
          permissionType: "accessibility",
          status: "denied",
          platform: "darwin",
          grantInstructions: "Go to System Settings → Privacy → Accessibility",
          checkedAt: NOW,
        },
      ]);

      const result = await guard.check({ type: "click" }, adapter);

      expect(result.allowed).toBe(false);
      expect(result.denialCode).toBe("DESKTOP_PERMISSION_DENIED_OS");
      expect(result.denialMessage).toContain("System Settings");
    });

    it("allows when OS permission is granted", async () => {
      const adapter = makeMockAdapter(["click"], [
        { permissionType: "accessibility", status: "granted", platform: "darwin", checkedAt: NOW },
      ]);

      const result = await guard.check({ type: "click" }, adapter);
      expect(result.allowed).toBe(true);
    });
  });

  describe("capability check", () => {
    it("denies when adapter lacks required capability", async () => {
      const adapter = makeMockAdapter(["type"]); // no 'click'

      const result = await guard.check({ type: "click" }, adapter);

      expect(result.allowed).toBe(false);
      expect(result.denialCode).toBe("DESKTOP_UNSUPPORTED_CAPABILITY");
    });

    it("enforces clipboard capability per operation", async () => {
      const cases: ReadonlyArray<{
        readonly action: FridayDesktopAction;
        readonly requiredCapability: FridayDesktopCapability;
      }> = [
        {
          action: { type: "clipboard", operation: "read" },
          requiredCapability: "clipboard_read",
        },
        {
          action: { type: "clipboard", operation: "write", content: "hello" },
          requiredCapability: "clipboard_write",
        },
        {
          action: { type: "clipboard", operation: "clear" },
          requiredCapability: "clipboard_write",
        },
      ];

      for (const { action, requiredCapability } of cases) {
        const adapter = makeMockAdapter([requiredCapability === "clipboard_read"
          ? "clipboard_write"
          : "clipboard_read"]);
        const result = await guard.check(action, adapter);
        expect(result.allowed).toBe(false);
        expect(result.denialCode).toBe("DESKTOP_UNSUPPORTED_CAPABILITY");
      }
    });

    it("enforces file_operation capability per operation", async () => {
      const cases: ReadonlyArray<{
        readonly action: FridayDesktopAction;
        readonly requiredCapability: FridayDesktopCapability;
      }> = [
        {
          action: { type: "file_operation", operation: "read", path: "/safe/a.txt" },
          requiredCapability: "file_read",
        },
        {
          action: {
            type: "file_operation",
            operation: "write",
            path: "/safe/a.txt",
            content: "hello",
          },
          requiredCapability: "file_write",
        },
        {
          action: {
            type: "file_operation",
            operation: "move",
            path: "/safe/a.txt",
            destinationPath: "/safe/b.txt",
          },
          requiredCapability: "file_move",
        },
        {
          action: {
            type: "file_operation",
            operation: "copy",
            path: "/safe/a.txt",
            destinationPath: "/safe/b.txt",
          },
          requiredCapability: "file_copy",
        },
        {
          action: { type: "file_operation", operation: "delete", path: "/safe/a.txt" },
          requiredCapability: "file_delete",
        },
        {
          action: { type: "file_operation", operation: "list", path: "/safe" },
          requiredCapability: "file_list",
        },
        {
          action: { type: "file_operation", operation: "stat", path: "/safe/a.txt" },
          requiredCapability: "file_stat",
        },
      ];

      for (const { action, requiredCapability } of cases) {
        const adapter = makeMockAdapter([requiredCapability === "file_read" ? "file_write" : "file_read"]);
        const result = await guard.check(action, adapter);
        expect(result.allowed).toBe(false);
        expect(result.denialCode).toBe("DESKTOP_UNSUPPORTED_CAPABILITY");
      }
    });
  });

  describe("operation-level OS permission mapping", () => {
    it("requires automation permission for clipboard operations", async () => {
      const deniedAutomation: FridayDesktopPermission = {
        permissionType: "automation",
        status: "denied",
        platform: "darwin",
        checkedAt: NOW,
      };

      const actions: FridayDesktopAction[] = [
        { type: "clipboard", operation: "read" },
        { type: "clipboard", operation: "write", content: "x" },
        { type: "clipboard", operation: "clear" },
      ];

      for (const action of actions) {
        const adapter = makeMockAdapter(
          ["clipboard_read", "clipboard_write"],
          [deniedAutomation],
        );
        const result = await guard.check(action, adapter);
        expect(result.allowed).toBe(false);
        expect(result.denialCode).toBe("DESKTOP_PERMISSION_DENIED_OS");
      }
    });

    it("requires file_access permission for all file operations", async () => {
      const deniedFileAccess: FridayDesktopPermission = {
        permissionType: "file_access",
        status: "denied",
        platform: "darwin",
        checkedAt: NOW,
      };

      const actions: FridayDesktopAction[] = [
        { type: "file_operation", operation: "read", path: "/safe/a.txt" },
        { type: "file_operation", operation: "write", path: "/safe/a.txt", content: "x" },
        {
          type: "file_operation",
          operation: "move",
          path: "/safe/a.txt",
          destinationPath: "/safe/b.txt",
        },
        {
          type: "file_operation",
          operation: "copy",
          path: "/safe/a.txt",
          destinationPath: "/safe/b.txt",
        },
        { type: "file_operation", operation: "delete", path: "/safe/a.txt" },
        { type: "file_operation", operation: "list", path: "/safe" },
        { type: "file_operation", operation: "stat", path: "/safe/a.txt" },
      ];

      for (const action of actions) {
        const adapter = makeMockAdapter(
          [
            "file_read",
            "file_write",
            "file_move",
            "file_copy",
            "file_delete",
            "file_list",
            "file_stat",
          ],
          [deniedFileAccess],
        );
        const result = await guard.check(action, adapter);
        expect(result.allowed).toBe(false);
        expect(result.denialCode).toBe("DESKTOP_PERMISSION_DENIED_OS");
      }
    });
  });

  describe("policy evaluation (Layer 2)", () => {
    it("denies when matching policy rule is 'deny'", async () => {
      const adapter = makeMockAdapter();
      const policy = makePolicy([
        { actionType: "close_app", appFilter: "com.apple.finder", decision: "deny", riskLevel: "critical" },
      ]);
      guard.loadPolicies([policy]);

      const action: FridayDesktopAction = {
        type: "close_app",
        appIdentifier: "com.apple.finder",
      };
      const result = await guard.check(action, adapter);

      expect(result.allowed).toBe(false);
      expect(result.denialCode).toBe("DESKTOP_PERMISSION_DENIED_POLICY");
      expect(result.policyDecision).toBe("deny");
    });

    it("allows when matching policy rule is 'allow'", async () => {
      const adapter = makeMockAdapter();
      const policy = makePolicy([
        { actionType: "click", appFilter: "*", decision: "allow", riskLevel: "low" },
      ]);
      guard.loadPolicies([policy]);

      const result = await guard.check({ type: "click" }, adapter);
      expect(result.allowed).toBe(true);
      expect(result.riskLevel).toBe("low");
    });

    it("uses higher priority rules first", async () => {
      const adapter = makeMockAdapter();
      const policy = makePolicy([
        { actionType: "click", appFilter: "*", decision: "allow", riskLevel: "low", priority: 1 },
        { actionType: "click", appFilter: "*", decision: "deny", riskLevel: "high", priority: 10 },
      ]);
      guard.loadPolicies([policy]);

      const result = await guard.check({ type: "click" }, adapter);
      expect(result.allowed).toBe(false); // higher priority deny wins
    });

    it("returns default risk level when no policy matches", async () => {
      const adapter = makeMockAdapter();

      const result = await guard.check({ type: "scroll", direction: "down" }, adapter);
      expect(result.allowed).toBe(true);
      expect(result.riskLevel).toBe("none");
    });
  });

  describe("human confirmation (Layer 3)", () => {
    it("denies critical-risk actions when no prompt resolver is set", async () => {
      const adapter = makeMockAdapter();
      const policy = makePolicy([
        { actionType: "click", appFilter: "*", decision: "allow", riskLevel: "critical" },
      ]);
      guard.loadPolicies([policy]);

      const result = await guard.check({ type: "click" }, adapter);
      expect(result.allowed).toBe(false);
      expect(result.denialCode).toBe("DESKTOP_PERMISSION_DENIED_USER");
      expect(result.prompt).toBeDefined();
    });

    it("allows critical-risk actions when prompt resolver approves", async () => {
      const guardWithResolver = createPermissionGuard(makeConfig({
        promptResolver: async () => ({ decision: "approved" as const, rationale: "Looks safe" }),
      }));
      const adapter = makeMockAdapter();
      const policy = makePolicy([
        { actionType: "click", appFilter: "*", decision: "allow", riskLevel: "critical" },
      ]);
      guardWithResolver.loadPolicies([policy]);

      const result = await guardWithResolver.check({ type: "click" }, adapter);
      expect(result.allowed).toBe(true);
      expect(result.decision).toBeDefined();
      expect(result.decision!.decision).toBe("approved");
    });

    it("denies critical-risk actions when prompt resolver denies", async () => {
      const guardWithResolver = createPermissionGuard(makeConfig({
        promptResolver: async () => ({ decision: "denied" as const, rationale: "Too risky" }),
      }));
      const adapter = makeMockAdapter();
      const policy = makePolicy([
        { actionType: "click", appFilter: "*", decision: "allow", riskLevel: "critical" },
      ]);
      guardWithResolver.loadPolicies([policy]);

      const result = await guardWithResolver.check({ type: "click" }, adapter);
      expect(result.allowed).toBe(false);
      expect(result.denialCode).toBe("DESKTOP_PERMISSION_DENIED_USER");
    });

    it("records timeout when prompt resolver returns null", async () => {
      const guardWithResolver = createPermissionGuard(makeConfig({
        promptResolver: async () => null,
      }));
      const adapter = makeMockAdapter();
      const policy = makePolicy([
        { actionType: "click", appFilter: "*", decision: "allow", riskLevel: "critical" },
      ]);
      guardWithResolver.loadPolicies([policy]);

      const result = await guardWithResolver.check({ type: "click" }, adapter);
      expect(result.allowed).toBe(false);
      expect(result.denialCode).toBe("DESKTOP_PERMISSION_PROMPT_EXPIRED");
      expect(result.decision!.decision).toBe("timeout");
    });

    it("fails closed and records a denied decision when prompt resolver throws", async () => {
      const guardWithResolver = createPermissionGuard(makeConfig({
        promptResolver: async () => {
          throw new Error("resolver exploded");
        },
      }));
      const adapter = makeMockAdapter();
      const policy = makePolicy([
        { actionType: "click", appFilter: "*", decision: "allow", riskLevel: "critical" },
      ]);
      guardWithResolver.loadPolicies([policy]);

      const result = await guardWithResolver.check({ type: "click" }, adapter);
      expect(result.allowed).toBe(false);
      expect(result.denialCode).toBe("DESKTOP_PERMISSION_DENIED_USER");
      expect(result.denialMessage).toContain("resolver exploded");
      expect(result.decision?.decision).toBe("denied");
      expect(guardWithResolver.getDecisions()).toHaveLength(1);
    });
  });

  describe("policy management", () => {
    it("replaces policies when loadPolicies is called", () => {
      guard.loadPolicies([makePolicy([])]);
      expect(guard.getPolicies()).toHaveLength(1);

      guard.loadPolicies([makePolicy([]), makePolicy([])]);
      expect(guard.getPolicies()).toHaveLength(2);
    });
  });

  describe("decision recording", () => {
    it("records decisions from prompt resolution", async () => {
      const guardWithResolver = createPermissionGuard(makeConfig({
        promptResolver: async () => ({ decision: "approved" as const }),
      }));
      const adapter = makeMockAdapter();
      const policy = makePolicy([
        { actionType: "click", appFilter: "*", decision: "allow", riskLevel: "critical" },
      ]);
      guardWithResolver.loadPolicies([policy]);

      await guardWithResolver.check({ type: "click" }, adapter);
      expect(guardWithResolver.getDecisions()).toHaveLength(1);
    });
  });
});
