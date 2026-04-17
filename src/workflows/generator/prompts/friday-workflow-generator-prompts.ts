import type { FridayWorkflowSpecTestCase, FridayWorkflowSpecV1 } from "#workflows";
import type {
  FridayWorkflowGenerationMaintenanceTarget,
  FridayWorkflowGenerationRequirements,
  FridayWorkflowGenerationTurn,
  FridayWorkflowGeneratorSkillContext,
} from "../model/friday-workflow-generator.types.js";

// ─── Prompt output shape ───

export interface FridayWorkflowGeneratorPrompt {
  system: string;
  user: string;
}

// ─── Prompt A: Requirements Analysis ───

export function buildWorkflowRequirementsPrompt(
  goal: string,
  requirementsSummary: string,
  openQuestions: string[],
  availableSkills: FridayWorkflowGeneratorSkillContext[],
  recentTurns: FridayWorkflowGenerationTurn[],
  maintenanceTarget?: FridayWorkflowGenerationMaintenanceTarget,
): FridayWorkflowGeneratorPrompt {
  const turnBlock = recentTurns
    .map((t) => `[${t.role}]: ${t.content}`)
    .join("\n");

  const questionsBlock =
    openQuestions.length > 0
      ? openQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")
      : "(none)";

  const summaryBlock = requirementsSummary || "(empty)";
  const maintenanceBlock = maintenanceTarget
    ? `\n\nExisting workflow maintenance target:
- This is an in-place update to an existing workflow record.
- Existing workflow db id: ${maintenanceTarget.workflowId}
- Existing workflow slug: ${maintenanceTarget.slug}
- Existing workflow name: ${maintenanceTarget.currentName}
- Existing published version: ${maintenanceTarget.publishedVersionNumber ?? "(unknown)"}
- Existing workflow spec id: ${maintenanceTarget.currentSpecWorkflowId ?? "(unknown)"}
- Existing workflow description: ${maintenanceTarget.currentDescription ?? "(none)"}
- Existing published spec snapshot:
${maintenanceTarget.publishedSpec ? JSON.stringify(maintenanceTarget.publishedSpec, null, 2) : "(unavailable)"}`
    : "";

  const skillsJson = JSON.stringify(
    availableSkills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      inputs: s.inputs,
      outputs: s.outputs,
    })),
    null,
    2,
  );

  const system = `You are an AI workflow requirements analyzer for Friday.

Goal:
Extract complete requirements for generating a FridayWorkflowSpecV1.

Rules:
1. Ask only blocking clarification questions (max 3).
2. Do not invent skill IDs; use only provided available skills.
3. If information is complete, set state="ready_for_generation".
4. If critical data is missing, set state="needs_clarification".
5. When an existing workflow maintenance target is provided, treat the current workflow as the base state and focus on the requested change rather than rebuilding requirements from scratch.
6. Return strict JSON only.

Response JSON:
{
  "state": "needs_clarification" | "ready_for_generation",
  "questions": ["..."],
  "requirements": {
    "goal": "string",
    "trigger": { "type": "manual" | "schedule" | "event", "cron?": "string", "timezone?": "string", "source?": "string", "event?": "string" },
    "inputs": [{ "key": "string", "type": "string|number|boolean|object|array", "required": true, "defaultValue?": "unknown" }],
    "plannedSteps": [{
      "id": "string (must start with a letter and only use letters, numbers, underscores, or hyphens)",
      "intent": "string",
      "nodeTypeHint": "action|condition|data|ai|approval",
      "preferredSkillId?": "string",
      "condition?": "string"
    }],
    "outputs": [{ "key": "string", "fromStep": "string", "path": "string" }],
    "errorPolicy": { "onFailure": "fail_fast|continue_on_error|fallback_step|compensate|pause_for_approval", "notifyUser": true, "fallbackStepId?": "string", "compensationWorkflowId?": "string" },
    "assumptions": ["string"],
    "testScenarios": [{ "name": "string", "description?": "string" }]
  }
}`;

  const user = `User goal:
${goal}

Current requirements summary (JSON string; may be empty):
${summaryBlock}

Open questions:
${questionsBlock}

Available skills (id, name, description, IO):
${skillsJson}

Recent conversation:
${turnBlock}${maintenanceBlock}`;

  return { system, user };
}

// ─── Prompt B: Spec Generation ───

export function buildWorkflowSpecPrompt(
  requirements: FridayWorkflowGenerationRequirements,
  availableSkills: FridayWorkflowGeneratorSkillContext[],
  repairContext?: { errors: string; attempt: number },
  maintenanceTarget?: FridayWorkflowGenerationMaintenanceTarget,
): FridayWorkflowGeneratorPrompt {
  const requirementsJson = JSON.stringify(requirements, null, 2);

  const skillsJson = JSON.stringify(
    availableSkills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      inputs: s.inputs,
      outputs: s.outputs,
    })),
    null,
    2,
  );

  const repairBlock = repairContext
    ? `\n\nPrevious attempt (${repairContext.attempt}) had errors:\n${repairContext.errors}\nFix these issues.`
    : "";
  const maintenanceRuleBlock = maintenanceTarget
    ? `\n13. This is an in-place update to workflow db id "${maintenanceTarget.workflowId}".\n14. Preserve workflowId exactly as "${maintenanceTarget.currentSpecWorkflowId ?? maintenanceTarget.slug}".\n15. Use the existing workflow snapshot as the baseline and only adapt it to satisfy the updated request.`
    : "";
  const maintenanceUserBlock = maintenanceTarget
    ? `\n\nExisting workflow target:
${JSON.stringify({
  workflowId: maintenanceTarget.workflowId,
  slug: maintenanceTarget.slug,
  currentName: maintenanceTarget.currentName,
  currentDescription: maintenanceTarget.currentDescription,
  publishedVersionNumber: maintenanceTarget.publishedVersionNumber,
  currentSpecWorkflowId: maintenanceTarget.currentSpecWorkflowId,
  publishedSpec: maintenanceTarget.publishedSpec,
}, null, 2)}`
    : "";

  const system = `You generate a valid FridayWorkflowSpecV1 JSON object.

Rules:
1. Output strict JSON only.
2. schemaVersion must be "1.0".
3. workflowId must be slug-safe lowercase (letters, numbers, hyphens).
3a. Every step id and startStepId must start with a letter and use only letters, numbers, underscores, or hyphens.
4. startStepId must exist in steps.
5. Allowed step types: "skill_call" | "tool_call" | "condition" | "transform" | "human_approval".
6. For skill_call/tool_call, ref must be one of available skill IDs.
7. Allowed edge.when: "success" | "failure" | "true" | "false".
8. Conditions must use Friday expression syntax:
   - references: $inputs.<key>, $steps.<stepId>.output.<key>
   - operators: == != > < >= <= && || !
9. outputs[].fromStep must reference an existing step.
10. tests must be [] (generated separately in next stage).
11. Keep graph acyclic and connected from startStepId.
12. Return a complete FridayWorkflowSpecV1 object only.${maintenanceRuleBlock}

Target shape:
{
  "schemaVersion": "1.0",
  "workflowId": "string",
  "name": "string",
  "description": "string",
  "startStepId": "string",
  "trigger": { ... },
  "inputs": [...],
  "steps": [...],
  "edges": [...],
  "outputs": [...],
  "errorPolicy": { ... },
  "tests": []
}

Example output (simple action workflow):
{
  "schemaVersion": "1.0",
  "workflowId": "template-simple-action",
  "name": "Simple Action",
  "description": "A workflow with a single action step",
  "startStepId": "action-1",
  "trigger": { "type": "manual" },
  "inputs": [{ "key": "input_data", "type": "string", "required": true }],
  "steps": [{ "id": "action-1", "type": "skill_call", "ref": "example-skill", "args": { "data": "$inputs.input_data" } }],
  "edges": [],
  "outputs": [{ "key": "result", "fromStep": "action-1", "path": "result" }],
  "errorPolicy": { "onFailure": "fail_fast", "notifyUser": true },
  "tests": []
}`;

  const user = `Requirements:
${requirementsJson}

Available skills:
${skillsJson}${maintenanceUserBlock}${repairBlock}`;

  return { system, user };
}

// ─── Prompt C: Visual Layout ───

export function buildWorkflowVisualLayoutPrompt(
  spec: FridayWorkflowSpecV1,
): FridayWorkflowGeneratorPrompt {
  const specJson = JSON.stringify(spec, null, 2);

  const system = `You generate a valid FridayWorkflowVisualGraphV1 JSON object for the given spec.

Rules:
1. Output strict JSON only.
2. schemaVersion must be "1.0".
3. workflowId must equal spec.workflowId.
4. nodes must include "__trigger__" and every spec step id exactly once.
5. x/y must be finite numbers.
6. Use readable layout: left-to-right flow, branch paths separated vertically.
7. viewport = { x: 0, y: 0, zoom: 1 }.
8. panelLayout = { leftOpen: true, rightOpen: false, bottomOpen: false }.
9. edges entries should map spec edges with edgeKey:
   "\${from}:\${to}:\${when ?? 'any'}".
10. Return FridayWorkflowVisualGraphV1 JSON only.`;

  const user = `Generate visual layout for this workflow spec:
${specJson}`;

  return { system, user };
}

// ─── Prompt D: Test Case Generation ───

export function buildWorkflowTestsPrompt(
  spec: FridayWorkflowSpecV1,
): FridayWorkflowGeneratorPrompt {
  const specJson = JSON.stringify(spec, null, 2);

  const system = `You generate workflow test cases for FridayWorkflowSpecV1.

Rules:
1. Output strict JSON only: FridayWorkflowSpecTestCase[].
2. Generate 2-4 meaningful test cases.
3. Use only known input keys, step IDs, and output keys from the spec.
4. Each test requires:
   - name
   - inputs
   - assertions (at least 1)
5. Optional mocks must reference valid step IDs.
6. Allowed operators: "==" | "!=" | ">" | "<" | "contains" | "matches".
7. Assertion path should target execution context:
   - "inputs.<key>"
   - "steps.<stepId>.output.<key>"
   - "outputs.<key>"
8. Include branch coverage for condition steps when present.
9. Include at least one failure-path test when edges include "failure".
10. Return JSON array only.

Example output:
[
  {
    "name": "basic test",
    "inputs": { "input_data": "test" },
    "mocks": { "action-1": { "output": { "result": "ok" } } },
    "assertions": [{ "path": "steps.action-1.output.result", "operator": "==", "expected": "ok" }]
  }
]`;

  const user = `Generate tests for this workflow spec:
${specJson}`;

  return { system, user };
}
