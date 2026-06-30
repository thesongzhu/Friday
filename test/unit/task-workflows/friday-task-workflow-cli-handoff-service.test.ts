import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createFridaySqliteLayer } from "#state";

import { FridayDomainError } from "../../../src/errors/friday-domain-error.js";
import {
  createFridayTaskWorkflowCliAdapter,
  createFridayTaskWorkflowRepository,
  createFridayTaskWorkflowService,
} from "../../../src/task-workflows/index.js";
import type {
  FridayTaskWorkflowCliAdapter,
  FridayTaskWorkflowCliHandoffRecord,
  FridayTaskWorkflowCliTextCompletion,
  FridayTaskWorkflowContextPackage,
  FridayTaskWorkflowService,
} from "../../../src/task-workflows/index.js";

let tmpDir: string;
let db: ReturnType<typeof createFridaySqliteLayer>;
let nextId = 0;
let frozenNow = "2026-05-16T00:00:00.000Z";

function makeContextPackage(
  overrides: Partial<FridayTaskWorkflowContextPackage> = {},
): FridayTaskWorkflowContextPackage {
  return {
    allowedFiles: ["src/task-workflows/friday-task-workflow-cli-adapter.ts"],
    allowedTools: ["read"],
    allowedApis: [],
    boundaryIds: ["api.task_workflows.cli_adapter"],
    ...overrides,
  };
}

function makeCreateInput(overrides: { risk?: "low" | "medium" | "high" } = {}) {
  return {
    charter: "phase 13.5c live binding slice",
    taskKind: "general",
    risk: overrides.risk,
    contextPackage: makeContextPackage(),
  };
}

function makeServiceWithAdapter(
  cliTextCompletion: FridayTaskWorkflowCliTextCompletion,
): { service: FridayTaskWorkflowService; adapter: FridayTaskWorkflowCliAdapter } {
  const repository = createFridayTaskWorkflowRepository();
  const adapter = createFridayTaskWorkflowCliAdapter({
    cliTextCompletion,
    nowIso: () => frozenNow,
    elapsedMs: () => 0,
  });
  const service = createFridayTaskWorkflowService({
    db,
    repository,
    idGenerator: () => {
      nextId += 1;
      return `id-${nextId.toString(16).padStart(8, "0")}`;
    },
    nowIso: () => frozenNow,
    cliAdapter: adapter,
  });
  return { service, adapter };
}

function makeServiceWithoutAdapter(): FridayTaskWorkflowService {
  const repository = createFridayTaskWorkflowRepository();
  return createFridayTaskWorkflowService({
    db,
    repository,
    idGenerator: () => {
      nextId += 1;
      return `id-${nextId.toString(16).padStart(8, "0")}`;
    },
    nowIso: () => frozenNow,
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-tw-cli-ho-test-"));
  const dbPath = path.join(tmpDir, "test.db");
  db = createFridaySqliteLayer({
    dbPath,
    readPoolSize: 1,
    pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
  });
  nextId = 0;
  frozenNow = "2026-05-16T00:00:00.000Z";
});

afterEach(async () => {
  try {
    db.close();
  } catch {
    // ok
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("Phase 13.5C live CLI handoff binding (service.recordCliHandoff)", () => {
  it("persists a handoff_ready handoff with verified=false and capability label intact", async () => {
    const { service } = makeServiceWithAdapter(async () =>
      "draft summary from codex-cli adapter shim",
    );
    const workflow = service.create(makeCreateInput({ risk: "medium" }));
    const lane = service.openExecutorLane(workflow.id, { laneRole: "cli" });
    const handoff = await service.recordCliHandoff(workflow.id, lane.id, {
      backendId: "codex-cli",
      systemPrompt: "You are a bounded CLI reviewer.",
      conversation: "USER: summarize the diff under <50 words.",
    });
    expect(handoff.status).toBe("handoff_ready");
    expect(handoff.workflowId).toBe(workflow.id);
    expect(handoff.laneId).toBe(lane.id);
    expect(handoff.backendId).toBe("codex-cli");
    expect(handoff.summaryDraft.startsWith("draft summary")).toBe(true);
    expect(handoff.capabilityLabel.nativeToolProof).toBe(false);
    expect(handoff.capabilityLabel.summaryStatus).toBe("draft_unverified");
    expect(handoff.capabilityLabel.verifierPromotionAllowed).toBe(false);
    expect(handoff.capabilityLabel.evidenceRefFreshReadRequired).toBe(true);
    expect(handoff.capabilityLabel.contextPackageBound).toBe(true);
    expect(handoff.capabilityLabel.laneRole).toBe("cli");
    expect(handoff.capabilityLabel.boundaryRefs).toEqual(workflow.boundaryRefs);
    expect(handoff.capabilityLabel.requiredGateIds).toContain(
      "cli_self_report_unconfirmed",
    );

    const persisted = service.listCliHandoffsByLane(workflow.id, lane.id);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.id).toBe(handoff.id);
    expect(persisted[0]!.capabilityLabel.nativeToolProof).toBe(false);

    const workflowList = service.listCliHandoffsByWorkflow(workflow.id);
    expect(workflowList).toHaveLength(1);
  });

  it("returns the handoff verbatim from the adapter — no service-side promotion of the summary", async () => {
    let observedConversation = "";
    const { service } = makeServiceWithAdapter(async (input) => {
      observedConversation = input.conversation;
      return "bounded reviewer reply";
    });
    const workflow = service.create(makeCreateInput({ risk: "low" }));
    const lane = service.openExecutorLane(workflow.id, { laneRole: "cli" });
    const handoff = await service.recordCliHandoff(workflow.id, lane.id, {
      backendId: "codex-cli",
      systemPrompt: "system",
      conversation: "user message",
    });
    // Adapter prepends a Phase 13.5C boundary preamble before passing the
    // conversation to CLI: confirm the live binding still goes through the
    // adapter (we did not bypass the boundary preface).
    expect(observedConversation).toContain("Friday CLI bounded text task");
    expect(observedConversation).toContain("Allowed files:");
    expect(observedConversation).toContain("Allowed tools:");
    expect(observedConversation).toContain("user message");
    expect(handoff.summaryDraft).toBe("bounded reviewer reply");
  });

  it("persists a handoff even on adapter timeout fail-closed (status=timeout, verified=false)", async () => {
    const { service } = makeServiceWithAdapter(async () =>
      new Promise((resolve) => {
        setTimeout(() => resolve("late"), 200);
      }),
    );
    const workflow = service.create(makeCreateInput({ risk: "medium" }));
    const lane = service.openExecutorLane(workflow.id, { laneRole: "cli" });
    const handoff = await service.recordCliHandoff(workflow.id, lane.id, {
      backendId: "codex-cli",
      systemPrompt: "system",
      conversation: "user",
      timeoutMs: 10,
    });
    expect(handoff.status).toBe("timeout");
    expect(handoff.failureReason).toMatch(/timed out/i);
    expect(handoff.capabilityLabel.nativeToolProof).toBe(false);

    const persisted = service.listCliHandoffsByLane(workflow.id, lane.id);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.status).toBe("timeout");
  });

  it("persists fail-closed for unavailable / auth_missing without throwing", async () => {
    const unavailableRun = makeServiceWithAdapter(async () => {
      throw new FridayDomainError("PROVIDER_UNREACHABLE", "no codex binary");
    });
    const workflowU = unavailableRun.service.create(
      makeCreateInput({ risk: "medium" }),
    );
    const laneU = unavailableRun.service.openExecutorLane(workflowU.id, {
      laneRole: "cli",
    });
    const handoffU = await unavailableRun.service.recordCliHandoff(
      workflowU.id,
      laneU.id,
      { backendId: "codex-cli", systemPrompt: "sys", conversation: "msg" },
    );
    expect(handoffU.status).toBe("unavailable");
    expect(handoffU.failureReason).toMatch(/unavailable/i);

    const authMissingRun = makeServiceWithAdapter(async () => {
      throw new FridayDomainError("LLM_ERROR", "auth required: please login");
    });
    const workflowA = authMissingRun.service.create(
      makeCreateInput({ risk: "medium" }),
    );
    const laneA = authMissingRun.service.openExecutorLane(workflowA.id, {
      laneRole: "cli",
    });
    const handoffA = await authMissingRun.service.recordCliHandoff(
      workflowA.id,
      laneA.id,
      { backendId: "codex-cli", systemPrompt: "sys", conversation: "msg" },
    );
    expect(handoffA.status).toBe("auth_missing");
    expect(handoffA.failureReason).toMatch(/authentication required/i);
  });

  it("refuses to record a handoff against a non-cli lane (laneRole='native')", async () => {
    const { service } = makeServiceWithAdapter(async () => "should not be called");
    const workflow = service.create(makeCreateInput({ risk: "medium" }));
    const lane = service.openExecutorLane(workflow.id, { laneRole: "native" });
    try {
      await service.recordCliHandoff(workflow.id, lane.id, {
        backendId: "codex-cli",
        systemPrompt: "sys",
        conversation: "msg",
      });
      throw new Error("expected CLI lane requirement");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe(
        "TASK_WORKFLOW_CLI_LANE_REQUIRED",
      );
    }
    expect(service.listCliHandoffsByLane(workflow.id, lane.id)).toEqual([]);
  });

  it("refuses to record a handoff against a completed/blocked CLI lane", async () => {
    const { service } = makeServiceWithAdapter(async () => "should not be called");
    const workflow = service.create(makeCreateInput({ risk: "medium" }));
    const lane = service.openExecutorLane(workflow.id, { laneRole: "cli" });
    service.completeLane(workflow.id, lane.id, { status: "completed" });
    try {
      await service.recordCliHandoff(workflow.id, lane.id, {
        backendId: "codex-cli",
        systemPrompt: "sys",
        conversation: "msg",
      });
      throw new Error("expected lane-closed refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe("TASK_WORKFLOW_LANE_CLOSED");
    }
  });

  it("refuses missing systemPrompt / conversation / backendId at the service layer", async () => {
    const { service } = makeServiceWithAdapter(async () => "ok");
    const workflow = service.create(makeCreateInput({ risk: "medium" }));
    const lane = service.openExecutorLane(workflow.id, { laneRole: "cli" });
    for (const broken of [
      { backendId: "codex-cli", systemPrompt: "  ", conversation: "msg" },
      { backendId: "codex-cli", systemPrompt: "sys", conversation: "  " },
      {
        backendId: "openai-cli" as never,
        systemPrompt: "sys",
        conversation: "msg",
      },
    ] as const) {
      try {
        await service.recordCliHandoff(workflow.id, lane.id, broken);
        throw new Error("expected validation refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(FridayDomainError);
        expect((error as FridayDomainError).code).toBe("TASK_WORKFLOW_INVALID");
      }
    }
  });

  it("returns 503 TASK_WORKFLOW_CLI_ADAPTER_DISABLED when service has no adapter wired", async () => {
    const service = makeServiceWithoutAdapter();
    const workflow = service.create(makeCreateInput({ risk: "medium" }));
    const lane = service.openExecutorLane(workflow.id, { laneRole: "cli" });
    try {
      await service.recordCliHandoff(workflow.id, lane.id, {
        backendId: "codex-cli",
        systemPrompt: "sys",
        conversation: "msg",
      });
      throw new Error("expected adapter-disabled refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe(
        "TASK_WORKFLOW_CLI_ADAPTER_DISABLED",
      );
    }
  });

  it("does NOT promote a drafted cli_self_report claim to verified after recording a handoff (gate still blocks)", async () => {
    const { service } = makeServiceWithAdapter(async () => "cli draft summary");
    const workflow = service.create(makeCreateInput({ risk: "medium" }));
    const lane = service.openExecutorLane(workflow.id, { laneRole: "cli" });
    const handoff: FridayTaskWorkflowCliHandoffRecord =
      await service.recordCliHandoff(workflow.id, lane.id, {
        backendId: "codex-cli",
        systemPrompt: "sys",
        conversation: "msg",
      });
    expect(handoff.capabilityLabel.verifierPromotionAllowed).toBe(false);
    expect(handoff.capabilityLabel.nativeToolProof).toBe(false);

    // Even when a user drafts a cli_self_report claim referencing the
    // handoff, the existing closeout gate `cli_self_report_unconfirmed`
    // remains the backstop. Drafting alone never promotes to verified.
    const claim = service.draftClaim(workflow.id, {
      claimText: "cli observed test pass",
      claimKind: "cli_self_report",
    });
    expect(claim.status).toBe("draft");
    service.attachEvidenceRef(workflow.id, claim.id, {
      refKind: "cli.handoff",
      refId: handoff.id,
      refSource: "manual_external",
    });
    const afterAttach = service.getClaim(workflow.id, claim.id);
    // Attaching evidence promotes a draft claim to `unverified` per Phase
    // 13.5A semantics; CLI self-report remains non-verifiable, so the
    // claim cannot reach `verified` from here without violating policy.
    expect(["draft", "unverified"]).toContain(afterAttach.status);
    expect(afterAttach.status).not.toBe("verified");
  });
});
