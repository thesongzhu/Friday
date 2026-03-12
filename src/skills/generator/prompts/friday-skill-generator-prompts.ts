import type { SkillManifestV2, SkillRuntimeKind } from "#skills";

import type { FridaySkillGenerationTurn } from "../model/friday-skill-generator.types.js";

// ─── Prompt output shape ───

export interface FridaySkillGeneratorPrompt {
  system: string;
  user: string;
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

  const system = `You are an AI skill requirements analyzer for the Friday automation platform.

Your job is to extract a complete skill specification from the user's request.

Rules:
1. Extract task goal, inputs, outputs, triggers, external dependencies, and security-sensitive actions.
2. Ask only missing, blocking questions (max 3 per turn).
3. Return strict JSON only — no markdown, no explanation outside JSON.
4. Prefer deterministic automation over open-ended agent behavior.
5. If all required fields are resolved, set state to "ready_for_generation".
6. If critical information is missing, set state to "needs_clarification".

Response format (JSON only):
{
  "state": "needs_clarification" | "ready_for_generation",
  "questions": ["..."],
  "spec": {
    "goal": "string",
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
): FridaySkillGeneratorPrompt {
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
12. Defaults will be applied for omitted optional fields, so only provide fields you are confident about.`;

  // Extract repair context if present so it doesn't pollute the spec JSON
  const { _repairContext, ...cleanSpec } = spec as Record<string, unknown> & {
    _repairContext?: { errors: string; attempt: number };
  };

  let userContent = `Generate a SkillManifestV2 for this specification:\n${JSON.stringify(cleanSpec, null, 2)}`;

  if (_repairContext) {
    userContent += `\n\nPrevious errors (attempt ${String(_repairContext.attempt)}):\n${_repairContext.errors}\n\nFix these errors. Output only valid JSON.`;
  }

  return { system, user: userContent };
}

// ─── Prompt C: Code Generator ───

export function buildCodePrompt(
  manifest: SkillManifestV2,
  runtimeKind: SkillRuntimeKind,
): FridaySkillGeneratorPrompt {
  const system = `You are a code generator for the Friday automation platform.

You generate executable code files for a skill based on the provided manifest.

Rules:
1. Output a JSON array of file objects only — no markdown, no explanation outside JSON.
2. Each file object: { "path": "string", "content": "string", "language": "string", "executable": boolean }.
3. Conform to Friday executor contracts:
   - Node: export an async function execute(input, ctx?) that returns an object matching manifest outputs.
   - Shell: read JSON from stdin, write JSON to stdout.
4. No privileged actions without matching manifest permissions.
5. If AI is needed inside runtime, use the provided runtime context helper (backed by BYOK provider service).
6. Favor small, readable code and explicit error handling.
7. Do not use TypeScript in generated files — output JavaScript (.mjs) or Bash (.sh) only.
8. For Node runtime, the entrypoint must be "index.mjs".
9. For Shell runtime, the entrypoint must be "run.sh" with proper shebang (#!/usr/bin/env bash).

Language values: "javascript", "bash", "json", "markdown".

Response: JSON array of file objects only.`;

  const user = `Generate code files for this manifest (runtime: ${runtimeKind}):\n${JSON.stringify(manifest, null, 2)}`;

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
