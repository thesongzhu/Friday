import type { FridayAgentRunRecord } from "../../agent/model/friday-agent.types.js";

export interface FridayCustomPackInput {
  name: string;
  nameEn: string;
  description: string;
  descriptionEn: string;
  skillIds: string[];
  entryPrompts: string[];
}

export interface FridayResolvedCustomPack {
  index: number;
  packId: string;
  input: FridayCustomPackInput;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isFridayCustomPackInput(value: unknown): value is FridayCustomPackInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.name === "string"
    && typeof record.nameEn === "string"
    && typeof record.description === "string"
    && typeof record.descriptionEn === "string"
    && isStringArray(record.skillIds)
    && isStringArray(record.entryPrompts);
}

function clampInlineText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

const CUSTOM_PACK_INTERNAL_LINE_PATTERNS = [
  /(?:任务包\s*id|pack(?:\s|_)?id)\s*[:：=]/iu,
  /\b(?:run(?:\s|_)?id|session(?:\s|_)?id|session(?:\s|_)?key)\b/iu,
  /\b(?:readOnly|readonly)\b/iu,
  /\b(?:skills_list|memory_search|agents_list)\b/iu,
  /\b(?:sub-agent|subagent|tool call)\b/iu,
];

const UUID_INLINE_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const UUID_GLOBAL_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

function sanitizeCustomPackPromptText(value: string): string {
  const filteredLines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !CUSTOM_PACK_INTERNAL_LINE_PATTERNS.some((pattern) => pattern.test(line)))
    .filter((line) => !(UUID_INLINE_RE.test(line) && /\b(?:run|session|pack|id|任务)\b/iu.test(line)));

  return filteredLines.join("\n")
    .replace(/(?:任务包\s*id|pack(?:\s|_)?id)\s*[:：=]\s*[^\s,，;；)]+/giu, "")
    .replace(/(?:run(?:\s|_)?id|session(?:\s|_)?id|session(?:\s|_)?key)\s*[:：=]\s*[^\s,，;；)]+/giu, "")
    .replace(/\b(?:readOnly|readonly)\b\s*(?:[:=]\s*(?:true|false))?/giu, "")
    .replace(/\b(?:skills_list|memory_search|agents_list|sub-agent|subagent|tool call)\b/giu, "")
    .replace(UUID_GLOBAL_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizeSummary(run: FridayAgentRunRecord): string {
  const value = run.summary ?? run.responseText ?? run.errorMessage ?? run.task;
  const sanitized = sanitizeCustomPackPromptText(value);
  return clampInlineText(sanitized || `${run.status} live run recorded.`, 180);
}

export function buildFridayCustomPackId(
  input: Pick<FridayCustomPackInput, "name">,
  index: number,
): string {
  return `custom-${index}-${input.name.replace(/\s+/g, "-").toLowerCase()}`;
}

export function normalizeFridayCustomPackInputs(value: unknown): FridayCustomPackInput[] {
  return Array.isArray(value) ? value.filter(isFridayCustomPackInput) : [];
}

export function findFridayCustomPackById(
  value: unknown,
  packId: string,
): FridayResolvedCustomPack | null {
  const inputs = normalizeFridayCustomPackInputs(value);
  for (const [index, input] of inputs.entries()) {
    if (buildFridayCustomPackId(input, index) === packId) {
      return {
        index,
        packId,
        input,
      };
    }
  }
  return null;
}

export function buildFridayCustomPackPromptFragment(params: {
  packId: string;
  pack: FridayResolvedCustomPack;
  recentRuns?: FridayAgentRunRecord[];
}): string {
  const { input } = params.pack;
  const description = input.description.trim() || input.descriptionEn.trim() || "No description provided.";
  const entryPrompts = input.entryPrompts
    .map((prompt) => clampInlineText(prompt, 220))
    .filter((prompt) => prompt.length > 0)
    .slice(0, 4);
  const skillIds = input.skillIds
    .map((skillId) => skillId.trim())
    .filter((skillId) => skillId.length > 0)
    .slice(0, 8);
  const recentRuns = (params.recentRuns ?? []).slice(0, 3);

  const lines = [
    "<active-custom-pack>",
    "Use this stored custom-pack brief as the authoritative source for the current run.",
    `Stored pack name: ${input.name.trim() || input.nameEn.trim() || "Untitled custom pack"}`,
    `Stored pack brief: ${clampInlineText(description, 320)}`,
  ];

  if (skillIds.length > 0) {
    lines.push("Preferred skills from the stored brief:");
    for (const skillId of skillIds) {
      lines.push(`- ${skillId}`);
    }
  }

  if (entryPrompts.length > 0) {
    lines.push("User-defined launch prompts for this pack:");
    for (const prompt of entryPrompts) {
      lines.push(`- ${prompt}`);
    }
  }

  if (recentRuns.length > 0) {
    lines.push("Recent live runs for this pack:");
    for (const run of recentRuns) {
      const timestamp = run.completedAt ?? run.startedAt ?? run.createdAt;
      lines.push(`- [${run.status}] ${timestamp}: ${normalizeSummary(run)}`);
    }
  }

  lines.push(
    "When you reason about this pack, rely on this stored brief and these recent live runs even if other registries do not contain a matching template.",
    "This is a real user-created task definition with persisted data behind it.",
    "For the user-facing answer, refer to the stored brief and the recent run evidence, not internal runtime identifiers, storage keys, tool names, or debugging flags.",
    "If the pack is underspecified, ask only the minimum blocking question. Otherwise continue from the stored brief and recent live evidence.",
    "</active-custom-pack>",
  );

  return lines.join("\n");
}
