import { describe, it, expect, vi } from "vitest";
import type { FridayHubConfigManagerService } from "#hub";
import type { FridayHubMemoryStateService } from "#hub";
import type { FridayHubGatewayIngressService } from "#hub";

describe("Hub service contract tests", () => {
  it("FridayHubConfigManagerService provides skill registry settings", async () => {
    const configManager: FridayHubConfigManagerService = {
      getCurrentConfig: vi.fn().mockResolvedValue({
        config: {},
        configPath: "/config.json",
        exists: true,
      }),
      getConfig: vi.fn().mockResolvedValue({ revision: 1, settings: {} }),
      validatePatch: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
      applyPatch: vi.fn().mockResolvedValue({ revision: 2, changedKeys: [] }),
      listRevisions: vi.fn().mockResolvedValue({ items: [] }),
      revertToRevision: vi.fn().mockResolvedValue({
        revision: 1,
        changedKeys: [],
        revertedFrom: 2,
      }),
      getSkillRegistrySettings: vi.fn().mockResolvedValue({
        workspaceDir: "/workspace",
        bundledSkillsDir: "/bundled",
        managedSkillsDir: "/managed",
        extraSkillDirs: [],
        watchEnabled: false,
        watchDebounceMs: 300,
      }),
      getSkillSecurityProfile: vi.fn().mockResolvedValue({}),
    };

    const settings = await configManager.getSkillRegistrySettings("/workspace");
    expect(settings.workspaceDir).toBe("/workspace");
    expect(settings.bundledSkillsDir).toBe("/bundled");
    expect(configManager.getSkillRegistrySettings).toHaveBeenCalledWith("/workspace");
  });

  it("FridayHubMemoryStateService persists skill statuses", async () => {
    const memState: FridayHubMemoryStateService = {
      listSkillStatuses: vi.fn().mockResolvedValue({ "skill-1": "installed" }),
      upsertDiscoveredSkills: vi.fn().mockResolvedValue(undefined),
      updateSkillStatus: vi.fn().mockResolvedValue(undefined),
      appendAuditLog: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockResolvedValue(null),
      appendSessionMessage: vi.fn().mockResolvedValue({
        id: "msg-1",
        sessionId: "s1",
        leaseEpoch: 1,
        role: "user",
        content: "hello",
        sequence: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      getMemoryItems: vi.fn().mockResolvedValue([]),
      putMemoryItem: vi.fn().mockResolvedValue(undefined),
    };

    const statuses = await memState.listSkillStatuses();
    expect(statuses["skill-1"]).toBe("installed");

    await memState.updateSkillStatus("skill-1", "disabled", "user request");
    expect(memState.updateSkillStatus).toHaveBeenCalledWith("skill-1", "disabled", "user request");
  });

  it("FridayHubGatewayIngressService dispatches frames", async () => {
    const gateway: FridayHubGatewayIngressService = {
      registerMethod: vi.fn(),
      dispatchFrame: vi.fn().mockResolvedValue({
        type: "res",
        id: "req-1",
        ok: true,
        payload: { result: "done" },
      }),
      publishEvent: vi.fn().mockResolvedValue(undefined),
    };

    gateway.registerMethod("skill.run", async () => ({ ok: true }));
    expect(gateway.registerMethod).toHaveBeenCalledWith("skill.run", expect.any(Function));

    const response = await gateway.dispatchFrame(
      { type: "req", id: "req-1", method: "skill.run" },
      { principalType: "user", scopes: ["admin"] },
    );
    expect(response).toBeDefined();
    expect(response!.ok).toBe(true);

    await gateway.publishEvent({
      type: "event",
      event: "skill.status_changed",
      seq: 1,
      emittedAt: new Date().toISOString(),
    });
    expect(gateway.publishEvent).toHaveBeenCalled();
  });

  it("Config manager validates patches before applying", async () => {
    const configManager: FridayHubConfigManagerService = {
      getCurrentConfig: vi.fn(),
      getConfig: vi.fn(),
      validatePatch: vi.fn().mockResolvedValue({
        valid: false,
        errors: [{ field: "database.readPoolSize", rule: "min", message: "Must be >= 1" }],
      }),
      applyPatch: vi.fn(),
      listRevisions: vi.fn(),
      revertToRevision: vi.fn(),
      getSkillRegistrySettings: vi.fn(),
      getSkillSecurityProfile: vi.fn(),
    };

    const validation = await configManager.validatePatch({ database: { readPoolSize: 0 } });
    expect(validation.valid).toBe(false);
    expect(validation.errors).toHaveLength(1);
    expect(validation.errors[0]!.field).toBe("database.readPoolSize");
  });
});
