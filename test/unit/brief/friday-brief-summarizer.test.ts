import { describe, it, expect } from "vitest";

import { createFridayBriefSummarizer } from "../../../src/brief/friday-brief-summarizer.js";
import type {
  FridayBriefEvent,
  FridayBriefSummary,
} from "../../../src/brief/friday-brief.types.js";

function evt(partial: Partial<FridayBriefEvent> & Pick<FridayBriefEvent, "source" | "summary">): FridayBriefEvent {
  return {
    occurredAt: "2026-04-24T09:00:00.000Z",
    externalId: "x1",
    ...partial,
  };
}

describe("createFridayBriefSummarizer (deterministic fallback)", () => {
  it("detects zh-CN when Chinese characters dominate", async () => {
    const summarizer = createFridayBriefSummarizer();
    const events: FridayBriefEvent[] = [
      evt({ source: "friday_history", summary: "用户询问了天气预报" }),
      evt({ source: "friday_history", summary: "用户讨论了项目进度" }),
    ];

    const result = await summarizer.summarize({
      events,
      languageOverride: "",
      length: "normal",
      signal: new AbortController().signal,
    });

    expect(result.language).toBe("zh-CN");
    expect(result.opening).toContain("今天");
    expect(result.fullText).toContain("•");
  });

  it("detects en-US when Latin characters dominate", async () => {
    const summarizer = createFridayBriefSummarizer();
    const events: FridayBriefEvent[] = [
      evt({ source: "git_repos", summary: "Fixed login regression" }),
      evt({ source: "git_repos", summary: "Refactored auth middleware" }),
    ];

    const result = await summarizer.summarize({
      events,
      languageOverride: "",
      length: "normal",
      signal: new AbortController().signal,
    });

    expect(result.language).toBe("en-US");
    expect(result.opening).toContain("today");
  });

  it("honors languageOverride when provided", async () => {
    const summarizer = createFridayBriefSummarizer();
    const events: FridayBriefEvent[] = [
      evt({ source: "friday_history", summary: "用户询问问题" }),
    ];

    const result = await summarizer.summarize({
      events,
      languageOverride: "en-US",
      length: "normal",
      signal: new AbortController().signal,
    });

    expect(result.language).toBe("en-US");
  });

  it("emits an empty-day opening when no events exist", async () => {
    const summarizer = createFridayBriefSummarizer();
    const result = await summarizer.summarize({
      events: [],
      languageOverride: "en-US",
      length: "normal",
      signal: new AbortController().signal,
    });

    expect(result.bullets).toHaveLength(0);
    expect(result.opening.toLowerCase()).toContain("no tracked activity");
    expect(result.closing).toBeUndefined();
  });

  it("groups events by source with one bullet per source", async () => {
    const summarizer = createFridayBriefSummarizer();
    const events: FridayBriefEvent[] = [
      evt({ source: "git_repos", summary: "Commit A" }),
      evt({ source: "git_repos", summary: "Commit B" }),
      evt({ source: "slack", summary: "Slack msg C" }),
      evt({ source: "mail", summary: "Email D" }),
    ];

    const result = await summarizer.summarize({
      events,
      languageOverride: "en-US",
      length: "normal",
      signal: new AbortController().signal,
    });

    expect(result.bullets).toHaveLength(3);
    const sources = result.bullets.map((b) => b.source);
    expect(sources).toContain("git_repos");
    expect(sources).toContain("slack");
    expect(sources).toContain("mail");
  });

  it("falls through to deterministic when LLM returns null", async () => {
    const summarizer = createFridayBriefSummarizer({
      llmSummarize: async () => null,
    });
    const events: FridayBriefEvent[] = [
      evt({ source: "git_repos", summary: "Commit A" }),
    ];

    const result = await summarizer.summarize({
      events,
      languageOverride: "en-US",
      length: "short",
      signal: new AbortController().signal,
    });

    expect(result.bullets).toHaveLength(1);
    expect(result.fullText.length).toBeGreaterThan(0);
  });

  it("falls through to deterministic when LLM throws", async () => {
    const summarizer = createFridayBriefSummarizer({
      llmSummarize: async () => {
        throw new Error("llm blew up");
      },
    });
    const events: FridayBriefEvent[] = [
      evt({ source: "git_repos", summary: "Commit A" }),
    ];

    const result = await summarizer.summarize({
      events,
      languageOverride: "en-US",
      length: "short",
      signal: new AbortController().signal,
    });

    expect(result.bullets).toHaveLength(1);
  });

  it("uses LLM output when it returns a valid summary", async () => {
    const llmOutput: FridayBriefSummary = {
      language: "en-US",
      opening: "LLM opening",
      bullets: [{ source: "git_repos", text: "LLM bullet" }],
      fullText: "LLM generated full text",
      wordCount: 4,
    };
    const summarizer = createFridayBriefSummarizer({
      llmSummarize: async () => llmOutput,
    });

    const result = await summarizer.summarize({
      events: [evt({ source: "git_repos", summary: "Commit A" })],
      languageOverride: "en-US",
      length: "normal",
      signal: new AbortController().signal,
    });

    expect(result).toBe(llmOutput);
    expect(result.fullText).toBe("LLM generated full text");
  });

  it("includes the total event count in the opening", async () => {
    const summarizer = createFridayBriefSummarizer();
    const events: FridayBriefEvent[] = Array.from({ length: 7 }, (_, i) =>
      evt({ source: "git_repos", summary: `Commit ${i}`, externalId: `c${i}` }),
    );

    const result = await summarizer.summarize({
      events,
      languageOverride: "en-US",
      length: "normal",
      signal: new AbortController().signal,
    });

    expect(result.opening).toContain("7");
  });
});
