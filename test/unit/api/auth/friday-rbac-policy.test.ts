import { describe, it, expect } from "vitest";
import {
  getScopesForRole,
  roleHasScope,
  principalHasAnyScope,
  principalHasAnyRole,
} from "#api";

describe("FridayRbacPolicy", () => {
  describe("getScopesForRole", () => {
    it("returns all scopes for owner", () => {
      const scopes = getScopesForRole("owner");
      expect(scopes).toContain("hub.admin");
      expect(scopes).toContain("workflow.read");
      expect(scopes).toContain("security.write");
      expect(scopes).toContain("skill.write");
      expect(scopes).toContain("desktop.execute");
      expect(scopes).toContain("playbook.write");
    });

    it("returns all scopes for admin", () => {
      const scopes = getScopesForRole("admin");
      expect(scopes).toContain("hub.admin");
      expect(scopes).toContain("security.write");
      expect(scopes).toContain("desktop.read");
    });

    it("returns limited scopes for operator", () => {
      const scopes = getScopesForRole("operator");
      expect(scopes).toContain("workflow.read");
      expect(scopes).toContain("workflow.write");
      expect(scopes).toContain("workflow.run");
      expect(scopes).toContain("agent.read");
      expect(scopes).toContain("agent.run");
      expect(scopes).toContain("agent.write");
      expect(scopes).toContain("desktop.execute");
      expect(scopes).not.toContain("hub.admin");
      expect(scopes).not.toContain("security.write");
    });

    it("returns read-only scopes for viewer", () => {
      const scopes = getScopesForRole("viewer");
      expect(scopes).toContain("workflow.read");
      expect(scopes).toContain("fleet.read");
      expect(scopes).toContain("desktop.read");
      expect(scopes).not.toContain("workflow.write");
      expect(scopes).not.toContain("workflow.run");
      expect(scopes).not.toContain("hub.admin");
      expect(scopes).not.toContain("desktop.write");
    });
  });

  describe("roleHasScope", () => {
    it("owner has hub.admin", () => {
      expect(roleHasScope("owner", "hub.admin")).toBe(true);
    });

    it("viewer does not have workflow.write", () => {
      expect(roleHasScope("viewer", "workflow.write")).toBe(false);
    });

    it("operator has satellite.read", () => {
      expect(roleHasScope("operator", "satellite.read")).toBe(true);
    });

    it("operator does not have satellite.write", () => {
      expect(roleHasScope("operator", "satellite.write")).toBe(false);
    });

    it("viewer has agent.read but not agent.run", () => {
      expect(roleHasScope("viewer", "agent.read")).toBe(true);
      expect(roleHasScope("viewer", "agent.run")).toBe(false);
    });
  });

  describe("principalHasAnyScope", () => {
    it("returns true when principal has at least one required scope", () => {
      expect(
        principalHasAnyScope(["workflow.read", "workflow.write"], ["workflow.read"]),
      ).toBe(true);
    });

    it("returns false when principal has none of the required scopes", () => {
      expect(
        principalHasAnyScope(["workflow.read"], ["hub.admin", "security.write"]),
      ).toBe(false);
    });
  });

  describe("principalHasAnyRole", () => {
    it("returns true when principal role is in required roles", () => {
      expect(principalHasAnyRole("admin", ["admin", "owner"])).toBe(true);
    });

    it("returns false when principal role is not in required roles", () => {
      expect(principalHasAnyRole("viewer", ["admin", "owner"])).toBe(false);
    });

    it("returns false for undefined role", () => {
      expect(principalHasAnyRole(undefined, ["admin"])).toBe(false);
    });
  });
});
