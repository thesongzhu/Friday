import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { FridaySqliteLayer } from "#state";
import type { FridaySkillExecuteResult, FridaySkillExecutor, SkillManifestV2 } from "#skills";
import { createFridaySkillRepository } from "#skills";
import {
  createFridaySkillLifecycleCanaryInputDigest,
  createFridaySkillLifecycleMutatingActionRequest,
  createFridaySkillUpgradeLifecycleService,
} from "../../../src/autonomy/services/friday-skill-upgrade-lifecycle-service.js";
import type { FridayExternalSkillCandidate } from "../../../src/skills/converter/services/friday-skill-candidate-store.js";
import {
  createFridayMutatingActionDigest,
  createFridayMutatingActionGate,
} from "../../../src/security/friday-mutating-action-gate.js";

import { createTestDb } from "../satellites/_helpers/create-test-db.helper.js";

const NOW = "2026-04-17T20:00:00.000Z";
const PLAN_DIGEST = "phase32a-plan-digest";

function makeManifest(overrides: Partial<SkillManifestV2> = {}): SkillManifestV2 {
  return {
    schemaVersion: "2.0",
    id: "skill-1",
    name: "Skill 1",
    description: "A skill lifecycle test fixture",
    version: "2.0.0",
    kind: "conversation",
    category: "utility",
    author: { name: "tester" },
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
    outputs: [{ key: "result", type: "string", description: "Result" }],
    permissions: { grants: [], promptOn: [] },
    schemas: { input: null, state: null, output: null },
    flow: null,
    executionTargets: {
      allowedSatelliteTypes: ["phone", "desktop", "rpi", "cloud-vm"],
      requiredCapabilities: [],
    },
    telemetry: { events: [] },
    ...overrides,
  };
}

function writeSkillFiles(dir: string, manifest = makeManifest()): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "skill.manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  writeFileSync(join(dir, "SKILL.md"), "# Skill 1\n", "utf8");
  writeFileSync(join(dir, "skill.ui.json"), JSON.stringify({
    schemaVersion: "1.0",
    title: manifest.name,
    sections: [],
    fields: [],
    outputs: [],
    actions: [],
  }, null, 2), "utf8");
  writeFileSync(join(dir, "run.sh"), "#!/usr/bin/env bash\necho '{\"result\":\"ok\"}'\n", { encoding: "utf8", mode: 0o755 });
}

function makeCandidate(filesDir: string, manifest = makeManifest()): FridayExternalSkillCandidate {
  return {
    candidateId: "skill-1-2-abcdef",
    shadowVersionId: "skill-1-2-abcdef",
    skillId: manifest.id,
    version: manifest.version,
    converterId: "native-friday-package",
    detectedFormat: "friday-package",
    sourceProvenance: {
      sourceKind: "uri",
      sourceDigest: "source-digest",
      redactedUri: "file-uri:redacted",
      formatHint: "friday-package",
    },
    canonicalApprovalProof: {
      gateId: "friday_canonical_mutating_action_gate",
      ticketId: "stage-ticket",
      actionDigest: "stage-digest",
      action: "skills.import.stage_candidate",
      surface: "test",
      resource: { type: "external_skill_candidate", id: "candidate" },
      risk: "high",
      approvalId: "stage-approval",
      approvedByPrincipalId: "tester",
      issuedAt: NOW,
      planDigest: PLAN_DIGEST,
    },
    candidateDir: join(filesDir, ".."),
    filesDir,
    stagedAt: NOW,
    validation: {
      ok: true,
      issues: [],
      verifiedAt: NOW,
    },
  };
}

function makeApprovalInput(input: {
  action: "shadow" | "canary" | "promote" | "rollback";
  candidateId: string;
  runtimeVersion?: string;
  approvalIdSuffix?: string;
  canaryInput?: Record<string, unknown>;
}) {
  const actor = { kind: "test", id: "tester", principalId: "tester" };
  const rollback = input.action === "rollback"
    ? { planned: true, planDigest: PLAN_DIGEST, actions: ["skills.lifecycle.promote"] }
    : undefined;
  const request = createFridaySkillLifecycleMutatingActionRequest({
    action: input.action,
    skillId: "skill-1",
    candidateId: input.candidateId,
    shadowVersionId: input.candidateId,
    runtimeVersion: input.runtimeVersion ?? "runtime-v1",
    actor,
    surface: `test:${input.action}`,
    planDigest: PLAN_DIGEST,
    rollback,
    canaryInputDigest: input.action === "canary"
      ? createFridaySkillLifecycleCanaryInputDigest(input.canaryInput)
      : undefined,
  });
  return {
    actor,
    surface: `test:${input.action}`,
    planDigest: PLAN_DIGEST,
    canonicalApproval: {
      decision: "approved",
      approvalId: `${input.action}-approval${input.approvalIdSuffix ?? ""}`,
      decidedByPrincipalId: "tester",
      actionDigest: createFridayMutatingActionDigest(request),
      expiresAt: "2026-04-17T21:10:00.000Z",
    },
  } as const;
}

function makeCanaryResultTicket(candidateId: string, canaryInput?: Record<string, unknown>) {
  return {
    gateId: "friday_canonical_mutating_action_gate",
    ticketId: "lifecycle-ticket",
    actionDigest: makeApprovalInput({ action: "canary", candidateId, canaryInput }).canonicalApproval.actionDigest,
    action: "skills.lifecycle.canary",
    surface: "test:canary",
    resource: { type: "external_skill_lifecycle", id: "skill-1" },
    risk: "high",
    approvalId: "canary-approval",
    approvedByPrincipalId: "tester",
    issuedAt: "2026-04-17T20:10:00.000Z",
    planDigest: PLAN_DIGEST,
  } as const;
}

describe("createFridaySkillUpgradeLifecycleService", () => {
  let db: FridaySqliteLayer;
  let rootDir: string;
  let managedSkillsDir: string;
  let candidateFilesDir: string;
  let candidate: FridayExternalSkillCandidate;
  let statusUpdates: Array<{ skillId: string; status: string }>;
  let refreshCount: number;

  beforeEach(() => {
    db = createTestDb();
    rootDir = join(tmpdir(), `friday-skill-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    managedSkillsDir = join(rootDir, "managed-skills");
    candidateFilesDir = join(rootDir, "skill-candidates", "skill-1-2-abcdef", "files");
    writeSkillFiles(candidateFilesDir);
    candidate = makeCandidate(candidateFilesDir);
    statusUpdates = [];
    refreshCount = 0;
    db.withWriteTransaction((conn) => {
      createFridaySkillRepository().upsertSkillFromCatalog(conn, {
        id: "skill-1",
        name: "Skill 1",
        source: "local",
        origin: "managed",
        latestVersion: "2.0.0",
        status: "not_installed",
        currentManifest: makeManifest(),
        nowIso: NOW,
      });
    });
  });

  afterEach(() => {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  });

  function createService(executor?: FridaySkillExecutor) {
    return createFridaySkillUpgradeLifecycleService({
      db,
      skillRepo: createFridaySkillRepository(),
      nowIso: () => "2026-04-17T20:30:00.000Z",
      managedSkillsDir,
      resolveCandidate: ({ skillId, candidateId }) =>
        skillId === candidate.skillId && candidateId === candidate.candidateId ? candidate : null,
      skillExecutor: executor,
      canonicalMutationGate: createFridayMutatingActionGate({
        nowIso: () => "2026-04-17T20:10:00.000Z",
        ticketIdGenerator: () => "lifecycle-ticket",
      }),
      updateSkillStatus: async (skillId, status) => {
        statusUpdates.push({ skillId, status });
      },
      refreshRegistry: async () => {
        refreshCount += 1;
      },
    });
  }

  it("shadows a staged candidate into managed lifecycle storage while keeping it unavailable", async () => {
    const service = createService();

    const shadowed = await service.registerShadowVersion({
      skillId: "skill-1",
      candidateId: candidate.candidateId,
      runtimeVersion: "runtime-v1",
      ...makeApprovalInput({ action: "shadow", candidateId: candidate.candidateId }),
    });

    expect(shadowed.promotionChannel).toBe("shadow");
    expect(shadowed.status).toBe("not_installed");
    expect(existsSync(join(managedSkillsDir, ".shadow", "skill-1", candidate.candidateId, "skill.manifest.json"))).toBe(true);
    expect(existsSync(join(managedSkillsDir, "skill-1", "skill.manifest.json"))).toBe(false);
    expect(statusUpdates).toEqual([{ skillId: "skill-1", status: "not_installed" }]);
    expect(refreshCount).toBe(1);
  });

  it("requires a real lifecycle canary before plan-authorized promote, then rollback restores real artifact state", async () => {
    const executor: FridaySkillExecutor = {
      execute: () => ({
        runId: "unexpected-public-run",
        result: Promise.resolve({
          runId: "unexpected-public-run",
          status: "failed",
          output: { ok: false },
          stdout: "",
          stderr: "public execute should not run lifecycle canary",
          durationMs: 0,
        }),
      }),
      executeLifecycleCanary: (request) => ({
        runId: "canary-run-1",
        result: Promise.resolve({
          runId: "canary-run-1",
          status: "completed",
          output: { ok: true },
          stdout: "ok",
          stderr: "",
          durationMs: 12,
          canonicalTicket: makeCanaryResultTicket(candidate.candidateId),
        }).then((result) => {
          expect(request.lifecycleCanary?.skillDir).toContain(join(".shadow", "skill-1", candidate.candidateId));
          expect(request.canonicalApproval.approvalId).toBe("canary-approval");
          return result;
        }),
      }),
      cancel: () => {},
    };
    const service = createService(executor);

    await service.registerShadowVersion({
      skillId: "skill-1",
      candidateId: candidate.candidateId,
      runtimeVersion: "runtime-v1",
      ...makeApprovalInput({ action: "shadow", candidateId: candidate.candidateId }),
    });
    await expect(service.promote({
      skillId: "skill-1",
      candidateId: candidate.candidateId,
      runtimeVersion: "runtime-v1",
      ...makeApprovalInput({ action: "promote", candidateId: candidate.candidateId, approvalIdSuffix: "-before-canary" }),
    })).rejects.toMatchObject({ code: "SKILL_LIFECYCLE_CANARY_NOT_GREEN" });

    const canary = await service.recordCanaryResult({
      skillId: "skill-1",
      candidateId: candidate.candidateId,
      runtimeVersion: "runtime-v1",
      ...makeApprovalInput({ action: "canary", candidateId: candidate.candidateId }),
    });
    expect(canary.promotionChannel).toBe("canary");
    expect(canary.canaryStats?.successCount).toBe(1);

    const promoted = await service.promote({
      skillId: "skill-1",
      candidateId: candidate.candidateId,
      runtimeVersion: "runtime-v1",
      ...makeApprovalInput({ action: "promote", candidateId: candidate.candidateId }),
    });
    expect(promoted.promotionChannel).toBe("active");
    expect(promoted.status).toBe("installed");
    expect(existsSync(join(managedSkillsDir, "skill-1", "skill.manifest.json"))).toBe(true);
    expect(statusUpdates.at(-1)).toEqual({ skillId: "skill-1", status: "installed" });

    const sensitiveValue = "alpha123";
    const sensitiveReason = [
      `tok${"en"}: ${sensitiveValue}`,
      `sec${"ret"}=${sensitiveValue}`,
      `cook${"ie"}: ${sensitiveValue}`,
      `api_${"key"}=${sensitiveValue}`,
      `Bearer ${sensitiveValue}`,
    ].join(" ");
    const rolledBack = await service.rollback({
      skillId: "skill-1",
      candidateId: candidate.candidateId,
      runtimeVersion: "runtime-v1",
      reason: sensitiveReason,
      ...makeApprovalInput({ action: "rollback", candidateId: candidate.candidateId }),
    });
    expect(rolledBack.promotionChannel).toBe("rolled_back");
    expect(rolledBack.status).toBe("not_installed");
    expect(existsSync(join(managedSkillsDir, "skill-1", "skill.manifest.json"))).toBe(false);
    expect(statusUpdates.at(-1)).toEqual({ skillId: "skill-1", status: "not_installed" });
    expect(refreshCount).toBe(3);
    const evidence = readFileSync(
      join(managedSkillsDir, ".lifecycle", "skill-1", `${candidate.candidateId}.json`),
      "utf8",
    );
    expect(evidence).not.toContain(sensitiveValue);
    expect(evidence).toContain("[redacted]");
  });

  it("refuses metadata-only rollback when previous install metadata has no active artifact", async () => {
    db.withWriteTransaction((conn) => {
      createFridaySkillRepository().setInstalledVersion(conn, "skill-1", "1.0.0", makeManifest({
        name: "Previous Skill",
        version: "1.0.0",
      }), NOW);
    });
    const service = createService();

    await service.registerShadowVersion({
      skillId: "skill-1",
      candidateId: candidate.candidateId,
      runtimeVersion: "runtime-v1",
      ...makeApprovalInput({ action: "shadow", candidateId: candidate.candidateId }),
    });

    await expect(service.rollback({
      skillId: "skill-1",
      candidateId: candidate.candidateId,
      runtimeVersion: "runtime-v1",
      reason: "metadata rollback",
      ...makeApprovalInput({ action: "rollback", candidateId: candidate.candidateId }),
    })).rejects.toMatchObject({
      code: "SKILL_LIFECYCLE_ROLLBACK_METADATA_ONLY_REFUSED",
      httpStatus: 409,
    });
  });

  it("refuses promote when previous install metadata has no real rollback artifact", async () => {
    db.withWriteTransaction((conn) => {
      createFridaySkillRepository().setInstalledVersion(conn, "skill-1", "1.0.0", makeManifest({
        name: "Previous Skill",
        version: "1.0.0",
      }), NOW);
    });
    const executor: FridaySkillExecutor = {
      execute: () => ({
        runId: "unexpected-public-run",
        result: Promise.resolve({
          runId: "unexpected-public-run",
          status: "failed",
          output: {},
          stdout: "",
          stderr: "public execute should not run lifecycle canary",
          durationMs: 0,
        }),
      }),
      executeLifecycleCanary: () => ({
        runId: "canary-run-1",
        result: Promise.resolve({
          runId: "canary-run-1",
          status: "completed",
          output: { ok: true },
          stdout: "ok",
          stderr: "",
          durationMs: 12,
          canonicalTicket: makeCanaryResultTicket(candidate.candidateId),
        }),
      }),
      cancel: () => {},
    };
    const service = createService(executor);

    await service.registerShadowVersion({
      skillId: "skill-1",
      candidateId: candidate.candidateId,
      runtimeVersion: "runtime-v1",
      ...makeApprovalInput({ action: "shadow", candidateId: candidate.candidateId }),
    });
    await service.recordCanaryResult({
      skillId: "skill-1",
      candidateId: candidate.candidateId,
      runtimeVersion: "runtime-v1",
      ...makeApprovalInput({ action: "canary", candidateId: candidate.candidateId }),
    });

    await expect(service.promote({
      skillId: "skill-1",
      candidateId: candidate.candidateId,
      runtimeVersion: "runtime-v1",
      ...makeApprovalInput({ action: "promote", candidateId: candidate.candidateId }),
    })).rejects.toMatchObject({
      code: "SKILL_LIFECYCLE_ROLLBACK_POINTER_REQUIRED",
      httpStatus: 409,
    });
  });

	  it("passes the actual canary input digest into the internal lifecycle executor", async () => {
    const actualInput = { mode: "actual" };
    const executor: FridaySkillExecutor = {
      execute: () => ({
        runId: "unexpected-public-run",
        result: Promise.resolve({
          runId: "unexpected-public-run",
          status: "failed",
          output: {},
          stdout: "",
          stderr: "public execute should not run lifecycle canary",
          durationMs: 0,
        }),
      }),
      executeLifecycleCanary: (request) => ({
        runId: "canary-run-actual-input",
        result: Promise.resolve({
          runId: "canary-run-actual-input",
          status: "completed",
          output: {},
          stdout: "",
          stderr: "",
          durationMs: 0,
          canonicalTicket: makeCanaryResultTicket(candidate.candidateId, actualInput),
        }).then((result) => {
          const expectedDigest = createFridaySkillLifecycleCanaryInputDigest(actualInput);
          expect(request.lifecycleCanary.canaryInputDigest).toBe(expectedDigest);
          expect(request.canonicalApprovalRequest.parameters?.canaryInputDigest).toBe(expectedDigest);
          return result;
        }),
      }),
      cancel: () => {},
    };
    const service = createService(executor);

    await service.registerShadowVersion({
      skillId: "skill-1",
      candidateId: candidate.candidateId,
      runtimeVersion: "runtime-v1",
      ...makeApprovalInput({ action: "shadow", candidateId: candidate.candidateId }),
    });

    await service.recordCanaryResult({
      skillId: "skill-1",
      candidateId: candidate.candidateId,
      runtimeVersion: "runtime-v1",
      canaryInput: actualInput,
      ...makeApprovalInput({
        action: "canary",
        candidateId: candidate.candidateId,
        canaryInput: actualInput,
      }),
	    });
	  });

	  it("redacts token and cookie evidence from persisted canary output", async () => {
	    const executor: FridaySkillExecutor = {
	      execute: () => ({
	        runId: "unexpected-public-run",
	        result: Promise.resolve({
	          runId: "unexpected-public-run",
	          status: "failed",
	          output: {},
	          stdout: "",
	          stderr: "public execute should not run lifecycle canary",
	          durationMs: 0,
	        }),
	      }),
	      executeLifecycleCanary: () => ({
	        runId: "canary-run-redaction",
	        result: Promise.resolve({
	          runId: "canary-run-redaction",
	          status: "completed",
	          output: {},
	          stdout: '{"token":"alpha123","access_token":"beta456","status":"ok"}',
	          stderr: "Cookie: session=gamma789; refresh=delta012\nAuthorization: Bearer secretBearer123",
	          durationMs: 0,
	          canonicalTicket: makeCanaryResultTicket(candidate.candidateId),
	        }),
	      }),
	      cancel: () => {},
	    };
	    const service = createService(executor);

	    await service.registerShadowVersion({
	      skillId: "skill-1",
	      candidateId: candidate.candidateId,
	      runtimeVersion: "runtime-v1",
	      ...makeApprovalInput({ action: "shadow", candidateId: candidate.candidateId }),
	    });
	    await service.recordCanaryResult({
	      skillId: "skill-1",
	      candidateId: candidate.candidateId,
	      runtimeVersion: "runtime-v1",
	      ...makeApprovalInput({ action: "canary", candidateId: candidate.candidateId }),
	    });

	    const evidence = JSON.parse(
	      readFileSync(join(managedSkillsDir, ".lifecycle", "skill-1", `${candidate.candidateId}.json`), "utf8"),
	    ) as { canaryRuns: Array<{ stdout: string; stderr: string }> };
	    const run = evidence.canaryRuns[0]!;
	    expect(run.stdout).toContain('"token":[redacted]');
	    expect(run.stdout).toContain('"access_token":[redacted]');
	    expect(run.stdout).toContain('"status":"ok"');
	    expect(run.stderr).toContain("Cookie: [redacted]");
	    expect(run.stderr).toContain("Authorization: [redacted]");
	    expect(`${run.stdout}\n${run.stderr}`).not.toMatch(/alpha123|beta456|gamma789|delta012|secretBearer123/);
	  });

	  it("starts a fresh lifecycle proof window when the same candidate is shadowed again", async () => {
    const executor: FridaySkillExecutor = {
      execute: () => ({
        runId: "unexpected-public-run",
        result: Promise.resolve({
          runId: "unexpected-public-run",
          status: "failed",
          output: {},
          stdout: "",
          stderr: "public execute should not run lifecycle canary",
          durationMs: 0,
        }),
      }),
      executeLifecycleCanary: () => ({
        runId: "canary-run-1",
        result: Promise.resolve({
          runId: "canary-run-1",
          status: "completed",
          output: { ok: true },
          stdout: "ok",
          stderr: "",
          durationMs: 12,
          canonicalTicket: makeCanaryResultTicket(candidate.candidateId),
        }),
      }),
      cancel: () => {},
    };
    const service = createService(executor);

    await service.registerShadowVersion({
      skillId: "skill-1",
      candidateId: candidate.candidateId,
      runtimeVersion: "runtime-v1",
      ...makeApprovalInput({ action: "shadow", candidateId: candidate.candidateId, approvalIdSuffix: "-first" }),
    });
    await service.recordCanaryResult({
      skillId: "skill-1",
      candidateId: candidate.candidateId,
      runtimeVersion: "runtime-v1",
      ...makeApprovalInput({ action: "canary", candidateId: candidate.candidateId }),
    });
    await service.promote({
      skillId: "skill-1",
      candidateId: candidate.candidateId,
      runtimeVersion: "runtime-v1",
      ...makeApprovalInput({ action: "promote", candidateId: candidate.candidateId }),
    });
    await service.rollback({
      skillId: "skill-1",
      candidateId: candidate.candidateId,
      runtimeVersion: "runtime-v1",
      ...makeApprovalInput({ action: "rollback", candidateId: candidate.candidateId }),
    });
    expect(service.getLifecycleEvidence({ skillId: "skill-1", candidateId: candidate.candidateId }))
      .toMatchObject({ stage: "rolled_back", canarySuccessCount: 1 });

    await service.registerShadowVersion({
      skillId: "skill-1",
      candidateId: candidate.candidateId,
      runtimeVersion: "runtime-v2",
      ...makeApprovalInput({
        action: "shadow",
        candidateId: candidate.candidateId,
        runtimeVersion: "runtime-v2",
        approvalIdSuffix: "-second",
      }),
    });
    expect(service.getLifecycleEvidence({ skillId: "skill-1", candidateId: candidate.candidateId }))
      .toMatchObject({ stage: "shadow", canarySuccessCount: 0, canaryFailureCount: 0 });

    await expect(service.promote({
      skillId: "skill-1",
      candidateId: candidate.candidateId,
      runtimeVersion: "runtime-v2",
      ...makeApprovalInput({
        action: "promote",
        candidateId: candidate.candidateId,
        runtimeVersion: "runtime-v2",
        approvalIdSuffix: "-second",
      }),
	    })).rejects.toMatchObject({ code: "SKILL_LIFECYCLE_CANARY_NOT_GREEN" });
	  });

	  it("ignores an in-flight canary result when the same candidate is shadowed again", async () => {
	    let resolveCanary!: (value: FridaySkillExecuteResult) => void;
	    const canaryResult = new Promise<FridaySkillExecuteResult>((resolve) => {
	      resolveCanary = resolve;
	    });
	    let executeStarted = false;
	    const executor: FridaySkillExecutor = {
	      execute: () => ({
	        runId: "unexpected-public-run",
	        result: Promise.resolve({
	          runId: "unexpected-public-run",
	          status: "failed",
	          output: {},
	          stdout: "",
	          stderr: "public execute should not run lifecycle canary",
	          durationMs: 0,
	        }),
	      }),
	      executeLifecycleCanary: () => {
	        executeStarted = true;
	        return {
	          runId: "canary-run-stale",
	          result: canaryResult,
	        };
	      },
	      cancel: () => {},
	    };
	    const service = createService(executor);

	    await service.registerShadowVersion({
	      skillId: "skill-1",
	      candidateId: candidate.candidateId,
	      runtimeVersion: "runtime-v1",
	      ...makeApprovalInput({ action: "shadow", candidateId: candidate.candidateId, approvalIdSuffix: "-first" }),
	    });
	    const staleCanary = service.recordCanaryResult({
	      skillId: "skill-1",
	      candidateId: candidate.candidateId,
	      runtimeVersion: "runtime-v1",
	      ...makeApprovalInput({ action: "canary", candidateId: candidate.candidateId }),
	    });
	    expect(executeStarted).toBe(true);

	    await service.registerShadowVersion({
	      skillId: "skill-1",
	      candidateId: candidate.candidateId,
	      runtimeVersion: "runtime-v2",
	      ...makeApprovalInput({
	        action: "shadow",
	        candidateId: candidate.candidateId,
	        runtimeVersion: "runtime-v2",
	        approvalIdSuffix: "-second",
	      }),
	    });
	    resolveCanary({
	      runId: "canary-run-stale",
	      status: "completed",
	      output: { ok: true },
	      stdout: "ok",
	      stderr: "",
	      durationMs: 12,
	      canonicalTicket: makeCanaryResultTicket(candidate.candidateId),
	    });

	    await expect(staleCanary).rejects.toMatchObject({ code: "SKILL_LIFECYCLE_CANARY_STALE" });
	    expect(service.getLifecycleEvidence({ skillId: "skill-1", candidateId: candidate.candidateId }))
	      .toMatchObject({ stage: "shadow", canarySuccessCount: 0, canaryFailureCount: 0 });
	    await expect(service.promote({
	      skillId: "skill-1",
	      candidateId: candidate.candidateId,
	      runtimeVersion: "runtime-v2",
	      ...makeApprovalInput({
	        action: "promote",
	        candidateId: candidate.candidateId,
	        runtimeVersion: "runtime-v2",
	        approvalIdSuffix: "-second",
	      }),
	    })).rejects.toMatchObject({ code: "SKILL_LIFECYCLE_CANARY_NOT_GREEN" });
	  });

	  it("counts current shadow digest mismatch canary rejection as a promote-blocking failure", async () => {
	    const executor: FridaySkillExecutor = {
	      execute: () => ({
	        runId: "unexpected-public-run",
	        result: Promise.resolve({
	          runId: "unexpected-public-run",
	          status: "failed",
	          output: {},
	          stdout: "",
	          stderr: "public execute should not run lifecycle canary",
	          durationMs: 0,
	        }),
	      }),
	      executeLifecycleCanary: () => ({
	        runId: "canary-run-before-mismatch",
	        result: Promise.resolve({
	          runId: "canary-run-before-mismatch",
	          status: "completed",
	          output: { ok: true },
	          stdout: "ok",
	          stderr: "",
	          durationMs: 12,
	          canonicalTicket: makeCanaryResultTicket(candidate.candidateId),
	        }),
	      }),
	      cancel: () => {},
	    };
	    const service = createService(executor);

	    await service.registerShadowVersion({
	      skillId: "skill-1",
	      candidateId: candidate.candidateId,
	      runtimeVersion: "runtime-v1",
	      ...makeApprovalInput({ action: "shadow", candidateId: candidate.candidateId }),
	    });
	    await service.recordCanaryResult({
	      skillId: "skill-1",
	      candidateId: candidate.candidateId,
	      runtimeVersion: "runtime-v1",
	      ...makeApprovalInput({ action: "canary", candidateId: candidate.candidateId }),
	    });

	    const evidencePath = join(managedSkillsDir, ".lifecycle", "skill-1", `${candidate.candidateId}.json`);
	    const evidenceBeforeTamper = JSON.parse(readFileSync(evidencePath, "utf8")) as {
	      shadow: { shadowDir: string; shadowWindowId: string };
	    };
	    const tamperPath = join(evidenceBeforeTamper.shadow.shadowDir, "tamper.txt");
	    writeFileSync(tamperPath, "tampered", "utf8");
	    await expect(service.recordCanaryResult({
	      skillId: "skill-1",
	      candidateId: candidate.candidateId,
	      runtimeVersion: "runtime-v1",
	      ...makeApprovalInput({
	        action: "canary",
	        candidateId: candidate.candidateId,
	        approvalIdSuffix: "-digest-mismatch",
	      }),
	    })).rejects.toMatchObject({ code: "SKILL_LIFECYCLE_SHADOW_DIGEST_MISMATCH" });
	    rmSync(tamperPath, { force: true });

	    const evidenceAfterMismatch = JSON.parse(readFileSync(evidencePath, "utf8")) as {
	      canaryRuns: Array<{ status: string; success: boolean; shadowWindowId?: string }>;
	    };
	    expect(evidenceAfterMismatch.canaryRuns.at(-1)).toMatchObject({
	      status: "artifact_digest_mismatch",
	      success: false,
	      shadowWindowId: evidenceBeforeTamper.shadow.shadowWindowId,
	    });
	    await expect(service.promote({
	      skillId: "skill-1",
	      candidateId: candidate.candidateId,
	      runtimeVersion: "runtime-v1",
	      ...makeApprovalInput({ action: "promote", candidateId: candidate.candidateId }),
	    })).rejects.toMatchObject({
	      code: "SKILL_LIFECYCLE_CANARY_NOT_GREEN",
	      details: { canarySuccessCount: 1, canaryFailureCount: 1 },
	    });
	  });

	  it("refuses promote when the previous active artifact changed after shadow", async () => {
    const previousManifest = makeManifest({ name: "Previous Skill", version: "1.0.0" });
    writeSkillFiles(join(managedSkillsDir, "skill-1"), previousManifest);
    db.withWriteTransaction((conn) => {
      createFridaySkillRepository().setInstalledVersion(conn, "skill-1", "1.0.0", previousManifest, NOW);
    });
    const executor: FridaySkillExecutor = {
      execute: () => ({
        runId: "unexpected-public-run",
        result: Promise.resolve({
          runId: "unexpected-public-run",
          status: "failed",
          output: {},
          stdout: "",
          stderr: "public execute should not run lifecycle canary",
          durationMs: 0,
        }),
      }),
      executeLifecycleCanary: () => ({
        runId: "canary-run-1",
        result: Promise.resolve({
          runId: "canary-run-1",
          status: "completed",
          output: { ok: true },
          stdout: "ok",
          stderr: "",
          durationMs: 12,
          canonicalTicket: makeCanaryResultTicket(candidate.candidateId),
        }),
      }),
      cancel: () => {},
    };
    const service = createService(executor);

    await service.registerShadowVersion({
      skillId: "skill-1",
      candidateId: candidate.candidateId,
      runtimeVersion: "runtime-v1",
      ...makeApprovalInput({ action: "shadow", candidateId: candidate.candidateId }),
    });
    await service.recordCanaryResult({
      skillId: "skill-1",
      candidateId: candidate.candidateId,
      runtimeVersion: "runtime-v1",
      ...makeApprovalInput({ action: "canary", candidateId: candidate.candidateId }),
    });
    writeFileSync(join(managedSkillsDir, "skill-1", "SKILL.md"), "# Tampered previous skill\n", "utf8");

    await expect(service.promote({
      skillId: "skill-1",
      candidateId: candidate.candidateId,
      runtimeVersion: "runtime-v1",
      ...makeApprovalInput({ action: "promote", candidateId: candidate.candidateId }),
    })).rejects.toMatchObject({
      code: "SKILL_LIFECYCLE_PREVIOUS_ARTIFACT_CHANGED",
      httpStatus: 409,
    });
  });

  it("refuses rollback when the previous artifact backup digest no longer matches", async () => {
    const previousManifest = makeManifest({ name: "Previous Skill", version: "1.0.0" });
    writeSkillFiles(join(managedSkillsDir, "skill-1"), previousManifest);
    db.withWriteTransaction((conn) => {
      createFridaySkillRepository().setInstalledVersion(conn, "skill-1", "1.0.0", previousManifest, NOW);
    });
    const executor: FridaySkillExecutor = {
      execute: () => ({
        runId: "unexpected-public-run",
        result: Promise.resolve({
          runId: "unexpected-public-run",
          status: "failed",
          output: {},
          stdout: "",
          stderr: "public execute should not run lifecycle canary",
          durationMs: 0,
        }),
      }),
      executeLifecycleCanary: () => ({
        runId: "canary-run-1",
        result: Promise.resolve({
          runId: "canary-run-1",
          status: "completed",
          output: { ok: true },
          stdout: "ok",
          stderr: "",
          durationMs: 12,
          canonicalTicket: makeCanaryResultTicket(candidate.candidateId),
        }),
      }),
      cancel: () => {},
    };
    const service = createService(executor);

    await service.registerShadowVersion({
      skillId: "skill-1",
      candidateId: candidate.candidateId,
      runtimeVersion: "runtime-v1",
      ...makeApprovalInput({ action: "shadow", candidateId: candidate.candidateId }),
    });
    await service.recordCanaryResult({
      skillId: "skill-1",
      candidateId: candidate.candidateId,
      runtimeVersion: "runtime-v1",
      ...makeApprovalInput({ action: "canary", candidateId: candidate.candidateId }),
    });
    await service.promote({
      skillId: "skill-1",
      candidateId: candidate.candidateId,
      runtimeVersion: "runtime-v1",
      ...makeApprovalInput({ action: "promote", candidateId: candidate.candidateId }),
    });
    writeFileSync(
      join(managedSkillsDir, ".rollback", "skill-1", candidate.candidateId, "previous", "SKILL.md"),
      "# Tampered backup\n",
      "utf8",
    );

    await expect(service.rollback({
      skillId: "skill-1",
      candidateId: candidate.candidateId,
      runtimeVersion: "runtime-v1",
      reason: "tampered backup",
      ...makeApprovalInput({ action: "rollback", candidateId: candidate.candidateId }),
    })).rejects.toMatchObject({
      code: "SKILL_LIFECYCLE_ROLLBACK_ARTIFACT_MISMATCH",
      httpStatus: 409,
    });
  });

  it("rejects canonical approval that does not match the requested candidate action digest", async () => {
    const service = createService();
    await expect(service.registerShadowVersion({
      skillId: "skill-1",
      candidateId: candidate.candidateId,
      runtimeVersion: "runtime-v2",
      ...makeApprovalInput({ action: "shadow", candidateId: candidate.candidateId, runtimeVersion: "runtime-v1" }),
    })).rejects.toMatchObject({ code: "CANONICAL_APPROVAL_DENIED" });
  });
});
