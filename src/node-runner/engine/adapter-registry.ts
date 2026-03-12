/**
 * NodeRunner Adapter Registry — maps node types to adapter implementations.
 *
 * Supports three-level precedence for adapter resolution:
 * 1. `node.config.adapterKey` — exact match (highest priority).
 * 2. `nodeType:actionType` — compound key (e.g. "action:tool").
 * 3. `nodeType` — fallback by node type alone.
 *
 * Registers built-in adapters (`action:tool`, `ai`) by default, with an
 * explicit opt-out (`registerBuiltIns: false`) for projects that want full
 * control over adapter precedence.
 *
 * @module node-runner/engine
 */

import type {
  FridayNodeAdapter,
  FridayNodeAdapterRegistry,
} from "../model/friday-node-runner.types.js";

import { ToolNodeAdapter } from "./tool-node-adapter.js";
import { AgentNodeAdapter } from "./agent-node-adapter.js";

// ─── Implementation ───

export interface NodeAdapterRegistryOptions {
  registerBuiltIns?: boolean;
}

export class NodeAdapterRegistry implements FridayNodeAdapterRegistry {
  private readonly adapters = new Map<string, FridayNodeAdapter>();

  constructor(options: NodeAdapterRegistryOptions = {}) {
    const { registerBuiltIns = false } = options;
    if (registerBuiltIns) {
      this.register(new ToolNodeAdapter());
      this.register(new AgentNodeAdapter());
    }
  }

  register(adapter: FridayNodeAdapter): void {
    if (!adapter.nodeType) {
      throw new Error("Adapter must have a non-empty nodeType");
    }
    this.adapters.set(adapter.nodeType, adapter);
  }

  get(key: string): FridayNodeAdapter | undefined {
    return this.adapters.get(key);
  }

  resolve(node: { type: string; config?: Record<string, unknown> }): FridayNodeAdapter | undefined {
    // Level 1: exact adapterKey from config
    const adapterKey = node.config?.adapterKey;
    if (typeof adapterKey === "string" && adapterKey) {
      const exact = this.adapters.get(adapterKey);
      if (exact) return exact;
    }

    // Level 2: compound key nodeType:actionType
    const actionType = node.config?.actionType;
    if (typeof actionType === "string" && actionType) {
      const compound = this.adapters.get(`${node.type}:${actionType}`);
      if (compound) return compound;
    }

    // Level 3: fallback by nodeType alone
    return this.adapters.get(node.type);
  }

  listTypes(): string[] {
    return [...this.adapters.keys()];
  }
}
