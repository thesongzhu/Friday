import { describe, it, expect, beforeEach } from "vitest";
import {
  createNavigationManager,
} from "../../../../src/uix/engine/navigation-manager.js";
import type {
  NavigationManager,
  NavigationNode,
} from "../../../../src/uix/engine/navigation-manager.js";

// ─── Fixtures ───

function makeNode(overrides: Partial<NavigationNode> = {}): NavigationNode {
  return {
    id: "node-1",
    label: "Dashboard",
    path: "/dashboard",
    sortOrder: 0,
    visibility: "visible",
    requiredScopes: [],
    metadata: {},
    ...overrides,
  };
}

// ─── Tests ───

describe("NavigationManager", () => {
  let nav: NavigationManager;

  beforeEach(() => {
    nav = createNavigationManager();
  });

  describe("node registry", () => {
    it("registers and retrieves a node by id", () => {
      const node = makeNode();
      nav.registerNode(node);
      expect(nav.getNode("node-1")).toEqual(node);
    });

    it("retrieves a node by path", () => {
      const node = makeNode();
      nav.registerNode(node);
      expect(nav.getNodeByPath("/dashboard")).toEqual(node);
    });

    it("returns undefined for unknown id", () => {
      expect(nav.getNode("unknown")).toBeUndefined();
    });

    it("returns undefined for unknown path", () => {
      expect(nav.getNodeByPath("/unknown")).toBeUndefined();
    });

    it("unregisters a node", () => {
      nav.registerNode(makeNode());
      expect(nav.unregisterNode("node-1")).toBe(true);
      expect(nav.getNode("node-1")).toBeUndefined();
      expect(nav.getNodeByPath("/dashboard")).toBeUndefined();
    });

    it("returns false when unregistering unknown node", () => {
      expect(nav.unregisterNode("unknown")).toBe(false);
    });

    it("returns all nodes sorted by sortOrder", () => {
      nav.registerNode(makeNode({ id: "b", label: "B", path: "/b", sortOrder: 2 }));
      nav.registerNode(makeNode({ id: "a", label: "A", path: "/a", sortOrder: 1 }));
      const all = nav.getAllNodes();
      expect(all.map((n) => n.id)).toEqual(["a", "b"]);
    });

    it("cleans stale path index entries when re-registering an existing id with a new path", () => {
      nav.registerNode(makeNode({ id: "node-1", path: "/old" }));
      nav.registerNode(makeNode({ id: "node-1", path: "/new" }));

      expect(nav.getNodeByPath("/old")).toBeUndefined();
      expect(nav.getNodeByPath("/new")?.id).toBe("node-1");
      expect(nav.navigateTo("/old")).toBeUndefined();
    });

    it("reindexes duplicate paths when the newest owner is removed", () => {
      nav.registerNode(makeNode({ id: "node-a", path: "/shared" }));
      nav.registerNode(makeNode({ id: "node-b", path: "/shared" }));

      expect(nav.getNodeByPath("/shared")?.id).toBe("node-b");
      nav.unregisterNode("node-b");
      expect(nav.getNodeByPath("/shared")?.id).toBe("node-a");
    });
  });

  describe("hierarchy", () => {
    it("returns root nodes (no parentId)", () => {
      nav.registerNode(makeNode({ id: "root", path: "/root", sortOrder: 0 }));
      nav.registerNode(makeNode({ id: "child", path: "/root/child", parentId: "root", sortOrder: 0 }));
      const roots = nav.getRootNodes();
      expect(roots).toHaveLength(1);
      expect(roots[0].id).toBe("root");
    });

    it("returns children sorted by sortOrder", () => {
      nav.registerNode(makeNode({ id: "root", path: "/root" }));
      nav.registerNode(makeNode({ id: "c2", path: "/root/c2", parentId: "root", sortOrder: 2 }));
      nav.registerNode(makeNode({ id: "c1", path: "/root/c1", parentId: "root", sortOrder: 1 }));
      const children = nav.getChildren("root");
      expect(children.map((n) => n.id)).toEqual(["c1", "c2"]);
    });
  });

  describe("breadcrumbs", () => {
    it("builds breadcrumb chain from leaf to root", () => {
      nav.registerNode(makeNode({ id: "home", label: "Home", path: "/" }));
      nav.registerNode(makeNode({ id: "settings", label: "Settings", path: "/settings", parentId: "home" }));
      nav.registerNode(makeNode({ id: "notif", label: "Notifications", path: "/settings/notifications", parentId: "settings" }));

      const crumbs = nav.getBreadcrumbs("notif");
      expect(crumbs).toHaveLength(3);
      expect(crumbs.map((c) => c.label)).toEqual(["Home", "Settings", "Notifications"]);
    });

    it("returns single breadcrumb for root node", () => {
      nav.registerNode(makeNode({ id: "home", label: "Home", path: "/" }));
      const crumbs = nav.getBreadcrumbs("home");
      expect(crumbs).toHaveLength(1);
      expect(crumbs[0].label).toBe("Home");
    });

    it("returns empty for unknown node", () => {
      expect(nav.getBreadcrumbs("unknown")).toEqual([]);
    });
  });

  describe("navigation state", () => {
    it("navigates to a path and tracks current path", () => {
      nav.registerNode(makeNode());
      nav.navigateTo("/dashboard");
      expect(nav.getCurrentPath()).toBe("/dashboard");
    });

    it("returns the current node when navigated to a registered path", () => {
      const node = makeNode();
      nav.registerNode(node);
      nav.navigateTo("/dashboard");
      expect(nav.getCurrentNode()?.id).toBe("node-1");
    });

    it("returns undefined for current path when no navigation has occurred", () => {
      expect(nav.getCurrentPath()).toBeUndefined();
      expect(nav.getCurrentNode()).toBeUndefined();
    });

    it("navigates to unregistered path (returns undefined node)", () => {
      const result = nav.navigateTo("/unknown");
      expect(result).toBeUndefined();
      expect(nav.getCurrentPath()).toBe("/unknown");
    });
  });

  describe("history", () => {
    it("tracks navigation history", () => {
      nav.navigateTo("/a");
      nav.navigateTo("/b");
      nav.navigateTo("/c");
      const history = nav.getHistory();
      expect(history).toHaveLength(3);
      expect(history.map((h) => h.path)).toEqual(["/a", "/b", "/c"]);
    });

    it("goes back in history", () => {
      nav.navigateTo("/a");
      nav.navigateTo("/b");
      const entry = nav.goBack();
      expect(entry?.path).toBe("/a");
      expect(nav.getCurrentPath()).toBe("/a");
    });

    it("returns undefined when going back from first entry", () => {
      nav.navigateTo("/a");
      expect(nav.goBack()).toBeUndefined();
    });

    it("returns undefined when going back with empty history", () => {
      expect(nav.goBack()).toBeUndefined();
    });

    it("truncates forward history when navigating from a back position", () => {
      nav.navigateTo("/a");
      nav.navigateTo("/b");
      nav.navigateTo("/c");
      nav.goBack(); // at /b
      nav.navigateTo("/d"); // should truncate /c
      const history = nav.getHistory();
      expect(history.map((h) => h.path)).toEqual(["/a", "/b", "/d"]);
    });

    it("clears history", () => {
      nav.navigateTo("/a");
      nav.navigateTo("/b");
      nav.clearHistory();
      expect(nav.getHistory()).toHaveLength(0);
      expect(nav.getCurrentPath()).toBeUndefined();
    });
  });

  describe("filtering", () => {
    it("filters out hidden nodes", () => {
      nav.registerNode(makeNode({ id: "visible", visibility: "visible", path: "/v" }));
      nav.registerNode(makeNode({ id: "hidden", visibility: "hidden", path: "/h" }));
      const visible = nav.getVisibleNodes([]);
      expect(visible).toHaveLength(1);
      expect(visible[0].id).toBe("visible");
    });

    it("filters by required scopes", () => {
      nav.registerNode(makeNode({ id: "admin", path: "/admin", requiredScopes: ["admin"] }));
      nav.registerNode(makeNode({ id: "public", path: "/public", requiredScopes: [] }));

      const userNodes = nav.getVisibleNodes(["user"]);
      expect(userNodes.map((n) => n.id)).toEqual(["public"]);

      const adminNodes = nav.getVisibleNodes(["admin"]);
      expect(adminNodes.map((n) => n.id)).toEqual(["admin", "public"]);
    });

    it("includes collapsed nodes", () => {
      nav.registerNode(makeNode({ id: "collapsed", visibility: "collapsed", path: "/c" }));
      const visible = nav.getVisibleNodes([]);
      expect(visible).toHaveLength(1);
    });
  });
});
