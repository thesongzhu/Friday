import { describe, expect, it } from "vitest";

import type {
  FridayAgentCapabilityGrantIssuedPayload,
  FridayAgentCapabilityGrantDeniedPayload,
  FridayAgentCapabilityGrantUsedPayload,
  FridayAgentCapabilityGrantRevokedPayload,
  FridayAgentEventMap,
} from "#agent";

describe("Capability grant lifecycle payloads", () => {
  it("grant issued payload has required fields", () => {
    const payload: FridayAgentCapabilityGrantIssuedPayload = {
      runId: "run-1",
      grantId: "grant-1",
      toolCallId: "tc-1",
      toolName: "shell",
      scopes: ["exec"],
      principalId: "user-1",
    };

    expect(payload.runId).toBe("run-1");
    expect(payload.grantId).toBe("grant-1");
    expect(payload.toolCallId).toBe("tc-1");
    expect(payload.toolName).toBe("shell");
    expect(payload.scopes).toEqual(["exec"]);
  });

  it("grant revoked payload has required fields", () => {
    const payload: FridayAgentCapabilityGrantRevokedPayload = {
      grantId: "grant-1",
      revokedBy: "manual",
    };

    expect(payload.grantId).toBe("grant-1");
    expect(payload.revokedBy).toBe("manual");
    // Optional fields default to undefined
    expect(payload.runId).toBeUndefined();
    expect(payload.toolName).toBeUndefined();
    expect(payload.reason).toBeUndefined();
  });

  it("grant revoke type validates revokedBy enum", () => {
    const manualRevoke: FridayAgentCapabilityGrantRevokedPayload = {
      grantId: "g-1",
      revokedBy: "manual",
    };
    const expirationRevoke: FridayAgentCapabilityGrantRevokedPayload = {
      grantId: "g-2",
      revokedBy: "expiration",
    };
    const policyRevoke: FridayAgentCapabilityGrantRevokedPayload = {
      grantId: "g-3",
      revokedBy: "policy",
      reason: "policy violation",
      principalId: "user-1",
      surface: "cli",
    };

    expect(manualRevoke.revokedBy).toBe("manual");
    expect(expirationRevoke.revokedBy).toBe("expiration");
    expect(policyRevoke.revokedBy).toBe("policy");
    expect(policyRevoke.reason).toBe("policy violation");
  });

  it("grant event map includes all 4 events", () => {
    // Compile-time assertion: all four keys exist on FridayAgentEventMap.
    const keys: Array<keyof FridayAgentEventMap> = [
      "agent.run.capability_grant_issued",
      "agent.run.capability_grant_denied",
      "agent.run.capability_grant_used",
      "agent.run.capability_grant_revoked",
    ];

    expect(keys).toHaveLength(4);
    expect(keys).toContain("agent.run.capability_grant_issued");
    expect(keys).toContain("agent.run.capability_grant_denied");
    expect(keys).toContain("agent.run.capability_grant_used");
    expect(keys).toContain("agent.run.capability_grant_revoked");
  });
});
