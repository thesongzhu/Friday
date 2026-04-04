import { describe, it, expect } from "vitest";
import {
  recoverToolCallsFromAssistantText,
  looksLikeJson,
  unwrapJsonCodeFence,
  extractJsonCodeBlocks,
} from "#agent";
import type { FridayAgentToolDefinition } from "#agent";

const MOCK_TOOLS: FridayAgentToolDefinition[] = [
  { name: "web_search", description: "Search", inputSchema: { type: "object", properties: {} } },
  { name: "read", description: "Read file", inputSchema: { type: "object", properties: {} } },
] as unknown as FridayAgentToolDefinition[];

describe("looksLikeJson", () => {
  it("returns true for object-shaped strings", () => {
    expect(looksLikeJson('{"name":"web_search"}')).toBe(true);
  });

  it("returns true for array-shaped strings", () => {
    expect(looksLikeJson('[{"name":"web_search"}]')).toBe(true);
  });

  it("returns false for plain text", () => {
    expect(looksLikeJson("hello world")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(looksLikeJson("")).toBe(false);
  });

  it("returns false for single character", () => {
    expect(looksLikeJson("{")).toBe(false);
  });
});

describe("unwrapJsonCodeFence", () => {
  it("unwraps json code fence", () => {
    const input = '```json\n{"name":"web_search"}\n```';
    expect(unwrapJsonCodeFence(input)).toBe('{"name":"web_search"}');
  });

  it("unwraps plain code fence", () => {
    const input = '```\n{"name":"web_search"}\n```';
    expect(unwrapJsonCodeFence(input)).toBe('{"name":"web_search"}');
  });

  it("returns null for non-fenced text", () => {
    expect(unwrapJsonCodeFence('{"name":"web_search"}')).toBeNull();
  });

  it("returns null for empty fence", () => {
    expect(unwrapJsonCodeFence("```\n\n```")).toBeNull();
  });
});

describe("extractJsonCodeBlocks", () => {
  it("extracts multiple JSON blocks", () => {
    const input = 'Text\n```json\n{"a":1}\n```\nMore text\n```\n{"b":2}\n```';
    const blocks = extractJsonCodeBlocks(input);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe('{"a":1}');
    expect(blocks[1]).toBe('{"b":2}');
  });

  it("returns empty array for no blocks", () => {
    expect(extractJsonCodeBlocks("just text")).toEqual([]);
  });
});

describe("recoverToolCallsFromAssistantText", () => {
  it("recovers a single tool call from JSON", () => {
    const text = '{"name":"web_search","arguments":{"query":"test"}}';
    const calls = recoverToolCallsFromAssistantText(text, MOCK_TOOLS);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("web_search");
    expect(calls[0]!.input).toEqual({ query: "test" });
  });

  it("recovers tool call from code fence", () => {
    const text = '```json\n{"name":"read","arguments":{"path":"/tmp/file.txt"}}\n```';
    const calls = recoverToolCallsFromAssistantText(text, MOCK_TOOLS);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("read");
  });

  it("recovers array of tool calls", () => {
    const text = '[{"name":"web_search","arguments":{"query":"a"}},{"name":"read","arguments":{"path":"b"}}]';
    const calls = recoverToolCallsFromAssistantText(text, MOCK_TOOLS);
    expect(calls).toHaveLength(2);
  });

  it("ignores unknown tool names", () => {
    const text = '{"name":"unknown_tool","arguments":{}}';
    const calls = recoverToolCallsFromAssistantText(text, MOCK_TOOLS);
    expect(calls).toHaveLength(0);
  });

  it("returns empty for plain text", () => {
    const calls = recoverToolCallsFromAssistantText("I will search for that.", MOCK_TOOLS);
    expect(calls).toHaveLength(0);
  });

  it("returns empty for empty tools list", () => {
    const text = '{"name":"web_search","arguments":{}}';
    const calls = recoverToolCallsFromAssistantText(text, []);
    expect(calls).toHaveLength(0);
  });

  it("handles tool call with id", () => {
    const text = '{"name":"web_search","arguments":{},"id":"call_123"}';
    const calls = recoverToolCallsFromAssistantText(text, MOCK_TOOLS);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe("call_123");
  });

  it("handles string arguments", () => {
    const text = '{"name":"web_search","arguments":"{\\"query\\":\\"test\\"}"}';
    const calls = recoverToolCallsFromAssistantText(text, MOCK_TOOLS);
    expect(calls).toHaveLength(1);
  });
});
