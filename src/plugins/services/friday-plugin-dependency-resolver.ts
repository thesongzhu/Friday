/**
 * Dependency resolver: topological sort, semver checking, circular detection.
 *
 * Algorithm (from design doc):
 * 1. Start from target plugin(s); recursively expand `dependencies`.
 * 2. For each dependency edge (A -> B@range):
 *    - If B missing: emit PLUGIN_DEPENDENCY_MISSING.
 *    - If found but !semver.satisfies(B.version, range): emit PLUGIN_DEPENDENCY_VERSION_MISMATCH.
 * 3. Build DAG with edge B -> A (dependency loads before dependent).
 * 4. Run Kahn topological sort with lexical tie-break on plugin id.
 * 5. If unresolved nodes remain: run DFS to extract cycle and throw PLUGIN_DEPENDENCY_CYCLE.
 * 6. Return ordered load/install plan.
 */

import * as semver from "semver";

import { FridayDomainError } from "#errors";
import type {
  FridayPluginEntity,
  FridayPluginLoadPlan,
} from "../model/friday-plugin.types.js";
import { FRIDAY_PLUGIN_ERROR_CODES } from "../model/friday-plugin.types.js";

// ─── Types ───

export interface FridayPluginDependencyResolver {
  /** Resolves a load order for the given plugin IDs (or all enabled). */
  resolveLoadOrder(plugins: FridayPluginEntity[], pluginIds?: string[]): FridayPluginLoadPlan;
}

export interface CreateFridayPluginDependencyResolverDeps {
  /** Override semver satisfies for testing. */
  satisfies?: (version: string, range: string) => boolean;
}

// ─── Factory ───

export function createFridayPluginDependencyResolver(
  deps?: CreateFridayPluginDependencyResolverDeps,
): FridayPluginDependencyResolver {
  const satisfies = deps?.satisfies ?? ((v: string, r: string) => semver.satisfies(v, r));

  return {
    resolveLoadOrder(plugins: FridayPluginEntity[], pluginIds?: string[]): FridayPluginLoadPlan {
      const warnings: string[] = [];

      // Build lookup map
      const pluginMap = new Map<string, FridayPluginEntity>();
      for (const p of plugins) {
        pluginMap.set(p.id, p);
      }

      // Determine target set
      const targetIds = pluginIds ?? [...pluginMap.keys()];
      const relevantIds = new Set<string>();

      // Recursively expand dependencies
      function expand(id: string, visited: Set<string>): void {
        if (relevantIds.has(id)) return;
        if (visited.has(id)) return; // cycle guard during expansion
        visited.add(id);

        const plugin = pluginMap.get(id);
        if (!plugin) {
          throw new FridayDomainError(
            FRIDAY_PLUGIN_ERROR_CODES.DEPENDENCY_MISSING,
            `Plugin "${id}" not found in registry`,
            { httpStatus: 400, details: { pluginId: id } },
          );
        }

        relevantIds.add(id);

        const deps = plugin.manifest.dependencies ?? {};
        for (const [depId, range] of Object.entries(deps)) {
          const depPlugin = pluginMap.get(depId);
          if (!depPlugin) {
            throw new FridayDomainError(
              FRIDAY_PLUGIN_ERROR_CODES.DEPENDENCY_MISSING,
              `Plugin "${id}" depends on "${depId}" which is not installed`,
              { httpStatus: 400, details: { pluginId: id, dependencyId: depId, range } },
            );
          }

          if (!satisfies(depPlugin.version, range)) {
            throw new FridayDomainError(
              FRIDAY_PLUGIN_ERROR_CODES.DEPENDENCY_VERSION_MISMATCH,
              `Plugin "${id}" requires "${depId}@${range}" but found version ${depPlugin.version}`,
              {
                httpStatus: 400,
                details: {
                  pluginId: id,
                  dependencyId: depId,
                  requiredRange: range,
                  installedVersion: depPlugin.version,
                },
              },
            );
          }

          expand(depId, visited);
        }
      }

      for (const id of targetIds) {
        expand(id, new Set<string>());
      }

      // Build adjacency list: edge from dependency -> dependent
      // inDegree: how many deps does each node have
      const adjacency = new Map<string, Set<string>>();
      const inDegree = new Map<string, number>();

      for (const id of relevantIds) {
        if (!adjacency.has(id)) adjacency.set(id, new Set());
        if (!inDegree.has(id)) inDegree.set(id, 0);
      }

      for (const id of relevantIds) {
        const plugin = pluginMap.get(id);
        if (!plugin) continue;
        const deps = plugin.manifest.dependencies ?? {};
        for (const depId of Object.keys(deps)) {
          if (!relevantIds.has(depId)) continue;
          // Edge: depId -> id (dep loads before dependent)
          adjacency.get(depId)!.add(id);
          inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
        }
      }

      // Kahn's algorithm with lexical tie-break
      const queue: string[] = [];
      for (const [id, degree] of inDegree) {
        if (degree === 0) queue.push(id);
      }
      queue.sort(); // lexical tie-break

      const order: string[] = [];
      while (queue.length > 0) {
        const current = queue.shift()!;
        order.push(current);

        const neighbors = adjacency.get(current) ?? new Set();
        const nextBatch: string[] = [];
        for (const neighbor of neighbors) {
          const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
          inDegree.set(neighbor, newDegree);
          if (newDegree === 0) {
            nextBatch.push(neighbor);
          }
        }
        // Insert new zero-degree nodes maintaining sorted order
        nextBatch.sort();
        for (const n of nextBatch) {
          // Binary insert to maintain sorted queue
          const insertIdx = queue.findIndex((q) => q > n);
          if (insertIdx === -1) {
            queue.push(n);
          } else {
            queue.splice(insertIdx, 0, n);
          }
        }
      }

      // Check for cycles
      if (order.length < relevantIds.size) {
        // Extract cycle via DFS
        const remaining = new Set<string>();
        for (const id of relevantIds) {
          if (!order.includes(id)) remaining.add(id);
        }

        const cycle = extractCycle(remaining, pluginMap);
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.DEPENDENCY_CYCLE,
          `Circular dependency detected: ${cycle.join(" → ")}`,
          { httpStatus: 400, details: { cycle } },
        );
      }

      return { order, warnings };
    },
  };
}

// ─── Helpers ───

function extractCycle(
  remaining: Set<string>,
  pluginMap: Map<string, FridayPluginEntity>,
): string[] {
  const visited = new Set<string>();
  const stack = new Set<string>();
  const path: string[] = [];

  function dfs(id: string): string[] | null {
    visited.add(id);
    stack.add(id);
    path.push(id);

    const plugin = pluginMap.get(id);
    if (plugin) {
      const deps = plugin.manifest.dependencies ?? {};
      for (const depId of Object.keys(deps)) {
        if (!remaining.has(depId)) continue;
        if (stack.has(depId)) {
          // Found cycle
          const cycleStart = path.indexOf(depId);
          return [...path.slice(cycleStart), depId];
        }
        if (!visited.has(depId)) {
          const result = dfs(depId);
          if (result) return result;
        }
      }
    }

    path.pop();
    stack.delete(id);
    return null;
  }

  for (const id of remaining) {
    if (!visited.has(id)) {
      const result = dfs(id);
      if (result) return result;
    }
  }

  return [...remaining]; // fallback
}
