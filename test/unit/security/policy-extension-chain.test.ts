import { describe, it, expect } from "vitest";
import {
  evaluatePolicyExtensionChain,
  PolicyExtensionChain,
} from "../../../src/security/policy-extension-chain.js";
import type {
  PolicyExtension,
  PolicyExtensionContext,
  CorePolicyDecision,
} from "../../../src/security/policy-extension-chain.js";

// ─── Test Helpers ───

function makeContext(overrides?: Partial<PolicyExtensionContext>): PolicyExtensionContext {
  return {
    principalId: "user-1",
    resource: "document",
    action: "read",
    ...overrides,
  };
}

function makeExtension(
  name: string,
  decision: "pass" | "deny" | "abstain",
): PolicyExtension {
  return {
    name,
    evaluate: () => decision,
  };
}

/**
 * Create an extension that records the context it receives and returns
 * the given decision. Useful for verifying context pass-through.
 */
function makeSpyExtension(
  name: string,
  decision: "pass" | "deny" | "abstain",
): PolicyExtension & { receivedContexts: PolicyExtensionContext[] } {
  const receivedContexts: PolicyExtensionContext[] = [];
  return {
    name,
    receivedContexts,
    evaluate(context: PolicyExtensionContext) {
      receivedContexts.push(context);
      return decision;
    },
  };
}

// ─── Tests ───

describe("PolicyExtensionChain", () => {
  // ═══════════════════════════════════════════════════════════════
  // CORE: Extension can deny what core allowed
  // ═══════════════════════════════════════════════════════════════

  describe("extension can deny what core allowed", () => {
    it("single extension denying overrides core allow", () => {
      const ext = makeExtension("rate-limiter", "deny");
      const result = evaluatePolicyExtensionChain("allow", [ext], makeContext());

      expect(result.decision).toBe("deny");
      expect(result.coreDecision).toBe("allow");
      expect(result.decidedBy).toBe("rate-limiter");
      expect(result.overriddenByExtension).toBe(true);
      expect(result.evaluations).toHaveLength(1);
      expect(result.evaluations[0]).toEqual({
        extensionName: "rate-limiter",
        decision: "deny",
      });
    });

    it("deny extension after passing extensions still denies", () => {
      const extensions: PolicyExtension[] = [
        makeExtension("geo-check", "pass"),
        makeExtension("rate-limiter", "deny"),
      ];
      const result = evaluatePolicyExtensionChain("allow", extensions, makeContext());

      expect(result.decision).toBe("deny");
      expect(result.decidedBy).toBe("rate-limiter");
      expect(result.overriddenByExtension).toBe(true);
      expect(result.evaluations).toHaveLength(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // CORE: Extension cannot allow what core denied
  // ═══════════════════════════════════════════════════════════════

  describe("extension cannot allow what core denied", () => {
    it("core deny is preserved even when extension passes", () => {
      const ext = makeExtension("lenient-ext", "pass");
      const result = evaluatePolicyExtensionChain("deny", [ext], makeContext());

      expect(result.decision).toBe("deny");
      expect(result.coreDecision).toBe("deny");
      expect(result.decidedBy).toBeNull();
      expect(result.overriddenByExtension).toBe(false);
    });

    it("core deny is preserved even when all extensions abstain", () => {
      const extensions: PolicyExtension[] = [
        makeExtension("ext-a", "abstain"),
        makeExtension("ext-b", "abstain"),
      ];
      const result = evaluatePolicyExtensionChain("deny", extensions, makeContext());

      expect(result.decision).toBe("deny");
      expect(result.coreDecision).toBe("deny");
      expect(result.decidedBy).toBeNull();
      expect(result.overriddenByExtension).toBe(false);
      // All extensions still evaluated for audit
      expect(result.evaluations).toHaveLength(2);
    });

    it("core deny is preserved even when extension returns deny too", () => {
      const ext = makeExtension("strict-ext", "deny");
      const result = evaluatePolicyExtensionChain("deny", [ext], makeContext());

      expect(result.decision).toBe("deny");
      // decidedBy is null because core already denied — extension did not trigger it
      expect(result.decidedBy).toBeNull();
      expect(result.overriddenByExtension).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // CORE: Multiple extensions — first deny wins
  // ═══════════════════════════════════════════════════════════════

  describe("multiple extensions: first deny wins", () => {
    it("first denying extension short-circuits the chain", () => {
      const spyThird = makeSpyExtension("third-ext", "deny");
      const extensions: PolicyExtension[] = [
        makeExtension("first-ext", "pass"),
        makeExtension("second-ext", "deny"),
        spyThird,
      ];
      const result = evaluatePolicyExtensionChain("allow", extensions, makeContext());

      expect(result.decision).toBe("deny");
      expect(result.decidedBy).toBe("second-ext");
      expect(result.overriddenByExtension).toBe(true);
      // Only first two extensions evaluated (short-circuit on second)
      expect(result.evaluations).toHaveLength(2);
      expect(result.evaluations[0]).toEqual({ extensionName: "first-ext", decision: "pass" });
      expect(result.evaluations[1]).toEqual({ extensionName: "second-ext", decision: "deny" });
      // Third extension never called
      expect(spyThird.receivedContexts).toHaveLength(0);
    });

    it("first extension denying stops evaluation immediately", () => {
      const spySecond = makeSpyExtension("second-ext", "pass");
      const extensions: PolicyExtension[] = [
        makeExtension("first-ext", "deny"),
        spySecond,
      ];
      const result = evaluatePolicyExtensionChain("allow", extensions, makeContext());

      expect(result.decision).toBe("deny");
      expect(result.decidedBy).toBe("first-ext");
      expect(result.evaluations).toHaveLength(1);
      expect(spySecond.receivedContexts).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // CORE: All abstain → original decision preserved
  // ═══════════════════════════════════════════════════════════════

  describe("all abstain preserves original decision", () => {
    it("core allow preserved when all extensions abstain", () => {
      const extensions: PolicyExtension[] = [
        makeExtension("ext-a", "abstain"),
        makeExtension("ext-b", "abstain"),
        makeExtension("ext-c", "abstain"),
      ];
      const result = evaluatePolicyExtensionChain("allow", extensions, makeContext());

      expect(result.decision).toBe("allow");
      expect(result.coreDecision).toBe("allow");
      expect(result.decidedBy).toBeNull();
      expect(result.overriddenByExtension).toBe(false);
      expect(result.evaluations).toHaveLength(3);
      for (const evaluation of result.evaluations) {
        expect(evaluation.decision).toBe("abstain");
      }
    });

    it("core allow preserved when all extensions pass", () => {
      const extensions: PolicyExtension[] = [
        makeExtension("ext-a", "pass"),
        makeExtension("ext-b", "pass"),
      ];
      const result = evaluatePolicyExtensionChain("allow", extensions, makeContext());

      expect(result.decision).toBe("allow");
      expect(result.decidedBy).toBeNull();
      expect(result.overriddenByExtension).toBe(false);
    });

    it("core allow preserved with no extensions at all", () => {
      const result = evaluatePolicyExtensionChain("allow", [], makeContext());

      expect(result.decision).toBe("allow");
      expect(result.coreDecision).toBe("allow");
      expect(result.decidedBy).toBeNull();
      expect(result.overriddenByExtension).toBe(false);
      expect(result.evaluations).toHaveLength(0);
    });

    it("core deny preserved with no extensions", () => {
      const result = evaluatePolicyExtensionChain("deny", [], makeContext());

      expect(result.decision).toBe("deny");
      expect(result.coreDecision).toBe("deny");
      expect(result.evaluations).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // CORE: Context is passed through chain
  // ═══════════════════════════════════════════════════════════════

  describe("context is passed through chain", () => {
    it("each extension receives the full context object", () => {
      const context = makeContext({
        principalId: "admin-42",
        resource: "secret",
        action: "write",
        resourceId: "secret-99",
        attributes: { environment: "production", clearanceLevel: 5 },
      });

      const spy1 = makeSpyExtension("ext-1", "pass");
      const spy2 = makeSpyExtension("ext-2", "abstain");
      const result = evaluatePolicyExtensionChain("allow", [spy1, spy2], context);

      expect(result.decision).toBe("allow");

      // Both extensions received the exact same context
      expect(spy1.receivedContexts).toHaveLength(1);
      expect(spy2.receivedContexts).toHaveLength(1);
      expect(spy1.receivedContexts[0]).toBe(context);
      expect(spy2.receivedContexts[0]).toBe(context);

      // Verify all fields were passed through
      expect(spy1.receivedContexts[0].principalId).toBe("admin-42");
      expect(spy1.receivedContexts[0].resource).toBe("secret");
      expect(spy1.receivedContexts[0].action).toBe("write");
      expect(spy1.receivedContexts[0].resourceId).toBe("secret-99");
      expect(spy1.receivedContexts[0].attributes).toEqual({
        environment: "production",
        clearanceLevel: 5,
      });
    });

    it("context is included in the result for audit", () => {
      const context = makeContext({ principalId: "svc-worker", resource: "queue", action: "consume" });
      const result = evaluatePolicyExtensionChain("allow", [], context);

      expect(result.context).toBe(context);
      expect(result.context.principalId).toBe("svc-worker");
      expect(result.context.resource).toBe("queue");
      expect(result.context.action).toBe("consume");
    });

    it("denying extension receives context before short-circuit", () => {
      const context = makeContext({ principalId: "user-blocked" });
      const spy = makeSpyExtension("blocker", "deny");
      const result = evaluatePolicyExtensionChain("allow", [spy], context);

      expect(result.decision).toBe("deny");
      expect(spy.receivedContexts).toHaveLength(1);
      expect(spy.receivedContexts[0]).toBe(context);
      expect(spy.receivedContexts[0].principalId).toBe("user-blocked");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // AUDITABILITY
  // ═══════════════════════════════════════════════════════════════

  describe("auditability", () => {
    it("records the evaluation of every extension when core allows and all pass", () => {
      const extensions: PolicyExtension[] = [
        makeExtension("ext-a", "pass"),
        makeExtension("ext-b", "abstain"),
        makeExtension("ext-c", "pass"),
      ];
      const result = evaluatePolicyExtensionChain("allow", extensions, makeContext());

      expect(result.evaluations).toEqual([
        { extensionName: "ext-a", decision: "pass" },
        { extensionName: "ext-b", decision: "abstain" },
        { extensionName: "ext-c", decision: "pass" },
      ]);
    });

    it("records all extensions evaluated when core denies (audit completeness)", () => {
      const extensions: PolicyExtension[] = [
        makeExtension("ext-a", "pass"),
        makeExtension("ext-b", "deny"),
        makeExtension("ext-c", "abstain"),
      ];
      const result = evaluatePolicyExtensionChain("deny", extensions, makeContext());

      // When core denies, ALL extensions are still evaluated for audit
      expect(result.evaluations).toHaveLength(3);
      expect(result.evaluations[0]).toEqual({ extensionName: "ext-a", decision: "pass" });
      expect(result.evaluations[1]).toEqual({ extensionName: "ext-b", decision: "deny" });
      expect(result.evaluations[2]).toEqual({ extensionName: "ext-c", decision: "abstain" });
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // CLASS API: PolicyExtensionChain
  // ═══════════════════════════════════════════════════════════════

  describe("PolicyExtensionChain class", () => {
    it("evaluates through the class interface", () => {
      const chain = new PolicyExtensionChain([
        makeExtension("ext-a", "pass"),
        makeExtension("ext-b", "deny"),
      ]);

      const result = chain.evaluate("allow", makeContext());

      expect(result.decision).toBe("deny");
      expect(result.decidedBy).toBe("ext-b");
      expect(result.overriddenByExtension).toBe(true);
    });

    it("exposes extension names for diagnostics", () => {
      const chain = new PolicyExtensionChain([
        makeExtension("geo-fence", "pass"),
        makeExtension("rate-limit", "abstain"),
        makeExtension("ip-block", "deny"),
      ]);

      expect(chain.extensionNames).toEqual(["geo-fence", "rate-limit", "ip-block"]);
    });

    it("is reusable across multiple evaluations", () => {
      const chain = new PolicyExtensionChain([
        makeExtension("audit-ext", "pass"),
      ]);

      const r1 = chain.evaluate("allow", makeContext({ principalId: "user-1" }));
      const r2 = chain.evaluate("deny", makeContext({ principalId: "user-2" }));
      const r3 = chain.evaluate("allow", makeContext({ principalId: "user-3" }));

      expect(r1.decision).toBe("allow");
      expect(r2.decision).toBe("deny");
      expect(r3.decision).toBe("allow");

      expect(r1.context.principalId).toBe("user-1");
      expect(r2.context.principalId).toBe("user-2");
      expect(r3.context.principalId).toBe("user-3");
    });

    it("handles empty extension list", () => {
      const chain = new PolicyExtensionChain([]);
      const result = chain.evaluate("allow", makeContext());

      expect(result.decision).toBe("allow");
      expect(result.evaluations).toHaveLength(0);
      expect(chain.extensionNames).toEqual([]);
    });
  });
});
