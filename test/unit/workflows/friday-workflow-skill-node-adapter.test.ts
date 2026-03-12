import { describe, it, expect, vi } from "vitest";
import { createFridayWorkflowSkillNodeAdapter } from "#workflows";

describe("FridayWorkflowSkillNodeAdapter", () => {
  function createMockSkill(modes: string[]) {
    return {
      manifest: {
        id: "test-skill",
        name: "Test Skill",
        invocation: { modes },
        inputs: [{ key: "text", type: "string" }],
        outputs: [{ key: "result", type: "string" }],
      },
    };
  }

  function createAdapter(
    skills: Map<string, ReturnType<typeof createMockSkill>>,
    invokeResult: unknown = { result: "ok" },
  ) {
    return createFridayWorkflowSkillNodeAdapter({
      resolveSkill: (id) => skills.get(id) ?? null,
      invokeSkill: vi.fn().mockResolvedValue(invokeResult),
      listSkills: () => Array.from(skills.values()),
    });
  }

  // ─── assertWorkflowInvocable checks invocation mode ───

  it("accepts skill with 'workflow' invocation mode", () => {
    const skills = new Map([["s1", createMockSkill(["workflow"])]]);
    const adapter = createAdapter(skills);
    expect(() => adapter.assertWorkflowInvocable("s1")).not.toThrow();
  });

  it("accepts skill with multiple modes including 'workflow'", () => {
    const skills = new Map([["s1", createMockSkill(["intent", "workflow"])]]);
    const adapter = createAdapter(skills);
    expect(() => adapter.assertWorkflowInvocable("s1")).not.toThrow();
  });

  it("rejects skill with only 'intent' mode (no 'workflow')", () => {
    const skills = new Map([["s1", createMockSkill(["intent"])]]);
    const adapter = createAdapter(skills);
    expect(() => adapter.assertWorkflowInvocable("s1")).toThrow(
      "does not support workflow invocation mode",
    );
  });

  it("rejects when skill is not found", () => {
    const adapter = createAdapter(new Map());
    expect(() => adapter.assertWorkflowInvocable("missing")).toThrow(
      "not found",
    );
  });

  // ─── Does NOT check manifest.kind ───

  it("does not check manifest.kind — only invocation.modes", () => {
    // Skill with kind: "conversation" but workflow mode should pass
    const skill = createMockSkill(["workflow"]);
    (skill.manifest as Record<string, unknown>).kind = "conversation";
    const skills = new Map([["s1", skill]]);
    const adapter = createAdapter(skills);
    expect(() => adapter.assertWorkflowInvocable("s1")).not.toThrow();
  });

  // ─── execute validates before invoking ───

  it("execute throws for non-workflow skill", async () => {
    const skills = new Map([["s1", createMockSkill(["intent"])]]);
    const adapter = createAdapter(skills);
    await expect(
      adapter.execute({ runId: "r1", nodeId: "n1", skillId: "s1", inputData: {} }),
    ).rejects.toThrow("does not support workflow invocation mode");
  });

  it("execute returns output for workflow-invocable skill", async () => {
    const skills = new Map([["s1", createMockSkill(["workflow"])]]);
    const adapter = createAdapter(skills, { result: "done" });
    const result = await adapter.execute({
      runId: "r1",
      nodeId: "n1",
      skillId: "s1",
      inputData: { text: "hello" },
    });
    expect(result.output).toEqual({ result: "done" });
  });

  // ─── listWorkflowInvocableSkills ───

  it("lists only workflow-invocable skills", () => {
    const skills = new Map([
      ["s1", createMockSkill(["workflow"])],
      ["s2", createMockSkill(["intent"])],
      ["s3", createMockSkill(["intent", "workflow"])],
    ]);
    const adapter = createAdapter(skills);
    const list = adapter.listWorkflowInvocableSkills();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.skillId)).toEqual(
      expect.arrayContaining(["test-skill", "test-skill"]),
    );
  });
});
