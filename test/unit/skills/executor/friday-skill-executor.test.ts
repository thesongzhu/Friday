import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createFridayChannelRegistry } from "#channels";
import {
  createFridaySkillExecutor,
  createFridaySkillRunMutatingActionRequest,
  FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV,
  FRIDAY_SKILL_PYTHON_BIN_ENV,
} from "#skills";
import { createFridaySkillRunStore } from "#ledger";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { makeManifest } from "../_helpers/make-manifest.helper.js";
import type { FridaySqliteLayer } from "#state";
import type { FridaySkillRegistry } from "#skills";
import type { FridayRegisteredSkill } from "#skills";
import type { FridaySkillRunStore } from "#ledger";
import type { FridaySkillExecuteRequest } from "#skills";
import {
  createFridayMutatingActionDigest,
  createFridayMutatingActionGate,
  signFridayCanonicalApproval,
} from "../../../../src/security/friday-mutating-action-gate.js";
import {
  createFridaySkillLifecycleCanaryInputDigest,
  createFridaySkillLifecycleMutatingActionRequest,
} from "../../../../src/autonomy/services/friday-skill-upgrade-lifecycle-service.js";
import { createFridaySkillReadonlyRuntimeContext } from "../../../../src/skills/executor/friday-skill-runtime-bridge.js";

/** Minimal mock registry that returns skills from a pre-built map. */
function createMockRegistry(
  skills: Map<string, FridayRegisteredSkill>,
): FridaySkillRegistry {
  return {
    list: () => Array.from(skills.values()),
    get: (id: string) => skills.get(id) ?? null,
    resolveByIntent: () => null,
    validateAll: () => [],
    reload: async () => {},
    refresh: async () => {},
    isCompatible: () => ({ compatible: true, reasons: [] }),
    startWatching: async () => {},
    stopWatching: async () => {},
    close: async () => {},
  };
}

/** Creates a minimal FridayRegisteredSkill for testing. */
function makeRegisteredSkill(
  overrides: {
    id?: string;
    kind?: "conversation" | "workflow" | "system";
    runtimeKind?: "shell" | "node" | "builtin" | "python" | "remote-http";
    entrypoint?: string;
    skillDir?: string;
    inputs?: FridayRegisteredSkill["manifest"]["inputs"];
    timeoutMs?: number;
    source?: FridayRegisteredSkill["source"];
    origin?: FridayRegisteredSkill["origin"];
    trust?: FridayRegisteredSkill["trust"];
  } = {},
): FridayRegisteredSkill {
  const manifest = makeManifest({
    id: overrides.id ?? "test-skill",
    kind: overrides.kind ?? "conversation",
    runtime: {
      kind: overrides.runtimeKind ?? "shell",
      entrypoint: overrides.entrypoint ?? "run.sh",
      minHubVersion: "1.0.0",
      apiVersion: "1",
      timeoutMsDefault: overrides.timeoutMs ?? 30_000,
    },
    ...(overrides.inputs ? { inputs: overrides.inputs } : {}),
  });

  return {
    manifest,
    skillDir: overrides.skillDir ?? "/tmp/test-skill",
    source: overrides.source ?? "local",
    origin: overrides.origin ?? "workspace",
    status: "installed",
    loaded: {
      manifest,
      format: "skill-json",
      rawContent: "{}",
      declaredFiles: [],
    },
    validation: {
      ok: true,
      issues: [],
      skillId: manifest.id,
      timestamp: "2025-01-01T00:00:00.000Z",
    },
    trust: overrides.trust ?? {
      trustTier: "workspace",
      sandboxPolicy: {
        trustTier: "workspace",
        defaultExecutionMode: "trusted",
        allowedExecutionModes: ["trusted", "restricted", "isolated"],
      },
      executionMode: "trusted",
      requiredPermissionIds: [],
      optionalPermissionIds: [],
    },
  };
}

describe("FridaySkillExecutor", () => {
  let db: FridaySqliteLayer;
  let runStore: FridaySkillRunStore;

  beforeEach(() => {
    db = createTestDb();
    runStore = createFridaySkillRunStore({ db });
  });

  afterEach(() => {
    db.close();
  });

  const baseRequest: FridaySkillExecuteRequest = {
    skillId: "echo-skill",
    input: { message: "hello" },
    sessionId: "session-1",
    userId: "test-user",
    channel: "test",
  };

  function makeSkillRunApprovalRequest(input: Partial<FridaySkillExecuteRequest> = {}) {
    return createFridaySkillRunMutatingActionRequest({
      skillId: input.skillId ?? "external-skill",
      input: input.input ?? baseRequest.input,
      timeoutMs: input.timeoutMs,
      channel: input.channel ?? baseRequest.channel,
      sessionId: input.sessionId ?? baseRequest.sessionId,
      actor: { kind: "api", id: "test-user", principalId: "test-user" },
      surface: "test:skill-run",
    });
  }

  function makeSignedSkillRunApproval(request = makeSkillRunApprovalRequest()) {
    return signFridayCanonicalApproval({
      decision: "approved",
      approvalId: "approval-skill-run",
      decidedByPrincipalId: "test-user",
      actionDigest: createFridayMutatingActionDigest(request),
      expiresAt: "2999-01-15T10:59:00.000Z",
    }, "skill-run-test-secret");
  }

  function makeSkillRunGate() {
    return createFridayMutatingActionGate({
      nowIso: () => "2025-01-15T10:00:00.000Z",
      ticketIdGenerator: () => "ticket-skill-run",
      approvalSignatureSecret: "skill-run-test-secret", // pragma: allowlist secret
      requireApprovalSignature: true,
    });
  }

  it("routes shell skill to shell executor and returns result", async () => {
    const skill = makeRegisteredSkill({
      id: "echo-skill",
      runtimeKind: "shell",
      entrypoint: "/bin/echo",
      skillDir: "/tmp",
    });

    const skills = new Map<string, FridayRegisteredSkill>();
    skills.set("echo-skill", skill);

    const executor = createFridaySkillExecutor({
      db,
      registry: createMockRegistry(skills),
      runStore,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2025-01-15T10:00:00.000Z",
      canonicalMutationGate: makeSkillRunGate(),
    });

    const handle = executor.execute(baseRequest);
    expect(handle.runId).toBe("test-id-0001");

    const result = await handle.result;
    expect(result.status).toBe("completed");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const snapshot = runStore.getRun(handle.runId);
    expect(snapshot?.metadata?.sandbox).toMatchObject({
      os: {
        boundary: process.platform === "darwin"
          ? "darwin_sandbox_exec_write_network_guard"
          : "os_sandbox_unavailable_fail_closed",
        requested: process.platform === "darwin",
        required: process.platform === "darwin",
        denyNetwork: true,
        writableRootCount: 1,
      },
    });
  });

  it("runs shell skills that require the local shell capability", async () => {
    const skill = makeRegisteredSkill({
      id: "echo-skill",
      runtimeKind: "shell",
      entrypoint: "/bin/echo",
      skillDir: "/tmp",
    });
    skill.manifest.executionTargets.requiredCapabilities = ["shell"];

    const skills = new Map<string, FridayRegisteredSkill>();
    skills.set("echo-skill", skill);

    const executor = createFridaySkillExecutor({
      db,
      registry: createMockRegistry(skills),
      runStore,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2025-01-15T10:00:00.000Z",
    });

    const result = await executor.execute(baseRequest).result;

    expect(result.status).toBe("completed");
  });

  it("blocks managed external skill execution without a canonical run ticket, including workflow channel", async () => {
    const skill = makeRegisteredSkill({
      id: "external-skill",
      runtimeKind: "shell",
      entrypoint: "/bin/echo",
      skillDir: "/tmp",
      source: "local",
      origin: "managed",
    });

    const skills = new Map<string, FridayRegisteredSkill>();
    skills.set("external-skill", skill);

    const executor = createFridaySkillExecutor({
      db,
      registry: createMockRegistry(skills),
      runStore,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2025-01-15T10:00:00.000Z",
    });

    const result = await executor.execute({
      ...baseRequest,
      skillId: "external-skill",
      channel: "workflow",
    }).result;

    expect(result.status).toBe("failed");
    expect(result.output).toMatchObject({
      code: "SKILL_RUN_APPROVAL_REQUIRED",
      status: "installed",
    });
    expect(result.stderr).toContain("requires canonical approval");
  });

  it("rejects lifecycle canary markers on the public execute entrypoint", () => {
    const skill = makeRegisteredSkill({
      id: "echo-skill",
      runtimeKind: "shell",
      entrypoint: "/bin/echo",
      skillDir: "/tmp",
    });
    const skills = new Map<string, FridayRegisteredSkill>();
    skills.set("echo-skill", skill);
    const executor = createFridaySkillExecutor({
      db,
      registry: createMockRegistry(skills),
      runStore,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2025-01-15T10:00:00.000Z",
    });

    expect(() => executor.execute({
      ...baseRequest,
      lifecycleCanary: {
        skillDir: "/tmp",
        artifactDigest: "sha256:test",
        candidateId: "candidate-1",
        runtimeVersion: "runtime-v1",
        canaryInputDigest: "sha256:input",
      },
    } as never)).toThrow("Lifecycle canary execution must use the internal lifecycle executor entrypoint.");
  });

  it("rejects lifecycle canary approval when the input digest does not match", async () => {
    const skill = makeRegisteredSkill({
      id: "external-skill",
      runtimeKind: "shell",
      entrypoint: "/bin/echo",
      skillDir: "/tmp",
      source: "local",
      origin: "managed",
    });
    const skills = new Map<string, FridayRegisteredSkill>();
    skills.set("external-skill", skill);
    const executor = createFridaySkillExecutor({
      db,
      registry: createMockRegistry(skills),
      runStore,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2025-01-15T10:00:00.000Z",
      canonicalMutationGate: createFridayMutatingActionGate({
        nowIso: () => "2025-01-15T10:00:00.000Z",
        ticketIdGenerator: () => "ticket-lifecycle-canary",
      }),
    });
    const actor = { kind: "api", id: "test-user", principalId: "test-user" };
    const approvedDigest = createFridaySkillLifecycleCanaryInputDigest({ mode: "approved" });
    const actualDigest = createFridaySkillLifecycleCanaryInputDigest({ mode: "actual" });
    const approvalRequest = createFridaySkillLifecycleMutatingActionRequest({
      action: "canary",
      skillId: "external-skill",
      candidateId: "candidate-1",
      shadowVersionId: "candidate-1",
      runtimeVersion: "runtime-v1",
      actor,
      surface: "test:lifecycle-canary",
      planDigest: "phase32a-plan-digest",
      canaryInputDigest: approvedDigest,
    });

    const result = await executor.executeLifecycleCanary({
      ...baseRequest,
      skillId: "external-skill",
      input: { mode: "actual" },
      lifecycleCanary: {
        skillDir: "/tmp",
        artifactDigest: "sha256:test",
        candidateId: "candidate-1",
        runtimeVersion: "runtime-v1",
        canaryInputDigest: actualDigest,
      },
      canonicalApprovalRequest: approvalRequest,
      canonicalApproval: {
        decision: "approved",
        approvalId: "approval-lifecycle-canary",
        decidedByPrincipalId: "test-user",
        actionDigest: createFridayMutatingActionDigest(approvalRequest),
        expiresAt: "2999-01-15T10:59:00.000Z",
      },
    }).result;

    expect(result.status).toBe("failed");
    expect(result.output).toMatchObject({
      code: "SKILL_LIFECYCLE_CANARY_APPROVAL_DENIED",
    });
    expect(result.stderr).toContain("do not match");
  });

  it("allows managed external skill execution with a matching canonical approval", async () => {
    const skill = makeRegisteredSkill({
      id: "external-skill",
      runtimeKind: "shell",
      entrypoint: "/bin/echo",
      skillDir: "/tmp",
      source: "local",
      origin: "managed",
    });

    const skills = new Map<string, FridayRegisteredSkill>();
    skills.set("external-skill", skill);

    const executor = createFridaySkillExecutor({
      db,
      registry: createMockRegistry(skills),
      runStore,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2025-01-15T10:00:00.000Z",
      canonicalMutationGate: makeSkillRunGate(),
    });
    const approvalRequest = makeSkillRunApprovalRequest();

    const result = await executor.execute({
      ...baseRequest,
      skillId: "external-skill",
      canonicalApprovalRequest: approvalRequest,
      canonicalApproval: makeSignedSkillRunApproval(approvalRequest),
    }).result;

    expect(result.status).toBe("completed");
  });

  it("rejects managed external execution when approval digest does not match the actual input", async () => {
    const skill = makeRegisteredSkill({
      id: "external-skill",
      runtimeKind: "shell",
      entrypoint: "/bin/echo",
      skillDir: "/tmp",
      source: "local",
      origin: "managed",
    });

    const skills = new Map<string, FridayRegisteredSkill>();
    skills.set("external-skill", skill);

    const executor = createFridaySkillExecutor({
      db,
      registry: createMockRegistry(skills),
      runStore,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2025-01-15T10:00:00.000Z",
      canonicalMutationGate: makeSkillRunGate(),
    });
    const approvalRequest = makeSkillRunApprovalRequest({ input: { message: "approved" } });

    const result = await executor.execute({
      ...baseRequest,
      skillId: "external-skill",
      input: { message: "tampered" },
      canonicalApprovalRequest: approvalRequest,
      canonicalApproval: makeSignedSkillRunApproval(approvalRequest),
    }).result;

    expect(result.status).toBe("failed");
    expect(result.output).toMatchObject({
      code: "SKILL_RUN_APPROVAL_DENIED",
      status: "installed",
    });
    expect(result.stderr).toContain("does not match");
  });

  it("blocks restricted shell entrypoints that escape the skill directory sandbox", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const rootDir = await fs.mkdtemp("/tmp/friday-shell-sandbox-");
    const skillDir = path.join(rootDir, "skill");
    const outsideScript = path.join(rootDir, "outside.sh");
    await fs.mkdir(skillDir);
    await fs.writeFile(outsideScript, "#!/bin/sh\necho '{\"escaped\":true}'\n", { mode: 0o755 });
    try {
      const skill = makeRegisteredSkill({
        id: "sandboxed-shell-skill",
        runtimeKind: "shell",
        entrypoint: "../outside.sh",
        skillDir,
        trust: {
          trustTier: "workspace",
          sandboxPolicy: {
            trustTier: "workspace",
            defaultExecutionMode: "isolated",
            allowedExecutionModes: ["restricted", "isolated"],
          },
          executionMode: "isolated",
          requiredPermissionIds: [],
          optionalPermissionIds: [],
        },
      });
      const skills = new Map<string, FridayRegisteredSkill>();
      skills.set("sandboxed-shell-skill", skill);
      const executor = createFridaySkillExecutor({
        db,
        registry: createMockRegistry(skills),
        runStore,
        idGenerator: createTestIdGenerator(),
        nowIso: () => "2025-01-15T10:00:00.000Z",
      });

      const result = await executor.execute({
        ...baseRequest,
        skillId: "sandboxed-shell-skill",
      }).result;

      expect(result.status).toBe("failed");
      expect(result.stderr).toContain("escapes the skill directory sandbox");
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("returns failed when skill is not found", async () => {
    const executor = createFridaySkillExecutor({
      db,
      registry: createMockRegistry(new Map()),
      runStore,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2025-01-15T10:00:00.000Z",
    });

    const result = await executor.execute(baseRequest).result;

    expect(result.status).toBe("failed");
    expect(result.stderr).toContain("not found");
  });

  it("rejects unsafe manifest input regex patterns before execution", async () => {
    const skill = makeRegisteredSkill({
      id: "regex-skill",
      runtimeKind: "shell",
      entrypoint: "/bin/echo",
      inputs: [
        {
          key: "message",
          label: "Message",
          type: "string",
          required: true,
          validation: { regex: "^(a+)+$" },
        },
      ],
    });
    const skills = new Map<string, FridayRegisteredSkill>();
    skills.set("regex-skill", skill);
    const executor = createFridaySkillExecutor({
      db,
      registry: createMockRegistry(skills),
      runStore,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2025-01-15T10:00:00.000Z",
    });

    const result = await executor.execute({
      ...baseRequest,
      skillId: "regex-skill",
      input: { message: "aaaaaaaaaaaaaaaa!" },
    }).result;

    expect(result.status).toBe("failed");
    expect(result.output.code).toBe("SKILL_INPUT_INVALID");
    expect(result.stderr).toContain("invalid or unsafe regex pattern");
  });

  it("routes python skills through the configured interpreter", async () => {
    const fs = await import("node:fs/promises");
    const scriptDir = await fs.mkdtemp("/tmp/friday-python-");
    const previousPythonBin = process.env[FRIDAY_SKILL_PYTHON_BIN_ENV];

    try {
      await fs.writeFile(
        `${scriptDir}/python-shim`,
        "#!/bin/sh\nprintf '{\"result\":\"python-ok\",\"entrypoint\":\"%s\"}' \"$(basename \"$1\")\"\n",
        { mode: 0o755 },
      );
      await fs.writeFile(`${scriptDir}/index.py`, "print('ignored by shim')\n", "utf8");
      process.env[FRIDAY_SKILL_PYTHON_BIN_ENV] = `${scriptDir}/python-shim`;

      const skill = makeRegisteredSkill({
        id: "echo-skill",
        runtimeKind: "python",
        entrypoint: "index.py",
        skillDir: scriptDir,
      });

      const skills = new Map<string, FridayRegisteredSkill>();
      skills.set("echo-skill", skill);

      const executor = createFridaySkillExecutor({
        db,
        registry: createMockRegistry(skills),
        runStore,
        idGenerator: createTestIdGenerator(),
        nowIso: () => "2025-01-15T10:00:00.000Z",
      });

      const result = await executor.execute(baseRequest).result;

      expect(result.status).toBe("completed");
      expect(result.output).toMatchObject({
        result: "python-ok",
        entrypoint: "index.py",
      });
    } finally {
      if (previousPythonBin === undefined) {
        delete process.env[FRIDAY_SKILL_PYTHON_BIN_ENV];
      } else {
        process.env[FRIDAY_SKILL_PYTHON_BIN_ENV] = previousPythonBin;
      }
      await fs.rm(scriptDir, { recursive: true, force: true });
    }
  });

  it("fails when runtime readiness requirements are missing", async () => {
    const requiredEnvKey = "FRIDAY_TEST_REQUIRED_EXECUTOR_ENV";
    const previous = process.env[requiredEnvKey];
    delete process.env[requiredEnvKey];

    try {
      const skill = makeRegisteredSkill({
        id: "env-skill",
        runtimeKind: "shell",
        entrypoint: "/bin/echo",
        skillDir: "/tmp",
      });
      skill.manifest.requirements.env = [requiredEnvKey];

      const skills = new Map<string, FridayRegisteredSkill>();
      skills.set("env-skill", skill);

      const executor = createFridaySkillExecutor({
        db,
        registry: createMockRegistry(skills),
        runStore,
        idGenerator: createTestIdGenerator(),
        nowIso: () => "2025-01-15T10:00:00.000Z",
      });

      const result = await executor.execute({
        ...baseRequest,
        skillId: "env-skill",
      }).result;

      expect(result.status).toBe("failed");
      expect(result.output).toMatchObject({
        code: "SKILL_NOT_READY",
        runtimeKind: "shell",
      });
      expect((result.output.blockers as string[])).toContain(
        `Missing required environment variables: ${requiredEnvKey}`,
      );
    } finally {
      if (previous === undefined) {
        delete process.env[requiredEnvKey];
      } else {
        process.env[requiredEnvKey] = previous;
      }
    }
  });

  it("persists run state in the run store", async () => {
    const skill = makeRegisteredSkill({
      id: "echo-skill",
      runtimeKind: "shell",
      entrypoint: "/bin/echo",
      skillDir: "/tmp",
    });

    const skills = new Map<string, FridayRegisteredSkill>();
    skills.set("echo-skill", skill);

    const executor = createFridaySkillExecutor({
      db,
      registry: createMockRegistry(skills),
      runStore,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2025-01-15T10:00:00.000Z",
    });

    const handle = executor.execute(baseRequest);
    const result = await handle.result;

    const stored = runStore.getRun(result.runId);
    expect(stored).not.toBeNull();
    expect(stored!.skillId).toBe("echo-skill");
    expect(stored!.sessionId).toBe("session-1");
    expect(stored!.userId).toBe("test-user");
    // Terminal status
    expect(["completed", "failed", "cancelled"]).toContain(stored!.status);
  });

  it("applies manifest default values before execution", async () => {
    const fs = await import("node:fs/promises");
    const scriptDir = await fs.mkdtemp("/tmp/friday-defaults-");

    try {
      await fs.writeFile(
        `${scriptDir}/echo-input.sh`,
        "#!/bin/sh\ncat\n",
        { mode: 0o755 },
      );

      const skill = makeRegisteredSkill({
        id: "defaults-skill",
        runtimeKind: "shell",
        entrypoint: "echo-input.sh",
        skillDir: scriptDir,
      });
      skill.manifest.inputs = [{
        key: "topic",
        type: "string",
        required: true,
        label: "Topic",
        defaultValue: "fallback-topic",
      }];

      const skills = new Map<string, FridayRegisteredSkill>();
      skills.set("defaults-skill", skill);

      const executor = createFridaySkillExecutor({
        db,
        registry: createMockRegistry(skills),
        runStore,
        idGenerator: createTestIdGenerator(),
        nowIso: () => "2025-01-15T10:00:00.000Z",
      });

      const result = await executor.execute({
        ...baseRequest,
        skillId: "defaults-skill",
        input: {},
      }).result;

      expect(result.status).toBe("completed");
      expect(result.output).toMatchObject({
        topic: "fallback-topic",
      });
    } finally {
      await fs.rm(scriptDir, { recursive: true, force: true });
    }
  });

  it("fails when input schema validation rejects the prepared input", async () => {
    const fs = await import("node:fs/promises");
    const scriptDir = await fs.mkdtemp("/tmp/friday-input-schema-");

    try {
      await fs.writeFile(
        `${scriptDir}/echo-input.sh`,
        "#!/bin/sh\ncat\n",
        { mode: 0o755 },
      );
      await fs.writeFile(
        `${scriptDir}/input.schema.json`,
        JSON.stringify({
          type: "object",
          properties: {
            topic: { type: "string", minLength: 3 },
          },
          required: ["topic"],
          additionalProperties: false,
        }),
        "utf8",
      );

      const skill = makeRegisteredSkill({
        id: "schema-input-skill",
        runtimeKind: "shell",
        entrypoint: "echo-input.sh",
        skillDir: scriptDir,
      });
      skill.manifest.schemas = {
        input: "input.schema.json",
        state: null,
        output: null,
      };

      const skills = new Map<string, FridayRegisteredSkill>();
      skills.set("schema-input-skill", skill);

      const executor = createFridaySkillExecutor({
        db,
        registry: createMockRegistry(skills),
        runStore,
        idGenerator: createTestIdGenerator(),
        nowIso: () => "2025-01-15T10:00:00.000Z",
      });

      const result = await executor.execute({
        ...baseRequest,
        skillId: "schema-input-skill",
        input: { topic: "x" },
      }).result;

      expect(result.status).toBe("failed");
      expect(result.output).toMatchObject({
        code: "SKILL_INPUT_SCHEMA_INVALID",
      });
    } finally {
      await fs.rm(scriptDir, { recursive: true, force: true });
    }
  });

  it("fails when output schema validation rejects runtime output", async () => {
    const fs = await import("node:fs/promises");
    const scriptDir = await fs.mkdtemp("/tmp/friday-output-schema-");

    try {
      await fs.writeFile(
        `${scriptDir}/bad-output.sh`,
        "#!/bin/sh\nprintf '{\"count\":\"oops\"}'\n",
        { mode: 0o755 },
      );
      await fs.writeFile(
        `${scriptDir}/output.schema.json`,
        JSON.stringify({
          type: "object",
          properties: {
            count: { type: "number" },
          },
          required: ["count"],
          additionalProperties: false,
        }),
        "utf8",
      );

      const skill = makeRegisteredSkill({
        id: "schema-output-skill",
        runtimeKind: "shell",
        entrypoint: "bad-output.sh",
        skillDir: scriptDir,
      });
      skill.manifest.schemas = {
        input: null,
        state: null,
        output: "output.schema.json",
      };

      const skills = new Map<string, FridayRegisteredSkill>();
      skills.set("schema-output-skill", skill);

      const executor = createFridaySkillExecutor({
        db,
        registry: createMockRegistry(skills),
        runStore,
        idGenerator: createTestIdGenerator(),
        nowIso: () => "2025-01-15T10:00:00.000Z",
      });

      const result = await executor.execute({
        ...baseRequest,
        skillId: "schema-output-skill",
      }).result;

      expect(result.status).toBe("failed");
      expect(result.output).toMatchObject({
        code: "SKILL_OUTPUT_SCHEMA_INVALID",
      });
    } finally {
      await fs.rm(scriptDir, { recursive: true, force: true });
    }
  });

  it("handles shell execution with timeout", { timeout: 30_000 }, async () => {
    // Use a script that ignores stdin and sleeps forever
    const scriptDir = await import("node:fs/promises").then(async (fs) => {
      const dir = await fs.mkdtemp("/tmp/friday-test-");
      await fs.writeFile(`${dir}/slow.sh`, "#!/bin/sh\nsleep 60\n", { mode: 0o755 });
      return dir;
    });

    const skill = makeRegisteredSkill({
      id: "echo-skill",
      runtimeKind: "shell",
      entrypoint: "slow.sh",
      skillDir: scriptDir,
      timeoutMs: 30_000,
    });

    const skills = new Map<string, FridayRegisteredSkill>();
    skills.set("echo-skill", skill);

    const executor = createFridaySkillExecutor({
      db,
      registry: createMockRegistry(skills),
      runStore,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2025-01-15T10:00:00.000Z",
    });

    const result = await executor.execute({
      ...baseRequest,
      timeoutMs: 200,
    }).result;

    expect(result.status).toBe("timeout");
    expect(result.durationMs).toBeLessThan(5_000);

    // Cleanup
    const fs = await import("node:fs/promises");
    await fs.rm(scriptDir, { recursive: true });
  });

  it("cancel kills a running shell process", { timeout: 30_000 }, async () => {
    // Create a script that sleeps for 60s
    const scriptDir = await import("node:fs/promises").then(async (fs) => {
      const dir = await fs.mkdtemp("/tmp/friday-cancel-");
      await fs.writeFile(`${dir}/slow.sh`, "#!/bin/sh\nsleep 60\n", { mode: 0o755 });
      return dir;
    });

    const skill = makeRegisteredSkill({
      id: "echo-skill",
      runtimeKind: "shell",
      entrypoint: "slow.sh",
      skillDir: scriptDir,
      timeoutMs: 60_000,
    });

    const skills = new Map<string, FridayRegisteredSkill>();
    skills.set("echo-skill", skill);

    const executor = createFridaySkillExecutor({
      db,
      registry: createMockRegistry(skills),
      runStore,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2025-01-15T10:00:00.000Z",
    });

    // execute() now returns { runId, result } synchronously
    const handle = executor.execute(baseRequest);

    // Cancel after a short delay to let the process start
    await new Promise((r) => setTimeout(r, 100));
    executor.cancel(handle.runId);

    const result = await handle.result;
    expect(result.status).toBe("cancelled");
    expect(result.durationMs).toBeLessThan(5_000);

    // Cleanup
    const fs = await import("node:fs/promises");
    await fs.rm(scriptDir, { recursive: true });
  });

  it("cancel on non-existent run does not throw", () => {
    const executor = createFridaySkillExecutor({
      db,
      registry: createMockRegistry(new Map()),
      runStore,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2025-01-15T10:00:00.000Z",
    });

    // Should not throw
    executor.cancel("nonexistent-run");
  });

  it("generates unique run IDs for each execution", async () => {
    const skill = makeRegisteredSkill({
      id: "echo-skill",
      runtimeKind: "shell",
      entrypoint: "/bin/echo",
      skillDir: "/tmp",
    });

    const skills = new Map<string, FridayRegisteredSkill>();
    skills.set("echo-skill", skill);

    const executor = createFridaySkillExecutor({
      db,
      registry: createMockRegistry(skills),
      runStore,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2025-01-15T10:00:00.000Z",
    });

    const result1 = await executor.execute(baseRequest).result;
    const result2 = await executor.execute(baseRequest).result;

    expect(result1.runId).not.toBe(result2.runId);
  });

  it("does not warn when a shell skill returns plain-text stdout", async () => {
    const fs = await import("node:fs/promises");
    const scriptDir = await fs.mkdtemp("/tmp/friday-skill-plain-");
    await fs.writeFile(
      `${scriptDir}/plain.sh`,
      "#!/bin/sh\nprintf 'hello from shell\\n'\n",
      { mode: 0o755 },
    );

    const skill = makeRegisteredSkill({
      id: "echo-skill",
      runtimeKind: "shell",
      entrypoint: "plain.sh",
      skillDir: scriptDir,
    });

    const skills = new Map<string, FridayRegisteredSkill>();
    skills.set("echo-skill", skill);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const executor = createFridaySkillExecutor({
      db,
      registry: createMockRegistry(skills),
      runStore,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2025-01-15T10:00:00.000Z",
    });

    const result = await executor.execute(baseRequest).result;

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ raw: "hello from shell\n" });
    expect(warnSpy).not.toHaveBeenCalledWith(
      "[friday][skill-executor] operation failed:",
      expect.any(String),
    );

    await fs.rm(scriptDir, { recursive: true, force: true });
  });

  it("warns when a shell skill returns malformed JSON-looking stdout and preserves raw output", async () => {
    const fs = await import("node:fs/promises");
    const scriptDir = await fs.mkdtemp("/tmp/friday-skill-badjson-");
    await fs.writeFile(
      `${scriptDir}/badjson.sh`,
      "#!/bin/sh\nprintf '{\"broken\":'\n",
      { mode: 0o755 },
    );

    const skill = makeRegisteredSkill({
      id: "echo-skill",
      runtimeKind: "shell",
      entrypoint: "badjson.sh",
      skillDir: scriptDir,
    });

    const skills = new Map<string, FridayRegisteredSkill>();
    skills.set("echo-skill", skill);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const executor = createFridaySkillExecutor({
      db,
      registry: createMockRegistry(skills),
      runStore,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2025-01-15T10:00:00.000Z",
    });

    const result = await executor.execute(baseRequest).result;

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ raw: "{\"broken\":" });
    expect(warnSpy).toHaveBeenCalledWith(
      "[friday][skill-executor] operation failed:",
      expect.any(String),
    );

    await fs.rm(scriptDir, { recursive: true, force: true });
  });

  it("injects readonly Friday runtime helpers into node skills without write interfaces", async () => {
    const previousGate = process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV];
    process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV] = "true";
    const fs = await import("node:fs/promises");
    const scriptDir = await fs.mkdtemp("/tmp/friday-node-runtime-");
    try {
      await fs.writeFile(
        `${scriptDir}/index.mjs`,
        `
export async function execute(_input, ctx) {
  const snapshot = await ctx.system.getSnapshot();
  const issues = await ctx.diagnosis.listIssueCards(5);
  const incidents = await ctx.diagnosis.listIncidents(5);
  const incident = await ctx.diagnosis.getIncident("incident-1");
  const actions = await ctx.autofix.listActions(5, "planned");
  const action = await ctx.autofix.getAction("action-1");
  return {
    hasSystem: typeof ctx?.system?.getSnapshot === "function",
    hasDiagnosis: typeof ctx?.diagnosis?.listIssueCards === "function",
    hasAutofix: typeof ctx?.autofix?.listActions === "function",
    hasWriteInterface: Boolean(ctx?.autofix?.execute || ctx?.autofix?.rollback || ctx?.diagnosis?.approve),
    workspaceRoot: snapshot.workspaceRoot,
    issueCount: issues.length,
    incidentCount: incidents.length,
    incidentId: incident?.incident?.incidentId,
    actionCount: actions.length,
    actionId: action?.action?.actionId,
  };
}
`,
        "utf8",
      );

      const skill = makeRegisteredSkill({
        id: "node-runtime-skill",
        runtimeKind: "node",
        entrypoint: "index.mjs",
        skillDir: scriptDir,
      });

      const skills = new Map<string, FridayRegisteredSkill>();
      skills.set("node-runtime-skill", skill);

      const executor = createFridaySkillExecutor({
        db,
        registry: createMockRegistry(skills),
        runStore,
        idGenerator: createTestIdGenerator(),
        nowIso: () => "2025-01-15T10:00:00.000Z",
        getSystemService: () => ({
          getState: async () => ({
            workspaceRoot: "/tmp/friday-workspace",
            health: { status: "healthy" },
          }),
        }),
        getSelfHealingService: () => ({
          listIssueCards: () => [{ id: "issue-1", kind: "incident", incidentId: "incident-1" }],
          listIncidents: () => [{ incident: { incidentId: "incident-1", category: "workflow" } }],
          getIncident: () => ({ incident: { incidentId: "incident-1", category: "workflow" } }),
          listActions: () => [{ action: { actionId: "action-1", incidentId: "incident-1" } }],
          getAction: () => ({ action: { actionId: "action-1", incidentId: "incident-1" } }),
        }),
      });

      const result = await executor.execute({
        ...baseRequest,
        skillId: "node-runtime-skill",
      }).result;

      expect(result.status).toBe("completed");
      expect(result.output).toMatchObject({
        hasSystem: true,
        hasDiagnosis: true,
        hasAutofix: true,
        hasWriteInterface: false,
        workspaceRoot: "/tmp/friday-workspace",
        issueCount: 1,
        incidentCount: 1,
        incidentId: "incident-1",
        actionCount: 1,
        actionId: "action-1",
      });
    } finally {
      if (previousGate === undefined) {
        delete process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV];
      } else {
        process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV] = previousGate;
      }
      await fs.rm(scriptDir, { recursive: true, force: true });
    }
  });

  it("scopes readonly self-healing runtime get helpers to the executing user", async () => {
    const getIncident = vi.fn((input: { incidentId: string; userId?: string }) =>
      input.userId === "owner-user"
        ? { incident: { incidentId: input.incidentId, userId: input.userId } }
        : null,
    );
    const getAction = vi.fn((input: { actionId: string; userId?: string }) =>
      input.userId === "owner-user"
        ? { action: { actionId: input.actionId, userId: input.userId } }
        : null,
    );

    const ctx = createFridaySkillReadonlyRuntimeContext({
      getSelfHealingService: () => ({
        listIssueCards: () => [],
        listIncidents: () => [],
        getIncident,
        listActions: () => [],
        getAction,
      }),
    }, {
      skillId: "runtime-scope-proof",
      sessionId: "session-1",
      userId: "other-user",
    });

    await expect(ctx?.diagnosis?.getIncident("incident-owner")).resolves.toBeNull();
    await expect(ctx?.autofix?.getAction("action-owner")).resolves.toBeNull();
    expect(getIncident).toHaveBeenCalledWith({ incidentId: "incident-owner", userId: "other-user" });
    expect(getAction).toHaveBeenCalledWith({ actionId: "action-owner", userId: "other-user" });
  });

  it("injects readonly channel runtime helpers into node skills", async () => {
    const previousGate = process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV];
    process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV] = "true";
    const fs = await import("node:fs/promises");
    const scriptDir = await fs.mkdtemp("/tmp/friday-node-channels-");
    try {
      await fs.writeFile(
        `${scriptDir}/index.mjs`,
        `
export async function execute(_input, ctx) {
  const channels = await ctx.channels.listChannels();
  const discord = await ctx.channels.getChannel("discord");
  return {
    hasChannels: typeof ctx?.channels?.listChannels === "function",
    channelCount: channels.length,
    discordStatus: discord?.status,
    discordThreads: Boolean(discord?.contract?.supports?.threads),
  };
}
`,
        "utf8",
      );

      const channelRegistry = createFridayChannelRegistry();
      channelRegistry.register({
        kind: "discord",
        init: async () => {},
        start: async () => {},
        stop: async () => {},
        send: async () => ({ messageId: "sent-1" }),
        contract: {
          coreAuthority: {
            messageRouting: true,
            sessionMirroring: true,
            audit: true,
            evidence: true,
          },
          pluginResponsibilities: {
            config: true,
            auth: true,
            pairing: false,
            outboundDelivery: true,
            threadResolution: true,
            providerRetries: false,
          },
          supports: {
            directMessages: true,
            groupMessages: true,
            threads: true,
            typing: true,
          },
        },
        adapters: {
          status: {
            status: () => "connected",
          },
        },
      });

      const skill = makeRegisteredSkill({
        id: "node-channel-runtime-skill",
        runtimeKind: "node",
        entrypoint: "index.mjs",
        skillDir: scriptDir,
      });

      const skills = new Map<string, FridayRegisteredSkill>();
      skills.set("node-channel-runtime-skill", skill);

      const executor = createFridaySkillExecutor({
        db,
        registry: createMockRegistry(skills),
        runStore,
        idGenerator: createTestIdGenerator(),
        nowIso: () => "2025-01-15T10:00:00.000Z",
        getChannelRegistry: () => channelRegistry,
      });

      const result = await executor.execute({
        ...baseRequest,
        skillId: "node-channel-runtime-skill",
      }).result;

      expect(result.status).toBe("completed");
      expect(result.output).toMatchObject({
        hasChannels: true,
        channelCount: 1,
        discordStatus: "connected",
        discordThreads: true,
      });
    } finally {
      if (previousGate === undefined) {
        delete process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV];
      } else {
        process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV] = previousGate;
      }
      await fs.rm(scriptDir, { recursive: true, force: true });
    }
  });

  it("fails node skills with CAPABILITY_DISABLED metadata when the runtime gate is off", async () => {
    const fs = await import("node:fs/promises");
    const scriptDir = await fs.mkdtemp("/tmp/friday-node-disabled-");
    const previousGate = process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV];
    delete process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV];
    try {
      await fs.writeFile(
        `${scriptDir}/index.mjs`,
        `export async function execute() { return { ok: true }; }`,
        "utf8",
      );

      const skill = makeRegisteredSkill({
        id: "node-disabled-skill",
        runtimeKind: "node",
        entrypoint: "index.mjs",
        skillDir: scriptDir,
      });
      const skills = new Map<string, FridayRegisteredSkill>();
      skills.set("node-disabled-skill", skill);

      const executor = createFridaySkillExecutor({
        db,
        registry: createMockRegistry(skills),
        runStore,
        idGenerator: createTestIdGenerator(),
        nowIso: () => "2025-01-15T10:00:00.000Z",
      });

      const result = await executor.execute({
        ...baseRequest,
        skillId: "node-disabled-skill",
      }).result;

      expect(result.status).toBe("failed");
      expect(result.stderr).toContain("disabled");
      expect(result.output).toMatchObject({
        code: "CAPABILITY_DISABLED",
        capability: "skill_node_runtime",
        runtimeKind: "node",
      });
      const snapshot = runStore.getRun("test-id-0001");
      expect(snapshot?.metadata?.sandbox).toMatchObject({
        os: {
          boundary: "disabled_in_production_unisolated_test_harness_only",
          requested: false,
          required: false,
          denyNetwork: false,
          writableRootCount: 0,
        },
      });
    } finally {
      if (previousGate === undefined) {
        delete process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV];
      } else {
        process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV] = previousGate;
      }
      await fs.rm(scriptDir, { recursive: true, force: true });
    }
  });

  it("blocks bundled system node skills when the runtime gate is off", async () => {
    const fs = await import("node:fs/promises");
    const scriptDir = await fs.mkdtemp("/tmp/friday-node-bundled-system-");
    const previousGate = process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV];
    delete process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV];
    try {
      await fs.writeFile(
        `${scriptDir}/index.mjs`,
        `export async function execute() { return { summary: "starter-ok" }; }`,
        "utf8",
      );

      const skill = makeRegisteredSkill({
        id: "review-open-issues",
        kind: "system",
        runtimeKind: "node",
        entrypoint: "index.mjs",
        skillDir: scriptDir,
        source: "bundled",
        origin: "bundled",
      });
      const skills = new Map<string, FridayRegisteredSkill>();
      skills.set("review-open-issues", skill);

      const executor = createFridaySkillExecutor({
        db,
        registry: createMockRegistry(skills),
        runStore,
        idGenerator: createTestIdGenerator(),
        nowIso: () => "2025-01-15T10:00:00.000Z",
      });

      const result = await executor.execute({
        ...baseRequest,
        skillId: "review-open-issues",
      }).result;

      expect(result.status).toBe("failed");
      expect(result.stderr).toContain("disabled in production");
      expect(result.output).toMatchObject({
        code: "CAPABILITY_DISABLED",
        capability: "skill_node_runtime",
        runtimeKind: "node",
      });
    } finally {
      if (previousGate === undefined) {
        delete process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV];
      } else {
        process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV] = previousGate;
      }
      await fs.rm(scriptDir, { recursive: true, force: true });
    }
  });
});
