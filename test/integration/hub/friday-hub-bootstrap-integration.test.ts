import { beforeEach, describe, it, expect, afterEach } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { resetMasterKeyCache } from "#providers";
import { createFridayHub } from "#hub";
import type { FridayHub } from "#hub";
import {
  createFridaySkillStageMutatingActionRequest,
  type FridaySkillImportInput,
} from "#skills/converter";
import { initializeFridayState } from "#state";
import {
  createFridayAgentRunRepository,
  createFridaySubagentRunRepository,
} from "#agent";
import { buildFridaySubagentSessionKey } from "#sessions";
import type { FridayCompiledWorkflowGraphV2 } from "#workflows";
import {
  clearAutoDetectProviderEnv,
  restoreAutoDetectProviderEnv,
  type FridayAutoDetectProviderEnvSnapshot,
} from "../../_helpers/auto-detect-provider-env.js";
import {
  createFridayMutatingActionDigest,
  createFridayMutatingActionGate,
  signFridayCanonicalApproval,
  type FridayCanonicalApprovalResolution,
} from "../../../src/security/friday-mutating-action-gate.js";
import {
  createFridaySkillLifecycleCanaryInputDigest,
  createFridaySkillLifecycleMutatingActionRequest,
} from "../../../src/autonomy/services/friday-skill-upgrade-lifecycle-service.js";
import {
  createFridayProviderProfileLifecycleMutatingActionRequest,
} from "../../../src/autonomy/services/friday-provider-profile-upgrade-lifecycle-service.js";
import { createFridaySkillRunMutatingActionRequest } from "../../../src/api/http/routes/friday-skill-routes.js";

const CANONICAL_STAGE_NOW = "2026-02-17T12:00:00.000Z";
const PHASE32_TOKEN_SECRET = "phase32-token-secret"; // pragma: allowlist secret
const PHASE32_PLAN_DIGEST = "phase32a-plan-digest";
const PHASE32B_PROVIDER_PLAN_DIGEST = "phase32b-provider-plan-digest";

function makeCanonicalStageTicket(input: FridaySkillImportInput) {
  const actor = {
    kind: "test",
    id: "hub-integration-test",
    principalId: "hub-integration-test",
  };
  const request = createFridaySkillStageMutatingActionRequest({
    source: input.source,
    formatHint: input.formatHint,
    target: input.target,
    replace: input.replace,
    refreshRegistry: input.refreshRegistry,
    options: input.options,
    actor,
    surface: "test:hub-integration",
    idempotencyKey: "hub-stage-1",
  });
  const gate = createFridayMutatingActionGate({
    nowIso: () => CANONICAL_STAGE_NOW,
    ticketIdGenerator: () => "ticket-1",
  });
  const result = gate.evaluate({
    ...request,
    canonicalApproval: {
      decision: "approved",
      approvalId: "approval-1",
      decidedByPrincipalId: actor.principalId,
      actionDigest: createFridayMutatingActionDigest(request),
      expiresAt: "2026-02-17T13:00:00.000Z",
    },
  });
  if (!result.ticket) {
    throw new Error(`failed to create canonical stage ticket: ${result.reason}`);
  }
  return result.ticket;
}

function makeSignedLifecycleApproval(input: {
  action: "shadow" | "canary" | "promote" | "rollback";
  skillId: string;
  candidateId: string;
  runtimeVersion: string;
  canaryInput?: Record<string, unknown>;
}): FridayCanonicalApprovalResolution {
  const rollback = input.action === "rollback"
    ? { planned: true, planDigest: PHASE32_PLAN_DIGEST, actions: ["skills.lifecycle.promote"] }
    : undefined;
  const request = createFridaySkillLifecycleMutatingActionRequest({
    action: input.action,
    skillId: input.skillId,
    candidateId: input.candidateId,
    shadowVersionId: input.candidateId,
    runtimeVersion: input.runtimeVersion,
    actor: {
      kind: "user",
      id: "phase32-user",
      principalId: "phase32-user",
    },
    surface: `api:/v1/autonomy/skills/${input.action}`,
    planDigest: PHASE32_PLAN_DIGEST,
    rollback,
    canaryInputDigest: input.action === "canary"
      ? createFridaySkillLifecycleCanaryInputDigest(input.canaryInput)
      : undefined,
  });
  return signFridayCanonicalApproval({
    decision: "approved",
    approvalId: `phase32-${input.action}-approval`,
    decidedByPrincipalId: "phase32-user",
    actionDigest: createFridayMutatingActionDigest(request),
    expiresAt: "2027-02-17T13:00:00.000Z",
  }, PHASE32_TOKEN_SECRET);
}

function makeSignedSkillRunApproval(input: {
  skillId: string;
  runInput: Record<string, unknown>;
}): FridayCanonicalApprovalResolution {
  const request = createFridaySkillRunMutatingActionRequest({
    skillId: input.skillId,
    input: input.runInput,
    channel: "api",
    sessionId: `api-skill-run:${input.skillId}`,
    actor: {
      kind: "user",
      id: "phase32-user",
      principalId: "phase32-user",
    },
    surface: "api:/v1/skills/:skillId/run",
  });
  return signFridayCanonicalApproval({
    decision: "approved",
    approvalId: "phase32-run-approval",
    decidedByPrincipalId: "phase32-user",
    actionDigest: createFridayMutatingActionDigest(request),
    expiresAt: "2027-02-17T13:00:00.000Z",
  }, PHASE32_TOKEN_SECRET);
}

function makeSignedProviderLifecycleApproval(input: {
  action: "shadow" | "canary" | "promote" | "rollback";
  providerId: string;
  shadowVersionId?: string;
  runtimeVersion: string;
}): FridayCanonicalApprovalResolution {
  const rollback = input.action === "rollback"
    ? { planned: true, planDigest: PHASE32B_PROVIDER_PLAN_DIGEST, actions: ["providers.lifecycle.promote"] }
    : undefined;
  const request = createFridayProviderProfileLifecycleMutatingActionRequest({
    action: input.action,
    providerId: input.providerId,
    shadowVersionId: input.shadowVersionId,
    runtimeVersion: input.runtimeVersion,
    actor: {
      kind: "user",
      id: "phase32-user",
      principalId: "phase32-user",
    },
    surface: `api:/v1/autonomy/providers/${input.action}`,
    planDigest: PHASE32B_PROVIDER_PLAN_DIGEST,
    rollback,
  });
  return signFridayCanonicalApproval({
    decision: "approved",
    approvalId: `phase32b-provider-${input.action}-approval`,
    decidedByPrincipalId: "phase32-user",
    actionDigest: createFridayMutatingActionDigest(request),
    expiresAt: "2027-02-17T13:00:00.000Z",
  }, PHASE32_TOKEN_SECRET);
}

describe("FridayHub Bootstrap Integration", () => {
  const tmpDirs: string[] = [];
  const hubs: FridayHub[] = [];
  let lastStateDir: string | null = null;
  let autoDetectEnvSnapshot: FridayAutoDetectProviderEnvSnapshot | null = null;
  // SEC-REALTIME-EVENT-PII-BY-VALUE / round-6 P0-1: this integration test drives real
  // workflow runs that publish realtime events; the sink is now FAIL-CLOSED without a
  // durable master key. Provision a real key so the default createFridayHub realtime
  // plane is ACTIVE (opaque + redacted) — the faithful production path.
  let savedMasterKey: string | undefined;
  let savedMasterKeySource: string | undefined;

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-hub-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  async function createIsolatedHub(): Promise<FridayHub> {
    const stateDir = makeTmpDir();
    lastStateDir = stateDir;
    const bundledSkillsDir = makeTmpDir();
    const managedSkillsDir = makeTmpDir();
    const hub = await createHubForDirs(stateDir, bundledSkillsDir, managedSkillsDir);
    return hub;
  }

  async function createHubForDirs(
    stateDir: string,
    bundledSkillsDir: string,
    managedSkillsDir: string,
  ): Promise<FridayHub> {
    const hub = await createFridayHub({
      allowTestOnlyWorkflowRunExecution: true, // TS-retirement method guard: test-oracle opt-in
      // TS-retirement method guards (orphan off-route leak audit): these hub
      // integration tests exercise the legacy TypeScript inbound satellite paths
      // (sync/register/heartbeat) as part of self-learning/self-healing scenarios.
      // Production hub creation leaves these unset so the methods fail closed.
      allowTestOnlySatelliteRuntimeExecution: true,
      allowTestOnlySatellitePairingExecution: true,
      stateDir,
      skillDirs: [bundledSkillsDir, managedSkillsDir],
    });
    hubs.push(hub);
    return hub;
  }

  async function withAutoFixDispatcherEnabled<T>(fn: () => Promise<T>): Promise<T> {
    const previous = process.env.FRIDAY_AUTOFIX_DISPATCHER_ENABLED;
    process.env.FRIDAY_AUTOFIX_DISPATCHER_ENABLED = "true";
    try {
      return await fn();
    } finally {
      if (previous === undefined) {
        delete process.env.FRIDAY_AUTOFIX_DISPATCHER_ENABLED;
      } else {
        process.env.FRIDAY_AUTOFIX_DISPATCHER_ENABLED = previous;
      }
    }
  }

  function makeApprovalOnlyGraph(
    workflowId: string,
    versionId: string,
  ): FridayCompiledWorkflowGraphV2 {
    return {
      schemaVersion: "2.0",
      workflowId,
      workflowVersionId: versionId,
      sourceSpecSchemaVersion: "1.0",
      graph: {
        nodes: [
          { id: "trigger", type: "trigger", label: "Trigger", config: {} },
          {
            id: "approval1",
            type: "approval",
            label: "Approval Gate",
            config: {
              approverRole: "admin",
              message: "Please approve restart durability",
              timeoutMs: 3_600_000,
            },
          },
        ],
        edges: [
          { id: "e1", sourceNodeId: "trigger", targetNodeId: "approval1" },
        ],
      },
      failurePolicy: { onFailure: "fail_fast", notifyUser: false },
      tests: [],
      checksum: "placeholder",
    };
  }

  function makeFailingActionGraph(
    workflowId: string,
    versionId: string,
  ): FridayCompiledWorkflowGraphV2 {
    return {
      schemaVersion: "2.0",
      workflowId,
      workflowVersionId: versionId,
      sourceSpecSchemaVersion: "1.0",
      graph: {
        nodes: [
          { id: "trigger", type: "trigger", label: "Trigger", config: {} },
          {
            id: "action1",
            type: "action",
            label: "Broken Action",
            config: {
              skillId: "missing-skill",
            },
          },
        ],
        edges: [
          { id: "e1", sourceNodeId: "trigger", targetNodeId: "action1" },
        ],
      },
      failurePolicy: { onFailure: "fail_fast", notifyUser: false },
      tests: [],
      checksum: "placeholder",
    };
  }

  function makeSkillActionGraph(
    workflowId: string,
    versionId: string,
    skillId: string,
  ): FridayCompiledWorkflowGraphV2 {
    return {
      schemaVersion: "2.0",
      workflowId,
      workflowVersionId: versionId,
      sourceSpecSchemaVersion: "1.0",
      graph: {
        nodes: [
          { id: "trigger", type: "trigger", label: "Trigger", config: {} },
          {
            id: "action1",
            type: "action",
            label: "Skill Action",
            config: { skillId },
          },
        ],
        edges: [
          { id: "e1", sourceNodeId: "trigger", targetNodeId: "action1" },
        ],
      },
      failurePolicy: { onFailure: "fail_fast", notifyUser: false },
      tests: [],
      checksum: "placeholder",
    };
  }

  function writeShellSkillFixture(input: {
    dir: string;
    skillId: string;
    name: string;
    result: string;
    sideEffectFile?: string;
  }): void {
    fs.mkdirSync(input.dir, { recursive: true });
    fs.writeFileSync(path.join(input.dir, "skill.manifest.json"), JSON.stringify({
      schemaVersion: "2.0",
      id: input.skillId,
      name: input.name,
      description: "Workflow availability fixture",
      version: "1.0.0",
      kind: "conversation",
      category: "utility",
      author: { name: "Friday Test" },
      tags: ["workflow-availability"],
      runtime: {
        kind: "shell",
        entrypoint: "run.sh",
        minHubVersion: "1.0.0",
        apiVersion: "1",
        timeoutMsDefault: 30_000,
      },
      triggers: { intents: [], phrases: [], channels: ["*"] },
      invocation: { userInvocable: true, modelInvocable: true, priority: 50, modes: ["workflow"] },
      requirements: { bins: [], env: [], config: [], os: ["darwin", "linux", "win32"] },
      inputs: [],
      outputs: [{ key: "result", type: "string", description: "Result" }],
      permissions: { grants: [], promptOn: [] },
      schemas: { input: null, state: null, output: null },
      flow: null,
      executionTargets: {
        allowedSatelliteTypes: ["phone", "desktop", "rpi", "cloud-vm"],
        requiredCapabilities: [],
      },
      telemetry: { events: [] },
    }, null, 2));
    fs.writeFileSync(path.join(input.dir, "SKILL.md"), `# ${input.name}\n`);
    const sideEffectLine = input.sideEffectFile
      ? `echo ran > '${input.sideEffectFile.replace(/'/g, "'\\''")}'\n`
      : "";
    fs.writeFileSync(path.join(input.dir, "run.sh"), `#!/usr/bin/env bash\n${sideEffectLine}echo '{"result":"${input.result}"}'\n`);
    fs.chmodSync(path.join(input.dir, "run.sh"), 0o755);
  }

  async function waitForWorkflowRunStable(
    hub: FridayHub,
    runId: string,
    timeoutMs = 5_000,
  ): Promise<string> {
    const start = Date.now();
    const transient = new Set(["queued", "running"]);
    while (Date.now() - start < timeoutMs) {
      const run = hub.workflowRuntime.execution.getRun(runId);
      if (run && !transient.has(run.status)) {
        return run.status;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const run = hub.workflowRuntime.execution.getRun(runId);
    return run?.status ?? "unknown";
  }

  beforeEach(() => {
    autoDetectEnvSnapshot = clearAutoDetectProviderEnv();
    savedMasterKey = process.env.FRIDAY_MASTER_KEY;
    savedMasterKeySource = process.env.FRIDAY_MASTER_KEY_SOURCE;
    process.env.FRIDAY_MASTER_KEY = crypto.randomBytes(32).toString("hex");
    delete process.env.FRIDAY_MASTER_KEY_SOURCE;
    resetMasterKeyCache();
  });

  afterEach(async () => {
    for (const hub of hubs) {
      try {
        await hub.stop();
      } catch {
        // ignore cleanup errors
      }
    }
    hubs.length = 0;

    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tmpDirs.length = 0;
    lastStateDir = null;
    if (autoDetectEnvSnapshot) {
      restoreAutoDetectProviderEnv(autoDetectEnvSnapshot);
      autoDetectEnvSnapshot = null;
    }
    if (savedMasterKey === undefined) delete process.env.FRIDAY_MASTER_KEY;
    else process.env.FRIDAY_MASTER_KEY = savedMasterKey;
    if (savedMasterKeySource === undefined) delete process.env.FRIDAY_MASTER_KEY_SOURCE;
    else process.env.FRIDAY_MASTER_KEY_SOURCE = savedMasterKeySource;
    resetMasterKeyCache();
  });

  // ─── Wires all services ───

  it("creates a hub with all expected service handles", async () => {
    const hub = await createIsolatedHub();

    expect(hub.skills).toBeDefined();
    expect(hub.executor).toBeDefined();
    expect(hub.providerService).toBeDefined();
    expect(hub.skillGenerator).toBeDefined();
    expect(hub.converterService).toBeDefined();
    expect(hub.workflowGenerator).toBeDefined();
    expect(hub.workflowRuntime).toBeDefined();
    expect(hub.apiRuntime).toBeDefined();
    expect(hub.workflowRuntime.crud).toBeDefined();
    expect(hub.workflowRuntime.execution).toBeDefined();
    expect(hub.workflowRuntime.triggers).toBeDefined();
    expect(hub.workflowRuntime.approval).toBeDefined();
  });

  it("keeps the local system runtime and companion IPC disabled by default", async () => {
    const previousEnabled = process.env.FRIDAY_SYSTEM_ENABLED;
    const previousRemote = process.env.FRIDAY_SYSTEM_REMOTE_MODE;
    const previousTransport = process.env.FRIDAY_SYSTEM_COMPANION_TRANSPORT;
    const previousSocketPath = process.env.FRIDAY_SYSTEM_COMPANION_SOCKET_PATH;
    const previousToken = process.env.FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN;
    const previousTokenFile = process.env.FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN_FILE;
    delete process.env.FRIDAY_SYSTEM_ENABLED;
    delete process.env.FRIDAY_SYSTEM_REMOTE_MODE;
    delete process.env.FRIDAY_SYSTEM_COMPANION_TRANSPORT;
    delete process.env.FRIDAY_SYSTEM_COMPANION_SOCKET_PATH;
    delete process.env.FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN;
    delete process.env.FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN_FILE;
    try {
      const hub = await createIsolatedHub();
      const route = hub.apiRuntime.routes.getRoutes()
        .find((entry) => entry.operationId === "system.session.get");
      const runDir = path.join(lastStateDir ?? "", ".friday", "run");

      expect(route).toBeUndefined();
      expect(fs.existsSync(path.join(runDir, "system-companion.auth.token"))).toBe(false);
      expect(fs.existsSync(path.join(runDir, "system-companion.sock"))).toBe(false);
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.FRIDAY_SYSTEM_ENABLED;
      } else {
        process.env.FRIDAY_SYSTEM_ENABLED = previousEnabled;
      }
      if (previousRemote === undefined) {
        delete process.env.FRIDAY_SYSTEM_REMOTE_MODE;
      } else {
        process.env.FRIDAY_SYSTEM_REMOTE_MODE = previousRemote;
      }
      if (previousTransport === undefined) {
        delete process.env.FRIDAY_SYSTEM_COMPANION_TRANSPORT;
      } else {
        process.env.FRIDAY_SYSTEM_COMPANION_TRANSPORT = previousTransport;
      }
      if (previousSocketPath === undefined) {
        delete process.env.FRIDAY_SYSTEM_COMPANION_SOCKET_PATH;
      } else {
        process.env.FRIDAY_SYSTEM_COMPANION_SOCKET_PATH = previousSocketPath;
      }
      if (previousToken === undefined) {
        delete process.env.FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN;
      } else {
        process.env.FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN = previousToken;
      }
      if (previousTokenFile === undefined) {
        delete process.env.FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN_FILE;
      } else {
        process.env.FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN_FILE = previousTokenFile;
      }
    }
  });


  it("keeps local system runtime on when explicitly enabled while remote stays disabled", async () => {
    const previousEnabled = process.env.FRIDAY_SYSTEM_ENABLED;
    const previousRemote = process.env.FRIDAY_SYSTEM_REMOTE_MODE;
    process.env.FRIDAY_SYSTEM_ENABLED = "true";
    delete process.env.FRIDAY_SYSTEM_REMOTE_MODE;
    try {
      const hub = await createIsolatedHub();
      const route = hub.apiRuntime.routes.getRoutes()
        .find((entry) => entry.operationId === "system.session.get");

      expect(route).toBeDefined();
      const response = await route!.handler({
        requestId: "req-system-session-default-on",
        receivedAt: new Date().toISOString(),
        params: {},
        query: {},
        body: {},
        headers: {},
        principal: null,
      } as never) as { session: { remoteMode: string; companion: { connected: boolean; transport: { authenticated: boolean } } } };

      expect(response.session.remoteMode).toBe("disabled");
      expect(response.session.companion.connected).toBe(true);
      expect(response.session.companion.transport.authenticated).toBe(true);
      expect(fs.statSync(path.join(lastStateDir ?? "", ".friday", "run", "system-companion.auth.token")).mode & 0o777)
        .toBe(0o600);
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.FRIDAY_SYSTEM_ENABLED;
      } else {
        process.env.FRIDAY_SYSTEM_ENABLED = previousEnabled;
      }
      if (previousRemote === undefined) {
        delete process.env.FRIDAY_SYSTEM_REMOTE_MODE;
      } else {
        process.env.FRIDAY_SYSTEM_REMOTE_MODE = previousRemote;
      }
    }
  });

  it("keeps hub booting with system runtime unavailable when companion socket setup fails closed", async () => {
    const previousEnabled = process.env.FRIDAY_SYSTEM_ENABLED;
    const previousSocketPath = process.env.FRIDAY_SYSTEM_COMPANION_SOCKET_PATH;
    process.env.FRIDAY_SYSTEM_ENABLED = "true";
    const blockedSocketPath = path.join(makeTmpDir(), "system-companion.sock");
    fs.writeFileSync(blockedSocketPath, "not a socket");
    process.env.FRIDAY_SYSTEM_COMPANION_SOCKET_PATH = blockedSocketPath;
    try {
      const hub = await createIsolatedHub();
      const route = hub.apiRuntime.routes.getRoutes()
        .find((entry) => entry.operationId === "system.session.get");

      expect(route).toBeDefined();
      const response = await route!.handler({
        requestId: "req-system-session-unavailable",
        receivedAt: new Date().toISOString(),
        params: {},
        query: {},
        body: {},
        headers: {},
        principal: null,
      } as never) as { session: { health: { status: string; reasons: string[] }; companion: { connected: boolean } } };

      expect(response.session.companion.connected).toBe(false);
      expect(response.session.health.status).toBe("unavailable");
      expect(response.session.health.reasons).toContain("companion_disconnected");
      expect(fs.readFileSync(blockedSocketPath, "utf8")).toBe("not a socket");
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.FRIDAY_SYSTEM_ENABLED;
      } else {
        process.env.FRIDAY_SYSTEM_ENABLED = previousEnabled;
      }
      if (previousSocketPath === undefined) {
        delete process.env.FRIDAY_SYSTEM_COMPANION_SOCKET_PATH;
      } else {
        process.env.FRIDAY_SYSTEM_COMPANION_SOCKET_PATH = previousSocketPath;
      }
    }
  });

  it("stores external skill candidates under the resolved state dir when no input stateDir is provided", async () => {
    const previousHome = process.env.HOME;
    const previousFridayStateDir = process.env.FRIDAY_STATE_DIR;
    const previousXdgStateHome = process.env.XDG_STATE_HOME;
    const previousCwd = process.cwd();
    const homeDir = makeTmpDir();
    const cwdDir = makeTmpDir();
    const bundledSkillsDir = makeTmpDir();
    const managedSkillsDir = makeTmpDir();
    const sourceDir = makeTmpDir();
    const expectedStateDir = process.platform === "darwin"
      ? path.join(homeDir, "Library", "Application Support", "Friday", "state")
      : process.platform === "win32"
        ? path.join(homeDir, "AppData", "Local", "Friday", "state")
        : path.join(homeDir, ".local", "state", "friday");

    fs.writeFileSync(path.join(sourceDir, "skill.manifest.json"), JSON.stringify({
      schemaVersion: "2.0",
      id: "resolved-state-candidate-skill",
      name: "Resolved State Candidate Skill",
      description: "Verifies candidate storage path.",
      version: "1.0.0",
      kind: "conversation",
      category: "utility",
      author: { name: "Test" },
      tags: ["test"],
      runtime: {
        kind: "shell",
        entrypoint: "run.sh",
        minHubVersion: "1.0.0",
        apiVersion: "1",
        timeoutMsDefault: 30_000,
      },
      triggers: { intents: [], phrases: [], channels: ["*"] },
      invocation: {
        userInvocable: true,
        modelInvocable: true,
        priority: 50,
        modes: ["intent"],
      },
      requirements: { bins: [], env: [], config: [], os: ["darwin", "linux", "win32"] },
      inputs: [],
      outputs: [{ key: "result", type: "string" }],
      permissions: { grants: [], promptOn: [] },
      schemas: { input: null, state: null, output: null },
      flow: null,
      executionTargets: {
        allowedSatelliteTypes: ["phone", "desktop", "rpi", "cloud-vm"],
        requiredCapabilities: [],
      },
      telemetry: { events: [] },
    }, null, 2));
    fs.writeFileSync(path.join(sourceDir, "skill.ui.json"), JSON.stringify({
      schemaVersion: "1.0",
      title: "Resolved State Candidate Skill",
      sections: [],
      fields: [],
      outputs: [],
      actions: [],
    }, null, 2));
    fs.writeFileSync(path.join(sourceDir, "run.sh"), "#!/usr/bin/env bash\necho '{}'\n");

    try {
      process.env.HOME = homeDir;
      delete process.env.FRIDAY_STATE_DIR;
      delete process.env.XDG_STATE_HOME;
      process.chdir(cwdDir);

      const hub = await createFridayHub({
        skillDirs: [bundledSkillsDir, managedSkillsDir],
      });
      hubs.push(hub);

      await expect(hub.converterService.import({
        source: { uri: sourceDir },
        formatHint: "friday-package",
      })).rejects.toThrow("canonical approval ticket");

      const importInput = {
        source: { uri: sourceDir },
        formatHint: "friday-package" as const,
      };
      const result = await hub.converterService.import({
        ...importInput,
        canonicalApprovalTicket: makeCanonicalStageTicket(importInput),
      });
      const candidate = result.candidates[0]!;

      expect(candidate.candidateDir.startsWith(path.join(expectedStateDir, "skill-candidates"))).toBe(true);
      expect(candidate.candidateDir.startsWith(path.join(cwdDir, "skill-candidates"))).toBe(false);
    } finally {
      process.chdir(previousCwd);
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousFridayStateDir === undefined) {
        delete process.env.FRIDAY_STATE_DIR;
      } else {
        process.env.FRIDAY_STATE_DIR = previousFridayStateDir;
      }
      if (previousXdgStateHome === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = previousXdgStateHome;
      }
    }
  });

  it("drives external skill candidate through shadow, real canary, promote, run, and rollback via autonomy routes", async () => {
    const stateDir = makeTmpDir();
    const bundledSkillsDir = makeTmpDir();
    const managedSkillsDir = makeTmpDir();
    const sourceDir = makeTmpDir();
    const skillId = "phase32-skill";
    const runtimeVersion = "runtime-phase32";

    fs.writeFileSync(path.join(sourceDir, "skill.manifest.json"), JSON.stringify({
      schemaVersion: "2.0",
      id: skillId,
      name: "Phase 3.2 Skill",
      description: "External lifecycle closure fixture",
      version: "1.0.0",
      kind: "conversation",
      category: "utility",
      author: { name: "Friday Test" },
      tags: ["phase32"],
      runtime: {
        kind: "shell",
        entrypoint: "run.sh",
        minHubVersion: "1.0.0",
        apiVersion: "1",
        timeoutMsDefault: 30_000,
      },
      triggers: { intents: [], phrases: [], channels: ["*"] },
      invocation: { userInvocable: true, modelInvocable: true, priority: 50, modes: ["intent"] },
      requirements: { bins: [], env: [], config: [], os: ["darwin", "linux", "win32"] },
      inputs: [],
      outputs: [{ key: "result", type: "string", description: "Result" }],
      permissions: { grants: [], promptOn: [] },
      schemas: { input: null, state: null, output: null },
      flow: null,
      executionTargets: {
        allowedSatelliteTypes: ["phone", "desktop", "rpi", "cloud-vm"],
        requiredCapabilities: [],
      },
      telemetry: { events: [] },
    }, null, 2));
    fs.writeFileSync(path.join(sourceDir, "SKILL.md"), "# Phase 3.2 Skill\n");
    fs.writeFileSync(path.join(sourceDir, "skill.ui.json"), JSON.stringify({
      schemaVersion: "1.0",
      title: "Phase 3.2 Skill",
      sections: [],
      fields: [],
      outputs: [],
      actions: [],
    }, null, 2));
    fs.writeFileSync(path.join(sourceDir, "run.sh"), "#!/usr/bin/env bash\necho '{\"result\":\"phase32-ok\"}'\n");
    fs.chmodSync(path.join(sourceDir, "run.sh"), 0o755);

    const hub = await createFridayHub({
      stateDir,
      skillDirs: [bundledSkillsDir, managedSkillsDir],
      tokenSecret: PHASE32_TOKEN_SECRET,
      allowTestOnlySkillRunExecution: true,
      allowTestOnlyNonDarwinShellSandboxExecution: true,
      allowTestOnlyAutonomyLifecycleExecution: true,
    });
    hubs.push(hub);

    const importInput = {
      source: { uri: sourceDir },
      formatHint: "friday-package" as const,
    };
    const importResult = await hub.converterService.import({
      ...importInput,
      canonicalApprovalTicket: makeCanonicalStageTicket(importInput),
    });
    const candidate = importResult.candidates[0]!;

    const principal = {
      principalType: "user" as const,
      principalId: "phase32-user",
      userId: "phase32-user",
      role: "admin" as const,
      scopes: ["hub.admin"] as const,
    };
	    const invokeRoute = async (operationId: string, body: Record<string, unknown>) => {
	      const route = hub.apiRuntime.routes.getRoutes().find((entry) => entry.operationId === operationId);
	      expect(route).toBeDefined();
	      return route!.handler({
        requestId: `${operationId}:req`,
        receivedAt: new Date().toISOString(),
        params: { skillId },
        query: {},
        body,
        headers: {},
	        principal,
	      });
	    };

	    await expect(invokeRoute("skills.install", { skillId, sourceId: "legacy-source" }))
	      .rejects.toMatchObject({ code: "SKILL_LEGACY_LIFECYCLE_ROUTE_RETIRED" });
	    await expect(invokeRoute("skills.update", { version: "2.0.0" }))
	      .rejects.toMatchObject({ code: "SKILL_LEGACY_LIFECYCLE_ROUTE_RETIRED" });
	    await expect(invokeRoute("skills.delete", {}))
	      .rejects.toMatchObject({ code: "SKILL_LEGACY_LIFECYCLE_ROUTE_RETIRED" });

	    await invokeRoute("autonomy.skills.shadow", {
      candidateId: candidate.candidateId,
      runtimeVersion,
      planDigest: PHASE32_PLAN_DIGEST,
      canonicalApproval: makeSignedLifecycleApproval({
        action: "shadow",
        skillId,
        candidateId: candidate.candidateId,
        runtimeVersion,
      }),
    });
    expect(fs.existsSync(path.join(managedSkillsDir, ".shadow", skillId, candidate.candidateId, "skill.manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(managedSkillsDir, skillId, "skill.manifest.json"))).toBe(false);

    await expect(invokeRoute("skills.run", { input: {} })).rejects.toMatchObject({
      code: "SKILL_NOT_AVAILABLE",
    });

    await invokeRoute("autonomy.skills.canary", {
      candidateId: candidate.candidateId,
      runtimeVersion,
      planDigest: PHASE32_PLAN_DIGEST,
      input: {},
      canonicalApproval: makeSignedLifecycleApproval({
        action: "canary",
        skillId,
        candidateId: candidate.candidateId,
        runtimeVersion,
        canaryInput: {},
      }),
    });

    await invokeRoute("autonomy.skills.promote", {
      candidateId: candidate.candidateId,
      runtimeVersion,
      planDigest: PHASE32_PLAN_DIGEST,
      canonicalApproval: makeSignedLifecycleApproval({
        action: "promote",
        skillId,
        candidateId: candidate.candidateId,
        runtimeVersion,
      }),
    });
    expect(fs.existsSync(path.join(managedSkillsDir, skillId, "skill.manifest.json"))).toBe(true);

    await expect(invokeRoute("skills.run", { input: {} })).rejects.toMatchObject({
      code: "SKILL_RUN_APPROVAL_REQUIRED",
    });
    const runResult = await invokeRoute("skills.run", {
      input: {},
      canonicalApproval: makeSignedSkillRunApproval({ skillId, runInput: {} }),
    }) as {
      status: string;
      output: { result?: string };
    };
    expect(runResult.status).toBe("completed");
    expect(runResult.output.result).toBe("phase32-ok");

    await invokeRoute("autonomy.skills.rollback", {
      candidateId: candidate.candidateId,
      runtimeVersion,
      planDigest: PHASE32_PLAN_DIGEST,
      reason: "integration rollback proof",
      canonicalApproval: makeSignedLifecycleApproval({
        action: "rollback",
        skillId,
        candidateId: candidate.candidateId,
        runtimeVersion,
      }),
    });
    expect(fs.existsSync(path.join(managedSkillsDir, skillId, "skill.manifest.json"))).toBe(false);
    await expect(invokeRoute("skills.run", { input: {} })).rejects.toMatchObject({
      code: "SKILL_NOT_AVAILABLE",
    });
  });

  it("blocks workflow skill execution when persisted lifecycle status is unavailable", async () => {
    const stateDir = makeTmpDir();
    lastStateDir = stateDir;
    const bundledSkillsDir = makeTmpDir();
    const managedSkillsDir = makeTmpDir();
    const sourceDir = makeTmpDir();
    const skillId = "workflow-status-proof";
    const sideEffectFile = path.join(stateDir, "workflow-skill-ran.txt");

    writeShellSkillFixture({
      dir: path.join(bundledSkillsDir, skillId),
      skillId,
      name: "Workflow Status Proof",
      result: "bundled-ran",
      sideEffectFile,
    });
    writeShellSkillFixture({
      dir: sourceDir,
      skillId,
      name: "Workflow Status Proof Candidate",
      result: "candidate-ran",
    });

    const hub = await createFridayHub({
      allowTestOnlyWorkflowRunExecution: true, // TS-retirement method guard: test-oracle opt-in
      stateDir,
      skillDirs: [bundledSkillsDir, managedSkillsDir],
      tokenSecret: PHASE32_TOKEN_SECRET,
    });
    hubs.push(hub);
    await hub.start();

    expect(hub.skills.get(skillId)?.status).toBe("installed");

    const importInput = {
      source: { uri: sourceDir },
      formatHint: "friday-package" as const,
    };
    await hub.converterService.import({
      ...importInput,
      canonicalApprovalTicket: makeCanonicalStageTicket(importInput),
    });
    await hub.skills.refresh();

    expect(hub.skills.get(skillId)?.status).toBe("installed");

    const skillListRoute = hub.apiRuntime.routes.getRoutes()
      .find((entry) => entry.operationId === "skills.list");
    expect(skillListRoute).toBeDefined();
    const skillList = await skillListRoute!.handler({
      requestId: "workflow-status-proof:list",
      receivedAt: new Date().toISOString(),
      params: {},
      query: {},
      body: {},
      headers: {},
      principal: null,
    } as never) as { items: Array<{ skillId: string; status: string }> };
    expect(skillList.items.find((item) => item.skillId === skillId)?.status).toBe("not_installed");

    const workflow = hub.workflowRuntime.crud.createWorkflow({
      slug: "workflow-status-proof",
      name: "Workflow Status Proof",
    });
    const version = hub.workflowRuntime.crud.createVersion(
      workflow.id,
      makeSkillActionGraph(workflow.id, "placeholder", skillId),
    );
    hub.workflowRuntime.crud.publishVersion(workflow.id, version.versionNumber);

    const run = await hub.workflowRuntime.execution.startRun({
      workflowId: workflow.id,
      workflowVersionId: version.id,
      triggerType: "manual",
      startedByUserId: "admin-001",
    });

    const finalStatus = await waitForWorkflowRunStable(hub, run.id, 10_000);
    expect(finalStatus).toBe("failed");
    expect(fs.existsSync(sideEffectFile)).toBe(false);
  });

  it("drives provider profile lifecycle through canonical-approved autonomy routes and survives restart", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "phase32b-model" }] }), { status: 200 })) as typeof fetch;
    try {
      const stateDir = makeTmpDir();
      lastStateDir = stateDir;
      const bundledSkillsDir = makeTmpDir();
      const managedSkillsDir = makeTmpDir();
      const runtimeVersion = "phase32b-runtime";
      const hub = await createFridayHub({
        stateDir,
        skillDirs: [bundledSkillsDir, managedSkillsDir],
        tokenSecret: PHASE32_TOKEN_SECRET,
        allowTestOnlyAutonomyLifecycleExecution: true,
      });
      hubs.push(hub);

      const provider = await hub.providerService.createProvider({
        kind: "openai-compatible",
        name: "Phase 3.2B Provider",
        baseUrl: "https://example.com",
        authMode: "none",
        api: "openai-completions",
        supportedModels: ["phase32b-model"],
        defaultModel: "phase32b-model",
        enabled: true,
        validateOnSave: false,
      });
      const validation = await hub.providerService.validateProvider(provider.id);
      expect(validation.status).toBe("ok");
      await hub.providerService.setRoutingConfig({
        defaultProviderId: provider.id,
        fallbackProviderIds: [],
      });
      await expect(hub.providerService.resolveRoute(undefined, provider.id)).resolves.toMatchObject({
        provider: { id: provider.id },
      });

      const principal = {
        principalType: "user" as const,
        principalId: "phase32-user",
        userId: "phase32-user",
        role: "admin" as const,
        scopes: ["hub.admin"] as const,
      };
      const shadowVersionId = `${provider.id}@shadow`;
      const invokeProviderRoute = async (operationId: string, body: Record<string, unknown>) => {
        const route = hub.apiRuntime.routes.getRoutes().find((entry) => entry.operationId === operationId);
        expect(route).toBeDefined();
        return route!.handler({
          requestId: `${operationId}:req`,
          receivedAt: new Date().toISOString(),
          params: { providerId: provider.id },
          query: {},
          body,
          headers: {},
          principal,
        });
      };

      await expect(invokeProviderRoute("autonomy.providers.shadow", {
        shadowVersionId,
        runtimeVersion,
        planDigest: PHASE32B_PROVIDER_PLAN_DIGEST,
      })).rejects.toMatchObject({ code: "CANONICAL_APPROVAL_REQUIRED" });

      await invokeProviderRoute("autonomy.providers.shadow", {
        shadowVersionId,
        runtimeVersion,
        planDigest: PHASE32B_PROVIDER_PLAN_DIGEST,
        canonicalApproval: makeSignedProviderLifecycleApproval({
          action: "shadow",
          providerId: provider.id,
          shadowVersionId,
          runtimeVersion,
        }),
      });
      await expect(hub.providerService.resolveRoute(undefined, provider.id)).rejects.toMatchObject({
        code: "PROVIDER_LIFECYCLE_UNPROMOTED",
      });

      await expect(invokeProviderRoute("autonomy.providers.canary", {
        runtimeVersion,
        success: true,
        planDigest: PHASE32B_PROVIDER_PLAN_DIGEST,
        canonicalApproval: makeSignedProviderLifecycleApproval({
          action: "canary",
          providerId: provider.id,
          shadowVersionId,
          runtimeVersion,
        }),
      })).rejects.toMatchObject({ code: "PROVIDER_CANARY_RUNTIME_PROOF_REQUIRED" });

      await invokeProviderRoute("autonomy.providers.canary", {
        runtimeVersion,
        planDigest: PHASE32B_PROVIDER_PLAN_DIGEST,
        canonicalApproval: makeSignedProviderLifecycleApproval({
          action: "canary",
          providerId: provider.id,
          shadowVersionId,
          runtimeVersion,
        }),
      });
      await expect(hub.providerService.resolveRoute(undefined, provider.id)).rejects.toMatchObject({
        code: "PROVIDER_LIFECYCLE_UNPROMOTED",
      });

      const promoteResult = await invokeProviderRoute("autonomy.providers.promote", {
        runtimeVersion,
        planDigest: PHASE32B_PROVIDER_PLAN_DIGEST,
        canonicalApproval: makeSignedProviderLifecycleApproval({
          action: "promote",
          providerId: provider.id,
          shadowVersionId,
          runtimeVersion,
        }),
      }) as {
        provider: { promotionChannel?: string };
        evidence?: { stage?: string };
      };
      expect(promoteResult.provider.promotionChannel).toBe("active");
      expect(promoteResult.evidence?.stage).toBe("active");
      await expect(hub.providerService.resolveRoute(undefined, provider.id)).resolves.toMatchObject({
        provider: { id: provider.id },
      });

      await hub.stop();
      const restarted = await createFridayHub({
        stateDir,
        skillDirs: [bundledSkillsDir, managedSkillsDir],
        tokenSecret: PHASE32_TOKEN_SECRET,
        allowTestOnlyAutonomyLifecycleExecution: true,
      });
      hubs.push(restarted);
      const restartedProvider = await restarted.providerService.getProvider(provider.id);
      expect(restartedProvider?.promotionChannel).toBe("active");
      expect(restartedProvider?.config.validation?.status).toBe("ok");
      await expect(restarted.providerService.resolveRoute(undefined, provider.id)).resolves.toMatchObject({
        provider: { id: provider.id },
      });

      const rollbackRoute = restarted.apiRuntime.routes.getRoutes()
        .find((entry) => entry.operationId === "autonomy.providers.rollback");
      expect(rollbackRoute).toBeDefined();
      const rollbackResult = await rollbackRoute!.handler({
        requestId: "autonomy.providers.rollback:req",
        receivedAt: new Date().toISOString(),
        params: { providerId: provider.id },
        query: {},
        body: {
          runtimeVersion,
          planDigest: PHASE32B_PROVIDER_PLAN_DIGEST,
          reason: "integration rollback proof",
          canonicalApproval: makeSignedProviderLifecycleApproval({
            action: "rollback",
            providerId: provider.id,
            shadowVersionId,
            runtimeVersion,
          }),
        },
        headers: {},
        principal,
      }) as {
        provider: { promotionChannel?: string };
        evidence?: { stage?: string };
      };
      expect(rollbackResult.provider.promotionChannel).toBe("none");
      expect(rollbackResult.evidence?.stage).toBe("rolled_back");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("blocks legacy system approval-rule mutation route in the live hub", async () => {
    const previousEnabled = process.env.FRIDAY_SYSTEM_ENABLED;
    const previousTransport = process.env.FRIDAY_SYSTEM_COMPANION_TRANSPORT;
    const previousCanonicalGate = process.env.FRIDAY_CANONICAL_GATE;
    process.env.FRIDAY_SYSTEM_ENABLED = "true";
    process.env.FRIDAY_SYSTEM_COMPANION_TRANSPORT = "in_process";
    process.env.FRIDAY_CANONICAL_GATE = "true";
    try {
      const hub = await createIsolatedHub();
      const route = hub.apiRuntime.routes.getRoutes()
        .find((entry) => entry.operationId === "system.approvals.update");

      expect(route).toBeDefined();
      await expect(route!.handler({
        requestId: "req-system-approval-1",
        receivedAt: new Date().toISOString(),
        params: { approvalId: "approval-1" },
        query: {},
        body: { decision: "allow", idempotencyKey: "approval-update-1" },
        headers: {},
        principal: null,
      } as never)).rejects.toMatchObject({
        // TS runtime retirement: the route-level fail-close guard now rejects
        // system.approvals.update (503) BEFORE the hub canonical-approval stub
        // (deps.approvals.update) would run; the route is blocked even harder.
        code: "TS_RUNTIME_SYSTEM_APPROVAL_RETIRED",
        httpStatus: 503,
      });
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.FRIDAY_SYSTEM_ENABLED;
      } else {
        process.env.FRIDAY_SYSTEM_ENABLED = previousEnabled;
      }
      if (previousTransport === undefined) {
        delete process.env.FRIDAY_SYSTEM_COMPANION_TRANSPORT;
      } else {
        process.env.FRIDAY_SYSTEM_COMPANION_TRANSPORT = previousTransport;
      }
      if (previousCanonicalGate === undefined) {
        delete process.env.FRIDAY_CANONICAL_GATE;
      } else {
        process.env.FRIDAY_CANONICAL_GATE = previousCanonicalGate;
      }
    }
  });

  it("fail-closes the system approval-rule route by default in the production profile (retirement guard precedes the canonical gate)", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousEnabled = process.env.FRIDAY_SYSTEM_ENABLED;
    const previousTransport = process.env.FRIDAY_SYSTEM_COMPANION_TRANSPORT;
    const previousCanonicalGate = process.env.FRIDAY_CANONICAL_GATE;
    // NODE_ENV=production with FRIDAY_CANONICAL_GATE unset previously asserted the
    // canonical-approval default; after TS runtime retirement the route-level
    // fail-close guard rejects the route regardless of these env vars, so this
    // env scaffolding is retained only to prove the production profile is still
    // blocked (now by the retirement guard, not the canonical gate).
    process.env.NODE_ENV = "production";
    process.env.FRIDAY_SYSTEM_ENABLED = "true";
    process.env.FRIDAY_SYSTEM_COMPANION_TRANSPORT = "in_process";
    delete process.env.FRIDAY_CANONICAL_GATE;
    try {
      const hub = await createIsolatedHub();
      const route = hub.apiRuntime.routes.getRoutes()
        .find((entry) => entry.operationId === "system.approvals.update");

      expect(route).toBeDefined();
      await expect(route!.handler({
        requestId: "req-system-approval-production-default",
        receivedAt: new Date().toISOString(),
        params: { approvalId: "approval-1" },
        query: {},
        body: { decision: "allow", idempotencyKey: "approval-update-production-default" },
        headers: {},
        principal: null,
      } as never)).rejects.toMatchObject({
        code: "TS_RUNTIME_SYSTEM_APPROVAL_RETIRED",
        httpStatus: 503,
      });
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
      if (previousEnabled === undefined) {
        delete process.env.FRIDAY_SYSTEM_ENABLED;
      } else {
        process.env.FRIDAY_SYSTEM_ENABLED = previousEnabled;
      }
      if (previousTransport === undefined) {
        delete process.env.FRIDAY_SYSTEM_COMPANION_TRANSPORT;
      } else {
        process.env.FRIDAY_SYSTEM_COMPANION_TRANSPORT = previousTransport;
      }
      if (previousCanonicalGate === undefined) {
        delete process.env.FRIDAY_CANONICAL_GATE;
      } else {
        process.env.FRIDAY_CANONICAL_GATE = previousCanonicalGate;
      }
    }
  });

  // ─── start() transitions to running ───

  it("transitions to 'running' after start()", async () => {
    const hub = await createIsolatedHub();

    expect(hub.status().state).toBe("stopped");

    await hub.start();

    const status = hub.status();
    expect(status.state).toBe("running");
    expect(status.upSince).toBeTruthy();
    expect(status.skillCount).toBe(0); // no skill dirs configured
  });

  it("starts successfully when desktop runtime is enabled", async () => {
    const prevDesktopEnabled = process.env.FRIDAY_DESKTOP_ENABLED;
    const prevSandboxRoots = process.env.FRIDAY_DESKTOP_SANDBOX_ALLOWED_ROOTS;
    process.env.FRIDAY_DESKTOP_ENABLED = "true";
    try {
      const hub = await createIsolatedHub();
      process.env.FRIDAY_DESKTOP_SANDBOX_ALLOWED_ROOTS = lastStateDir ?? process.cwd();
      await hub.start();
      expect(hub.status().state).toBe("running");
    } finally {
      if (prevDesktopEnabled === undefined) {
        delete process.env.FRIDAY_DESKTOP_ENABLED;
      } else {
        process.env.FRIDAY_DESKTOP_ENABLED = prevDesktopEnabled;
      }
      if (prevSandboxRoots === undefined) {
        delete process.env.FRIDAY_DESKTOP_SANDBOX_ALLOWED_ROOTS;
      } else {
        process.env.FRIDAY_DESKTOP_SANDBOX_ALLOWED_ROOTS = prevSandboxRoots;
      }
    }
  }, 30_000);

  it("registers late-bound setup tools on the top-level agent runtime", async () => {
    const prevMcpServerEnabled = process.env.FRIDAY_MCP_SERVER_ENABLED;
    process.env.FRIDAY_MCP_SERVER_ENABLED = "true";

    try {
      const hub = await createIsolatedHub();
      const tools = await Promise.resolve(hub.apiRuntime.mcpServer!.listTools());
      const toolNames = tools.map((tool) => tool.name);

      // MCP self-server now defaults to a curated safe catalog.
      // Unsafe tools (autonomous, setup, setup_assistant) are no longer
      // exposed by default — only safe read-only tools are listed.
      expect(toolNames).toContain("capabilities");
      expect(toolNames).toContain("task_status");
      expect(toolNames).toContain("read");
      expect(toolNames).not.toContain("sessions");
      expect(toolNames).not.toContain("autonomous");
      expect(toolNames).not.toContain("setup");
      expect(toolNames).not.toContain("exec");
    } finally {
      if (prevMcpServerEnabled === undefined) {
        delete process.env.FRIDAY_MCP_SERVER_ENABLED;
      } else {
        process.env.FRIDAY_MCP_SERVER_ENABLED = prevMcpServerEnabled;
      }
    }
  });

  // ─── stop() cleans up ───

  it("transitions to 'stopped' after stop()", async () => {
    const hub = await createIsolatedHub();

    await hub.start();
    expect(hub.status().state).toBe("running");

    await hub.stop();

    const status = hub.status();
    expect(status.state).toBe("stopped");
    expect(status.upSince).toBeNull();
  });

  // ─── SQLite DB file created ───

  it("creates friday.db in the stateDir", async () => {
    const stateDir = makeTmpDir();
    const bundledSkillsDir = makeTmpDir();
    const managedSkillsDir = makeTmpDir();
    const hub = await createFridayHub({
      stateDir,
      skillDirs: [bundledSkillsDir, managedSkillsDir],
    });
    hubs.push(hub);

    const dbPath = path.join(stateDir, "friday.db");
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it("loads setup wizard channel config when explicit channels are not provided", async () => {
    const stateDir = makeTmpDir();
    const bundledSkillsDir = makeTmpDir();
    const managedSkillsDir = makeTmpDir();

    const stateRuntime = initializeFridayState({
      env: {
        ...process.env,
        FRIDAY_STATE_DIR: stateDir,
      },
    });

    const now = new Date().toISOString();
    stateRuntime.sqlite.withWriteTransaction((db) => {
      db.prepare(
        `INSERT OR IGNORE INTO friday_setup_state (id, created_at, updated_at)
         VALUES ('singleton', ?, ?)`,
      ).run(now, now);
      db.prepare(
        `UPDATE friday_setup_state
         SET channels_json = ?, updated_at = ?
         WHERE id = 'singleton'`,
      ).run(
        JSON.stringify([
          {
            kind: "webchat",
            enabled: true,
            controlConfirmed: true,
            controlConfirmedAt: now,
            config: {
              wsPath: "/ws/friday",
              authMode: "none",
            },
          },
        ]),
        now,
      );
    });
    stateRuntime.close();

    const hub = await createFridayHub({
      stateDir,
      skillDirs: [bundledSkillsDir, managedSkillsDir],
    });
    hubs.push(hub);

    await hub.start();

    expect(hub.channelRegistry.list()).toContain("webchat");
    expect(hub.channelRegistry.status("webchat")).toBe("connected");
  });

  it("disables plaintext-secret channels under strict policy by default", async () => {
    const stateDir = makeTmpDir();
    const bundledSkillsDir = makeTmpDir();
    const managedSkillsDir = makeTmpDir();

    const hub = await createFridayHub({
      stateDir,
      skillDirs: [bundledSkillsDir, managedSkillsDir],
      channels: {
        enabled: true,
        instances: [
          {
            kind: "discord",
            enabled: true,
            token: "plaintext-token-should-not-load",
          },
        ],
      },
    });
    hubs.push(hub);

    expect(hub.channelRegistry.list()).not.toContain("discord");
  });

  it("routes satellite local events through self-learning pipeline", async () => {
    const hub = await createIsolatedHub();
    const now = new Date().toISOString();
    const eventId = `evt-local-${Date.now()}`;

    await hub.satelliteRuntime.sync.push({
      satelliteId: "sat-1",
      acks: [],
      localEvents: [
        {
          eventId,
          ts: now,
          userId: "admin-001",
          kind: "user_message",
          payload: { text: "call me captain" },
        },
      ],
    });

    const dbPath = path.join(lastStateDir ?? "", "friday.db");
    const db = new Database(dbPath);
    try {
      const eventRow = db
        .prepare("SELECT event_id FROM learning_events WHERE event_id = ?")
        .get(eventId) as { event_id: string } | undefined;
      expect(eventRow?.event_id).toBe(eventId);

      const factRow = db
        .prepare("SELECT value_json FROM preference_facts WHERE user_id = ? AND key = ?")
        .get("admin-001", "pref:display_name") as { value_json: string } | undefined;
      expect(factRow).toBeDefined();
      expect(JSON.parse(factRow!.value_json)).toBe("captain");
    } finally {
      db.close();
    }
  });

  it("routes agent runtime failures through self-learning pipeline and diagnosis storage", async () => {
    const hub = await createIsolatedHub();
    const runId = `agent-run-${Date.now()}`;

    hub.apiRuntime.agentRuntime!.emitRunEvent("agent.run.failed", {
      runId,
      error: {
        code: "AGENT_LLM_ERROR",
        message: "Synthetic agent learning bridge failure",
      },
      durationMs: 123,
    }, runId);

    const dbPath = path.join(lastStateDir ?? "", "friday.db");
    const db = new Database(dbPath);
    try {
      const eventRow = db
        .prepare("SELECT kind, payload_json FROM learning_events WHERE payload_json LIKE ? ORDER BY ts DESC LIMIT 1")
        .get(`%${runId}%`) as { kind: string; payload_json: string } | undefined;
      expect(eventRow?.kind).toBe("error_incident");
      expect(JSON.parse(eventRow!.payload_json).agentRunId).toBe(runId);

      const incident = db.prepare(
        "SELECT category, severity, context_json FROM error_incidents WHERE context_json LIKE ? ORDER BY created_at DESC LIMIT 1",
      ).get(`%${runId}%`) as
        | { category: string; severity: string; context_json: string }
        | undefined;
      expect(incident).toBeDefined();
      expect(incident!.category).toBe("tool");
      expect(incident!.severity).toBe("medium");
      expect(JSON.parse(incident!.context_json).agentRunId).toBe(runId);
    } finally {
      db.close();
    }
  });

  it("backs runtime config APIs with persisted revisions and rollback", async () => {
    const hub = await createIsolatedHub();
    const routes = hub.apiRuntime.routes.getRoutes();
    const getConfig = routes.find((route) => route.operationId === "config.get")!;
    const updateConfig = routes.find((route) => route.operationId === "config.update")!;
    const listRevisions = routes.find((route) => route.operationId === "config.revisions.list")!;
    const revertConfig = routes.find((route) => route.operationId === "config.revisions.revert")!;

    const baseCtx = {
      requestId: "req-config-1",
      receivedAt: new Date().toISOString(),
      params: {},
      query: {},
      body: null,
      headers: {},
      principal: null,
    };
    const configAdminPrincipal = {
      principalType: "user",
      principalId: "config-admin-1",
      userId: "config-admin-1",
      role: "admin",
      scopes: ["hub.admin"],
      tokenId: "config-token-1",
      tokenKind: "access",
      issuedAt: "2026-03-08T00:00:00.000Z",
    };

    const initial = await getConfig.handler({
      ...baseCtx,
      principal: configAdminPrincipal,
      query: { keys: "database.busyTimeoutMs" },
    } as never) as { revision: number; settings: Record<string, unknown> };

    expect(initial.revision).toBe(1);
    expect(initial.settings["database.busyTimeoutMs"]).toBe(5000);

    const updated = await updateConfig.handler({
      ...baseCtx,
      principal: configAdminPrincipal,
      body: {
        expectedRevision: initial.revision,
        patch: { database: { busyTimeoutMs: 6000 } },
        reason: "integration config update",
      },
    } as never) as { revision: number; changedKeys: string[] };

    expect(updated.revision).toBe(2);
    expect(updated.changedKeys).toContain("database.busyTimeoutMs");

    const afterUpdate = await getConfig.handler({
      ...baseCtx,
      principal: configAdminPrincipal,
      query: { keys: "database.busyTimeoutMs" },
    } as never) as { revision: number; settings: Record<string, unknown> };
    expect(afterUpdate.revision).toBe(2);
    expect(afterUpdate.settings["database.busyTimeoutMs"]).toBe(6000);

    const revisions = await listRevisions.handler({
      ...baseCtx,
      principal: configAdminPrincipal,
    } as never) as {
      items: Array<{ revision: number; changedKeys: string[] }>;
    };
    expect(revisions.items.map((revision) => revision.revision)).toEqual([2, 1]);

    const reverted = await revertConfig.handler({
      ...baseCtx,
      principal: configAdminPrincipal,
      body: { toRevision: 1 },
    } as never) as { revision: number; revertedFrom: number; changedKeys: string[] };
    expect(reverted).toMatchObject({ revision: 3, revertedFrom: 2 });
    expect(reverted.changedKeys).toContain("database.busyTimeoutMs");

    const afterRevert = await getConfig.handler({
      ...baseCtx,
      principal: configAdminPrincipal,
      query: { keys: "database.busyTimeoutMs" },
    } as never) as { revision: number; settings: Record<string, unknown> };
    expect(afterRevert.revision).toBe(3);
    expect(afterRevert.settings["database.busyTimeoutMs"]).toBe(5000);

    expect(fs.existsSync(path.join(lastStateDir ?? "", "friday.config.json5"))).toBe(true);
  });

  it("registers autofix-dispatch scheduler job on startup", async () => {
    await withAutoFixDispatcherEnabled(async () => {
      const hub = await createIsolatedHub();
      await hub.start();

      const dbPath = path.join(lastStateDir ?? "", "friday.db");
      const db = new Database(dbPath);
      try {
        const row = db
          .prepare("SELECT id, interval_ms, enabled FROM friday_scheduler_jobs WHERE id = 'autofix-dispatch'")
          .get() as { id: string; interval_ms: number; enabled: number } | undefined;
        expect(row).toBeDefined();
        expect(row!.id).toBe("autofix-dispatch");
        expect(row!.interval_ms).toBe(60_000);
        expect(row!.enabled).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  it("does NOT register the retired agent-loop cooldown sweep job on startup (SEV-1 stop-the-fail-loop)", async () => {
    // The `agent-loop-cooldown-sweep` job's terminal action (executionService.execute)
    // is fail-closed (TS_RUNTIME_AUTOFIX_EXECUTION_RETIRED). It is no longer registered,
    // and bootstrap calls schedulerRepoRef.disableJob("agent-loop-cooldown-sweep") so any
    // persisted row is excluded from due-selection and min-wake. On a fresh DB the
    // disableJob is a no-op UPDATE, so the row never exists; if a legacy row were present
    // it would be enabled=0 with next_run_at=NULL. Either way it must not be enabled.
    const hub = await createIsolatedHub();
    await hub.start();

    const dbPath = path.join(lastStateDir ?? "", "friday.db");
    const db = new Database(dbPath);
    try {
      const row = db
        .prepare("SELECT id, interval_ms, enabled, next_run_at FROM friday_scheduler_jobs WHERE id = 'agent-loop-cooldown-sweep'")
        .get() as { id: string; interval_ms: number; enabled: number; next_run_at: string | null } | undefined;
      // Fresh DB: the retired job is never seeded, so no row exists.
      if (row !== undefined) {
        // Legacy/pre-existing row: bootstrap's disableJob must have disabled it.
        expect(row.enabled).toBe(0);
        expect(row.next_run_at).toBeNull();
      }
    } finally {
      db.close();
    }
  });

  it("exposes hub-registered scheduler jobs through /v1/jobs", async () => {
    await withAutoFixDispatcherEnabled(async () => {
      const hub = await createIsolatedHub();
      await hub.start();

      const route = hub.apiRuntime.routes.getRoutes().find((entry) => entry.operationId === "tui.jobs.list");
      expect(route).toBeDefined();

      const jobs = await route!.handler({
        params: {},
        query: {},
        body: null,
        headers: {},
        principal: {
          principalType: "user",
          principalId: "scheduler-admin",
          role: "admin",
          scopes: ["hub.admin"],
          tokenId: "token-scheduler-admin",
          tokenKind: "access",
          issuedAt: "2026-04-23T00:00:00.000Z",
        },
        requestId: "req-scheduler-jobs",
        receivedAt: "2026-04-23T00:00:00.000Z",
      } as never) as Array<{
        jobId: string;
        status: string;
        nextRunAt: string | null;
      }>;

      const jobById = new Map(jobs.map((job) => [job.jobId, job]));
      expect(jobById.get("workflow-timeout-sweep")).toMatchObject({
        jobId: "workflow-timeout-sweep",
        status: expect.stringMatching(/^(scheduled|pending|idle)$/),
      });
      expect(jobById.get("autofix-dispatch")).toMatchObject({
        jobId: "autofix-dispatch",
        status: expect.stringMatching(/^(scheduled|pending|idle)$/),
      });
      // SEV-1 stop-the-fail-loop: the retired `agent-loop-cooldown-sweep` job is no
      // longer registered (its terminal action is fail-closed), so it does not appear
      // in the /v1/jobs listing on a fresh hub.
      expect(jobById.get("agent-loop-cooldown-sweep")).toBeUndefined();
    });
  });

  it("replays persisted scheduled automations onto the scheduler after restart", async () => {
    const stateDir = makeTmpDir();
    lastStateDir = stateDir;
    const bundledSkillsDir = makeTmpDir();
    const managedSkillsDir = makeTmpDir();
    const dbPath = path.join(stateDir, "friday.db");

    const firstHub = await createHubForDirs(stateDir, bundledSkillsDir, managedSkillsDir);
    await firstHub.start();

    const automation = firstHub.apiRuntime.agentAutomationService!.save({
      name: "Restarted automation",
      taskTemplate: "Summarize the latest workspace state",
      schedule: {
        type: "cron",
        cron: "* * * * *",
        timezone: "UTC",
      },
    });
    const jobId = `agent-automation:${automation.id}`;

    let db = new Database(dbPath);
    try {
      db.prepare("DELETE FROM friday_scheduler_jobs WHERE id = ?").run(jobId);
    } finally {
      db.close();
    }

    await firstHub.stop();

    const secondHub = await createHubForDirs(stateDir, bundledSkillsDir, managedSkillsDir);
    await secondHub.start();

    db = new Database(dbPath);
    try {
      const row = db
        .prepare(
          `SELECT id, enabled, schedule_kind, schedule_cron_expr, schedule_tz, next_run_at
           FROM friday_scheduler_jobs
           WHERE id = ?`,
        )
        .get(jobId) as
          | {
              id: string;
              enabled: number;
              schedule_kind: string;
              schedule_cron_expr: string | null;
              schedule_tz: string | null;
              next_run_at: string | null;
            }
          | undefined;
      expect(row).toBeDefined();
      expect(row!.id).toBe(jobId);
      expect(row!.enabled).toBe(1);
      expect(row!.schedule_kind).toBe("cron");
      expect(row!.schedule_cron_expr).toBe("* * * * *");
      expect(row!.schedule_tz).toBe("UTC");
      expect(row!.next_run_at).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it("preserves pending workflow approvals across restart and resumes on approval", async () => {
    const stateDir = makeTmpDir();
    lastStateDir = stateDir;
    const bundledSkillsDir = makeTmpDir();
    const managedSkillsDir = makeTmpDir();

    const firstHub = await createHubForDirs(stateDir, bundledSkillsDir, managedSkillsDir);
    await firstHub.start();

    const workflow = firstHub.workflowRuntime.crud.createWorkflow({
      slug: "restart-approval-proof",
      name: "Restart Approval Proof",
    });
    const version = firstHub.workflowRuntime.crud.createVersion(
      workflow.id,
      makeApprovalOnlyGraph(workflow.id, "placeholder"),
    );
    firstHub.workflowRuntime.crud.publishVersion(workflow.id, version.versionNumber);

    const run = await firstHub.workflowRuntime.execution.startRun({
      workflowId: workflow.id,
      workflowVersionId: version.id,
      triggerType: "manual",
    });

    const firstStatus = await waitForWorkflowRunStable(firstHub, run.id);
    expect(["waiting_for_approval", "paused", "blocked", "pause_for_approval"]).toContain(firstStatus);

    const firstPending = firstHub.workflowRuntime.approval.listPending({});
    const approval = firstPending.find((item) => item.runId === run.id);
    expect(approval).toBeDefined();
    expect(approval!.status).toBe("pending");

    await firstHub.stop();

    const secondHub = await createHubForDirs(stateDir, bundledSkillsDir, managedSkillsDir);
    await secondHub.start();

    const restartedPending = secondHub.workflowRuntime.approval.listPending({});
    const restartedApproval = restartedPending.find((item) => item.id === approval!.id);
    expect(restartedApproval).toBeDefined();
    expect(restartedApproval!.status).toBe("pending");
    expect(restartedApproval!.runId).toBe(run.id);

    const approvalResult = await secondHub.workflowRuntime.approval.approve({
      approvalId: restartedApproval!.id,
      decidedByUserId: "admin-001",
      comment: "Resume after restart",
    });
    expect(approvalResult.approval.status).toBe("approved");
    expect(approvalResult.resumed).toBe(true);

    const finalStatus = await waitForWorkflowRunStable(secondHub, run.id);
    expect(finalStatus).toBe("completed");
  });

  it("marks persisted stale agent and subagent runs as failed on startup", async () => {
    const stateDir = makeTmpDir();
    lastStateDir = stateDir;
    const bundledSkillsDir = makeTmpDir();
    const managedSkillsDir = makeTmpDir();
    const dbPath = path.join(stateDir, "friday.db");
    const nowIso = new Date().toISOString();
    const agentRunRepo = createFridayAgentRunRepository();
    const subagentRunRepo = createFridaySubagentRunRepository();

    const seedHub = await createHubForDirs(stateDir, bundledSkillsDir, managedSkillsDir);

    let db = new Database(dbPath);
    try {
      agentRunRepo.create(db, {
        id: "stale-agent-run",
        task: "Resume me after reboot",
        sessionKey: "agent:run:stale-agent-run",
        maxAttempts: 3,
        nowIso,
      });
      agentRunRepo.update(db, {
        id: "stale-agent-run",
        status: "executing",
      });

      agentRunRepo.create(db, {
        id: "parent-run",
        task: "Parent completed run",
        sessionKey: "agent:run:parent-run",
        maxAttempts: 3,
        nowIso,
      });
      agentRunRepo.update(db, {
        id: "parent-run",
        status: "completed",
        completedAt: nowIso,
      });

      subagentRunRepo.create(db, {
        id: "stale-subagent-run",
        parentRunId: "parent-run",
        parentSessionKey: "agent:run:parent-run",
        childRunId: "child-run-stale",
        childSessionKey: buildFridaySubagentSessionKey("agent:run:parent-run", "child-run-stale"),
        task: "Child run left mid-flight",
        depth: 1,
        nowIso,
      });
      subagentRunRepo.update(db, {
        id: "stale-subagent-run",
        status: "running",
        startedAt: nowIso,
      });
    } finally {
      db.close();
    }

    await seedHub.stop();

    const restartedHub = await createHubForDirs(stateDir, bundledSkillsDir, managedSkillsDir);
    await restartedHub.start();

    db = new Database(dbPath);
    try {
      const staleAgent = agentRunRepo.getById(db, "stale-agent-run");
      const parentRun = agentRunRepo.getById(db, "parent-run");
      const staleSubagent = subagentRunRepo.getById(db, "stale-subagent-run");

      expect(staleAgent?.status).toBe("failed");
      expect(staleAgent?.errorCode).toBe("AGENT_RUN_INTERRUPTED");
      expect(staleAgent?.errorMessage).toContain("system restarted");

      expect(parentRun?.status).toBe("completed");

      expect(staleSubagent?.status).toBe("failed");
      expect(staleSubagent?.outcome?.status).toBe("failed");
      expect(staleSubagent?.outcome?.response).toContain("system restarted");
    } finally {
      db.close();
    }
  });

  it("turns satellite degradation into a self-healing incident and loop run", async () => {
    const hub = await createIsolatedHub();
    await hub.start();

    const registration = hub.satelliteRuntime.registration.register({
      type: "phone",
      displayName: "Field node",
      publicKey: "pk-sat-field",
      runtime: {
        platform: "darwin",
        arch: "arm64",
        appVersion: "1.0.0",
        nodeVersion: "22.0.0",
      },
      transport: "ws",
    });

    hub.satelliteRuntime.heartbeat.recordHeartbeat({
      satelliteId: registration.satelliteId,
      ts: new Date().toISOString(),
      failureRate1m: 0.9,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const dbPath = path.join(lastStateDir ?? "", "friday.db");
    const db = new Database(dbPath);
    try {
      const incident = db.prepare(
        "SELECT category, severity, context_json FROM error_incidents ORDER BY created_at DESC LIMIT 1",
      ).get() as
        | { category: string; severity: string; context_json: string }
        | undefined;
      expect(incident).toBeDefined();
      expect(incident!.category).toBe("config");
      expect(incident!.severity).toBe("medium");
      let loopRun = db.prepare(
        "SELECT status, risk_tier, approval_required FROM friday_agent_loop_runs ORDER BY created_at DESC LIMIT 1",
      ).get() as { status: string; risk_tier: number; approval_required: number } | undefined;
      if (!loopRun) {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          loopRun = db.prepare(
            "SELECT status, risk_tier, approval_required FROM friday_agent_loop_runs ORDER BY created_at DESC LIMIT 1",
          ).get() as { status: string; risk_tier: number; approval_required: number } | undefined;
          if (loopRun) {
            break;
          }
        }
      }
      expect(loopRun).toBeDefined();
      expect(loopRun!.risk_tier).toBeGreaterThanOrEqual(0);
      expect(["verified", "awaiting_approval", "paused", "cooldown", "running", "failed", "halted"]).toContain(
        loopRun!.status,
      );
    } finally {
      db.close();
    }
  });

  it("turns naturally failed workflow runs into self-healing incidents and loop runs", async () => {
    const hub = await createIsolatedHub();
    await hub.start();

    const workflow = hub.workflowRuntime.crud.createWorkflow({
      slug: "workflow-self-healing-proof",
      name: "Workflow Self Healing Proof",
    });
    const version = hub.workflowRuntime.crud.createVersion(
      workflow.id,
      makeFailingActionGraph(workflow.id, "placeholder"),
    );
    hub.workflowRuntime.crud.publishVersion(workflow.id, version.versionNumber);

    const run = await hub.workflowRuntime.execution.startRun({
      workflowId: workflow.id,
      workflowVersionId: version.id,
      triggerType: "manual",
      startedByUserId: "admin-001",
    });

    const finalStatus = await waitForWorkflowRunStable(hub, run.id, 10_000);
    expect(finalStatus).toBe("failed");

    const dbPath = path.join(lastStateDir ?? "", "friday.db");
    const db = new Database(dbPath);
    try {
      let incident:
        | {
            category: string;
            severity: string;
            node_id: string | null;
            context_json: string;
          }
        | undefined;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        incident = db.prepare(
          `SELECT category, severity, node_id, context_json
           FROM error_incidents
           WHERE run_id = ?
           ORDER BY created_at DESC
           LIMIT 1`,
        ).get(run.id) as
          | {
              category: string;
              severity: string;
              node_id: string | null;
              context_json: string;
            }
          | undefined;
        if (incident) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(incident).toBeDefined();
      expect(incident!.category).toBe("workflow");
      expect(incident!.severity).toBe("medium");
      expect(incident!.node_id).toBe("action1");

      const incidentCount = db.prepare(
        "SELECT COUNT(*) AS count FROM error_incidents WHERE run_id = ?",
      ).get(run.id) as { count: number };
      expect(incidentCount.count).toBe(1);

      const context = JSON.parse(incident!.context_json) as Record<string, unknown>;
      expect(context["source"]).toBe("workflow_runtime");
      expect(context["workflowId"]).toBe(workflow.id);
      expect(context["failedNodeId"]).toBe("action1");

      let loopRun = db.prepare(
        "SELECT status, risk_tier, approval_required FROM friday_agent_loop_runs ORDER BY created_at DESC LIMIT 1",
      ).get() as { status: string; risk_tier: number; approval_required: number } | undefined;
      if (!loopRun) {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          loopRun = db.prepare(
            "SELECT status, risk_tier, approval_required FROM friday_agent_loop_runs ORDER BY created_at DESC LIMIT 1",
          ).get() as { status: string; risk_tier: number; approval_required: number } | undefined;
          if (loopRun) {
            break;
          }
        }
      }

      expect(loopRun).toBeDefined();
      expect(loopRun!.risk_tier).toBeGreaterThanOrEqual(0);
      expect(["verified", "awaiting_approval", "paused", "cooldown", "running", "failed", "halted"]).toContain(
        loopRun!.status,
      );
    } finally {
      db.close();
    }
  });

  // ─── DeepSeek auto-detect from env ───

  it("does not auto-register env providers when canonical gate is enabled", async () => {
    const previousCanonicalGate = process.env.FRIDAY_CANONICAL_GATE;
    process.env.FRIDAY_CANONICAL_GATE = "true";
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key-not-validated"; // pragma: allowlist secret
    try {
      const hub = await createIsolatedHub();
      await hub.start();

      const providers = await hub.providerService.listProviders();
      const routing = await hub.providerService.getRoutingConfig();

      expect(providers.find((p) => p.kind === "deepseek")).toBeUndefined();
      expect(routing.defaultProviderId).toBe("");
    } finally {
      if (previousCanonicalGate === undefined) {
        delete process.env.FRIDAY_CANONICAL_GATE;
      } else {
        process.env.FRIDAY_CANONICAL_GATE = previousCanonicalGate;
      }
    }
  });

  it("does not auto-configure provider fallbacks when canonical gate is enabled", async () => {
    const previousCanonicalGate = process.env.FRIDAY_CANONICAL_GATE;
    process.env.FRIDAY_CANONICAL_GATE = "true";
    try {
      const hub = await createIsolatedHub();
      const primary = await hub.providerService.createProvider({
        kind: "openai",
        name: "OpenAI Primary",
        baseUrl: "https://api.openai.com",
        authMode: "api-key",
        api: "openai-completions",
        apiKey: "$BOOT_PROVIDER_PRIMARY_KEY",
        supportedModels: ["gpt-4o-mini"],
        defaultModel: "gpt-4o-mini",
        validateOnSave: false,
      });
      const fallback = await hub.providerService.createProvider({
        kind: "deepseek",
        name: "DeepSeek Fallback",
        baseUrl: "https://api.deepseek.com",
        authMode: "api-key",
        api: "openai-completions",
        apiKey: "$BOOT_PROVIDER_FALLBACK_KEY",
        supportedModels: ["deepseek-v4-pro"],
        defaultModel: "deepseek-v4-pro",
        validateOnSave: false,
      });
      const dbPath = path.join(lastStateDir ?? "", "friday.db");
      const db = new Database(dbPath);
      try {
        for (const providerId of [primary.id, fallback.id]) {
          const row = db.prepare("SELECT config_json FROM provider_profiles WHERE id = ?")
            .get(providerId) as { config_json: string } | undefined;
          expect(row).toBeDefined();
          const config = JSON.parse(row!.config_json) as Record<string, unknown>;
          db.prepare("UPDATE provider_profiles SET config_json = ? WHERE id = ?")
            .run(JSON.stringify({
              ...config,
              validation: { status: "ok", checkedAt: "2026-05-08T00:00:00.000Z" },
            }), providerId);
        }
      } finally {
        db.close();
      }
      await hub.providerService.setRoutingConfig({
        defaultProviderId: primary.id,
        defaultModel: "gpt-4o-mini",
        fallbackProviderIds: [],
      });

      await hub.start();

      const routing = await hub.providerService.getRoutingConfig();
      expect(routing.defaultProviderId).toBe(primary.id);
      expect(routing.fallbackProviderIds).toEqual([]);
    } finally {
      if (previousCanonicalGate === undefined) {
        delete process.env.FRIDAY_CANONICAL_GATE;
      } else {
        process.env.FRIDAY_CANONICAL_GATE = previousCanonicalGate;
      }
    }
  });

  it("auto-registers DeepSeek provider with V4 defaults when DEEPSEEK_API_KEY is set", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key-not-validated"; // pragma: allowlist secret
    const hub = await createIsolatedHub();
    await hub.start();

    const providers = await hub.providerService.listProviders();
    const deepseek = providers.find((p) => p.kind === "deepseek");

    expect(deepseek).toBeDefined();
    expect(deepseek!.defaultModel).toBe("deepseek-v4-pro");
    expect(deepseek!.config.supportedModels).toEqual(
      expect.arrayContaining(["deepseek-v4-pro", "deepseek-v4-flash"]),
    );
    expect(deepseek!.baseUrl).toBe("https://api.deepseek.com");
    expect(deepseek!.config.api).toBe("openai-completions");
    expect(deepseek!.config.keySource).toMatchObject({
      kind: "env-ref",
      envVar: "DEEPSEEK_API_KEY",
    });

    const routing = await hub.providerService.getRoutingConfig();
    expect(routing.defaultProviderId).toBe(deepseek!.id);
    expect(routing.defaultModel).toBe("deepseek-v4-pro");
  });

  it("auto-registers DeepSeek provider when only FRIDAY_DEEPSEEK_API_KEY is set", async () => {
    process.env.FRIDAY_DEEPSEEK_API_KEY = "test-friday-deepseek-key"; // pragma: allowlist secret
    const hub = await createIsolatedHub();
    await hub.start();

    const providers = await hub.providerService.listProviders();
    const deepseek = providers.find((p) => p.kind === "deepseek");

    expect(deepseek).toBeDefined();
    expect(deepseek!.defaultModel).toBe("deepseek-v4-pro");
    expect(deepseek!.config.keySource).toMatchObject({
      kind: "env-ref",
      envVar: "FRIDAY_DEEPSEEK_API_KEY",
    });
  });

  it("does not register DeepSeek when no DeepSeek env var is present", async () => {
    const hub = await createIsolatedHub();
    await hub.start();

    const providers = await hub.providerService.listProviders();
    expect(providers.find((p) => p.kind === "deepseek")).toBeUndefined();
  });

  it("does not auto-select a provider when multiple kinds are detected and no routing is chosen", async () => {
    // Locked provider policy (gate OFF / dev boot): multiple LLM keys + no
    // explicit routing must require an explicit user choice — never a hidden
    // OpenAI / DeepSeek default and never an auto-added fallback.
    process.env.OPENAI_API_KEY = "test-openai-key-not-validated"; // pragma: allowlist secret
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key-not-validated"; // pragma: allowlist secret
    const hub = await createIsolatedHub();
    await hub.start();

    const providers = await hub.providerService.listProviders();
    // Both profiles are registered so the user can choose between them.
    expect(providers.find((p) => p.kind === "openai")).toBeDefined();
    expect(providers.find((p) => p.kind === "deepseek")).toBeDefined();

    // ...but no default route is auto-elected: this surfaces as action-required.
    const routing = await hub.providerService.getRoutingConfig();
    expect(routing.defaultProviderId).toBe("");
    expect(routing.fallbackProviderIds).toEqual([]);
  });

  it("does not auto-select a newly detected provider when an existing different kind is enabled", async () => {
    const hub = await createIsolatedHub();
    await hub.providerService.createProvider({
      kind: "openai",
      name: "Existing OpenAI",
      baseUrl: "https://api.openai.com/v1",
      authMode: "api-key",
      api: "openai-responses",
      apiKey: "$OPENAI_API_KEY",
      supportedModels: ["gpt-4o-mini"],
      defaultModel: "gpt-4o-mini",
      validateOnSave: false,
    });
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key-not-validated"; // pragma: allowlist secret

    await hub.start();

    const providers = await hub.providerService.listProviders();
    expect(providers.find((p) => p.kind === "openai")).toBeDefined();
    expect(providers.find((p) => p.kind === "deepseek")).toBeDefined();
    const routing = await hub.providerService.getRoutingConfig();
    expect(routing.defaultProviderId).toBe("");
    expect(routing.fallbackProviderIds).toEqual([]);
  });

  it("honors an explicit setup provider choice (FRIDAY_SETUP_DEFAULT_PROVIDER) even with multiple keys", async () => {
    // The CLI setup wizard records the user's explicit choice here; bootstrap
    // must route to it (a user choice, not a hidden auto-pick) even when other
    // provider keys are present.
    process.env.OPENAI_API_KEY = "test-openai-key-not-validated"; // pragma: allowlist secret
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key-not-validated"; // pragma: allowlist secret
    const previousIntent = process.env.FRIDAY_SETUP_DEFAULT_PROVIDER;
    process.env.FRIDAY_SETUP_DEFAULT_PROVIDER = "deepseek";
    try {
      const hub = await createIsolatedHub();
      await hub.start();

      const providers = await hub.providerService.listProviders();
      const deepseek = providers.find((p) => p.kind === "deepseek");
      expect(deepseek).toBeDefined();

      const routing = await hub.providerService.getRoutingConfig();
      expect(routing.defaultProviderId).toBe(deepseek!.id);
      expect(routing.fallbackProviderIds).toEqual([]);
    } finally {
      if (previousIntent === undefined) {
        delete process.env.FRIDAY_SETUP_DEFAULT_PROVIDER;
      } else {
        process.env.FRIDAY_SETUP_DEFAULT_PROVIDER = previousIntent;
      }
    }
  });

  it("preserves a saved default with empty fallbacks on multi-key boot (no auto-added fallback)", async () => {
    // Gate OFF (dev) path: a user who saved {default, fallbackProviderIds: []}
    // must not have a fallback silently added when a second key appears.
    const hub = await createIsolatedHub();
    const primary = await hub.providerService.createProvider({
      kind: "deepseek",
      name: "DeepSeek Primary",
      baseUrl: "https://api.deepseek.com",
      authMode: "api-key",
      api: "openai-completions",
      apiKey: "$DEEPSEEK_API_KEY",
      supportedModels: ["deepseek-v4-pro"],
      defaultModel: "deepseek-v4-pro",
      validateOnSave: false,
    });
    await hub.providerService.setRoutingConfig({
      defaultProviderId: primary.id,
      defaultModel: "deepseek-v4-pro",
      fallbackProviderIds: [],
    });
    // A second provider key appears in the environment.
    process.env.OPENAI_API_KEY = "test-openai-key-not-validated"; // pragma: allowlist secret

    await hub.start();

    const routing = await hub.providerService.getRoutingConfig();
    expect(routing.defaultProviderId).toBe(primary.id);
    expect(routing.fallbackProviderIds).toEqual([]);
  });
});
