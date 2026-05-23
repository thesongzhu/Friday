import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "#state";
import {
  createFridaySecretAdminService,
  resetMasterKeyCache,
} from "#providers";
import { createTestDb } from "../../../helpers/friday-test-db.helper.js";

describe("FridaySecretAdminService", () => {
  let db: FridaySqliteLayer;
  const nowIso = "2026-03-08T00:00:00.000Z";
  const previousMasterKey = process.env.FRIDAY_MASTER_KEY;

  beforeEach(() => {
    process.env.FRIDAY_MASTER_KEY = "11".repeat(32);
    resetMasterKeyCache();
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
    if (previousMasterKey === undefined) {
      delete process.env.FRIDAY_MASTER_KEY;
    } else {
      process.env.FRIDAY_MASTER_KEY = previousMasterKey;
    }
    resetMasterKeyCache();
  });

  function createService() {
    return createFridaySecretAdminService({
      db,
      idGenerator: () => "secret-1",
      nowIso: () => nowIso,
    });
  }

  it("creates, lists, fetches, updates, and deletes a secret", () => {
    const service = createService();
    const created = service.createSecret({
      scope: "provider",
      refKey: "provider:openai:key",
      value: "top-secret-value",
    });

    expect(created.scope).toBe("provider");
    expect(service.listSecrets()).toHaveLength(1);
    expect(service.getSecret(created.id)?.refKey).toBe("provider:openai:key");

    const updated = service.updateSecret(created.id, {
      refKey: "provider:openai:key-rotated",
      value: "rotated-secret-value",
    });
    expect(updated.refKey).toBe("provider:openai:key-rotated");
    expect(updated.rotatedAt).toBe(nowIso);

    expect(service.deleteSecret(created.id)).toBe(true);
    expect(service.getSecret(created.id)).toBeNull();
  });

  it("rejects duplicate scope/refKey pairs", () => {
    const service = createService();
    service.createSecret({
      scope: "provider",
      refKey: "provider:openai:key",
      value: "top-secret-value",
    });

    expect(() =>
      service.createSecret({
        scope: "provider",
        refKey: "provider:openai:key",
        value: "other-secret",
      }),
    ).toThrow("Secret already exists");
  });

  it("fails closed when FRIDAY_MASTER_KEY is not configured", () => {
    delete process.env.FRIDAY_MASTER_KEY;
    delete process.env.FRIDAY_MASTER_KEY_SOURCE;
    resetMasterKeyCache();

    const service = createService();
    expect(() =>
      service.createSecret({
        scope: "provider",
        refKey: "provider:openai:key",
        value: "top-secret-value",
      }),
    ).toThrow(/FRIDAY_MASTER_KEY is not configured/);
  });
});
