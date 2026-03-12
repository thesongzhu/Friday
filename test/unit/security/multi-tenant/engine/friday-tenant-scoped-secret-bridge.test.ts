/**
 * B-003 Tenant-Scoped Secret Bridge Tests
 *
 * Validates scope-aware secret resolution, access logging,
 * permission enforcement, provider/channel shortcuts, and
 * rotation health checks.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTenantScopedSecretBridge,
  type TenantScopedSecretBridgeDeps,
  type TenantSecretRef,
} from "../../../../../src/security/multi-tenant/engine/friday-tenant-scoped-secret-bridge.js";

// ─── Helpers ───

function makeDeps(overrides: Partial<TenantScopedSecretBridgeDeps> = {}): TenantScopedSecretBridgeDeps {
  return {
    resolveSecret: vi.fn().mockReturnValue({
      value: "secret-value-123",
      name: "provider:openai-1:apiKey",
      version: 1,
      scopeType: "workspace",
      rotationState: "active",
    }),
    logAccess: vi.fn(),
    checkScopePermission: vi.fn().mockReturnValue(true),
    nowIso: () => "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeRef(overrides: Partial<TenantSecretRef> = {}): TenantSecretRef {
  return {
    tenantId: "tenant-1",
    workspaceId: "ws-1",
    refKey: "provider:openai-1:apiKey",
    ...overrides,
  };
}

// ─── Tests ───

describe("B-003 FridayTenantScopedSecretBridge", () => {
  describe("resolve — granted", () => {
    it("resolves a secret with full tenant+workspace scope", () => {
      const deps = makeDeps();
      const bridge = createTenantScopedSecretBridge(deps);

      const result = bridge.resolve({
        ref: makeRef(),
        principalId: "user-1",
      });

      expect(result.decision).toBe("granted");
      expect(result.secret).not.toBeNull();
      expect(result.secret!.value).toBe("secret-value-123");
      expect(result.secret!.scopeType).toBe("workspace");
      expect(result.secret!.rotationHealthy).toBe(true);
      expect(result.logged).toBe(true);
    });

    it("passes correct parameters to resolveSecret", () => {
      const deps = makeDeps();
      const bridge = createTenantScopedSecretBridge(deps);

      bridge.resolve({
        ref: makeRef({ tenantId: "t-42", workspaceId: "ws-7", resourceId: "res-x", refKey: "my-secret" }),
        principalId: "user-1",
      });

      expect(deps.resolveSecret).toHaveBeenCalledWith({
        tenantId: "t-42",
        name: "my-secret",
        workspaceId: "ws-7",
        resourceId: "res-x",
      });
    });

    it("logs successful access", () => {
      const deps = makeDeps();
      const bridge = createTenantScopedSecretBridge(deps);

      bridge.resolve({ ref: makeRef(), principalId: "user-1" });

      expect(deps.logAccess).toHaveBeenCalledWith({
        tenantId: "tenant-1",
        secretName: "provider:openai-1:apiKey",
        principalId: "user-1",
        action: "read",
        granted: true,
      });
    });

    it("defaults action to read", () => {
      const deps = makeDeps();
      const bridge = createTenantScopedSecretBridge(deps);

      bridge.resolve({ ref: makeRef(), principalId: "user-1" });

      expect(deps.checkScopePermission).toHaveBeenCalledWith(
        expect.objectContaining({ requiredAction: "read" }),
      );
    });

    it("supports write action", () => {
      const deps = makeDeps();
      const bridge = createTenantScopedSecretBridge(deps);

      bridge.resolve({ ref: makeRef(), principalId: "user-1", action: "write" });

      expect(deps.checkScopePermission).toHaveBeenCalledWith(
        expect.objectContaining({ requiredAction: "write" }),
      );
    });
  });

  describe("resolve — denied", () => {
    it("denies access when scope permission fails", () => {
      const deps = makeDeps({ checkScopePermission: vi.fn().mockReturnValue(false) });
      const bridge = createTenantScopedSecretBridge(deps);

      const result = bridge.resolve({ ref: makeRef(), principalId: "user-1" });

      expect(result.decision).toBe("denied");
      expect(result.secret).toBeNull();
      expect(result.reason).toContain("Insufficient scope");
      expect(deps.logAccess).toHaveBeenCalledWith(expect.objectContaining({ granted: false }));
    });

    it("does not resolve secret when permission denied", () => {
      const deps = makeDeps({ checkScopePermission: vi.fn().mockReturnValue(false) });
      const bridge = createTenantScopedSecretBridge(deps);

      bridge.resolve({ ref: makeRef(), principalId: "user-1" });

      expect(deps.resolveSecret).not.toHaveBeenCalled();
    });
  });

  describe("resolve — not_found", () => {
    it("returns not_found when secret does not exist", () => {
      const deps = makeDeps({ resolveSecret: vi.fn().mockReturnValue(null) });
      const bridge = createTenantScopedSecretBridge(deps);

      const result = bridge.resolve({ ref: makeRef(), principalId: "user-1" });

      expect(result.decision).toBe("not_found");
      expect(result.secret).toBeNull();
      expect(result.reason).toContain("not found");
      expect(deps.logAccess).toHaveBeenCalledWith(expect.objectContaining({
        granted: false,
        reason: "Secret not found",
      }));
    });
  });

  describe("rotation health", () => {
    it("marks active secrets as healthy", () => {
      const deps = makeDeps();
      (deps.resolveSecret as ReturnType<typeof vi.fn>).mockReturnValue({
        value: "v", name: "n", version: 1, scopeType: "tenant", rotationState: "active",
      });
      const bridge = createTenantScopedSecretBridge(deps);

      const result = bridge.resolve({ ref: makeRef(), principalId: "user-1" });
      expect(result.secret!.rotationHealthy).toBe(true);
    });

    it("marks pending_rotation secrets as healthy", () => {
      const deps = makeDeps();
      (deps.resolveSecret as ReturnType<typeof vi.fn>).mockReturnValue({
        value: "v", name: "n", version: 1, scopeType: "tenant", rotationState: "pending_rotation",
      });
      const bridge = createTenantScopedSecretBridge(deps);

      const result = bridge.resolve({ ref: makeRef(), principalId: "user-1" });
      expect(result.secret!.rotationHealthy).toBe(true);
    });

    it("marks rotating secrets as unhealthy", () => {
      const deps = makeDeps();
      (deps.resolveSecret as ReturnType<typeof vi.fn>).mockReturnValue({
        value: "v", name: "n", version: 1, scopeType: "tenant", rotationState: "rotating",
      });
      const bridge = createTenantScopedSecretBridge(deps);

      const result = bridge.resolve({ ref: makeRef(), principalId: "user-1" });
      expect(result.secret!.rotationHealthy).toBe(false);
    });

    it("marks retired secrets as unhealthy", () => {
      const deps = makeDeps();
      (deps.resolveSecret as ReturnType<typeof vi.fn>).mockReturnValue({
        value: "v", name: "n", version: 1, scopeType: "tenant", rotationState: "retired",
      });
      const bridge = createTenantScopedSecretBridge(deps);

      const result = bridge.resolve({ ref: makeRef(), principalId: "user-1" });
      expect(result.secret!.rotationHealthy).toBe(false);
    });
  });

  describe("resolveProviderCredential", () => {
    it("builds provider ref key and delegates", () => {
      const deps = makeDeps();
      const bridge = createTenantScopedSecretBridge(deps);

      const result = bridge.resolveProviderCredential({
        tenantId: "t-1",
        providerId: "openai-prod",
        principalId: "agent-1",
        workspaceId: "ws-1",
      });

      expect(result.decision).toBe("granted");
      expect(deps.resolveSecret).toHaveBeenCalledWith({
        tenantId: "t-1",
        name: "provider:openai-prod:apiKey",
        workspaceId: "ws-1",
        resourceId: "openai-prod",
      });
    });

    it("works without workspaceId", () => {
      const deps = makeDeps();
      const bridge = createTenantScopedSecretBridge(deps);

      bridge.resolveProviderCredential({
        tenantId: "t-1",
        providerId: "anthropic-1",
        principalId: "system",
      });

      expect(deps.resolveSecret).toHaveBeenCalledWith(
        expect.objectContaining({ name: "provider:anthropic-1:apiKey" }),
      );
    });
  });

  describe("resolveChannelCredential", () => {
    it("builds channel ref key and delegates", () => {
      const deps = makeDeps();
      const bridge = createTenantScopedSecretBridge(deps);

      const result = bridge.resolveChannelCredential({
        tenantId: "t-1",
        channelId: "discord-main",
        principalId: "agent-1",
        workspaceId: "ws-1",
      });

      expect(result.decision).toBe("granted");
      expect(deps.resolveSecret).toHaveBeenCalledWith({
        tenantId: "t-1",
        name: "channel:discord-main:secret",
        workspaceId: "ws-1",
        resourceId: "discord-main",
      });
    });
  });

  describe("access log", () => {
    it("records all access attempts", () => {
      const deps = makeDeps();
      const bridge = createTenantScopedSecretBridge(deps);

      bridge.resolve({ ref: makeRef({ tenantId: "t-1" }), principalId: "user-1" });
      bridge.resolve({ ref: makeRef({ tenantId: "t-2" }), principalId: "user-2" });

      const log = bridge.getAccessLog();
      expect(log).toHaveLength(2);
      expect(log[0].tenantId).toBe("t-1");
      expect(log[1].tenantId).toBe("t-2");
    });

    it("records denied attempts in log", () => {
      const deps = makeDeps({ checkScopePermission: vi.fn().mockReturnValue(false) });
      const bridge = createTenantScopedSecretBridge(deps);

      bridge.resolve({ ref: makeRef(), principalId: "bad-user" });

      const log = bridge.getAccessLog();
      expect(log).toHaveLength(1);
      expect(log[0].decision).toBe("denied");
      expect(log[0].principalId).toBe("bad-user");
    });

    it("records not_found attempts in log", () => {
      const deps = makeDeps({ resolveSecret: vi.fn().mockReturnValue(null) });
      const bridge = createTenantScopedSecretBridge(deps);

      bridge.resolve({ ref: makeRef(), principalId: "user-1" });

      const log = bridge.getAccessLog();
      expect(log[0].decision).toBe("not_found");
    });

    it("includes timestamps from nowIso", () => {
      const deps = makeDeps();
      const bridge = createTenantScopedSecretBridge(deps);

      bridge.resolve({ ref: makeRef(), principalId: "user-1" });

      expect(bridge.getAccessLog()[0].timestamp).toBe("2026-01-01T00:00:00Z");
    });

    it("returns a copy (not mutable reference)", () => {
      const deps = makeDeps();
      const bridge = createTenantScopedSecretBridge(deps);

      bridge.resolve({ ref: makeRef(), principalId: "user-1" });

      const log = bridge.getAccessLog();
      log.length = 0;

      expect(bridge.getAccessLog()).toHaveLength(1);
    });
  });

  describe("reset", () => {
    it("clears the access log", () => {
      const deps = makeDeps();
      const bridge = createTenantScopedSecretBridge(deps);

      bridge.resolve({ ref: makeRef(), principalId: "user-1" });
      expect(bridge.getAccessLog()).toHaveLength(1);

      bridge.reset();
      expect(bridge.getAccessLog()).toHaveLength(0);
    });
  });
});
