import { describe, expect, it } from "vitest";

import { FridayDomainError } from "../../../src/errors/friday-domain-error.js";
import {
  buildFridayTaskWorkflowCliCapabilityLabel,
  createFridayTaskWorkflowCliAdapter,
} from "../../../src/task-workflows/index.js";
import type {
  FridayTaskWorkflowCliInvokeInput,
  FridayTaskWorkflowCliTextCompletion,
} from "../../../src/task-workflows/index.js";

function frozenNowFactory(values: string[]): () => string {
  let i = 0;
  return () => {
    const v = values[Math.min(i, values.length - 1)] ?? "2026-05-16T00:00:00.000Z";
    i += 1;
    return v;
  };
}

function elapsedClockFactory(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[Math.min(i, values.length - 1)] ?? 0;
    i += 1;
    return v;
  };
}

function makeInput(
  overrides: Partial<FridayTaskWorkflowCliInvokeInput> = {},
): FridayTaskWorkflowCliInvokeInput {
  return {
    backendId: "claude-cli",
    systemPrompt: "You are a bounded text reviewer.",
    conversation: "Review the linked spec.",
    contextPackage: {
      allowedFiles: ["docs/release-evidence-policy.md"],
      allowedTools: ["read"],
      allowedApis: [],
      boundaryIds: ["api.task_workflows.cli_adapter"],
    },
    boundaryRefs: ["api.task_workflows.cli_adapter"],
    minSummaryChars: 4,
    timeoutMs: 200,
    ...overrides,
  };
}

describe("Phase 13.5C CLI capability label", () => {
  it("always reports nativeToolProof=false, verifierPromotionAllowed=false, evidenceRefFreshReadRequired=true", () => {
    const label = buildFridayTaskWorkflowCliCapabilityLabel([
      "api.task_workflows.cli_adapter",
    ]);
    expect(label.nativeToolProof).toBe(false);
    expect(label.verifierPromotionAllowed).toBe(false);
    expect(label.evidenceRefFreshReadRequired).toBe(true);
    expect(label.contextPackageBound).toBe(true);
    expect(label.summaryStatus).toBe("draft_unverified");
    expect(label.laneRole).toBe("cli");
    expect(label.boundaryRefs).toEqual(["api.task_workflows.cli_adapter"]);
    expect(label.requiredGateIds).toEqual(
      expect.arrayContaining([
        "cli_self_report_unconfirmed",
        "claim_evidence_required",
        "verifier_fresh_read",
        "context_package_scope_limit",
      ]),
    );
    expect(label.disclosure).toMatch(/never native-tool proof/i);
    expect(label.disclosure).toMatch(/fresh-read/i);
  });
});

describe("Phase 13.5C CLI adapter", () => {
  const baseDeps = {
    nowIso: frozenNowFactory(["2026-05-16T00:00:00.000Z"]),
  };

  it("returns handoff_ready with a usable summary and never marks verified", async () => {
    let capturedConversation: string | null = null;
    const cliTextCompletion: FridayTaskWorkflowCliTextCompletion = async (call) => {
      capturedConversation = call.conversation;
      return "Spec looks aligned with stated scope.";
    };
    const adapter = createFridayTaskWorkflowCliAdapter({
      ...baseDeps,
      cliTextCompletion,
      elapsedMs: elapsedClockFactory([0, 25]),
    });
    const handoff = await adapter.produceHandoff(makeInput());
    expect(handoff.status).toBe("handoff_ready");
    expect(handoff.verified).toBe(false);
    expect(handoff.summaryDraft).toBe("Spec looks aligned with stated scope.");
    expect(handoff.capabilityLabel.nativeToolProof).toBe(false);
    expect(handoff.repairAttempts).toBe(0);
    expect(handoff.failureReason).toBeNull();
    expect(handoff.producedAt).toBe("2026-05-16T00:00:00.000Z");
    expect(handoff.elapsedMs).toBeGreaterThanOrEqual(0);
    // Conversation must mention only the scoped file, never a whole-repo sentinel.
    expect(capturedConversation).not.toBeNull();
    expect(capturedConversation).toContain("docs/release-evidence-policy.md");
    expect(capturedConversation).not.toContain("**");
  });

  it("refuses whole-repo context packages before invoking the CLI", async () => {
    let invoked = false;
    const cliTextCompletion: FridayTaskWorkflowCliTextCompletion = async () => {
      invoked = true;
      return "should not be called";
    };
    const adapter = createFridayTaskWorkflowCliAdapter({
      ...baseDeps,
      cliTextCompletion,
    });
    try {
      await adapter.produceHandoff(
        makeInput({
          contextPackage: {
            allowedFiles: ["**"],
            allowedTools: [],
            allowedApis: [],
            boundaryIds: [],
          },
        }),
      );
      throw new Error("expected whole-repo refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe(
        "CONTEXT_PACKAGE_WHOLE_REPO_REFUSED",
      );
    }
    expect(invoked).toBe(false);
  });

  it("maps PROVIDER_UNREACHABLE to status='unavailable' without throwing", async () => {
    const cliTextCompletion: FridayTaskWorkflowCliTextCompletion = async () => {
      throw new FridayDomainError(
        "PROVIDER_UNREACHABLE",
        "CLI binary 'claude' not found",
        { httpStatus: 422 },
      );
    };
    const adapter = createFridayTaskWorkflowCliAdapter({
      ...baseDeps,
      cliTextCompletion,
    });
    const handoff = await adapter.produceHandoff(makeInput());
    expect(handoff.status).toBe("unavailable");
    expect(handoff.summaryDraft).toBe("");
    expect(handoff.failureReason).toMatch(/unavailable/i);
    expect(handoff.repairAttempts).toBe(0);
  });

  it("maps auth-shaped LLM_ERROR to status='auth_missing'", async () => {
    const cliTextCompletion: FridayTaskWorkflowCliTextCompletion = async () => {
      throw new FridayDomainError(
        "LLM_ERROR",
        "Claude CLI auth required; please run claude auth",
        { httpStatus: 502 },
      );
    };
    const adapter = createFridayTaskWorkflowCliAdapter({
      ...baseDeps,
      cliTextCompletion,
    });
    const handoff = await adapter.produceHandoff(makeInput());
    expect(handoff.status).toBe("auth_missing");
    expect(handoff.failureReason).toMatch(/authentication required/i);
  });

  it("converts adapter-level timeouts to status='timeout' and stops cleanly", async () => {
    // CLI never resolves before the adapter's internal timeout.
    const cliTextCompletion: FridayTaskWorkflowCliTextCompletion = () =>
      new Promise<string>(() => {
        /* never resolves */
      });
    const adapter = createFridayTaskWorkflowCliAdapter({
      ...baseDeps,
      cliTextCompletion,
    });
    const handoff = await adapter.produceHandoff(
      makeInput({ timeoutMs: 50 }),
    );
    expect(handoff.status).toBe("timeout");
    expect(handoff.summaryDraft).toBe("");
    expect(handoff.failureReason).toMatch(/timed out after 50ms/);
  });

  it("performs exactly one bounded repair attempt then returns repair_failed when output stays unusable", async () => {
    let calls = 0;
    const cliTextCompletion: FridayTaskWorkflowCliTextCompletion = async () => {
      calls += 1;
      return "   "; // whitespace only — always below threshold
    };
    const adapter = createFridayTaskWorkflowCliAdapter({
      ...baseDeps,
      cliTextCompletion,
    });
    const handoff = await adapter.produceHandoff(makeInput({ minSummaryChars: 8 }));
    expect(calls).toBe(2);
    expect(handoff.status).toBe("repair_failed");
    expect(handoff.repairAttempts).toBe(1);
    expect(handoff.failureReason).toMatch(/repair attempt/i);
  });

  it("succeeds on the repair attempt when the second response is usable", async () => {
    let calls = 0;
    const cliTextCompletion: FridayTaskWorkflowCliTextCompletion = async () => {
      calls += 1;
      if (calls === 1) return "";
      return "Repaired summary covering the requested review.";
    };
    const adapter = createFridayTaskWorkflowCliAdapter({
      ...baseDeps,
      cliTextCompletion,
    });
    const handoff = await adapter.produceHandoff(makeInput({ minSummaryChars: 8 }));
    expect(handoff.status).toBe("handoff_ready");
    expect(handoff.repairAttempts).toBe(1);
    expect(handoff.summaryDraft).toMatch(/^Repaired summary/);
  });

  it("rejects unknown backendId before invoking the CLI", async () => {
    let invoked = false;
    const cliTextCompletion: FridayTaskWorkflowCliTextCompletion = async () => {
      invoked = true;
      return "should not run";
    };
    const adapter = createFridayTaskWorkflowCliAdapter({
      ...baseDeps,
      cliTextCompletion,
    });
    try {
      await adapter.produceHandoff(
        makeInput({
          // Force-cast a known-invalid value through Partial to test runtime guard.
          backendId: "openai-cli" as unknown as "claude-cli",
        }),
      );
      throw new Error("expected backend refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FridayDomainError);
      expect((error as FridayDomainError).code).toBe(
        "TASK_WORKFLOW_INVALID",
      );
    }
    expect(invoked).toBe(false);
  });

  it("scopes the CLI conversation to allowed files / tools / APIs and never claims native-tool capability", async () => {
    let captured: { systemPrompt: string; conversation: string } | null = null;
    const cliTextCompletion: FridayTaskWorkflowCliTextCompletion = async (call) => {
      captured = {
        systemPrompt: call.systemPrompt,
        conversation: call.conversation,
      };
      return "Bounded summary with scoped references.";
    };
    const adapter = createFridayTaskWorkflowCliAdapter({
      ...baseDeps,
      cliTextCompletion,
    });
    const input = makeInput({
      contextPackage: {
        allowedFiles: ["src/task-workflows/friday-task-workflow.types.ts"],
        allowedTools: ["read"],
        allowedApis: ["GET /v1/task-workflows/boundaries"],
        boundaryIds: ["api.task_workflows.cli_adapter"],
      },
      boundaryRefs: ["api.task_workflows.cli_adapter"],
    });
    await adapter.produceHandoff(input);
    expect(captured).not.toBeNull();
    expect(captured!.conversation).toContain(
      "src/task-workflows/friday-task-workflow.types.ts",
    );
    expect(captured!.conversation).toContain("read");
    expect(captured!.conversation).toContain(
      "GET /v1/task-workflows/boundaries",
    );
    expect(captured!.conversation).toContain("api.task_workflows.cli_adapter");
    expect(captured!.conversation).toMatch(/DRAFT/);
    expect(captured!.conversation).toMatch(/NOT verified evidence/i);
    expect(captured!.conversation).toMatch(/native tool execution/i);
  });
});
