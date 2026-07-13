import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import { createFridayMcpConfigStore } from "../../../../src/agent/mcp/friday-mcp-config-store.js";
import type { FridayMcpServerConfig } from "../../../../src/agent/mcp/friday-mcp-adapter.types.js";
import { resetMasterKeyCache } from "../../../../src/security/friday-secret-crypto.js";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `friday-mcp-config-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function makeServer(overrides: Partial<FridayMcpServerConfig> = {}): FridayMcpServerConfig {
  return {
    id: "test-server",
    transport: "stdio",
    command: "node",
    args: ["echo-server.mjs"],
    ...overrides,
  };
}

describe("FridayMcpConfigStore", () => {
  it("returns empty array when no config file exists", () => {
    const store = createFridayMcpConfigStore(testDir);
    expect(store.load()).toEqual([]);
  });

  it("saves and loads server configs", () => {
    const store = createFridayMcpConfigStore(testDir);
    const server = makeServer();
    store.save([server]);
    const loaded = store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe("test-server");
    expect(loaded[0]!.command).toBe("node");
  });

  it("addServer persists a new server", () => {
    const store = createFridayMcpConfigStore(testDir);
    store.addServer(makeServer({ id: "s1", command: "cmd1" }));
    store.addServer(makeServer({ id: "s2", command: "cmd2" }));
    const loaded = store.load();
    expect(loaded).toHaveLength(2);
    expect(loaded.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("addServer replaces existing server with same id", () => {
    const store = createFridayMcpConfigStore(testDir);
    store.addServer(makeServer({ id: "s1", command: "old" }));
    store.addServer(makeServer({ id: "s1", command: "new" }));
    const loaded = store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.command).toBe("new");
  });

  it("removeServer removes by id", () => {
    const store = createFridayMcpConfigStore(testDir);
    store.addServer(makeServer({ id: "s1" }));
    store.addServer(makeServer({ id: "s2" }));
    store.removeServer("s1");
    const loaded = store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe("s2");
  });

  it("removeServer is a no-op for nonexistent id", () => {
    const store = createFridayMcpConfigStore(testDir);
    store.addServer(makeServer({ id: "s1" }));
    store.removeServer("nonexistent");
    expect(store.load()).toHaveLength(1);
  });

  it("writes valid JSON to mcp-servers.json", () => {
    const store = createFridayMcpConfigStore(testDir);
    store.addServer(makeServer());
    const filePath = join(testDir, "mcp-servers.json");
    expect(existsSync(filePath)).toBe(true);
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].id).toBe("test-server");
  });

  it("handles corrupt JSON gracefully", () => {
    const store = createFridayMcpConfigStore(testDir);
    const filePath = join(testDir, "mcp-servers.json");
    writeFileSync(filePath, "not valid json {{{", "utf8");
    expect(store.load()).toEqual([]);
  });

  it("filters out entries without id", () => {
    const store = createFridayMcpConfigStore(testDir);
    const filePath = join(testDir, "mcp-servers.json");
    writeFileSync(filePath, JSON.stringify([{ command: "no-id" }, { id: "valid", command: "cmd" }]), "utf8");
    const loaded = store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe("valid");
  });

  it("creates parent directories if needed", () => {
    const nestedDir = join(testDir, "deep", "nested", "state");
    const store = createFridayMcpConfigStore(nestedDir);
    store.addServer(makeServer());
    expect(existsSync(join(nestedDir, "mcp-servers.json"))).toBe(true);
  });
});

// SEC-CREDENTIAL-INGRESS-001 (at-rest MCP slice): env/header secret VALUES must
// become opaque `secret://` references at rest (no plaintext embedded in
// mcp-servers.json), with ciphertext isolated in a sidecar vault.
// NOTE: canary literal below is a synthetic test value, never a real credential.
const MCP_SECRET_CANARY = "sk-live-CANARY-0xDEADBEEF"; // pragma: allowlist secret

describe("FridayMcpConfigStore secret-at-rest encryption", () => {
  const MASTER_KEY = randomBytes(32);

  function configPath(): string {
    return join(testDir, "mcp-servers.json");
  }
  function vaultPath(): string {
    return join(testDir, "mcp-secrets.json");
  }

  it("does not persist env secret values as plaintext (opaque ref + sidecar vault)", () => {
    const store = createFridayMcpConfigStore(testDir, { masterKey: MASTER_KEY });
    store.save([makeServer({ id: "gh", env: { GITHUB_TOKEN: MCP_SECRET_CANARY } })]);

    const raw = readFileSync(configPath(), "utf8");
    // The plaintext secret must NOT appear anywhere in the persisted config file.
    expect(raw).not.toContain(MCP_SECRET_CANARY);
    // It is replaced by an opaque reference.
    expect(raw).toContain("secret://");

    // The sidecar vault exists and holds only opaque ciphertext (no plaintext).
    expect(existsSync(vaultPath())).toBe(true);
    const vaultRaw = readFileSync(vaultPath(), "utf8");
    expect(vaultRaw).not.toContain(MCP_SECRET_CANARY);
    const vault = JSON.parse(vaultRaw);
    expect(Object.keys(vault.entries).length).toBe(1);
  });

  it("round-trips the real secret value on load (resolution still works for spawn/env)", () => {
    const store = createFridayMcpConfigStore(testDir, { masterKey: MASTER_KEY });
    store.save([makeServer({ id: "gh", env: { GITHUB_TOKEN: MCP_SECRET_CANARY } })]);
    const loaded = store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.env!.GITHUB_TOKEN).toBe(MCP_SECRET_CANARY);
  });

  it("encrypts http header secrets at rest and restores them on load", () => {
    const store = createFridayMcpConfigStore(testDir, { masterKey: MASTER_KEY });
    store.save([
      makeServer({
        id: "http",
        transport: "http",
        url: "https://example.test/mcp",
        headers: { Authorization: `Bearer ${MCP_SECRET_CANARY}` },
      }),
    ]);
    const raw = readFileSync(configPath(), "utf8");
    expect(raw).not.toContain(MCP_SECRET_CANARY);
    expect(raw).toContain("secret://");
    const loaded = store.load();
    expect(loaded[0]!.headers!.Authorization).toBe(`Bearer ${MCP_SECRET_CANARY}`);
  });

  it("fail-closed: refuses to persist a secret when no master key is available (never writes plaintext)", () => {
    const savedEnvKey = process.env.FRIDAY_MASTER_KEY;
    const savedEnvSource = process.env.FRIDAY_MASTER_KEY_SOURCE;
    delete process.env.FRIDAY_MASTER_KEY;
    delete process.env.FRIDAY_MASTER_KEY_SOURCE;
    resetMasterKeyCache();
    try {
      // No injected key → falls back to the real fail-closed hub resolver.
      const store = createFridayMcpConfigStore(testDir);
      expect(() =>
        store.save([makeServer({ id: "gh", env: { GITHUB_TOKEN: MCP_SECRET_CANARY } })]),
      ).toThrow();
      // Critical: it must NOT have silently written plaintext to disk.
      if (existsSync(configPath())) {
        expect(readFileSync(configPath(), "utf8")).not.toContain(MCP_SECRET_CANARY);
      } else {
        expect(existsSync(configPath())).toBe(false);
      }
    } finally {
      if (savedEnvKey !== undefined) process.env.FRIDAY_MASTER_KEY = savedEnvKey;
      if (savedEnvSource !== undefined) process.env.FRIDAY_MASTER_KEY_SOURCE = savedEnvSource;
      resetMasterKeyCache();
    }
  });

  it("PRODUCTION default path (no injected key, only the env master key) encrypts at rest", () => {
    // Mirrors friday-hub-bootstrap.ts:2815 exactly: `createFridayMcpConfigStore(stateDir)`
    // with NO options. The only key available is the persistent hub master key
    // (here FRIDAY_MASTER_KEY, as prod configures). This proves the default path
    // uses getStrictMasterKey() and does NOT silently no-op to plaintext.
    const savedEnvKey = process.env.FRIDAY_MASTER_KEY;
    const savedEnvSource = process.env.FRIDAY_MASTER_KEY_SOURCE;
    delete process.env.FRIDAY_MASTER_KEY_SOURCE;
    process.env.FRIDAY_MASTER_KEY = MASTER_KEY.toString("hex");
    resetMasterKeyCache();
    try {
      const store = createFridayMcpConfigStore(testDir); // no options — identical to bootstrap:2815
      store.save([makeServer({ id: "gh", env: { GITHUB_TOKEN: MCP_SECRET_CANARY } })]);
      const raw = readFileSync(configPath(), "utf8");
      expect(raw).not.toContain(MCP_SECRET_CANARY);
      expect(raw).toContain("secret://");
      // The default resolver round-trips too (real hub key decrypts).
      expect(store.load()[0]!.env!.GITHUB_TOKEN).toBe(MCP_SECRET_CANARY);
    } finally {
      if (savedEnvKey !== undefined) process.env.FRIDAY_MASTER_KEY = savedEnvKey;
      else delete process.env.FRIDAY_MASTER_KEY;
      if (savedEnvSource !== undefined) process.env.FRIDAY_MASTER_KEY_SOURCE = savedEnvSource;
      resetMasterKeyCache();
    }
  });

  it("tolerates legacy plaintext, reports residue, and re-encrypts on next save", () => {
    // Simulate a pre-encryption config file that embedded a plaintext env secret.
    writeFileSync(
      configPath(),
      JSON.stringify([{ id: "legacy", command: "node", env: { GITHUB_TOKEN: MCP_SECRET_CANARY } }]),
      "utf8",
    );

    const residue: Array<{ serverId: string; reason: string }> = [];
    const store = createFridayMcpConfigStore(testDir, {
      masterKey: MASTER_KEY,
      onSecretResidue: (entries) => residue.push(...entries),
    });

    const loaded = store.load();
    // Legacy plaintext is returned as-is so the server stays usable...
    expect(loaded[0]!.env!.GITHUB_TOKEN).toBe(MCP_SECRET_CANARY);
    // ...and the residue is reported (legacy-plaintext).
    expect(residue.length).toBeGreaterThan(0);
    expect(residue.some((r) => r.reason === "legacy-plaintext")).toBe(true);

    // Re-encrypted on next save → plaintext no longer at rest.
    store.save(loaded);
    const raw = readFileSync(configPath(), "utf8");
    expect(raw).not.toContain(MCP_SECRET_CANARY);
    expect(raw).toContain("secret://");
  });
});
