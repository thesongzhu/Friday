import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  createFridayMutatingActionDigest,
  createFridayMutatingActionGate,
  createFridaySystemIntentMutatingActionRequest,
  signFridayCanonicalApproval,
  type FridayCanonicalApprovalResolution,
  type FridayDeviceApprovalVerifyResult,
} from "../../../src/security/friday-mutating-action-gate.js";
import type { FridayMutatingActionRequest } from "../../../src/security/friday-mutating-action-gate.js";
import { createFridayProviderApprovalPoPVerifier } from "../../../src/api/auth/device-attest/index.js";
import {
  deviceOwnerPrincipalIdFor,
  generateTestDeviceKey,
  makeApprovalProof,
  makeApprovalTranscript,
  type TestDeviceKey,
} from "../../helpers/friday-provider-approval-test-kit.js";

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

  it("binds system intent approvals to explicit window ids", () => {
    const left = createFridaySystemIntentMutatingActionRequest({
      action: "focus",
      actorId: "agent-runtime",
      actorKind: "agent",
      targetKind: "window",
      windowId: "window:finder:1",
      idempotencyKey: "focus-window",
    });
    const right = createFridaySystemIntentMutatingActionRequest({
      action: "focus",
      actorId: "agent-runtime",
      actorKind: "agent",
      targetKind: "window",
      windowId: "window:terminal:2",
      idempotencyKey: "focus-window",
    });

    expect(left.resource.id).toBe("window:finder:1");
    expect(left.resource.attributes).toMatchObject({
      targetKind: "window",
      windowId: "window:finder:1",
    });
    expect(createFridayMutatingActionDigest(left)).not.toBe(createFridayMutatingActionDigest(right));
  });
});

// ─── SEC-APPROVAL-AUTHORITY-001 · device-authored (verify-only) admission ───

describe("friday mutating action gate — device-authored approval", () => {
  const popVerifier = createFridayProviderApprovalPoPVerifier();

  function deviceGate(options: { withVerifier?: boolean } = {}) {
    return createFridayMutatingActionGate({
      nowIso: () => NOW,
      ticketIdGenerator: () => "ticket-1",
      // The legacy HMAC secret coexists (plugin lifecycle). The device path never
      // uses it — the Hub holds NO signing key on the device-authored approval path.
      approvalSignatureSecret: "legacy-hmac-secret", // pragma: allowlist secret
      requireApprovalSignature: true,
      ...(options.withVerifier === false
        ? {}
        : {
            deviceApprovalVerifier: (proof, nowMs): FridayDeviceApprovalVerifyResult => {
              const r = popVerifier.verifyPossession({
                transcript: proof.transcript,
                devicePublicKey: proof.devicePublicKey,
                signature: proof.signature,
                nowMs,
              });
              return r.ok
                ? {
                    ok: true,
                    devicePublicKeyHash: r.devicePublicKeyHash,
                    approvalId: r.approvalId,
                    actionDigest: r.actionDigest,
                    decidedByPrincipalId: r.decidedByPrincipalId,
                    expiresAt: r.expiresAt,
                  }
                : { ok: false, reason: r.reason };
            },
          }),
    });
  }

  // Option B*: the acting principal is the ordinary local owner `user.id` (NOT a
  // `device-owner:` principal); the durable device binding is carried SERVER-SIDE as
  // `boundDeviceOwnerSentinelHash = sha256Hex(owner SPKI-DER base64)` — the SAME
  // sentinel convention `deviceKeyLogin`/`users.password_hash` use.
  function ownerSentinelHash(owner: TestDeviceKey): string {
    return createHash("sha256").update(owner.spkiDerBase64).digest("hex");
  }

  function ownerRequest(owner: TestDeviceKey, overrides: Partial<FridayMutatingActionRequest> = {}): FridayMutatingActionRequest {
    return makeRequest({
      action: "providers.create",
      actor: {
        kind: "user",
        id: "owner-user-1",
        principalId: "owner-user-1",
        boundDeviceOwnerSentinelHash: ownerSentinelHash(owner),
      },
      surface: "provider_setup",
      resource: { type: "provider_setup", id: "prov-x" },
      mutating: true,
      risk: "high",
      ...overrides,
    });
  }

  function deviceApprovalFor(
    owner: TestDeviceKey,
    request: FridayMutatingActionRequest,
    opts: { signWith?: TestDeviceKey; decidedByPrincipalId?: string; expiresAt?: string; approvalId?: string } = {},
  ): FridayCanonicalApprovalResolution {
    const actionDigest = createFridayMutatingActionDigest(request);
    const expiresAt = opts.expiresAt ?? "2026-05-04T12:09:00.000Z";
    const approvalId = opts.approvalId ?? "approval-gate-1";
    const decidedByPrincipalId = opts.decidedByPrincipalId ?? deviceOwnerPrincipalIdFor(owner);
    const transcript = makeApprovalTranscript(owner, { actionDigest, decidedByPrincipalId, approvalId, expiresAt });
    const proof = makeApprovalProof(opts.signWith ?? owner, transcript, owner);
    return {
      decision: "approved",
      approvalId,
      decidedByPrincipalId,
      actionDigest,
      expiresAt,
      issuer: "friday_device_owner",
      deviceProof: proof,
    };
  }

  it("ADMITS a valid device-authored approval and issues a ticket (Hub verify-only)", () => {
    const owner = generateTestDeviceKey();
    const request = ownerRequest(owner);
    const approval = deviceApprovalFor(owner, request);

    const result = deviceGate().evaluate({ ...request, canonicalApproval: approval });
    expect(result.decision).toBe("allow");
    expect(result.ticket?.approvedByPrincipalId).toBe(deviceOwnerPrincipalIdFor(owner));
  });

  it("DENIES when no device verifier is wired (fail closed)", () => {
    const owner = generateTestDeviceKey();
    const request = ownerRequest(owner);
    const approval = deviceApprovalFor(owner, request);

    const result = deviceGate({ withVerifier: false }).evaluate({ ...request, canonicalApproval: approval });
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("device_approval_verifier_unavailable");
  });

  it("DENIES a device whose key does not hash to the acting owner (wrong device)", () => {
    const owner = generateTestDeviceKey();
    const attacker = generateTestDeviceKey();
    const request = ownerRequest(owner);
    // The attacker signs with its own key but claims the owner's principal id. The
    // presented key does NOT hash (sentinel convention) to the authenticated owner's
    // registered device → the Option B* durable-binding check refuses it. Every OTHER
    // field matches the approval object so the device binding is the sole discrepancy.
    const attackerTranscript = makeApprovalTranscript(attacker, {
      actionDigest: createFridayMutatingActionDigest(request),
      decidedByPrincipalId: deviceOwnerPrincipalIdFor(owner),
      approvalId: "approval-attacker",
      expiresAt: "2026-05-04T12:09:00.000Z",
    });
    const approval: FridayCanonicalApprovalResolution = {
      decision: "approved",
      approvalId: "approval-attacker",
      decidedByPrincipalId: deviceOwnerPrincipalIdFor(owner),
      actionDigest: createFridayMutatingActionDigest(request),
      expiresAt: "2026-05-04T12:09:00.000Z",
      issuer: "friday_device_owner",
      deviceProof: makeApprovalProof(attacker, attackerTranscript, attacker),
    };

    const result = deviceGate().evaluate({ ...request, canonicalApproval: approval });
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("device_approval_actor_mismatch");
  });

  it("DENIES a device approval lifted onto a different action (digest mismatch)", () => {
    const owner = generateTestDeviceKey();
    const request = ownerRequest(owner);
    const approval = deviceApprovalFor(owner, request);
    // Same approval, but the request that arrives mutates a different resource.
    const drifted = ownerRequest(owner, { resource: { type: "provider_setup", id: "prov-OTHER" } });

    const result = deviceGate().evaluate({ ...drifted, canonicalApproval: approval });
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("canonical_approval_digest_mismatch");
  });

  it("DENIES a replayed (already-consumed) device approval", () => {
    const owner = generateTestDeviceKey();
    const request = ownerRequest(owner);
    const approval = deviceApprovalFor(owner, request);
    const gate = deviceGate();

    expect(gate.evaluate({ ...request, canonicalApproval: approval }).decision).toBe("allow");
    const replay = gate.evaluate({ ...request, canonicalApproval: approval });
    expect(replay.decision).toBe("deny");
    expect(replay.reason).toBe("canonical_approval_already_used");
  });

  it("DENIES an expired device approval", () => {
    const owner = generateTestDeviceKey();
    const request = ownerRequest(owner);
    const approval = deviceApprovalFor(owner, request, { expiresAt: "2026-05-04T11:00:00.000Z" });

    const result = deviceGate().evaluate({ ...request, canonicalApproval: approval });
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("canonical_approval_expired");
  });

  it("DENIES a device approval with a tampered signed action digest", () => {
    const owner = generateTestDeviceKey();
    const request = ownerRequest(owner);
    const approval = deviceApprovalFor(owner, request);
    // Flip the approval's top-level digest to match a DIFFERENT action while the
    // signed transcript still binds the original — the gate cross-checks both.
    const tampered: FridayCanonicalApprovalResolution = { ...approval, actionDigest: "f".repeat(64) };

    const result = deviceGate().evaluate({ ...request, canonicalApproval: tampered });
    expect(result.decision).toBe("deny");
    // The approval's advertised digest no longer matches the request's recomputed one.
    expect(result.reason).toBe("canonical_approval_digest_mismatch");
  });
});
