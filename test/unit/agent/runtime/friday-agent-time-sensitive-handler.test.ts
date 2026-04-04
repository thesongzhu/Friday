import { describe, it, expect } from "vitest";
import {
  buildRunTimeContext,
  resolveAgentTimezone,
  normalizeIanaTimezone,
  readPreferredTimezone,
  formatDateInTimezone,
  hasTimeSensitiveNewsIntent,
  textHasTimeSensitiveNewsIntent,
  evaluateTimeSensitiveResponse,
  extractMessageText,
} from "#agent";
import type { FridayAgentMessage, FridayAgentToolCallRecord } from "#agent";

describe("normalizeIanaTimezone", () => {
  it("returns valid IANA timezone as-is", () => {
    expect(normalizeIanaTimezone("America/New_York")).toBe("America/New_York");
  });

  it("returns undefined for empty string", () => {
    expect(normalizeIanaTimezone("")).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(normalizeIanaTimezone(undefined)).toBeUndefined();
  });

  it("returns undefined for invalid timezone", () => {
    expect(normalizeIanaTimezone("Not/A/Timezone")).toBeUndefined();
  });

  it("accepts UTC", () => {
    expect(normalizeIanaTimezone("UTC")).toBe("UTC");
  });
});

describe("resolveAgentTimezone", () => {
  it("prefers requested timezone", () => {
    expect(resolveAgentTimezone("Asia/Shanghai", "America/New_York")).toBe("Asia/Shanghai");
  });

  it("falls back to preferred timezone", () => {
    expect(resolveAgentTimezone(undefined, "America/New_York")).toBe("America/New_York");
  });

  it("returns UTC as last resort", () => {
    expect(resolveAgentTimezone("Invalid/Zone", "Also/Invalid")).toBeDefined();
  });
});

describe("formatDateInTimezone", () => {
  it("formats date in YYYY-MM-DD", () => {
    const result = formatDateInTimezone("2025-06-15T12:00:00Z", "UTC");
    expect(result).toBe("2025-06-15");
  });

  it("handles timezone offset", () => {
    // Midnight UTC on Jan 1 is still Dec 31 in some western timezones
    const result = formatDateInTimezone("2025-01-01T00:30:00Z", "America/New_York");
    expect(result).toBe("2024-12-31");
  });
});

describe("buildRunTimeContext", () => {
  it("builds context with all fields", () => {
    const ctx = buildRunTimeContext("2025-06-15T12:00:00Z", "UTC", undefined);
    expect(ctx.nowIso).toBe("2025-06-15T12:00:00Z");
    expect(ctx.timezone).toBe("UTC");
    expect(ctx.localDate).toBe("2025-06-15");
  });
});

describe("readPreferredTimezone", () => {
  it("reads from pref:timezone key", () => {
    expect(readPreferredTimezone({ "pref:timezone": "Asia/Tokyo" })).toBe("Asia/Tokyo");
  });

  it("returns undefined if not set", () => {
    expect(readPreferredTimezone({})).toBeUndefined();
  });

  it("returns undefined for non-string value", () => {
    expect(readPreferredTimezone({ "pref:timezone": 123 })).toBeUndefined();
  });
});

describe("textHasTimeSensitiveNewsIntent", () => {
  it("detects 'latest news'", () => {
    expect(textHasTimeSensitiveNewsIntent("What is the latest news?")).toBe(true);
  });

  it("detects 'breaking headlines'", () => {
    expect(textHasTimeSensitiveNewsIntent("Show me breaking headlines")).toBe(true);
  });

  it("detects Chinese news intent", () => {
    expect(textHasTimeSensitiveNewsIntent("最新新闻是什么")).toBe(true);
  });

  it("returns false for capability question", () => {
    expect(textHasTimeSensitiveNewsIntent("What capabilities does Friday have?")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(textHasTimeSensitiveNewsIntent("")).toBe(false);
  });

  it("returns false for general question", () => {
    expect(textHasTimeSensitiveNewsIntent("How do I write a function?")).toBe(false);
  });
});

describe("hasTimeSensitiveNewsIntent", () => {
  it("detects intent in task text", () => {
    expect(hasTimeSensitiveNewsIntent("latest news about AI", [])).toBe(true);
  });

  it("detects intent in recent history messages", () => {
    const history: FridayAgentMessage[] = [
      { role: "user", content: "Tell me the latest headlines" },
    ];
    expect(hasTimeSensitiveNewsIntent("please do that", history)).toBe(true);
  });

  it("returns false for non-news conversation", () => {
    expect(hasTimeSensitiveNewsIntent("write a test", [])).toBe(false);
  });
});

describe("extractMessageText", () => {
  it("extracts from string content", () => {
    expect(extractMessageText({ role: "user", content: "hello" })).toBe("hello");
  });

  it("extracts from content block array", () => {
    const msg: FridayAgentMessage = {
      role: "user",
      content: [
        { type: "text", text: "line 1" },
        { type: "text", text: "line 2" },
      ],
    };
    expect(extractMessageText(msg)).toBe("line 1\nline 2");
  });

  it("returns empty for non-array non-string content", () => {
    expect(extractMessageText({ role: "user", content: undefined as unknown as string })).toBe("");
  });
});

describe("evaluateTimeSensitiveResponse", () => {
  const makeToolCall = (overrides: Partial<FridayAgentToolCallRecord> = {}): FridayAgentToolCallRecord => ({
    toolName: "web_search",
    args: {},
    result: { content: "results", isError: false, metadata: { freshnessApplied: true, hasDates: true } },
    durationMs: 100,
    ...overrides,
  });

  it("passes through when not required", () => {
    const result = evaluateTimeSensitiveResponse({
      required: false,
      responseText: "Some response",
      toolCalls: [],
      localDate: "2025-06-15",
      timezone: "UTC",
    });
    expect(result.responseText).toBe("Some response");
    expect(result.retryPrompt).toBeUndefined();
  });

  it("passes through when evidence verified and coverage satisfied", () => {
    const result = evaluateTimeSensitiveResponse({
      required: true,
      responseText: "1. Article (2025-06-15) https://example.com\n2. Article (2025-06-14) https://other.com",
      toolCalls: [makeToolCall()],
      localDate: "2025-06-15",
      timezone: "UTC",
    });
    expect(result.responseText).toContain("Article");
    expect(result.retryPrompt).toBeUndefined();
  });

  it("appends caveat when evidence missing", () => {
    const result = evaluateTimeSensitiveResponse({
      required: true,
      responseText: "Here are some results.",
      toolCalls: [],
      localDate: "2025-06-15",
      timezone: "UTC",
    });
    expect(result.responseText).toContain("Caveat");
    expect(result.retryPrompt).toBeDefined();
  });
});
