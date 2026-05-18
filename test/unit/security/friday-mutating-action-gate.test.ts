import { describe, expect, it } from "vitest";
import {
  createFridayMutatingActionDigest,
  createFridayMutatingActionGate,
  signFridayCanonicalApproval,
} from "../../../src/security/friday-mutating-action-gate.js";
import type { FridayMutatingActionRequest } from "../../../src/security/friday-mutating-action-gate.js";

const NOW = "2026-05-04T12:00:00.000Z";

function makeRequest(overrides: Partial<FridayMutatingActionRequest> = {}): FridayMutatingActionRequest {
  return {
    action: "system.open_url",
    actor: { kind: "ui", id: "operator-ui", principalId: "user-1" },
    surface: "system",
    resource: { type: "url", id: "https://example.com" },
    mutating: true,
    risk: "medium",
    ...overrides,
  };
}

function makeGate() {
  return createFridayMutatingActionGate({
    nowIso: () => NOW,
    ticketIdGenerator: () => "ticket-1",
  });
}

describe("friday mutating action gate", () => {
  it("allows read-only actions without issuing a ticket", () => {
    const result = makeGate().evaluate(makeRequest({
      action: "system.snapshot",
      resource: { type: "desktop_snapshot" },
      mutating: false,
      risk: "read_only",
    }));

    expect(result.decision).toBe("allow");
    expect(result.approvalRequired).toBe(false);
    expect(result.ticket).toBeUndefined();
    expect(result.evidenceRecord).toMatchObject({
      gateId: "friday_canonical_mutating_action_gate",
      evaluatedAt: NOW,
      decision: "allow",
      reason: "read_only_action_allowed_without_ticket",
      approvalRequired: false,
    });
  });

  it("requires canonical approval for mutating actions before issuing a ticket", () => {
    const result = makeGate().evaluate(makeRequest());

    expect(result.decision).toBe("requires_approval");
    expect(result.approvalRequired).toBe(true);
    expect(result.ticket).toBeUndefined();
    expect(result.reason).toBe("canonical_approval_required");
  });

  it("does not let local allow claims bypass the canonical gate", () => {
    const result = makeGate().evaluate(makeRequest({
      localClaims: [
        { guardId: "desktop-local-guard", decision: "allow", reason: "known app target" },
      ],
    }));

    expect(result.decision).toBe("requires_approval");
    expect(result.approvalRequired).toBe(true);
    expect(result.ticket).toBeUndefined();
  });

  it("stops on local guard deny before canonical approval can issue a ticket", () => {
    const request = makeRequest({
      localClaims: [
        { guardId: "filesystem-scope-guard", decision: "deny", reason: "outside allowed scope" },
      ],
    });
    const digest = createFridayMutatingActionDigest(request);

    const result = makeGate().evaluate({
      ...request,
      canonicalApproval: {
        decision: "approved",
        approvalId: "approval-1",
        decidedByPrincipalId: "user-1",
        actionDigest: digest,
      },
    });

    expect(result.decision).toBe("deny");
    expect(result.deniedBy).toBe("filesystem-scope-guard");
    expect(result.ticket).toBeUndefined();
    expect(result.reason).toBe("outside allowed scope");
  });

  it("requires approval when a local guard marks a read-only action as approval required", () => {
    const result = makeGate().evaluate(makeRequest({
      action: "memory.export",
      resource: { type: "memory_export", id: "semantic" },
      mutating: false,
      risk: "low",
      localClaims: [
        { guardId: "privacy-guard", decision: "requires_approval", reason: "sensitive export" },
      ],
    }));

    expect(result.decision).toBe("requires_approval");
    expect(result.approvalRequired).toBe(true);
    expect(result.ticket).toBeUndefined();
  });

  it("raises effective risk from local claims", () => {
    const result = makeGate().evaluate(makeRequest({
      action: "provider.validate",
      resource: { type: "provider", id: "openai" },
      mutating: false,
      risk: "low",
      localClaims: [
        { guardId: "provider-secret-guard", decision: "allow", risk: "high" },
      ],
    }));

    expect(result.risk).toBe("high");
    expect(result.decision).toBe("requires_approval");
    expect(result.approvalRequired).toBe(true);
  });

  it("issues an action-scoped ticket when canonical approval matches the digest", () => {
    const request = makeRequest({
      action: "workflow.run_node",
      surface: "workflow",
      resource: { type: "workflow_node", id: "node-1", digest: "node-digest" },
      parameters: { command: "run", args: ["node-1"] },
      planDigest: "plan-digest-1",
      rollback: { planned: true, planDigest: "plan-digest-1", actions: ["workflow.rollback_node"] },
      idempotencyKey: "idem-1",
    });
    const digest = createFridayMutatingActionDigest(request);

    const result = makeGate().evaluate({
      ...request,
      canonicalApproval: {
        decision: "approved",
        approvalId: "approval-1",
        decidedByPrincipalId: "user-1",
        actionDigest: digest,
        expiresAt: "2026-05-04T13:00:00.000Z",
        childOfLifecycleTicketId: "lifecycle-ticket-1",
      },
    });

    expect(result.decision).toBe("allow");
    expect(result.approvalRequired).toBe(true);
    expect(result.ticket).toEqual({
      ticketId: "ticket-1",
      actionDigest: digest,
      action: "workflow.run_node",
      actor: { kind: "ui", id: "operator-ui", principalId: "user-1" },
      surface: "workflow",
      resource: { type: "workflow_node", id: "node-1", digest: "node-digest" },
      risk: "medium",
      approvalId: "approval-1",
      approvedByPrincipalId: "user-1",
      issuedAt: NOW,
      expiresAt: "2026-05-04T13:00:00.000Z",
      planDigest: "plan-digest-1",
      childOfLifecycleTicketId: "lifecycle-ticket-1",
      idempotencyKey: "idem-1",
    });
    expect(result.evidenceRecord).toMatchObject({
      decision: "allow",
      ticketId: "ticket-1",
      approvalId: "approval-1",
      planDigest: "plan-digest-1",
    });
  });

  it("does not issue two tickets from the same canonical approval", () => {
    let ticketSeq = 0;
    const gate = createFridayMutatingActionGate({
      nowIso: () => NOW,
      ticketIdGenerator: () => `ticket-${++ticketSeq}`,
    });
    const request = makeRequest({ idempotencyKey: "idem-1" });
    const digest = createFridayMutatingActionDigest(request);
    const canonicalApproval = {
      decision: "approved" as const,
      approvalId: "approval-1",
      decidedByPrincipalId: "user-1",
      actionDigest: digest,
      expiresAt: "2026-05-04T13:00:00.000Z",
    };

    expect(gate.evaluate({ ...request, canonicalApproval })).toMatchObject({
      decision: "allow",
      ticket: expect.objectContaining({ ticketId: "ticket-1" }),
    });
    expect(gate.evaluate({ ...request, canonicalApproval })).toMatchObject({
      decision: "deny",
      reason: "canonical_approval_already_used",
      ticket: undefined,
    });
  });

  it("treats alternate hex casing of the same approval signature as replay", () => {
    let ticketSeq = 0;
    const gate = createFridayMutatingActionGate({
      nowIso: () => NOW,
      ticketIdGenerator: () => `ticket-${++ticketSeq}`,
      approvalSignatureSecret: "server-secret", // pragma: allowlist secret
    });
    const request = makeRequest({ idempotencyKey: "idem-1" });
    const digest = createFridayMutatingActionDigest(request);
    const canonicalApproval = signFridayCanonicalApproval(
      {
        decision: "approved",
        approvalId: "approval-1",
        decidedByPrincipalId: "user-1",
        actionDigest: digest,
        expiresAt: "2026-05-04T13:00:00.000Z",
      },
      "server-secret",
    );

    expect(gate.evaluate({ ...request, canonicalApproval })).toMatchObject({
      decision: "allow",
      ticket: expect.objectContaining({ ticketId: "ticket-1" }),
    });

    expect(gate.evaluate({
      ...request,
      canonicalApproval: {
        ...canonicalApproval,
        signature: canonicalApproval.signature!.toUpperCase(),
      },
    })).toMatchObject({
      decision: "deny",
      reason: "canonical_approval_already_used",
      ticket: undefined,
    });
  });

  it("denies canonical approvals whose action digest does not match", () => {
    const result = makeGate().evaluate({
      ...makeRequest(),
      canonicalApproval: {
        decision: "approved",
        approvalId: "approval-1",
        decidedByPrincipalId: "user-1",
        actionDigest: "wrong-digest",
      },
    });

    expect(result.decision).toBe("deny");
    expect(result.deniedBy).toBe("canonical_gate");
    expect(result.reason).toBe("canonical_approval_digest_mismatch");
    expect(result.ticket).toBeUndefined();
  });

  it("treats canonical deny as final", () => {
    const request = makeRequest();
    const digest = createFridayMutatingActionDigest(request);

    const result = makeGate().evaluate({
      ...request,
      canonicalApproval: {
        decision: "denied",
        approvalId: "approval-1",
        decidedByPrincipalId: "user-1",
        actionDigest: digest,
        reason: "operator denied",
      },
    });

    expect(result.decision).toBe("deny");
    expect(result.deniedBy).toBe("canonical_gate");
    expect(result.reason).toBe("operator denied");
    expect(result.ticket).toBeUndefined();
  });

  it("denies expired canonical approvals before issuing a ticket", () => {
    const request = makeRequest();
    const digest = createFridayMutatingActionDigest(request);

    const result = makeGate().evaluate({
      ...request,
      canonicalApproval: {
        decision: "approved",
        approvalId: "approval-1",
        decidedByPrincipalId: "user-1",
        actionDigest: digest,
        expiresAt: "2026-05-04T11:59:59.000Z",
      },
    });

    expect(result.decision).toBe("deny");
    expect(result.deniedBy).toBe("canonical_gate");
    expect(result.reason).toBe("canonical_approval_expired");
    expect(result.ticket).toBeUndefined();
  });

  it("requires a valid server signature when the gate is configured with an approval secret", () => {
    const request = makeRequest();
    const digest = createFridayMutatingActionDigest(request);
    const gate = createFridayMutatingActionGate({
      nowIso: () => NOW,
      ticketIdGenerator: () => "ticket-1",
      approvalSignatureSecret: "server-secret", // pragma: allowlist secret
    });

    expect(gate.evaluate({
      ...request,
      canonicalApproval: {
        decision: "approved",
        approvalId: "approval-1",
        decidedByPrincipalId: "user-1",
        actionDigest: digest,
      },
    })).toMatchObject({
      decision: "deny",
      reason: "canonical_approval_signature_invalid",
    });

    expect(gate.evaluate({
      ...request,
      canonicalApproval: signFridayCanonicalApproval(
        {
          decision: "approved",
          approvalId: "approval-1",
          decidedByPrincipalId: "user-1",
          actionDigest: digest,
          expiresAt: "2026-05-04T13:00:00.000Z",
        },
        "server-secret",
      ),
    })).toMatchObject({
      decision: "allow",
      ticket: expect.objectContaining({ ticketId: "ticket-1" }),
    });
  });

  it("requires approved canonical approvals to carry a valid future expiration", () => {
    const request = makeRequest();
    const digest = createFridayMutatingActionDigest(request);
    const gate = createFridayMutatingActionGate({
      nowIso: () => NOW,
      ticketIdGenerator: () => "ticket-1",
      approvalSignatureSecret: "server-secret", // pragma: allowlist secret
    });

    expect(gate.evaluate({
      ...request,
      canonicalApproval: signFridayCanonicalApproval(
        {
          decision: "approved",
          approvalId: "approval-1",
          decidedByPrincipalId: "user-1",
          actionDigest: digest,
        },
        "server-secret",
      ),
    })).toMatchObject({
      decision: "deny",
      reason: "canonical_approval_expiration_required",
    });

    expect(gate.evaluate({
      ...request,
      canonicalApproval: signFridayCanonicalApproval(
        {
          decision: "approved",
          approvalId: "approval-2",
          decidedByPrincipalId: "user-1",
          actionDigest: digest,
          expiresAt: "not-a-date",
        },
        "server-secret",
      ),
    })).toMatchObject({
      decision: "deny",
      reason: "canonical_approval_expiration_invalid",
    });
  });

  it("fails closed on approved canonical approvals when signatures are required but no secret is configured", () => {
    const request = makeRequest();
    const digest = createFridayMutatingActionDigest(request);
    const gate = createFridayMutatingActionGate({
      nowIso: () => NOW,
      ticketIdGenerator: () => "ticket-1",
      requireApprovalSignature: true,
    });

    const result = gate.evaluate({
      ...request,
      canonicalApproval: {
        decision: "approved",
        approvalId: "approval-1",
        decidedByPrincipalId: "user-1",
        actionDigest: digest,
      },
    });

    expect(result.decision).toBe("deny");
    expect(result.deniedBy).toBe("canonical_gate");
    expect(result.reason).toBe("canonical_approval_signature_invalid");
    expect(result.ticket).toBeUndefined();
  });

  it("denies agent attempts to execute reserved system approval actions", () => {
    const result = makeGate().evaluate(makeRequest({
      action: "system.approve",
      actor: { kind: "agent", id: "agent-runtime", principalId: "agent-1" },
      resource: { type: "approval", id: "approval-1" },
      mutating: true,
      risk: "critical",
    }));

    expect(result.decision).toBe("deny");
    expect(result.deniedBy).toBe("canonical_gate");
    expect(result.reason).toBe("agent_cannot_execute_reserved_approval_action");
    expect(result.ticket).toBeUndefined();
  });

  it("uses stable action digests for equivalent scope payloads", () => {
    const left = makeRequest({
      parameters: {
        b: 2,
        a: { z: true, y: [{ b: "second", a: "first" }] },
      },
      resource: {
        type: "file",
        id: "/tmp/example",
        attributes: { z: "last", a: "first" },
      },
    });
    const right = makeRequest({
      parameters: {
        a: { y: [{ a: "first", b: "second" }], z: true },
        b: 2,
      },
      resource: {
        attributes: { a: "first", z: "last" },
        id: "/tmp/example",
        type: "file",
      },
    });

    expect(createFridayMutatingActionDigest(left)).toBe(createFridayMutatingActionDigest(right));
  });
});
