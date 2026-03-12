import { FridayDomainError } from "#errors";
import type {
  CreateFridayWorkflowSkillNodeAdapterDeps,
  FridayWorkflowSkillNodeAdapter,
} from "./friday-workflow-skill-node-adapter.types.js";

// ─── Factory ───

export function createFridayWorkflowSkillNodeAdapter(
  deps: CreateFridayWorkflowSkillNodeAdapterDeps,
): FridayWorkflowSkillNodeAdapter {
  return {
    assertWorkflowInvocable(skillId) {
      const skill = deps.resolveSkill(skillId);
      if (!skill) {
        throw new FridayDomainError(
          "WORKFLOW_SKILL_NOT_FOUND",
          `Skill '${skillId}' not found`,
          { httpStatus: 404 },
        );
      }

      const modes = skill.manifest.invocation.modes;
      if (!modes.includes("workflow")) {
        throw new FridayDomainError(
          "WORKFLOW_SKILL_NOT_INVOCABLE",
          `Skill '${skillId}' does not support workflow invocation mode (modes: ${modes.join(", ")})`,
          { httpStatus: 400 },
        );
      }
    },

    async execute(input) {
      this.assertWorkflowInvocable(input.skillId);

      const result = await deps.invokeSkill(
        input.skillId,
        input.runId,
        input.nodeId,
        input.inputData,
      );

      const output =
        result != null && typeof result === "object" && !Array.isArray(result)
          ? (result as Record<string, unknown>)
          : { value: result };

      return { output };
    },

    listWorkflowInvocableSkills() {
      if (!deps.listSkills) return [];

      return deps.listSkills()
        .filter((s) => s.manifest.invocation.modes.includes("workflow"))
        .map((s) => ({
          skillId: s.manifest.id,
          name: s.manifest.name,
          inputSchema: s.manifest.inputs,
          outputSchema: s.manifest.outputs,
        }));
    },
  };
}
