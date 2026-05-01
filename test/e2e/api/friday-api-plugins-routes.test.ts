import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FridayPluginManifestLoader, FridayPluginService } from "#plugins";
import {
  createFridayApiTestEnv,
  loginTestUser,
  authHeaders,
  createTokenWithScopes,
  type FridayApiTestEnv,
} from "./_helpers/friday-api-test-server.helper.js";

function createStubPluginService(): FridayPluginService {
  return {
    listPlugins: () => [],
    getPlugin: () => null,
    listPluginVersions: () => [],
    installPlugin: () => {
      throw new Error("not implemented in e2e stub");
    },
    enablePlugin: async () => {
      throw new Error("not implemented in e2e stub");
    },
    disablePlugin: async () => {
      throw new Error("not implemented in e2e stub");
    },
    uninstallPlugin: async () => {
      throw new Error("not implemented in e2e stub");
    },
  };
}

function createStubPluginManifestLoader(): FridayPluginManifestLoader {
  return {
    loadFromDirectory: () => {
      throw new Error("not implemented in e2e stub");
    },
    validate: (raw) => raw as never,
  };
}

describe("API — Plugin routes", () => {
  let env: FridayApiTestEnv;
  let token: string;

  beforeAll(async () => {
    env = await createFridayApiTestEnv({
      pluginService: createStubPluginService(),
      pluginManifestLoader: createStubPluginManifestLoader(),
    });
    const login = await loginTestUser(env.baseUrl);
    token = login.accessToken;
  });

  afterAll(async () => {
    await env.close();
  });

  it("plugins_list_returns_empty_initially — GET /v1/plugins → 200 with empty list", async () => {
    const res = await fetch(`${env.baseUrl}/v1/plugins`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      ok: boolean;
      data: { items: Array<Record<string, unknown>> };
    };
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.data.items)).toBe(true);
    expect(json.data.items).toHaveLength(0);
  });

  it("plugins_get_not_found — GET /v1/plugins/nonexistent → 404", async () => {
    const res = await fetch(`${env.baseUrl}/v1/plugins/nonexistent`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(404);

    const json = (await res.json()) as {
      ok: boolean;
      error: { code: string };
    };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("PLUGIN_NOT_FOUND");
  });

  it("plugin_scope_enforcement — access plugin routes without proper scope → 403", async () => {
    const tokenNoScopes = createTokenWithScopes([]);
    const res = await fetch(`${env.baseUrl}/v1/plugins`, {
      headers: authHeaders(tokenNoScopes),
    });
    expect(res.status).toBe(403);

    const json = (await res.json()) as {
      ok: boolean;
      error: { code: string };
    };
    expect(json.ok).toBe(false);
    expect(["FORBIDDEN", "INSUFFICIENT_SCOPE"]).toContain(json.error.code);
  });
});
