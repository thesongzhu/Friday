// ─── Skill Node Adapter Types ───

export interface FridayWorkflowSkillActionExecutionInput {
  runId: string;
  nodeId: string;
  skillId: string;
  inputData: Record<string, unknown>;
}

export interface FridayWorkflowSkillActionExecutionOutput {
  output: Record<string, unknown>;
}

export interface FridayWorkflowSkillNodeAdapter {
  /** Asserts that a skill is invocable in workflow context (has 'workflow' invocation mode). */
  assertWorkflowInvocable(skillId: string): void;

  /** Execute a skill within a workflow node. */
  execute(
    input: FridayWorkflowSkillActionExecutionInput,
  ): Promise<FridayWorkflowSkillActionExecutionOutput>;

  /** List all skills that support workflow invocation mode. */
  listWorkflowInvocableSkills(): Array<{
    skillId: string;
    name: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
  }>;
}

export interface CreateFridayWorkflowSkillNodeAdapterDeps {
  resolveSkill: (
    skillId: string,
  ) => { manifest: { invocation: { modes: string[] }; name: string; id: string; inputs?: unknown[]; outputs?: unknown[] } } | null;
  invokeSkill: (
    skillId: string,
    runId: string,
    nodeId: string,
    payload: Record<string, unknown>,
  ) => Promise<unknown>;
  listSkills?: () => Array<{
    manifest: { invocation: { modes: string[] }; name: string; id: string; inputs?: unknown[]; outputs?: unknown[] };
  }>;
}
