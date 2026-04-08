import { describe, expect, it } from "vitest";
import {
  PolicyExtensionChain,
  evaluatePolicyExtensionChain,
  type PolicyExtension,
  type PolicyExtensionContext,
  type PolicyExtensionChainResult,
} from "../../../src/security/policy-extension-chain.js";

function createTestContext(overrides?: Partial<PolicyExtensionContext>): PolicyExtensionContext {
  return {
    principalId: "user-1",
    resource: "skill",
    action: "execute",
    ...overrides,
  };
}

describe("friday grant across surfaces — PolicyExtensionChain end-to-end", () => {
  it("chain with two passing extensions preserves core allow", () => {
    const extensions: PolicyExtension[] = [
      { name: "rate-limiter", evaluate: () => "pass" },
      { name: "geo-fence", evaluate: () => "pass" },
    ];

    const chain = new PolicyExtensionChain(extensions);
    const context = createTestContext();
    const result = chain.evaluate("allow", context);

    expect(result.decision).toBe("allow");
    expect(result.coreDecision).toBe("allow");
    expect(result.decidedBy).toBeNull();
    expect(result.overriddenByExtension).toBe(false);
    expect(result.evaluations).toHaveLength(2);
    expect(result.evaluations[0]!.extensionName).toBe("rate-limiter");
    expect(result.evaluations[0]!.decision).toBe("pass");
    expect(result.evaluations[1]!.extensionName).toBe("geo-fence");
    expect(result.evaluations[1]!.decision).toBe("pass");
    expect(result.context).toBe(context);
  });

  it("chain with deny extension overrides core allow", () => {
    const extensions: PolicyExtension[] = [
      { name: "rate-limiter", evaluate: () => "pass" },
      { name: "ip-blocklist", evaluate: () => "deny" },
    ];

    const chain = new PolicyExtensionChain(extensions);
    const result = chain.evaluate("allow", createTestContext());

    expect(result.decision).toBe("deny");
    expect(result.coreDecision).toBe("allow");
    expect(result.decidedBy).toBe("ip-blocklist");
    expect(result.overriddenByExtension).toBe(true);
    // First deny short-circuits — only 2 evaluations recorded
    expect(result.evaluations).toHaveLength(2);
  });

  it("core deny cannot be overridden by extensions", () => {
    const extensions: PolicyExtension[] = [
      { name: "always-pass", evaluate: () => "pass" },
      { name: "also-pass", evaluate: () => "pass" },
    ];

    const chain = new PolicyExtensionChain(extensions);
    const result = chain.evaluate("deny", createTestContext());

    expect(result.decision).toBe("deny");
    expect(result.coreDecision).toBe("deny");
    expect(result.decidedBy).toBeNull();
    expect(result.overriddenByExtension).toBe(false);
    // All extensions still evaluated for audit trail
    expect(result.evaluations).toHaveLength(2);
  });

  it("first deny wins — later extensions are not evaluated", () => {
    let thirdExtensionCalled = false;
    const extensions: PolicyExtension[] = [
      { name: "pass-ext", evaluate: () => "pass" },
      { name: "deny-ext", evaluate: () => "deny" },
      {
        name: "never-reached",
        evaluate: () => {
          thirdExtensionCalled = true;
          return "pass";
        },
      },
    ];

    const chain = new PolicyExtensionChain(extensions);
    const result = chain.evaluate("allow", createTestContext());

    expect(result.decision).toBe("deny");
    expect(result.decidedBy).toBe("deny-ext");
    expect(result.evaluations).toHaveLength(2);
    expect(thirdExtensionCalled).toBe(false);
  });

  it("audit trail contains context for forensic review", () => {
    const extensions: PolicyExtension[] = [
      { name: "audit-ext", evaluate: () => "abstain" },
    ];

    const context = createTestContext({
      principalId: "operator-42",
      resource: "provider",
      action: "delete",
      resourceId: "provider-123",
      attributes: { reason: "cleanup" },
    });

    const result = evaluatePolicyExtensionChain("allow", extensions, context);

    expect(result.context.principalId).toBe("operator-42");
    expect(result.context.resource).toBe("provider");
    expect(result.context.action).toBe("delete");
    expect(result.context.resourceId).toBe("provider-123");
    expect(result.evaluations[0]!.decision).toBe("abstain");
    expect(result.decision).toBe("allow");
  });

  it("extensionNames returns the registered extension names", () => {
    const chain = new PolicyExtensionChain([
      { name: "alpha", evaluate: () => "pass" },
      { name: "beta", evaluate: () => "pass" },
    ]);

    expect(chain.extensionNames).toEqual(["alpha", "beta"]);
  });
});
