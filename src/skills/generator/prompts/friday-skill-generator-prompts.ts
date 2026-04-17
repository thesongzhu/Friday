import type { SkillDesignPattern, SkillManifestV2, SkillRuntimeKind } from "#skills";

import type { FridaySkillGenerationTurn } from "../model/friday-skill-generator.types.js";
import type { FridaySkillGenerationContract } from "../services/friday-skill-generator-contract.js";

// ─── Prompt output shape ───

export interface FridaySkillGeneratorPrompt {
  system: string;
  user: string;
}

// ─── Design Pattern Scaffolding ───

/**
 * Maps a detected design pattern to SKILL.md structural guidance.
 * Used by the requirements and code prompts to scaffold the right structure.
 */
const DESIGN_PATTERN_GUIDANCE: Record<SkillDesignPattern, string> = {
  "tool-wrapper": `Design Pattern: TOOL WRAPPER
Structure: Instructions reference conventions/docs in references/ directory. No templates, no scripts.
- SKILL.md says WHEN to load WHAT rules from references/.
- references/ holds detailed library/framework documentation.
- Agent loads references on-demand (progressive loading).
Example: A FastAPI skill that loads references/fastapi-conventions.md only when writing route handlers.`,

  "generator": `Design Pattern: GENERATOR
Structure: Produces structured output by filling a reusable template from assets/.
- assets/ holds the output template (e.g., assets/report-template.md).
- references/ holds quality rules / style guide.
- SKILL.md instructions orchestrate the fill-in-the-blank process.
Example: An incident brief skill that fills assets/incident-brief-template.md from collected evidence.`,

  "reviewer": `Design Pattern: REVIEWER
Structure: Evaluates code/content against a checklist, grouped by severity.
- references/ holds review-checklist.md (what to check).
- SKILL.md instructions define the review protocol (how to check).
- Swap the checklist file to get a completely different review.
- Output findings grouped by severity (critical > high > medium > low).
Example: A code review skill using references/review-checklist.md with severity-based output.`,

  "inversion": `Design Pattern: INVERSION
Structure: The skill interviews the user before acting.
- Define interview phases (understand goal, scope boundaries, define success).
- Include a hard gate: "DO NOT start building until all phases are complete."
- Prevents the agent from generating detailed output based on assumptions.
Example: A project planner that asks 5 structured questions before producing a plan.`,

  "pipeline": `Design Pattern: PIPELINE
Structure: Sequential steps with explicit gate conditions between them.
- Number each step clearly (Step 1, Step 2, ...).
- Include gates: "Do NOT proceed to Step N until the user confirms Step N-1."
- The most complex pattern but prevents agents from skipping validation.
- Can include Reviewer steps or Generator steps within the pipeline.
Example: An API doc pipeline: gather endpoints → generate docs → review → user confirms → publish.`,
};

/**
 * Detects which design pattern best matches a user's goal description.
 */
export function detectDesignPatternFromGoal(goal: string): SkillDesignPattern | null {
  const lower = goal.toLowerCase();

  // Reviewer signals
  if (
    lower.includes("review") || lower.includes("audit") || lower.includes("check") ||
    lower.includes("evaluate") || lower.includes("assess") || lower.includes("lint")
  ) {
    return "reviewer";
  }

  // Generator signals
  if (
    lower.includes("generate") || lower.includes("report") || lower.includes("template") ||
    lower.includes("brief") || lower.includes("document") || lower.includes("summary")
  ) {
    return "generator";
  }

  // Pipeline signals
  if (
    lower.includes("pipeline") || lower.includes("multi-step") || lower.includes("workflow") ||
    lower.includes("approval") || lower.includes("sequential")
  ) {
    return "pipeline";
  }

  // Inversion signals
  if (
    lower.includes("clarify") || lower.includes("interview") || lower.includes("gather requirements") ||
    lower.includes("scope") || lower.includes("ask first") || lower.includes("collect information")
  ) {
    return "inversion";
  }

  // Tool Wrapper signals
  if (
    lower.includes("best practices") || lower.includes("conventions") || lower.includes("wrapper") ||
    lower.includes("expert on") || lower.includes("library")
  ) {
    return "tool-wrapper";
  }

  return null;
}

/**
 * Returns the scaffolding guidance for a design pattern.
 */
export function getDesignPatternGuidance(pattern: SkillDesignPattern): string {
  return DESIGN_PATTERN_GUIDANCE[pattern];
}

// ─── Prompt A: Requirements / Clarification ───

export function buildRequirementsPrompt(
  goal: string,
  specSummary: string,
  openQuestions: string[],
  recentTurns: FridaySkillGenerationTurn[],
): FridaySkillGeneratorPrompt {
  const turnBlock = recentTurns
    .map((t) => `[${t.role}]: ${t.content}`)
    .join("\n");

  const questionsBlock =
    openQuestions.length > 0
      ? `\nOpen questions:\n${openQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`
      : "";

  const specBlock = specSummary
    ? `\nCurrent spec summary:\n${specSummary}`
    : "";

  // Detect design pattern from the goal
  const detectedPattern = detectDesignPatternFromGoal(goal);
  const patternBlock = detectedPattern
    ? `\n\n${getDesignPatternGuidance(detectedPattern)}\n\nUse this pattern to guide the skill structure. Include "designPattern": "${detectedPattern}" in the spec.`
    : "";

  const system = `You are an AI skill requirements analyzer for the Friday automation platform.

Your job is to extract a complete skill specification from the user's request.

Rules:
1. Extract task goal, inputs, outputs, triggers, external dependencies, and security-sensitive actions.
2. Ask only missing, blocking questions (max 3 per turn).
3. Return strict JSON only — no markdown, no explanation outside JSON.
4. Prefer deterministic automation over open-ended agent behavior.
5. If all required fields are resolved, set state to "ready_for_generation".
6. If critical information is missing, set state to "needs_clarification".
7. Detect which design pattern best fits the skill (tool-wrapper, generator, reviewer, inversion, pipeline) and include it in the spec.
8. If the user names an exact manifest id, exact version, or exact output marker/text, preserve that in successTests and constraints so later stages can enforce it.${patternBlock}

Response format (JSON only):
{
  "state": "needs_clarification" | "ready_for_generation",
  "questions": ["..."],
  "spec": {
    "goal": "string",
    "designPattern": "tool-wrapper" | "generator" | "reviewer" | "inversion" | "pipeline" | null,
    "successTests": ["string"],
    "constraints": ["string"],
    "inputs": [{ "key": "string", "type": "string", "required": true, "label": "string" }],
    "outputs": [{ "key": "string", "type": "string", "description": "string" }],
    "triggers": { "intents": [], "phrases": [] },
    "runtimeKind": "shell" | "node",
    "securityNotes": [],
    "externalDependencies": []
  }
}`;

  const user = `User goal: ${goal}${specBlock}${questionsBlock}${turnBlock ? `\n\nConversation:\n${turnBlock}` : ""}`;

  return { system, user };
}

// ─── Prompt B: Manifest Generator ───

export function buildManifestPrompt(
  spec: Record<string, unknown>,
  contract?: FridaySkillGenerationContract,
): FridaySkillGeneratorPrompt {
  const contractLines = [
    contract?.expectedSkillId ? `- manifest.id must be exactly "${contract.expectedSkillId}"` : null,
    contract?.expectedVersion ? `- manifest.version must be exactly "${contract.expectedVersion}"` : null,
    contract?.preserveExistingSkillId
      ? "- This is an in-place update. Preserve the existing skill id and do not invent a replacement id."
      : null,
  ].filter((line): line is string => Boolean(line));
  const contractSection = contractLines.length > 0
    ? `\n\nHard contract:\n<contract>\n${contractLines.join("\n")}\n</contract>`
    : "";
  const system = `You are a manifest generator for the Friday automation platform.

You generate valid SkillManifestV2 JSON for a skill based on the provided specification.

Rules:
1. Output strict SkillManifestV2 JSON only — no markdown, no explanation.
2. Required fields you MUST provide: schemaVersion ("2.0"), id, name, description, version, kind, category, author ({name}), runtime ({kind, entrypoint, minHubVersion, apiVersion: "1", timeoutMsDefault}), inputs, outputs, executionTargets ({allowedSatelliteTypes, requiredCapabilities}).
3. Optional fields with defaults (omit if unsure): tags, triggers, invocation, requirements, permissions, schemas, flow, ui, telemetry, distribution.
4. kind: "conversation" | "workflow" | "system"
5. category: "automation" | "communication" | "filesystem" | "browser" | "media" | "ai" | "integration" | "utility"
6. runtime.kind: "node" | "shell" (use "node" for most skills)
7. runtime.entrypoint: "index.mjs" (node) or "run.sh" (shell)
8. runtime.apiVersion must be "1" (string, not number)
9. schemaVersion must be "2.0" (string)
10. Do NOT add any keys not in the schema. All objects use strict validation — extra keys will cause rejection.
11. Minimize permissions (principle of least privilege).
12. Defaults will be applied for omitted optional fields, so only provide fields you are confident about.
13. If the spec includes a designPattern, set "designPatterns": ["<pattern>"] in the manifest. Valid values: "tool-wrapper", "generator", "reviewer", "inversion", "pipeline". A skill may combine multiple patterns.
14. When a <contract> block is present, every contract line is mandatory and must be satisfied exactly.`;

  // Extract repair context if present so it doesn't pollute the spec JSON
  const { _repairContext, ...cleanSpec } = spec as Record<string, unknown> & {
    _repairContext?: { errors: string; attempt: number };
  };

  let userContent = `Generate a SkillManifestV2 for this specification:\n${JSON.stringify(cleanSpec, null, 2)}${contractSection}`;

  if (_repairContext) {
    userContent += `\n\nPrevious errors (attempt ${String(_repairContext.attempt)}):\n${_repairContext.errors}\n\nFix these errors. Output only valid JSON.`;
  }

  return { system, user: userContent };
}

// ─── Prompt C: Code Generator ───

export function buildCodePrompt(
  manifest: SkillManifestV2,
  runtimeKind: SkillRuntimeKind,
  contract?: FridaySkillGenerationContract,
): FridaySkillGeneratorPrompt {
  // Build design-pattern-specific file guidance
  const patterns = manifest.designPatterns ?? [];
  const patternFileHints = patterns
    .map((p) => {
      switch (p) {
        case "reviewer":
          return "- Include a references/review-checklist.md with severity-grouped checklist items.\n- SKILL.md should reference the checklist and define a review protocol.";
        case "generator":
          return "- Include an assets/ directory with an output template file.\n- SKILL.md should define a generation protocol that fills the template.";
        case "inversion":
          return '- SKILL.md should define interview phases and a hard gate: "DO NOT start building until all phases are complete."';
        case "pipeline":
          return '- SKILL.md should define numbered steps with explicit gates: "Do NOT proceed to Step N until confirmed."';
        case "tool-wrapper":
          return "- Include a references/ directory with convention/best-practice docs.\n- SKILL.md should say when to load which reference files.";
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join("\n");

  const patternSection = patternFileHints
    ? `\n\nDesign pattern files to generate:\n${patternFileHints}`
    : "";
  const contractLines = [
    contract?.expectedSkillId ? `- Keep manifest.id exactly "${contract.expectedSkillId}"` : null,
    contract?.expectedVersion ? `- Keep manifest.version exactly "${contract.expectedVersion}"` : null,
    contract?.preserveExistingSkillId
      ? "- This is an update to an existing skill. Do not rename the skill id."
      : null,
    ...(contract?.requiredOutputMarkers ?? []).map((marker) =>
      `- At runtime, the skill must emit the exact marker "${marker}" with identical spelling and punctuation.`,
    ),
  ].filter((line): line is string => Boolean(line));
  const contractSection = contractLines.length > 0
    ? `\n\nExecution contract:\n<contract>\n${contractLines.join("\n")}\n</contract>`
    : "";

  const system = `You are a code generator for the Friday automation platform.

You generate executable code files for a skill based on the provided manifest.

Rules:
1. Output a JSON array of file objects only — no markdown, no explanation outside JSON.
2. Each file object: { "path": "string", "content": "string", "language": "string", "executable": boolean }.
3. Conform to Friday executor contracts:
   - Node: export an async function execute(input, ctx?) that returns an object matching manifest outputs.
   - Shell: read JSON from stdin, write JSON to stdout.
4. No privileged actions without matching manifest permissions.
5. If AI is needed inside runtime, use the provided runtime context helper via ctx.ai.infer(prompt, optionalModel).
   - Do NOT import any runtime helper packages.
   - Do NOT reference packages like "friday-runtime-context".
   - Do NOT call invented helpers like ctx.ai.complete(...).
6. Favor small, readable code and explicit error handling.
7. Do not use TypeScript in generated files — output JavaScript (.mjs) or Bash (.sh) only.
8. For Node runtime, the entrypoint must be "index.mjs".
9. For Shell runtime, the entrypoint must be "run.sh" with proper shebang (#!/usr/bin/env bash).
10. Generate a SKILL.md file that follows the skill's design pattern structure.
11. When a <contract> block is present, treat it as mandatory. Exact markers must appear exactly in the runtime output, not approximations or paraphrases.${patternSection}

Language values: "javascript", "bash", "json", "markdown".

Response: JSON array of file objects only.`;

  const user = `Generate code files for this manifest (runtime: ${runtimeKind}):\n${JSON.stringify(manifest, null, 2)}${contractSection}`;

  return { system, user };
}

// ─── Prompt D: UI Generator ───

export function buildUiPrompt(
  manifest: SkillManifestV2,
): FridaySkillGeneratorPrompt {
  const system = `You are a UI schema generator for the Friday automation platform.

You generate a FridaySkillUiSchemaV1 JSON object to render a form-based UI for a skill.

Rules:
1. Output valid FridaySkillUiSchemaV1 JSON only — no markdown, no explanation outside JSON.
2. Every UI input field's inputKey must map to a key in manifest.inputs.
3. Every UI output binding's outputKey must map to a key in manifest.outputs.
4. Keep v1 layout simple: form sections + run action + output renderers.
5. Set schemaVersion to "1.0".
6. Include at least one section grouping the input fields.
7. Include a "run" action with style "primary" and a "reset" action with style "secondary".
8. Choose appropriate field kinds based on input types:
   - string → "text" or "textarea" (use textarea for longer content)
   - number → "number"
   - boolean → "toggle"
   - object/array → "json"
   - file → "file"
9. Choose appropriate output widgets based on output types:
   - string → "text"
   - object → "json" or "keyValue"
   - array → "table" or "json"
   - number/boolean → "text"

Response format: FridaySkillUiSchemaV1 JSON only.`;

  const user = `Generate a UI schema for this manifest:\n${JSON.stringify(manifest, null, 2)}`;

  return { system, user };
}
