import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createFridayMcpConfigStore } from "../../../../src/agent/mcp/friday-mcp-config-store.js";
import type { FridayMcpServerConfig } from "../../../../src/agent/mcp/friday-mcp-adapter.types.js";

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
