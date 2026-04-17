import { describe, it, expect, vi } from "vitest";
import { FridayDomainError } from "#errors";
import { FRIDAY_MEMORY_GUARD_ERROR_CODES } from "#memory";
import { createGuardTestSetup, createMockMemoryItem } from "./_helpers/create-guard-service.helper.js";

describe("FridayMemoryGuardService — Namespace Isolation", () => {
  // ─── Tenant namespace prefixing ───

  it("prefixes namespace for tenant access level", async () => {
    const { guard, core } = createGuardTestSetup();
    await guard.store("my-notes", "content");
    expect(core.store).toHaveBeenCalledWith(
      "tenant.default.user.user1.my-notes",
      expect.anything(),
      expect.anything(),
    );
  });

  it("does not prefix namespace for system access level", async () => {
    const { guard, core } = createGuardTestSetup({
      subject: { hubId: "default", accessLevel: "system" },
      principalId: "service-1",
    });
    await guard.store("my-notes", "content");
    expect(core.store).toHaveBeenCalledWith(
      "my-notes",
      expect.anything(),
      expect.anything(),
    );
  });

  // ─── Reserved namespace enforcement ───

  it("denies tenant access to system.* namespace", async () => {
    const { guard } = createGuardTestSetup();
    // The reserved namespace check must reject the REQUESTED namespace ("system.config")
    // before prefixing, so tenants cannot use reserved prefixes at all.
    await expect(guard.store("system.config", "evil content")).rejects.toThrow(FridayDomainError);
    try {
      await guard.store("system.config", "evil content");
    } catch (e) {
      expect((e as FridayDomainError).code).toBe(FRIDAY_MEMORY_GUARD_ERROR_CODES.NAMESPACE_RESERVED);
    }
  });

  it("denies tenant access to bare system namespace", async () => {
    const { guard } = createGuardTestSetup();
    await expect(guard.store("system", "evil content")).rejects.toThrow(FridayDomainError);
    try {
      await guard.store("system", "evil content");
    } catch (e) {
      expect((e as FridayDomainError).code).toBe(FRIDAY_MEMORY_GUARD_ERROR_CODES.NAMESPACE_RESERVED);
    }
  });

  it("allows system access level to use system.* namespace", async () => {
    const { guard, core } = createGuardTestSetup({
      subject: { hubId: "default", accessLevel: "system" },
      principalId: "service-1",
    });
    await guard.store("system.config", "content");
    expect(core.store).toHaveBeenCalledWith(
      "system.config",
      expect.anything(),
      expect.anything(),
    );
  });

  // ─── Get scope check ───

  it("allows get for item within tenant scope", async () => {
    const { guard, core } = createGuardTestSetup();
    vi.mocked(core.get).mockResolvedValue(
      createMockMemoryItem({ namespace: "tenant.default.user.user1.notes" }),
    );
    const item = await guard.get("item-1");
    expect(item).not.toBeNull();
  });

  it("denies get for item outside tenant scope", async () => {
    const { guard, core } = createGuardTestSetup();
    vi.mocked(core.get).mockResolvedValue(
      createMockMemoryItem({ namespace: "tenant.other-hub.user.user2.notes" }),
    );
    await expect(guard.get("item-1")).rejects.toThrow(FridayDomainError);
    try {
      await guard.get("item-1");
    } catch (e) {
      expect((e as FridayDomainError).code).toBe(FRIDAY_MEMORY_GUARD_ERROR_CODES.ITEM_ACCESS_DENIED);
    }
  });

  it("system access can get any item", async () => {
    const { guard, core } = createGuardTestSetup({
      subject: { hubId: "default", accessLevel: "system" },
      principalId: "service-1",
    });
    vi.mocked(core.get).mockResolvedValue(
      createMockMemoryItem({ namespace: "any.namespace.at.all" }),
    );
    const item = await guard.get("item-1");
    expect(item).not.toBeNull();
  });

  // ─── Delete scope check ───

  it("denies delete for item outside scope", async () => {
    const { guard, core } = createGuardTestSetup();
    vi.mocked(core.get).mockResolvedValue(
      createMockMemoryItem({ namespace: "tenant.other-hub.user.user2.notes" }),
    );
    await expect(guard.delete("item-1")).rejects.toThrow(FridayDomainError);
    try {
      await guard.delete("item-1");
    } catch (e) {
      expect((e as FridayDomainError).code).toBe(FRIDAY_MEMORY_GUARD_ERROR_CODES.ITEM_ACCESS_DENIED);
    }
  });

  // ─── List scope enforcement ───

  it("list defaults to scoped namespace prefix for tenants", async () => {
    const { guard, core } = createGuardTestSetup();
    await guard.list();
    expect(core.list).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: expect.arrayContaining([
          "tenant.default.user.user1",
          "default",
        ]),
      }),
    );
  });

  it("list filters out items outside scope", async () => {
    const { guard, core } = createGuardTestSetup();
    vi.mocked(core.list).mockResolvedValue([
      createMockMemoryItem({ namespace: "tenant.default.user.user1.notes" }),
      createMockMemoryItem({ namespace: "tenant.other.user.user2.notes" }),
    ]);
    const items = await guard.list();
    expect(items).toHaveLength(1);
    expect(items[0].namespace).toBe("tenant.default.user.user1.notes");
  });

  // ─── Search scope enforcement ───

  it("search scopes namespace for tenants", async () => {
    const { guard, core } = createGuardTestSetup();
    await guard.search("hello");
    const callArgs = vi.mocked(core.search).mock.calls[0];
    expect(callArgs[1]).toEqual(
      expect.objectContaining({
        namespace: expect.arrayContaining([
          "tenant.default.user.user1",
          "default",
        ]),
      }),
    );
  });

  it("search filters results outside scope", async () => {
    const { guard, core } = createGuardTestSetup();
    vi.mocked(core.search).mockResolvedValue([
      {
        item: createMockMemoryItem({ namespace: "tenant.default.user.user1.notes" }),
        score: 0.9,
        ftsScore: 0.8,
        semanticScore: 1.0,
        matchedBy: ["fts"],
        snippet: "Hello",
      },
      {
        item: createMockMemoryItem({ namespace: "tenant.other.user.user2.notes" }),
        score: 0.8,
        ftsScore: 0.7,
        semanticScore: 0.9,
        matchedBy: ["fts"],
        snippet: "World",
      },
    ]);
    const results = await guard.search("hello");
    expect(results).toHaveLength(1);
  });

  // ─── Prune scope enforcement ───

  it("prune scopes namespace for tenants", async () => {
    const { guard, core } = createGuardTestSetup();
    await guard.prune();
    expect(core.prune).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: expect.arrayContaining([
          "tenant.default.user.user1",
          "default",
        ]),
      }),
    );
  });

  // ─── Tenant without userId ───

  it("tenant without userId uses hubId-only prefix", async () => {
    const { guard, core } = createGuardTestSetup({
      subject: { hubId: "hub42", accessLevel: "tenant" },
      principalId: "principal-1",
    });
    await guard.store("notes", "content");
    expect(core.store).toHaveBeenCalledWith(
      "tenant.hub42.notes",
      expect.anything(),
      expect.anything(),
    );
  });
});
