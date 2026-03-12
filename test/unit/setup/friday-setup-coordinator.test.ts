import { describe, it, expect } from "vitest";
import { createFridaySetupCoordinator } from "../../../src/setup/friday-setup-coordinator.js";

let counter = 0;
function idGen(): string {
  return `id-${++counter}`;
}
function nowIso(): string {
  return "2026-03-11T10:00:00Z";
}

describe("FridaySetupCoordinator", () => {
  function create() {
    counter = 0;
    return createFridaySetupCoordinator({ idGenerator: idGen, nowIso });
  }

  describe("createSession", () => {
    it("should create a new coordination session", () => {
      const coord = create();
      const session = coord.createSession("recipe-1", "exec-1");

      expect(session.id).toBe("id-1");
      expect(session.recipeId).toBe("recipe-1");
      expect(session.executionId).toBe("exec-1");
      expect(session.phase).toBe("idle");
      expect(session.activeDomain).toBeNull();
      expect(session.handoffHistory).toHaveLength(0);
      expect(session.sharedContext).toEqual({});
    });
  });

  describe("acquireDomain", () => {
    it("should acquire a domain for the session", () => {
      const coord = create();
      const session = coord.createSession("recipe-1", "exec-1");
      const result = coord.acquireDomain(session.id, "browser", "Starting browser automation");

      expect(result).not.toBeNull();
      expect(result!.phase).toBe("acquired");
      expect(result!.activeDomain).toBe("browser");
      expect(result!.handoffHistory).toHaveLength(1);
    });

    it("should refuse acquisition when another domain holds control", () => {
      const coord = create();
      const session = coord.createSession("recipe-1", "exec-1");
      coord.acquireDomain(session.id, "browser");
      const result = coord.acquireDomain(session.id, "desktop");

      expect(result).toBeNull();
    });

    it("should allow re-acquiring the same domain", () => {
      const coord = create();
      const session = coord.createSession("recipe-1", "exec-1");
      coord.acquireDomain(session.id, "browser");
      const result = coord.acquireDomain(session.id, "browser");

      expect(result).not.toBeNull();
      expect(result!.activeDomain).toBe("browser");
    });

    it("should return null for unknown session", () => {
      const coord = create();
      expect(coord.acquireDomain("nonexistent", "browser")).toBeNull();
    });

    it("should return null for released session", () => {
      const coord = create();
      const session = coord.createSession("recipe-1", "exec-1");
      coord.closeSession(session.id);
      expect(coord.acquireDomain(session.id, "browser")).toBeNull();
    });
  });

  describe("handoff", () => {
    it("should hand off control between domains", () => {
      const coord = create();
      const session = coord.createSession("recipe-1", "exec-1");
      coord.acquireDomain(session.id, "system", "Launch Chrome");

      const result = coord.handoff(session.id, {
        from: "system",
        to: "browser",
        reason: "Chrome launched, handing off to browser for navigation",
      });

      expect(result).not.toBeNull();
      expect(result!.activeDomain).toBe("browser");
      expect(result!.handoffHistory).toHaveLength(2); // acquire + handoff
      expect(result!.handoffHistory[1].from).toBe("system");
      expect(result!.handoffHistory[1].to).toBe("browser");
    });

    it("should transfer data during handoff", () => {
      const coord = create();
      const session = coord.createSession("recipe-1", "exec-1");
      coord.acquireDomain(session.id, "browser");

      const result = coord.handoff(session.id, {
        from: "browser",
        to: "desktop",
        reason: "Need to handle OS dialog",
        transferData: { url: "https://discord.com", token: "abc123" },
      });

      expect(result).not.toBeNull();
      expect(result!.sharedContext.url).toBe("https://discord.com");
      expect(result!.sharedContext.token).toBe("abc123");
    });

    it("should refuse handoff if from domain doesn't match active domain", () => {
      const coord = create();
      const session = coord.createSession("recipe-1", "exec-1");
      coord.acquireDomain(session.id, "browser");

      const result = coord.handoff(session.id, {
        from: "desktop",
        to: "exec",
        reason: "Invalid handoff",
      });

      expect(result).toBeNull();
    });
  });

  describe("releaseDomain", () => {
    it("should release the current domain", () => {
      const coord = create();
      const session = coord.createSession("recipe-1", "exec-1");
      coord.acquireDomain(session.id, "browser");
      const result = coord.releaseDomain(session.id);

      expect(result).not.toBeNull();
      expect(result!.phase).toBe("idle");
      expect(result!.activeDomain).toBeNull();
    });
  });

  describe("setSharedContext", () => {
    it("should set shared context values", () => {
      const coord = create();
      const session = coord.createSession("recipe-1", "exec-1");
      coord.setSharedContext(session.id, "botToken", "xoxb-abc123");

      const retrieved = coord.getSession(session.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.sharedContext.botToken).toBe("xoxb-abc123");
    });

    it("should refuse updates on failed sessions", () => {
      const coord = create();
      const session = coord.createSession("recipe-1", "exec-1");
      coord.failSession(session.id, "Something went wrong");

      const result = coord.setSharedContext(session.id, "key", "value");
      expect(result).toBeNull();
    });
  });

  describe("failSession", () => {
    it("should mark the session as failed", () => {
      const coord = create();
      const session = coord.createSession("recipe-1", "exec-1");
      coord.acquireDomain(session.id, "browser");
      const result = coord.failSession(session.id, "Browser crashed");

      expect(result).not.toBeNull();
      expect(result!.phase).toBe("failed");
      expect(result!.activeDomain).toBeNull();
    });
  });

  describe("closeSession", () => {
    it("should close the session cleanly", () => {
      const coord = create();
      const session = coord.createSession("recipe-1", "exec-1");
      const result = coord.closeSession(session.id);

      expect(result).not.toBeNull();
      expect(result!.phase).toBe("released");
      expect(result!.activeDomain).toBeNull();
    });
  });

  describe("getSession", () => {
    it("should return null for unknown session", () => {
      const coord = create();
      expect(coord.getSession("nonexistent")).toBeNull();
    });

    it("should return current session state", () => {
      const coord = create();
      const session = coord.createSession("recipe-1", "exec-1");
      coord.acquireDomain(session.id, "desktop");

      const result = coord.getSession(session.id);
      expect(result).not.toBeNull();
      expect(result!.activeDomain).toBe("desktop");
    });
  });
});
