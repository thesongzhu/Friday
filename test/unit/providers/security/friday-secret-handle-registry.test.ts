import { describe, expect, it } from "vitest";

import { createFridayEphemeralSecretHandleRegistry } from "#providers";

describe("FridayEphemeralSecretHandleRegistry", () => {
  it("issues one-shot handles and revokes material after use", async () => {
    let now = 1_000;
    let nextId = 0;
    const registry = createFridayEphemeralSecretHandleRegistry({
      nowMs: () => now,
      idGenerator: () => `handle-${++nextId}`,
      ttlMs: 1_000,
    });

    const handle = registry.issue("one-shot-secret", {
      providerId: "provider-1",
    });

    expect(handle.handleId).toBe("handle-1");
    expect(handle.expiresAtMs).toBe(2_000);
    expect(registry.size()).toBe(1);

    await expect(registry.use(handle.handleId, async (credential) => credential)).resolves.toBe("one-shot-secret");
    expect(registry.size()).toBe(0);
    await expect(registry.use(handle.handleId, async (credential) => credential)).rejects.toMatchObject({
      code: "SECRET_HANDLE_NOT_FOUND",
    });

    now += 1;
  });

  it("expires unused handles and never exposes expired material", async () => {
    let now = 10_000;
    const registry = createFridayEphemeralSecretHandleRegistry({
      nowMs: () => now,
      idGenerator: () => "handle-expiring",
      ttlMs: 50,
    });

    const handle = registry.issue("expired-secret");
    now = handle.expiresAtMs;

    expect(registry.size()).toBe(0);
    await expect(registry.use(handle.handleId, async (credential) => credential)).rejects.toMatchObject({
      code: "SECRET_HANDLE_NOT_FOUND",
    });
  });

  it("consumes handles even when the protected operation fails", async () => {
    const registry = createFridayEphemeralSecretHandleRegistry({
      idGenerator: () => "handle-failure",
      ttlMs: 1_000,
    });

    const handle = registry.issue("secret-used-during-failure");

    await expect(
      registry.use(handle.handleId, () => {
        throw new Error("operation failed");
      }),
    ).rejects.toThrow("operation failed");
    await expect(registry.use(handle.handleId, async (credential) => credential)).rejects.toMatchObject({
      code: "SECRET_HANDLE_NOT_FOUND",
    });
  });

  it("supports explicit revocation before use", async () => {
    const registry = createFridayEphemeralSecretHandleRegistry({
      idGenerator: () => "handle-revoked",
      ttlMs: 1_000,
    });

    const handle = registry.issue("revoked-secret");

    expect(registry.revoke(handle.handleId)).toBe(true);
    expect(registry.revoke(handle.handleId)).toBe(false);
    await expect(registry.use(handle.handleId, async (credential) => credential)).rejects.toMatchObject({
      code: "SECRET_HANDLE_NOT_FOUND",
    });
  });
});
