import { describe, expect, it, vi } from "vitest";

import { createFridayAutonomyRoutes } from "../../../../../src/api/http/routes/friday-autonomy-routes.js";
import {
  createFridaySkillLifecycleCanaryInputDigest,
  createFridaySkillLifecycleMutatingActionRequest,
} from "../../../../../src/autonomy/services/friday-skill-upgrade-lifecycle-service.js";
import {
  createFridayWorkflowLifecycleMutatingActionRequest,
} from "../../../../../src/autonomy/services/friday-workflow-upgrade-lifecycle-service.js";
import {
  createFridayProviderProfileLifecycleMutatingActionRequest,
} from "../../../../../src/autonomy/services/friday-provider-profile-upgrade-lifecycle-service.js";
import {
  createFridayMcpServerLifecycleMutatingActionRequest,
} from "../../../../../src/autonomy/services/friday-mcp-server-upgrade-lifecycle-service.js";
import {
  createFridayPluginLifecycleMutatingActionRequest,
} from "../../../../../src/autonomy/services/friday-plugin-upgrade-lifecycle-service.js";
import {
  createFridayChannelAdapterLifecycleMutatingActionRequest,
} from "../../../../../src/autonomy/services/friday-channel-adapter-upgrade-lifecycle-service.js";
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
const PROVIDER_PLAN_DIGEST = "provider-plan-1";
const MCP_PLAN_DIGEST = "mcp-plan-1";
const PLUGIN_PLAN_DIGEST = "plugin-plan-1";
const CHANNEL_PLAN_DIGEST = "channel-plan-1";

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

function makeProviderContext(body: Record<string, unknown>) {
  return {
    requestId: "req-1",
    receivedAt: "2026-05-07T18:00:00.000Z",
    params: { providerId: "provider-1" },
    query: {},
    body,
    headers: {},
    principal,
  };
}

function makeMcpContext(body: Record<string, unknown>) {
  return {
    requestId: "req-1",
    receivedAt: "2026-05-07T18:00:00.000Z",
    params: { serverId: "mcp-1" },
    query: {},
    body,
    headers: {},
    principal,
  };
}

function makePluginContext(body: Record<string, unknown>) {
  return {
    requestId: "req-1",
    receivedAt: "2026-05-07T18:00:00.000Z",
    params: { pluginId: "plugin-1" },
    query: {},
    body,
    headers: {},
    principal,
  };
}

function makeChannelContext(body: Record<string, unknown>) {
  return {
    requestId: "req-1",
    receivedAt: "2026-05-07T18:00:00.000Z",
    params: { channelKind: "webchat" },
    query: {},
    body,
    headers: {},
    principal,
  };
}

function makeAutonomyLifecycleContext(body: Record<string, unknown>) {
  return {
    requestId: "req-1",
    receivedAt: "2026-05-07T18:00:00.000Z",
    params: {
      workflowId: "workflow-1",
      skillId: "skill-1",
      providerId: "provider-1",
      serverId: "mcp-1",
      pluginId: "plugin-1",
      channelKind: "webchat",
    },
    query: {},
    body,
    headers: {},
    principal,
  };
}

function makeWorkflowApproval(input: {
  action: "shadow" | "canary" | "promote" | "rollback";
  workflowVersionId?: string;
  versionNumber?: number;
  targetVersionNumber?: number;
  success?: boolean;
  planDigest?: string;
}): FridayCanonicalApprovalResolution {
  const planDigest = input.planDigest ?? "workflow-plan-1";
  const request = createFridayWorkflowLifecycleMutatingActionRequest({
    action: input.action,
    workflowId: "workflow-1",
    workflowVersionId: input.workflowVersionId,
    versionNumber: input.versionNumber,
    targetVersionNumber: input.targetVersionNumber,
    success: input.success,
    runtimeVersion: "runtime-v1",
    actor: {
      kind: "user",
      id: "user-1",
      principalId: "user-1",
    },
    surface: `api:/v1/autonomy/workflows/workflow-1/${input.action}`,
    planDigest,
    rollback: input.action === "rollback"
      ? { planned: true, planDigest, actions: ["workflows.lifecycle.promote"] }
      : undefined,
  });
  return {
    decision: "approved",
    approvalId: `workflow-${input.action}-approval`,
    decidedByPrincipalId: "user-1",
    actionDigest: createFridayMutatingActionDigest(request),
    expiresAt: "2026-05-07T19:00:00.000Z",
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

function makeProviderApproval(input: {
  action: "shadow" | "canary" | "promote" | "rollback";
  shadowVersionId?: string;
  runtimeVersion?: string;
  planDigest?: string;
}): FridayCanonicalApprovalResolution {
  const planDigest = input.planDigest ?? PROVIDER_PLAN_DIGEST;
  const request = createFridayProviderProfileLifecycleMutatingActionRequest({
    action: input.action,
    providerId: "provider-1",
    shadowVersionId: input.shadowVersionId ?? "provider-1@shadow",
    runtimeVersion: input.runtimeVersion ?? "runtime-v1",
    actor: {
      kind: "user",
      id: "user-1",
      principalId: "user-1",
    },
    surface: `api:/v1/autonomy/providers/${input.action}`,
    planDigest,
    rollback: input.action === "rollback"
      ? { planned: true, planDigest, actions: ["providers.lifecycle.promote"] }
      : undefined,
  });
  return {
    decision: "approved",
    approvalId: `provider-${input.action}-approval`,
    decidedByPrincipalId: "user-1",
    actionDigest: createFridayMutatingActionDigest(request),
    expiresAt: "2026-05-07T19:00:00.000Z",
  };
}

function makeMcpApproval(input: {
  action: "shadow" | "canary" | "promote" | "rollback";
  shadowVersionId?: string;
  runtimeVersion?: string;
  planDigest?: string;
}): FridayCanonicalApprovalResolution {
  const planDigest = input.planDigest ?? MCP_PLAN_DIGEST;
  const request = createFridayMcpServerLifecycleMutatingActionRequest({
    action: input.action,
    serverId: "mcp-1",
    shadowVersionId: input.shadowVersionId ?? "mcp-1@shadow",
    runtimeVersion: input.runtimeVersion ?? "runtime-v1",
    actor: {
      kind: "user",
      id: "user-1",
      principalId: "user-1",
    },
    surface: `api:/v1/autonomy/mcp-servers/${input.action}`,
    planDigest,
    rollback: input.action === "rollback"
      ? { planned: true, planDigest, actions: ["mcp_servers.lifecycle.promote"] }
      : undefined,
  });
  return {
    decision: "approved",
    approvalId: `mcp-${input.action}-approval`,
    decidedByPrincipalId: "user-1",
    actionDigest: createFridayMutatingActionDigest(request),
    expiresAt: "2026-05-07T19:00:00.000Z",
  };
}

function makePluginApproval(input: {
  action: "shadow" | "canary" | "promote" | "rollback";
  shadowVersionId?: string;
  runtimeVersion?: string;
  planDigest?: string;
}): FridayCanonicalApprovalResolution {
  const planDigest = input.planDigest ?? PLUGIN_PLAN_DIGEST;
  const request = createFridayPluginLifecycleMutatingActionRequest({
    action: input.action,
    pluginId: "plugin-1",
    shadowVersionId: input.shadowVersionId ?? "plugin-1@shadow",
    runtimeVersion: input.runtimeVersion ?? "runtime-v1",
    actor: {
      kind: "user",
      id: "user-1",
      principalId: "user-1",
    },
    surface: `api:/v1/autonomy/plugins/${input.action}`,
    planDigest,
    rollback: input.action === "rollback"
      ? { planned: true, planDigest, actions: ["plugins.lifecycle.promote"] }
      : undefined,
  });
  return {
    decision: "approved",
    approvalId: `plugin-${input.action}-approval`,
    decidedByPrincipalId: "user-1",
    actionDigest: createFridayMutatingActionDigest(request),
    expiresAt: "2026-05-07T19:00:00.000Z",
  };
}

function makeChannelApproval(input: {
  action: "shadow" | "canary" | "promote" | "rollback";
  shadowVersionId?: string;
  runtimeVersion?: string;
  planDigest?: string;
}): FridayCanonicalApprovalResolution {
  const planDigest = input.planDigest ?? CHANNEL_PLAN_DIGEST;
  const request = createFridayChannelAdapterLifecycleMutatingActionRequest({
    action: input.action,
    channelKind: "webchat",
    shadowVersionId: input.shadowVersionId ?? "webchat@shadow",
    runtimeVersion: input.runtimeVersion ?? "runtime-v1",
    actor: {
      kind: "user",
      id: "user-1",
      principalId: "user-1",
    },
    surface: `api:/v1/autonomy/channels/${input.action}`,
    planDigest,
    rollback: input.action === "rollback"
      ? { planned: true, planDigest, actions: ["channel_adapters.lifecycle.promote"] }
      : undefined,
  });
  return {
    decision: "approved",
    approvalId: `channel-${input.action}-approval`,
    decidedByPrincipalId: "user-1",
    actionDigest: createFridayMutatingActionDigest(request),
    expiresAt: "2026-05-07T19:00:00.000Z",
  };
}

function createRoutes(input: { allowTestOnlyAutonomyLifecycleExecution?: boolean } = {}) {
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
  const promote = vi.fn(async () => ({ skillId: "skill-1", status: "installed", tags: [] }));
  const rollback = vi.fn(async () => ({ skillId: "skill-1", status: "not_installed", tags: [] }));
  const routes = createFridayAutonomyRoutes({
    allowTestOnlyAutonomyLifecycleExecution: input.allowTestOnlyAutonomyLifecycleExecution ?? true,
    canonicalMutationGate: createFridayMutatingActionGate({
      nowIso: () => "2026-05-07T18:00:00.000Z",
      ticketIdGenerator: () => "ticket-1",
    }),
    listUpgradeStatus: () => ({ items: [] }),
    skillActions: {
      registerShadow,
      recordCanary,
      promote,
      rollback,
      getStatus: () => null,
      getEvidence: vi.fn(() => evidence),
    },
  });
  return { routes, registerShadow, recordCanary, promote, rollback };
}

function createProviderRoutes() {
  const evidence = {
    providerId: "provider-1",
    stage: "shadow",
    canarySuccessCount: 0,
    canaryFailureCount: 0,
  };
  const registerShadow = vi.fn(async () => ({
    id: "provider-1",
    kind: "anthropic",
    name: "Anthropic",
    enabled: true,
    promotionChannel: "shadow",
    compatibilityStatus: "adaptation_required",
    shadowVersionId: "provider-1@shadow",
    config: { validation: { status: "ok" } },
  }));
  const recordCanary = vi.fn(async () => ({
    id: "provider-1",
    kind: "anthropic",
    name: "Anthropic",
    enabled: true,
    promotionChannel: "canary",
    compatibilityStatus: "compatible",
    shadowVersionId: "provider-1@shadow",
    config: { validation: { status: "ok" } },
    canaryStats: {
      sampleSize: 1,
      successCount: 1,
      failureCount: 0,
      rollbackCount: 0,
    },
  }));
  const routes = createFridayAutonomyRoutes({
    allowTestOnlyAutonomyLifecycleExecution: true,
    listUpgradeStatus: () => ({ items: [] }),
    providerProfileActions: {
      registerShadow,
      recordCanary,
      promote: vi.fn(async () => ({
        id: "provider-1",
        kind: "anthropic",
        name: "Anthropic",
        enabled: true,
        promotionChannel: "active",
        compatibilityStatus: "compatible",
        config: { validation: { status: "ok" } },
      })),
      rollback: vi.fn(async () => ({
        id: "provider-1",
        kind: "anthropic",
        name: "Anthropic",
        enabled: true,
        promotionChannel: "rolled_back",
        compatibilityStatus: "adaptation_required",
        config: { validation: { status: "ok" } },
      })),
      getStatus: () => null,
      getEvidence: vi.fn(() => evidence),
    },
  });
  return { routes, registerShadow, recordCanary };
}

function createMcpRoutes() {
  const evidence = {
    serverId: "mcp-1",
    stage: "shadow",
    canarySuccessCount: 0,
    canaryFailureCount: 0,
  };
  const registerShadow = vi.fn(async () => undefined);
  const recordCanary = vi.fn(async () => undefined);
  const routes = createFridayAutonomyRoutes({
    allowTestOnlyAutonomyLifecycleExecution: true,
    listUpgradeStatus: () => ({ items: [] }),
    mcpServerActions: {
      registerShadow,
      recordCanary,
      promote: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      getStatus: () => ({
        kind: "mcp_server",
        id: "mcp-1",
        displayName: "mcp-1",
        status: "configured",
        compatibilityStatus: "compatible",
        promotionChannel: "shadow",
        recordedCompatibilityStatus: "compatible",
        derivedCompatibilityStatus: "compatible",
        requiresAdaptation: false,
        statusDrift: false,
        findings: [],
        strategy: "noop",
        nextStage: "promoted",
        reasons: [],
      }),
      getEvidence: vi.fn(() => evidence),
    },
  });
  return { routes, registerShadow, recordCanary };
}

function createPluginRoutes() {
  const evidence = {
    pluginId: "plugin-1",
    stage: "shadow",
    canarySuccessCount: 0,
    canaryFailureCount: 0,
  };
  const registerShadow = vi.fn(async () => ({
    id: "plugin-1",
    name: "Plugin",
    description: "Plugin",
    version: "1.0.0",
    source: "local",
    status: "installed",
    enabled: false,
    trustMode: "trust_on_install",
    installPath: "/tmp/plugin",
    kinds: ["skill"],
    manifest: {
      schemaVersion: "1.0",
      id: "plugin-1",
      version: "1.0.0",
      name: "Plugin",
      description: "Plugin",
      kinds: ["skill"],
      entrypoints: { skill: "./dist/index.js" },
      permissions: { grants: [], promptOn: [] },
      compatibility: { minHubVersion: "0.1.0", apiVersion: "1" },
    },
    signatureAlgorithm: null,
    signatureKeyId: null,
    signatureValue: null,
    signatureVerified: true,
    trustedFingerprintSha256: "abc",
    promotionChannel: "shadow",
    compatibilityStatus: "adaptation_required",
    shadowVersionId: "plugin-1@shadow",
    installedAt: "2026-05-07T18:00:00.000Z",
    updatedAt: "2026-05-07T18:00:00.000Z",
    lastErrorCode: null,
    lastErrorMessage: null,
  }));
  const recordCanary = vi.fn(async () => ({
    ...(await registerShadow()),
    promotionChannel: "canary",
    compatibilityStatus: "compatible",
    canaryStats: {
      sampleSize: 1,
      successCount: 1,
      failureCount: 0,
      rollbackCount: 0,
    },
  }));
  const reviewEnable = vi.fn(async () => ({
    ...(await registerShadow()),
    status: "running",
    enabled: true,
    promotionChannel: "active",
    compatibilityStatus: "compatible",
  }));
  const routes = createFridayAutonomyRoutes({
    allowTestOnlyAutonomyLifecycleExecution: true,
    listUpgradeStatus: () => ({ items: [] }),
    pluginActions: {
      registerShadow,
      recordCanary,
      promote: vi.fn(async () => ({
        ...(await registerShadow()),
        status: "running",
        enabled: true,
        promotionChannel: "active",
        compatibilityStatus: "compatible",
      })),
      rollback: vi.fn(async () => ({
        ...(await registerShadow()),
        status: "installed",
        enabled: false,
        promotionChannel: "rolled_back",
        compatibilityStatus: "adaptation_required",
      })),
      reviewEnable,
      getStatus: () => null,
      getEvidence: vi.fn(() => evidence),
    },
  });
  return { routes, registerShadow, recordCanary, reviewEnable };
}

function createChannelRoutes() {
  const evidence = {
    channelKind: "webchat",
    stage: "shadow",
    canarySuccessCount: 0,
    canaryFailureCount: 0,
  };
  const registerShadow = vi.fn(async () => undefined);
  const recordCanary = vi.fn(async () => undefined);
  const routes = createFridayAutonomyRoutes({
    allowTestOnlyAutonomyLifecycleExecution: true,
    listUpgradeStatus: () => ({ items: [] }),
    channelAdapterActions: {
      registerShadow,
      recordCanary,
      promote: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      getStatus: () => ({
        kind: "channel_adapter",
        id: "webchat",
        displayName: "webchat",
        status: "connected",
        compatibilityStatus: "compatible",
        promotionChannel: "shadow",
        recordedCompatibilityStatus: "compatible",
        derivedCompatibilityStatus: "compatible",
        requiresAdaptation: false,
        statusDrift: false,
        findings: [],
        strategy: "noop",
        nextStage: "promoted",
        reasons: [],
        details: {
          running: true,
          credentialStatus: "unknown",
          authMode: "none",
        },
      }),
      getEvidence: vi.fn(() => evidence),
    },
  });
  return { routes, registerShadow, recordCanary };
}

function createAutonomyLifecycleRoutesDefaultOff() {
  const workflowMutations = {
    registerShadow: vi.fn(async () => ({ id: "workflow-1" })),
    recordCanary: vi.fn(async () => ({ id: "workflow-1" })),
    promote: vi.fn(async () => ({ id: "workflow-1" })),
    rollback: vi.fn(async () => ({ id: "workflow-1" })),
  };
  const skillMutations = {
    registerShadow: vi.fn(async () => ({ skillId: "skill-1", status: "not_installed", tags: [] })),
    recordCanary: vi.fn(async () => ({ skillId: "skill-1", status: "not_installed", tags: [] })),
    promote: vi.fn(async () => ({ skillId: "skill-1", status: "installed", tags: [] })),
    rollback: vi.fn(async () => ({ skillId: "skill-1", status: "not_installed", tags: [] })),
  };
  const pluginMutations = {
    registerShadow: vi.fn(async () => ({ id: "plugin-1" })),
    recordCanary: vi.fn(async () => ({ id: "plugin-1" })),
    promote: vi.fn(async () => ({ id: "plugin-1" })),
    rollback: vi.fn(async () => ({ id: "plugin-1" })),
    reviewEnable: vi.fn(async () => ({ id: "plugin-1" })),
  };
  const providerMutations = {
    registerShadow: vi.fn(async () => ({ id: "provider-1" })),
    recordCanary: vi.fn(async () => ({ id: "provider-1" })),
    promote: vi.fn(async () => ({ id: "provider-1" })),
    rollback: vi.fn(async () => ({ id: "provider-1" })),
  };
  const mcpMutations = {
    registerShadow: vi.fn(async () => undefined),
    recordCanary: vi.fn(async () => undefined),
    promote: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
  };
  const channelMutations = {
    registerShadow: vi.fn(async () => undefined),
    recordCanary: vi.fn(async () => undefined),
    promote: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
  };
  const routes = createFridayAutonomyRoutes({
    allowTestOnlyAutonomyLifecycleExecution: false,
    canonicalMutationGate: createFridayMutatingActionGate({
      nowIso: () => "2026-05-07T18:00:00.000Z",
      ticketIdGenerator: () => "ticket-1",
    }),
    listUpgradeStatus: () => ({ items: [] }),
    workflowActions: {
      ...workflowMutations,
      getStatus: () => null,
    },
    skillActions: {
      ...skillMutations,
      getStatus: () => null,
      getEvidence: vi.fn(() => null),
    },
    pluginActions: {
      ...pluginMutations,
      getStatus: () => null,
      getEvidence: vi.fn(() => null),
    },
    providerProfileActions: {
      ...providerMutations,
      getStatus: () => null,
      getEvidence: vi.fn(() => null),
    },
    mcpServerActions: {
      ...mcpMutations,
      getStatus: () => null,
      getEvidence: vi.fn(() => null),
    },
    channelAdapterActions: {
      ...channelMutations,
      getStatus: () => null,
      getEvidence: vi.fn(() => null),
    },
  });
  return {
    routes,
    mutations: [
      ...Object.values(workflowMutations),
      ...Object.values(skillMutations),
      ...Object.values(pluginMutations),
      ...Object.values(providerMutations),
      ...Object.values(mcpMutations),
      ...Object.values(channelMutations),
    ],
  };
}

function makeRouteContext(
  input: {
    body?: Record<string, unknown>;
    params?: Record<string, string>;
    query?: Record<string, unknown>;
  } = {},
) {
  return {
    requestId: "req-1",
    receivedAt: "2026-05-07T18:00:00.000Z",
    params: input.params ?? {},
    query: input.query ?? {},
    body: input.body ?? {},
    headers: {},
    principal,
  };
}

function createAutonomyControlRoutesDefaultOff() {
  const acquisitionMutations = {
    startRun: vi.fn(async () => ({ id: "run-1" })),
    approveRun: vi.fn(async () => ({ id: "run-1" })),
    cancelRun: vi.fn(() => ({ id: "run-1" })),
  };
  const policyMutation = vi.fn(() => ({ enabled: false }));
  const standingAgendaMutations = {
    createStandingGoal: vi.fn(async () => ({
      goal: { id: "goal-1", userId: "user-1", objective: "Ship Friday", status: "active" },
      agendaItem: { id: "agenda-1", userId: "user-1", goalId: "goal-1", status: "pending" },
    })),
    updateStandingGoal: vi.fn(() => ({ id: "goal-1", userId: "user-1", objective: "Ship Friday", status: "active" })),
    approveAgendaItem: vi.fn(() => ({ id: "agenda-1", userId: "user-1", status: "approved" })),
    runAgendaItem: vi.fn(async () => ({ runId: "run-1", status: "queued" })),
  };
  const routes = createFridayAutonomyRoutes({
    allowTestOnlyCapabilityAcquisitionExecution: false,
    allowTestOnlyAutonomyPolicyMutation: false,
    allowTestOnlyStandingAgendaExecution: false,
    listUpgradeStatus: () => ({ items: [] }),
    acquisitionService: {
      plan: vi.fn(async () => ({ id: "plan-1" })),
      ...acquisitionMutations,
    },
    policyService: {
      getPolicy: vi.fn(() => ({ enabled: false })),
      updatePolicy: policyMutation,
    },
    standingAgendaService: {
      listStandingGoals: vi.fn(() => []),
      listAgenda: vi.fn(() => []),
      ...standingAgendaMutations,
    },
  });
  return {
    routes,
    mutations: [
      ...Object.values(acquisitionMutations),
      policyMutation,
      ...Object.values(standingAgendaMutations),
    ],
  };
}

describe("createFridayAutonomyRoutes lifecycle route retirement", () => {
  it.each([
    {
      operationId: "autonomy.workflows.shadow",
      body: {
        workflowVersionId: "workflow-version-1",
        runtimeVersion: "runtime-v1",
        planDigest: "workflow-plan-1",
        canonicalApproval: makeWorkflowApproval({ action: "shadow", workflowVersionId: "workflow-version-1" }),
      },
    },
    {
      operationId: "autonomy.workflows.canary",
      body: {
        success: true,
        runtimeVersion: "runtime-v1",
        planDigest: "workflow-plan-1",
        canonicalApproval: makeWorkflowApproval({ action: "canary", success: true }),
      },
    },
    {
      operationId: "autonomy.workflows.promote",
      body: {
        versionNumber: 1,
        runtimeVersion: "runtime-v1",
        planDigest: "workflow-plan-1",
        canonicalApproval: makeWorkflowApproval({ action: "promote", versionNumber: 1 }),
      },
    },
    {
      operationId: "autonomy.workflows.rollback",
      body: {
        targetVersionNumber: 1,
        runtimeVersion: "runtime-v1",
        planDigest: "workflow-plan-1",
        canonicalApproval: makeWorkflowApproval({ action: "rollback", targetVersionNumber: 1 }),
      },
    },
    {
      operationId: "autonomy.skills.shadow",
      body: {
        candidateId: "candidate-1",
        runtimeVersion: "runtime-v1",
        canonicalApproval: makeApproval({ action: "shadow", candidateId: "candidate-1" }),
      },
    },
    {
      operationId: "autonomy.skills.canary",
      body: {
        candidateId: "candidate-1",
        runtimeVersion: "runtime-v1",
        canonicalApproval: makeApproval({ action: "canary", candidateId: "candidate-1" }),
      },
    },
    {
      operationId: "autonomy.skills.promote",
      body: {
        candidateId: "candidate-1",
        runtimeVersion: "runtime-v1",
        planDigest: "plan-digest-1",
        canonicalApproval: makeApproval({
          action: "promote",
          candidateId: "candidate-1",
          planDigest: "plan-digest-1",
        }),
      },
    },
    {
      operationId: "autonomy.skills.rollback",
      body: {
        candidateId: "candidate-1",
        runtimeVersion: "runtime-v1",
        planDigest: "plan-digest-1",
        canonicalApproval: makeApproval({
          action: "rollback",
          candidateId: "candidate-1",
          planDigest: "plan-digest-1",
        }),
      },
    },
    {
      operationId: "autonomy.plugins.review.enable",
      body: {
        runtimeVersion: "runtime-v1",
        providerModel: "model-v1",
        idempotencyKey: "review-enable-key",
      },
    },
    ...(["shadow", "canary", "promote", "rollback"] as const).map((action) => ({
      operationId: `autonomy.plugins.${action}`,
      body: {
        shadowVersionId: "plugin-1@shadow",
        runtimeVersion: "runtime-v1",
        planDigest: PLUGIN_PLAN_DIGEST,
        canonicalApproval: makePluginApproval({ action }),
      },
    })),
    ...(["shadow", "canary", "promote", "rollback"] as const).map((action) => ({
      operationId: `autonomy.providers.${action}`,
      body: {
        shadowVersionId: "provider-1@shadow",
        runtimeVersion: "runtime-v1",
        planDigest: PROVIDER_PLAN_DIGEST,
        canonicalApproval: makeProviderApproval({ action }),
      },
    })),
    ...(["shadow", "canary", "promote", "rollback"] as const).map((action) => ({
      operationId: `autonomy.mcp.servers.${action}`,
      body: {
        shadowVersionId: "mcp-1@shadow",
        runtimeVersion: "runtime-v1",
        planDigest: MCP_PLAN_DIGEST,
        canonicalApproval: makeMcpApproval({ action }),
      },
    })),
    ...(["shadow", "canary", "promote", "rollback"] as const).map((action) => ({
      operationId: `autonomy.channels.${action}`,
      body: {
        shadowVersionId: "webchat@shadow",
        runtimeVersion: "runtime-v1",
        planDigest: CHANNEL_PLAN_DIGEST,
        canonicalApproval: makeChannelApproval({ action }),
      },
    })),
  ])(
    "fail-closes %s by default before invoking legacy TypeScript lifecycle mutations",
    async ({ operationId, body }) => {
      const deps = createAutonomyLifecycleRoutesDefaultOff();
      const route = deps.routes.find((entry) => entry.operationId === operationId)!;

      await expect(route.handler(makeAutonomyLifecycleContext(body))).rejects.toMatchObject({
        code: "TS_RUNTIME_AUTONOMY_LIFECYCLE_RETIRED",
        httpStatus: 503,
        details: {
          classification: "fail_closed",
          replacement: "rust_owned_autonomy_subject_upgrade_lifecycle_entrypoint_required",
        },
      });

      for (const mutation of deps.mutations) {
        expect(mutation).not.toHaveBeenCalled();
      }
    },
  );
});

describe("createFridayAutonomyRoutes control route retirement", () => {
  it.each([
    {
      operationId: "capabilities.acquisition.runs.create",
      code: "TS_RUNTIME_CAPABILITY_ACQUISITION_RETIRED",
      replacement: "rust_owned_capability_acquisition_entrypoint_required",
      ctx: makeRouteContext({ body: { goal: "Ship Friday" } }),
    },
    {
      operationId: "capabilities.acquisition.runs.approve",
      code: "TS_RUNTIME_CAPABILITY_ACQUISITION_RETIRED",
      replacement: "rust_owned_capability_acquisition_entrypoint_required",
      ctx: makeRouteContext({ params: { id: "run-1" } }),
    },
    {
      operationId: "capabilities.acquisition.runs.cancel",
      code: "TS_RUNTIME_CAPABILITY_ACQUISITION_RETIRED",
      replacement: "rust_owned_capability_acquisition_entrypoint_required",
      ctx: makeRouteContext({ params: { id: "run-1" } }),
    },
    {
      operationId: "autonomy.policy.patch",
      code: "TS_RUNTIME_AUTONOMY_POLICY_MUTATION_RETIRED",
      replacement: "rust_owned_autonomy_policy_mutation_entrypoint_required",
      ctx: makeRouteContext({ body: { enabled: true } }),
    },
    {
      operationId: "standing.goals.create",
      code: "TS_RUNTIME_STANDING_AGENDA_RETIRED",
      replacement: "rust_owned_autonomy_standing_agenda_entrypoint_required",
      ctx: makeRouteContext({ body: { objective: "Ship Friday" } }),
    },
    {
      operationId: "standing.goals.patch",
      code: "TS_RUNTIME_STANDING_AGENDA_RETIRED",
      replacement: "rust_owned_autonomy_standing_agenda_entrypoint_required",
      ctx: makeRouteContext({ params: { id: "goal-1" }, body: { objective: "Ship Friday better" } }),
    },
    {
      operationId: "agenda.approve",
      code: "TS_RUNTIME_STANDING_AGENDA_RETIRED",
      replacement: "rust_owned_autonomy_standing_agenda_entrypoint_required",
      ctx: makeRouteContext({ params: { id: "agenda-1" } }),
    },
    {
      operationId: "agenda.run",
      code: "TS_RUNTIME_STANDING_AGENDA_RETIRED",
      replacement: "rust_owned_autonomy_standing_agenda_entrypoint_required",
      ctx: makeRouteContext({ params: { id: "agenda-1" } }),
    },
  ])(
    "fail-closes %s by default before invoking TypeScript autonomy control mutations",
    async ({ operationId, code, replacement, ctx }) => {
      const deps = createAutonomyControlRoutesDefaultOff();
      const route = deps.routes.find((entry) => entry.operationId === operationId)!;

      await expect(route.handler(ctx)).rejects.toMatchObject({
        code,
        httpStatus: 503,
        details: {
          classification: "fail_closed",
          replacement,
        },
      });

      for (const mutation of deps.mutations) {
        expect(mutation).not.toHaveBeenCalled();
      }
    },
  );
});

describe("createFridayAutonomyRoutes skill lifecycle approval", () => {
  it.each([
    {
      operationId: "autonomy.skills.shadow",
      body: {
        candidateId: "candidate-1",
        runtimeVersion: "runtime-v1",
        canonicalApproval: makeApproval({ action: "shadow", candidateId: "candidate-1" }),
      },
      mutation: "registerShadow",
    },
    {
      operationId: "autonomy.skills.canary",
      body: {
        candidateId: "candidate-1",
        runtimeVersion: "runtime-v1",
        canonicalApproval: makeApproval({ action: "canary", candidateId: "candidate-1" }),
      },
      mutation: "recordCanary",
    },
    {
      operationId: "autonomy.skills.promote",
      body: {
        candidateId: "candidate-1",
        runtimeVersion: "runtime-v1",
        planDigest: "plan-digest-1",
        canonicalApproval: makeApproval({
          action: "promote",
          candidateId: "candidate-1",
          planDigest: "plan-digest-1",
        }),
      },
      mutation: "promote",
    },
    {
      operationId: "autonomy.skills.rollback",
      body: {
        candidateId: "candidate-1",
        runtimeVersion: "runtime-v1",
        planDigest: "plan-digest-1",
        canonicalApproval: makeApproval({
          action: "rollback",
          candidateId: "candidate-1",
          planDigest: "plan-digest-1",
        }),
      },
      mutation: "rollback",
    },
  ] as const)(
    "fail-closes %s by default before invoking the TypeScript skill lifecycle mutation",
    async ({ operationId, body, mutation }) => {
      const deps = createRoutes({ allowTestOnlyAutonomyLifecycleExecution: false });
      const route = deps.routes.find((entry) => entry.operationId === operationId)!;

      await expect(route.handler(makeContext(body))).rejects.toMatchObject({
        code: "TS_RUNTIME_AUTONOMY_LIFECYCLE_RETIRED",
        httpStatus: 503,
        details: {
          classification: "fail_closed",
          replacement: "rust_owned_autonomy_subject_upgrade_lifecycle_entrypoint_required",
        },
      });

      expect(deps[mutation]).not.toHaveBeenCalled();
    },
  );

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

describe("createFridayAutonomyRoutes provider lifecycle approval", () => {
  it("requires canonical approval before provider shadow can mutate", async () => {
    const { routes, registerShadow } = createProviderRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.providers.shadow")!;

    await expect(route.handler(makeProviderContext({
      shadowVersionId: "provider-1@shadow",
      runtimeVersion: "runtime-v1",
      planDigest: PROVIDER_PLAN_DIGEST,
    }))).rejects.toMatchObject({ code: "CANONICAL_APPROVAL_REQUIRED" });

    expect(registerShadow).not.toHaveBeenCalled();
  });

  it("passes canonical approval metadata into provider shadow and returns evidence", async () => {
    const { routes, registerShadow } = createProviderRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.providers.shadow")!;

    const result = await route.handler(makeProviderContext({
      shadowVersionId: "provider-1@shadow",
      runtimeVersion: "runtime-v1",
      planDigest: PROVIDER_PLAN_DIGEST,
      canonicalApproval: makeProviderApproval({ action: "shadow" }),
    }));

    expect(registerShadow).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "provider-1",
      shadowVersionId: "provider-1@shadow",
      canonicalApproval: expect.objectContaining({ approvalId: "provider-shadow-approval" }),
      actor: expect.objectContaining({ principalId: "user-1" }),
      surface: "api:/v1/autonomy/providers/shadow",
      planDigest: PROVIDER_PLAN_DIGEST,
    }));
    expect(result).toHaveProperty("evidence.stage", "shadow");
  });

  it("rejects caller-supplied provider canary success because validation must run internally", async () => {
    const { routes, recordCanary } = createProviderRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.providers.canary")!;

    await expect(route.handler(makeProviderContext({
      runtimeVersion: "runtime-v1",
      success: true,
      planDigest: PROVIDER_PLAN_DIGEST,
      canonicalApproval: makeProviderApproval({ action: "canary" }),
    }))).rejects.toMatchObject({ code: "PROVIDER_CANARY_RUNTIME_PROOF_REQUIRED" });

    expect(recordCanary).not.toHaveBeenCalled();
  });

  it("passes principal tenant context into provider canary validation", async () => {
    const { routes, recordCanary } = createProviderRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.providers.canary")!;

    await route.handler(makeProviderContext({
      runtimeVersion: "runtime-v1",
      planDigest: PROVIDER_PLAN_DIGEST,
      canonicalApproval: makeProviderApproval({ action: "canary" }),
    }));

    expect(recordCanary).toHaveBeenCalledWith(expect.objectContaining({
      tenantContext: {
        hubId: "user-1",
        userId: "user-1",
      },
    }));
  });
});

describe("createFridayAutonomyRoutes MCP lifecycle approval", () => {
  it("requires canonical approval before MCP shadow can mutate", async () => {
    const { routes, registerShadow } = createMcpRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.mcp.servers.shadow")!;

    await expect(route.handler(makeMcpContext({
      shadowVersionId: "mcp-1@shadow",
      runtimeVersion: "runtime-v1",
      planDigest: MCP_PLAN_DIGEST,
    }))).rejects.toMatchObject({ code: "CANONICAL_APPROVAL_REQUIRED" });

    expect(registerShadow).not.toHaveBeenCalled();
  });

  it("passes canonical approval metadata into MCP shadow and returns evidence", async () => {
    const { routes, registerShadow } = createMcpRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.mcp.servers.shadow")!;

    const result = await route.handler(makeMcpContext({
      shadowVersionId: "mcp-1@shadow",
      runtimeVersion: "runtime-v1",
      planDigest: MCP_PLAN_DIGEST,
      canonicalApproval: makeMcpApproval({ action: "shadow" }),
    }));

    expect(registerShadow).toHaveBeenCalledWith(expect.objectContaining({
      serverId: "mcp-1",
      shadowVersionId: "mcp-1@shadow",
      canonicalApproval: expect.objectContaining({ approvalId: "mcp-shadow-approval" }),
      actor: expect.objectContaining({ principalId: "user-1" }),
      surface: "api:/v1/autonomy/mcp-servers/shadow",
      planDigest: MCP_PLAN_DIGEST,
    }));
    expect(result).toHaveProperty("evidence.stage", "shadow");
  });

  it("rejects caller-supplied MCP canary success because proof must run internally", async () => {
    const { routes, recordCanary } = createMcpRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.mcp.servers.canary")!;

    await expect(route.handler(makeMcpContext({
      runtimeVersion: "runtime-v1",
      success: true,
      planDigest: MCP_PLAN_DIGEST,
      canonicalApproval: makeMcpApproval({ action: "canary" }),
    }))).rejects.toMatchObject({ code: "MCP_SERVER_CANARY_RUNTIME_PROOF_REQUIRED" });

    expect(recordCanary).not.toHaveBeenCalled();
  });
});

describe("createFridayAutonomyRoutes plugin lifecycle approval", () => {
  it("requires canonical approval before plugin shadow can mutate", async () => {
    const { routes, registerShadow } = createPluginRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.plugins.shadow")!;

    await expect(route.handler(makePluginContext({
      shadowVersionId: "plugin-1@shadow",
      runtimeVersion: "runtime-v1",
      planDigest: PLUGIN_PLAN_DIGEST,
    }))).rejects.toMatchObject({ code: "CANONICAL_APPROVAL_REQUIRED" });

    expect(registerShadow).not.toHaveBeenCalled();
  });

  it("passes canonical approval metadata into plugin shadow and returns evidence", async () => {
    const { routes, registerShadow } = createPluginRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.plugins.shadow")!;

    const result = await route.handler(makePluginContext({
      shadowVersionId: "plugin-1@shadow",
      runtimeVersion: "runtime-v1",
      planDigest: PLUGIN_PLAN_DIGEST,
      canonicalApproval: makePluginApproval({ action: "shadow" }),
    }));

    expect(registerShadow).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: "plugin-1",
      shadowVersionId: "plugin-1@shadow",
      canonicalApproval: expect.objectContaining({ approvalId: "plugin-shadow-approval" }),
      actor: expect.objectContaining({ principalId: "user-1" }),
      surface: "api:/v1/autonomy/plugins/shadow",
      planDigest: PLUGIN_PLAN_DIGEST,
    }));
    expect(result).toHaveProperty("evidence.stage", "shadow");
  });

  it("rejects caller-supplied plugin canary success because proof must run internally", async () => {
    const { routes, recordCanary } = createPluginRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.plugins.canary")!;

    await expect(route.handler(makePluginContext({
      runtimeVersion: "runtime-v1",
      success: true,
      planDigest: PLUGIN_PLAN_DIGEST,
      canonicalApproval: makePluginApproval({ action: "canary" }),
    }))).rejects.toMatchObject({ code: "PLUGIN_CANARY_RUNTIME_PROOF_REQUIRED" });

    expect(recordCanary).not.toHaveBeenCalled();
  });

  it("passes principal context into plugin review-enable so backend can issue canonical child approvals", async () => {
    const { routes, reviewEnable } = createPluginRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.plugins.review.enable")!;

    const result = await route.handler(makePluginContext({
      runtimeVersion: "runtime-v1",
      providerModel: "model-v1",
      idempotencyKey: "review-enable-key",
    }));

    expect(reviewEnable).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: "plugin-1",
      runtimeVersion: "runtime-v1",
      providerModel: "model-v1",
      idempotencyKey: "review-enable-key",
      actor: expect.objectContaining({ principalId: "user-1" }),
      surface: "api:/v1/autonomy/plugins/review-enable",
    }));
    expect(result).toHaveProperty("plugin.promotionChannel", "active");
    expect(result).toHaveProperty("evidence.pluginId", "plugin-1");
  });
});

describe("createFridayAutonomyRoutes channel adapter lifecycle approval", () => {
  it("requires canonical approval before channel shadow can mutate", async () => {
    const { routes, registerShadow } = createChannelRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.channels.shadow")!;

    await expect(route.handler(makeChannelContext({
      shadowVersionId: "webchat@shadow",
      runtimeVersion: "runtime-v1",
      planDigest: CHANNEL_PLAN_DIGEST,
    }))).rejects.toMatchObject({ code: "CANONICAL_APPROVAL_REQUIRED" });

    expect(registerShadow).not.toHaveBeenCalled();
  });

  it("passes canonical approval metadata into channel shadow and returns evidence", async () => {
    const { routes, registerShadow } = createChannelRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.channels.shadow")!;

    const result = await route.handler(makeChannelContext({
      shadowVersionId: "webchat@shadow",
      runtimeVersion: "runtime-v1",
      planDigest: CHANNEL_PLAN_DIGEST,
      canonicalApproval: makeChannelApproval({ action: "shadow" }),
    }));

    expect(registerShadow).toHaveBeenCalledWith(expect.objectContaining({
      channelKind: "webchat",
      shadowVersionId: "webchat@shadow",
      canonicalApproval: expect.objectContaining({ approvalId: "channel-shadow-approval" }),
      actor: expect.objectContaining({ principalId: "user-1" }),
      surface: "api:/v1/autonomy/channels/shadow",
      planDigest: CHANNEL_PLAN_DIGEST,
    }));
    expect(result).toHaveProperty("evidence.stage", "shadow");
  });

  it("rejects caller-supplied channel canary success because proof must run internally", async () => {
    const { routes, recordCanary } = createChannelRoutes();
    const route = routes.find((entry) => entry.operationId === "autonomy.channels.canary")!;

    await expect(route.handler(makeChannelContext({
      runtimeVersion: "runtime-v1",
      success: true,
      planDigest: CHANNEL_PLAN_DIGEST,
      canonicalApproval: makeChannelApproval({ action: "canary" }),
    }))).rejects.toMatchObject({ code: "CHANNEL_ADAPTER_CANARY_RUNTIME_PROOF_REQUIRED" });

    expect(recordCanary).not.toHaveBeenCalled();
  });
});
