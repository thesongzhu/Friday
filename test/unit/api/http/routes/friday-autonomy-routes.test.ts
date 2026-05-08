import { describe, expect, it, vi } from "vitest";

import { createFridayAutonomyRoutes } from "../../../../../src/api/http/routes/friday-autonomy-routes.js";
import {
  createFridaySkillLifecycleCanaryInputDigest,
  createFridaySkillLifecycleMutatingActionRequest,
} from "../../../../../src/autonomy/services/friday-skill-upgrade-lifecycle-service.js";
import {
  createFridayMutatingActionDigest,
  createFridayMutatingActionGate,
  type FridayCanonicalApprovalResolution,
} from "../../../../../src/security/friday-mutating-action-gate.js";

const principal = {
  principalType: "user" as const,
  principalId: "user-1",
  userId: "user-1",
  role: "admin" as const,
  scopes: ["hub.admin"] as const,
};

function makeContext(body: Record<string, unknown>) {
  return {
    requestId: "req-1",
    receivedAt: "2026-05-07T18:00:00.000Z",
    params: { skillId: "skill-1" },
    query: {},
    body,
    headers: {},
    principal,
  };
}

function makeApproval(input: {
  action: "shadow" | "canary" | "promote" | "rollback";
  candidateId: string;
  runtimeVersion?: string;
  planDigest?: string;
  canaryInput?: Record<string, unknown>;
}): FridayCanonicalApprovalResolution {
  const rollback = input.action === "rollback"
    ? { planned: true, planDigest: input.planDigest, actions: ["skills.lifecycle.promote"] }
    : undefined;
  const request = createFridaySkillLifecycleMutatingActionRequest({
    action: input.action,
    skillId: "skill-1",
    candidateId: input.candidateId,
    shadowVersionId: input.candidateId,
    runtimeVersion: input.runtimeVersion ?? "runtime-v1",
    actor: {
      kind: "user",
      id: "user-1",
      principalId: "user-1",
    },
    surface: `api:/v1/autonomy/skills/${input.action}`,
    planDigest: input.planDigest,
    rollback,
    canaryInputDigest: input.action === "canary"
      ? createFridaySkillLifecycleCanaryInputDigest(input.canaryInput)
      : undefined,
  });
  return {
    decision: "approved",
    approvalId: `${input.action}-approval`,
    decidedByPrincipalId: "user-1",
    actionDigest: createFridayMutatingActionDigest(request),
    expiresAt: "2026-05-07T19:00:00.000Z",
  };
}

function createRoutes() {
  const evidence = {
    candidateId: "candidate-1",
    events: [{ type: "shadow", at: "2026-05-07T18:00:00.000Z" }],
  };
  const registerShadow = vi.fn(async () => ({
    skillId: "skill-1",
    status: "not_installed",
    tags: [],
  }));
  const recordCanary = vi.fn(async () => ({
    skillId: "skill-1",
    status: "not_installed",
    tags: [],
  }));
  const routes = createFridayAutonomyRoutes({
    canonicalMutationGate: createFridayMutatingActionGate({
      nowIso: () => "2026-05-07T18:00:00.000Z",
      ticketIdGenerator: () => "ticket-1",
    }),
    listUpgradeStatus: () => ({ items: [] }),
    skillActions: {
      registerShadow,
      recordCanary,
      promote: vi.fn(async () => ({ skillId: "skill-1", status: "installed", tags: [] })),
      rollback: vi.fn(async () => ({ skillId: "skill-1", status: "not_installed", tags: [] })),
      getStatus: () => null,
      getEvidence: vi.fn(() => evidence),
    },
  });
  return { routes, registerShadow, recordCanary };
}

describe("createFridayAutonomyRoutes skill lifecycle approval", () => {
  it("requires canonical approval before shadow can mutate", async () => {
    const { routes, registerShadow } = createRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.skills.shadow")!;

    await expect(route.handler(makeContext({
      candidateId: "candidate-1",
      runtimeVersion: "runtime-v1",
    }))).rejects.toMatchObject({ code: "CANONICAL_APPROVAL_REQUIRED" });

    expect(registerShadow).not.toHaveBeenCalled();
  });

  it("passes canonical approval metadata into the shadow action and returns persisted evidence", async () => {
    const { routes, registerShadow } = createRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.skills.shadow")!;

    const result = await route.handler(makeContext({
      candidateId: "candidate-1",
      runtimeVersion: "runtime-v1",
      canonicalApproval: makeApproval({ action: "shadow", candidateId: "candidate-1" }),
    }));

    expect(registerShadow).toHaveBeenCalledWith(expect.objectContaining({
      skillId: "skill-1",
      candidateId: "candidate-1",
      canonicalApproval: expect.objectContaining({ approvalId: "shadow-approval" }),
      actor: expect.objectContaining({ principalId: "user-1" }),
      surface: "api:/v1/autonomy/skills/shadow",
    }));
    expect(result).toHaveProperty("evidence.events.0.type", "shadow");
  });

  it("rejects caller-supplied skill canary success because canary proof must run internally", async () => {
    const { routes, recordCanary } = createRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.skills.canary")!;

    await expect(route.handler(makeContext({
      candidateId: "candidate-1",
      runtimeVersion: "runtime-v1",
      success: true,
      canonicalApproval: makeApproval({ action: "canary", candidateId: "candidate-1" }),
    }))).rejects.toMatchObject({ code: "SKILL_CANARY_RUNTIME_PROOF_REQUIRED" });

    expect(recordCanary).not.toHaveBeenCalled();
  });
});
