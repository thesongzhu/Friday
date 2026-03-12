/**
 * Navigation Manager — Information architecture, route management,
 * breadcrumbs, and navigation state tracking.
 *
 * Provides a centralized registry for application routes with
 * hierarchical breadcrumb resolution and navigation history.
 *
 * @module uix/engine
 */

import type {
  ISODateTime,
  JsonObject,
} from "../model/friday-uix.types.js";

// ─── Types ───

/** Visibility of a navigation node in menus. */
export type NavigationNodeVisibility = "visible" | "hidden" | "collapsed";

/** Badge type displayed on a navigation node. */
export interface NavigationBadge {
  /** Badge label (e.g., "3", "NEW"). */
  label: string;
  /** Badge variant for styling. */
  variant: "info" | "warning" | "error" | "success";
}

/** A single node in the navigation tree. */
export interface NavigationNode {
  /** Unique route identifier. */
  id: string;
  /** Human-readable label shown in the navigation. */
  label: string;
  /** Route path (e.g., "/settings/notifications"). */
  path: string;
  /** Icon identifier (emoji or icon name). */
  icon?: string;
  /** Parent node ID (undefined for root-level nodes). */
  parentId?: string;
  /** Sort order within siblings. Lower = shown first. */
  sortOrder: number;
  /** Visibility in navigation menus. */
  visibility: NavigationNodeVisibility;
  /** Optional badge overlay. */
  badge?: NavigationBadge;
  /** Required roles/scopes to see this node. Empty = unrestricted. */
  requiredScopes: string[];
  /** Arbitrary metadata attached to this node. */
  metadata: JsonObject;
}

/** Breadcrumb entry for display. */
export interface Breadcrumb {
  /** Node ID. */
  id: string;
  /** Display label. */
  label: string;
  /** Route path. */
  path: string;
  /** Icon identifier. */
  icon?: string;
}

/** A recorded navigation event in the history stack. */
export interface NavigationHistoryEntry {
  /** Route path navigated to. */
  path: string;
  /** Node ID (if matched). */
  nodeId?: string;
  /** When the navigation occurred. */
  timestamp: ISODateTime;
}

/** Read/write interface for the navigation manager. */
export interface NavigationManager {
  // ─── Node Registry ───
  registerNode(node: NavigationNode): void;
  unregisterNode(id: string): boolean;
  getNode(id: string): NavigationNode | undefined;
  getNodeByPath(path: string): NavigationNode | undefined;
  getRootNodes(): NavigationNode[];
  getChildren(parentId: string): NavigationNode[];
  getAllNodes(): NavigationNode[];

  // ─── Breadcrumbs ───
  getBreadcrumbs(nodeId: string): Breadcrumb[];

  // ─── Navigation State ───
  navigateTo(path: string): NavigationNode | undefined;
  getCurrentPath(): string | undefined;
  getCurrentNode(): NavigationNode | undefined;

  // ─── History ───
  getHistory(): NavigationHistoryEntry[];
  goBack(): NavigationHistoryEntry | undefined;
  clearHistory(): void;

  // ─── Filtering ───
  getVisibleNodes(userScopes: string[]): NavigationNode[];
}

// ─── Factory ───

/** Maximum navigation history entries retained. */
const MAX_HISTORY = 50;

function deepFreeze(value: object, seen: WeakSet<object>): void {
  if (seen.has(value)) return;
  seen.add(value);

  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") {
      deepFreeze(child, seen);
    }
  }

  Object.freeze(value);
}

function cloneAndFreeze<T>(value: T): T {
  const cloned = structuredClone(value);
  if (cloned !== null && typeof cloned === "object") {
    deepFreeze(cloned, new WeakSet());
  }
  return cloned;
}

/** Create a navigation manager instance. */
export function createNavigationManager(): NavigationManager {
  const nodesById = new Map<string, NavigationNode>();
  const nodesByPath = new Map<string, NavigationNode>();
  /** Re-registration counter for deterministic path replacement. */
  const nodeRegistrationOrder = new Map<string, number>();
  const history: NavigationHistoryEntry[] = [];
  let currentIndex = -1;
  let registrationCounter = 0;

  function sortedByOrder(nodes: NavigationNode[]): NavigationNode[] {
    return nodes.slice().sort((a, b) => a.sortOrder - b.sortOrder);
  }

  function findLatestNodeForPath(path: string): NavigationNode | undefined {
    let latestNode: NavigationNode | undefined;
    let latestOrder: number | undefined;

    for (const [id, node] of nodesById) {
      if (node.path !== path) continue;
      const order = nodeRegistrationOrder.get(id);
      if (order === undefined) continue;
      if (latestOrder === undefined || order > latestOrder) {
        latestOrder = order;
        latestNode = node;
      }
    }

    return latestNode;
  }

  function reindexPath(path: string): void {
    const latestNode = findLatestNodeForPath(path);
    if (latestNode === undefined) {
      nodesByPath.delete(path);
      return;
    }
    nodesByPath.set(path, latestNode);
  }

  return {
    // ─── Node Registry ───

    registerNode(node) {
      const existing = nodesById.get(node.id);
      const storedNode = structuredClone(node);
      nodesById.set(storedNode.id, storedNode);
      nodeRegistrationOrder.set(storedNode.id, ++registrationCounter);
      nodesByPath.set(storedNode.path, storedNode);

      if (existing && existing.path !== storedNode.path) {
        if (nodesByPath.get(existing.path)?.id === storedNode.id) {
          reindexPath(existing.path);
        }
      }
    },

    unregisterNode(id) {
      const node = nodesById.get(id);
      if (!node) return false;
      nodesById.delete(id);
      nodeRegistrationOrder.delete(id);

      if (nodesByPath.get(node.path)?.id === id) {
        reindexPath(node.path);
      }
      return true;
    },

    getNode(id) {
      const node = nodesById.get(id);
      return node !== undefined ? cloneAndFreeze(node) : undefined;
    },

    getNodeByPath(path) {
      const node = nodesByPath.get(path);
      return node !== undefined ? cloneAndFreeze(node) : undefined;
    },

    getRootNodes() {
      const roots: NavigationNode[] = [];
      for (const node of nodesById.values()) {
        if (node.parentId === undefined) roots.push(node);
      }
      return cloneAndFreeze(sortedByOrder(roots));
    },

    getChildren(parentId) {
      const children: NavigationNode[] = [];
      for (const node of nodesById.values()) {
        if (node.parentId === parentId) children.push(node);
      }
      return cloneAndFreeze(sortedByOrder(children));
    },

    getAllNodes() {
      return cloneAndFreeze(sortedByOrder([...nodesById.values()]));
    },

    // ─── Breadcrumbs ───

    getBreadcrumbs(nodeId) {
      const crumbs: Breadcrumb[] = [];
      let current = nodesById.get(nodeId);
      while (current) {
        crumbs.unshift({
          id: current.id,
          label: current.label,
          path: current.path,
          icon: current.icon,
        });
        current = current.parentId !== undefined
          ? nodesById.get(current.parentId)
          : undefined;
      }
      return cloneAndFreeze(crumbs);
    },

    // ─── Navigation State ───

    navigateTo(path) {
      const node = nodesByPath.get(path);
      const entry: NavigationHistoryEntry = {
        path,
        nodeId: node?.id,
        timestamp: new Date().toISOString(),
      };

      // Truncate forward history when navigating from a back position
      if (currentIndex < history.length - 1) {
        history.splice(currentIndex + 1);
      }

      history.push(entry);
      if (history.length > MAX_HISTORY) {
        history.shift();
      }
      currentIndex = history.length - 1;

      return node !== undefined ? cloneAndFreeze(node) : undefined;
    },

    getCurrentPath() {
      if (currentIndex < 0 || currentIndex >= history.length) return undefined;
      return history[currentIndex].path;
    },

    getCurrentNode() {
      const path = this.getCurrentPath();
      if (path === undefined) return undefined;
      const node = nodesByPath.get(path);
      return node !== undefined ? cloneAndFreeze(node) : undefined;
    },

    // ─── History ───

    getHistory() {
      return cloneAndFreeze(history.slice());
    },

    goBack() {
      if (currentIndex <= 0) return undefined;
      currentIndex--;
      return cloneAndFreeze(history[currentIndex]);
    },

    clearHistory() {
      history.length = 0;
      currentIndex = -1;
    },

    // ─── Filtering ───

    getVisibleNodes(userScopes) {
      const result: NavigationNode[] = [];
      for (const node of nodesById.values()) {
        if (node.visibility === "hidden") continue;
        if (
          node.requiredScopes.length > 0 &&
          !node.requiredScopes.some((s) => userScopes.includes(s))
        ) {
          continue;
        }
        result.push(node);
      }
      return cloneAndFreeze(sortedByOrder(result));
    },
  };
}
