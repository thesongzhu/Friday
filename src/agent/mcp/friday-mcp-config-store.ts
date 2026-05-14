import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { FridayMcpServerConfig } from "./friday-mcp-adapter.types.js";

const CONFIG_FILENAME = "mcp-servers.json";

export interface FridayMcpConfigStore {
  load(): FridayMcpServerConfig[];
  save(configs: FridayMcpServerConfig[]): void;
  addServer(config: FridayMcpServerConfig): FridayMcpServerConfig[];
  removeServer(id: string): FridayMcpServerConfig[];
}

export function createFridayMcpConfigStore(stateDir: string): FridayMcpConfigStore {
  const filePath = join(stateDir, CONFIG_FILENAME);

  function load(): FridayMcpServerConfig[] {
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isValidServerConfig);
    } catch {
      return [];
    }
  }

  function save(configs: FridayMcpServerConfig[]): void {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(configs, null, 2), "utf8");
  }

  function addServer(config: FridayMcpServerConfig): FridayMcpServerConfig[] {
    const existing = load();
    const filtered = existing.filter((s) => s.id !== config.id);
    const updated = [...filtered, config];
    save(updated);
    return updated;
  }

  function removeServer(id: string): FridayMcpServerConfig[] {
    const existing = load();
    const updated = existing.filter((s) => s.id !== id);
    save(updated);
    return updated;
  }

  return { load, save, addServer, removeServer };
}

function isValidServerConfig(value: unknown): value is FridayMcpServerConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.id === "string" && obj.id.trim().length > 0;
}
