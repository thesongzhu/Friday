import type { FridayAgentToolDefinition } from "../model/friday-agent.types.js";

export interface ParsedTextToolCall {
  name: string;
  input: Record<string, unknown>;
  id?: string;
}

export function recoverToolCallsFromAssistantText(
  assistantText: string,
  tools: FridayAgentToolDefinition[],
): ParsedTextToolCall[] {
  const validToolNames = new Set(tools.map((t) => t.name));
  if (validToolNames.size === 0) return [];

  const normalized = assistantText.trim();
  if (normalized.length === 0) return [];

  const candidates = new Set<string>([normalized]);
  const fenced = unwrapJsonCodeFence(normalized);
  if (fenced) candidates.add(fenced);
  for (const block of extractJsonCodeBlocks(normalized)) {
    candidates.add(block);
  }

  for (const candidate of candidates) {
    if (!looksLikeJson(candidate)) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (err) {
      console.warn("[friday][agent-runtime] parse-tool-call-json:", err instanceof Error ? err.message : String(err));
      continue;
    }

    if (Array.isArray(parsed)) {
      const calls = parsed
        .map((item) => parseTextToolCall(item, validToolNames))
        .filter((item): item is ParsedTextToolCall => item !== null);
      if (calls.length > 0) return calls;
      continue;
    }

    const single = parseTextToolCall(parsed, validToolNames);
    if (single) return [single];
  }

  return [];
}

function parseTextToolCall(
  value: unknown,
  validToolNames: Set<string>,
): ParsedTextToolCall | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (!name || !validToolNames.has(name)) return null;

  const rawArgs =
    obj.arguments ?? obj.args ?? obj.input;
  const args = normalizeToolCallArgs(rawArgs);
  if (!args) return null;

  const id = typeof obj.id === "string" && obj.id.trim().length > 0 ? obj.id.trim() : undefined;
  return { name, input: args, id };
}

function normalizeToolCallArgs(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return {};
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return {};
    if (!looksLikeJson(trimmed)) return { _raw: value };
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { _raw: value };
    } catch (err) {
      console.warn("[friday][agent-runtime] parse-tool-input:", err instanceof Error ? err.message : String(err));
      return { _raw: value };
    }
  }
  return null;
}

export function unwrapJsonCodeFence(value: string): string | null {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value);
  return match?.[1]?.trim() || null;
}

export function extractJsonCodeBlocks(value: string): string[] {
  const blocks: string[] = [];
  const regex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  for (const match of value.matchAll(regex)) {
    const content = match[1]?.trim();
    if (content) blocks.push(content);
  }
  return blocks;
}

export function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 2) return false;
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}
