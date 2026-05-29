import { describe, it, expect } from "vitest";
import {
  classifyWorkflowNodeSideEffect,
  resolveNodeCompletionVerification,
  isVerifiedCompletion,
} from "../../../../src/workflows/runtime/friday-workflow-node-acceptance.js";
import {
  FRIDAY_FS_WRITE_TARGET_ARG_KEY,
  resolveFilesystemWriteTarget,
} from "../../../../src/workflows/runtime/friday-workflow-fs-write-verifier.js";
import type { FridayWorkflowNode } from "../../../../src/workflows/model/friday-workflow-graph.types.js";

// Audit C Stage 1: a side-effect node without deterministic evidence must be
// truth-labeled proof_pending (NOT a clean/verified completion); classification
// derives from declared capability (node.type + manifest grants), never output.

function node(type: FridayWorkflowNode["type"], config: Record<string, unknown> = {}): Pick<FridayWorkflowNode, "type" | "config"> {
  return { type, config } as Pick<FridayWorkflowNode, "type" | "config">;
}
const skillWith = (actions: string[]) => () => ({ manifest: { permissions: { grants: actions.map((a) => ({ action: a })) } } });
const noSkill = () => null;

describe("workflow node acceptance classifier (audit C)", () => {
  it("pure-compute nodes (trigger/condition/data) are informational → verified", () => {
    for (const t of ["trigger", "condition", "data"] as const) {
      const cls = classifyWorkflowNodeSideEffect(node(t), noSkill);
      expect(cls).toBe("informational");
      expect(resolveNodeCompletionVerification(node(t), cls)).toBe("verified");
    }
  });

  it("ai / approval nodes are informational → model_assessed_unverified (never release proof)", () => {
    for (const t of ["ai", "approval"] as const) {
      const cls = classifyWorkflowNodeSideEffect(node(t), noSkill);
      const v = resolveNodeCompletionVerification(node(t), cls);
      expect(v).toBe("model_assessed_unverified");
      expect(isVerifiedCompletion(v)).toBe(false);
    }
  });

  it("action node with a side-effecting grant (write/send/connect/execute/capture) → side_effect → proof_pending", () => {
    for (const a of ["write", "send", "connect", "execute", "capture"]) {
      const n = node("action", { skillId: "s1" });
      const cls = classifyWorkflowNodeSideEffect(n, skillWith([a]));
      expect(cls).toBe("side_effect");
      const v = resolveNodeCompletionVerification(n, cls);
      expect(v).toBe("proof_pending");
      expect(isVerifiedCompletion(v)).toBe(false);
    }
  });

  it("action node whose grants are all read/receive → informational → verified", () => {
    const n = node("action", { skillId: "s1" });
    const cls = classifyWorkflowNodeSideEffect(n, skillWith(["read", "receive"]));
    expect(cls).toBe("informational");
    expect(resolveNodeCompletionVerification(n, cls)).toBe("verified");
  });

  it("fail-closed: action node with empty grants → side_effect (empty != safe)", () => {
    const n = node("action", { skillId: "s1" });
    expect(classifyWorkflowNodeSideEffect(n, skillWith([]))).toBe("side_effect");
  });

  it("fail-closed: action node with unresolved skill or no skillId → side_effect", () => {
    expect(classifyWorkflowNodeSideEffect(node("action", { skillId: "missing" }), noSkill)).toBe("side_effect");
    expect(classifyWorkflowNodeSideEffect(node("action", {}), skillWith(["write"]))).toBe("side_effect");
  });

  it("supports config.ref as the skill identity", () => {
    const n = node("action", { ref: "s2" });
    expect(classifyWorkflowNodeSideEffect(n, skillWith(["send"]))).toBe("side_effect");
  });

  it("legacy v1 permission shape (network:true) → side_effect", () => {
    const legacySkill = () => ({ manifest: { permissions: { network: true, filesystem: "none", memoryScope: "read", tools: [] } } });
    expect(classifyWorkflowNodeSideEffect(node("action", { skillId: "s3" }), legacySkill)).toBe("side_effect");
  });

  it("Stage 2 forward-compat: side_effect WITH deterministic evidence → verified", () => {
    const n = node("action", { skillId: "s1" });
    const cls = classifyWorkflowNodeSideEffect(n, skillWith(["write"]));
    expect(resolveNodeCompletionVerification(n, cls, /* hasDeterministicEvidence */ true)).toBe("verified");
  });
});

// Audit C Stage 2A: the fs-write candidate gate is a NARROWER subset of the
// Stage 1 side-effect class — a write node co-declaring send/connect/capture/
// execute is still side_effect (proof_pending) but is NOT an fs-write
// verification candidate, so it can never be upgraded to verified.
describe("audit C Stage 2A — fs-write candidate gate vs the Stage 1 classifier", () => {
  const writeSkill = (extraActions: string[] = []) => () => ({
    id: "s",
    skillDir: "/tmp/skill",
    manifest: {
      permissions: {
        grants: [
          { resource: "filesystem", action: "read" },
          { resource: "filesystem", action: "write", selectors: { pathPrefixes: ["out"] } },
          ...extraActions.map((a) => ({ action: a })),
        ],
      },
    },
  });

  it("pure write-class node with a binding target IS a candidate (verified-eligible)", () => {
    const n = node("action", { skillId: "s", args: { [FRIDAY_FS_WRITE_TARGET_ARG_KEY]: "out/x.json" } });
    expect(classifyWorkflowNodeSideEffect(n, writeSkill())).toBe("side_effect");
    expect(resolveFilesystemWriteTarget(n, writeSkill())).not.toBeNull();
  });

  it("write+send node stays side_effect but is NOT a candidate (never verified)", () => {
    const n = node("action", { skillId: "s", args: { [FRIDAY_FS_WRITE_TARGET_ARG_KEY]: "out/x.json" } });
    expect(classifyWorkflowNodeSideEffect(n, writeSkill(["send"]))).toBe("side_effect");
    expect(resolveFilesystemWriteTarget(n, writeSkill(["send"]))).toBeNull();
  });
});
