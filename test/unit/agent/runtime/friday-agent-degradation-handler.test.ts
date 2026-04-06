import { describe, it, expect } from "vitest";
import { assessDegradation, getDegradationSystemPrompt } from "#agent";

describe("assessDegradation", () => {
  it("returns conversational when no tools available", () => {
    expect(assessDegradation([])).toBe("conversational");
  });

  it("returns nominal when read and write tools available", () => {
    const tools = [
      { name: "file_read" },
      { name: "write" },
    ];
    expect(assessDegradation(tools)).toBe("nominal");
  });

  it("returns nominal when read and exec tools available", () => {
    const tools = [
      { name: "file_read" },
      { name: "exec" },
    ];
    expect(assessDegradation(tools)).toBe("nominal");
  });

  it("returns nominal when skill_run is present (counted as write)", () => {
    const tools = [
      { name: "memory_search" },
      { name: "skill_run" },
    ];
    expect(assessDegradation(tools)).toBe("nominal");
  });

  it("returns degraded when only read tools available", () => {
    const tools = [
      { name: "file_read" },
      { name: "memory_search" },
      { name: "skills_list" },
    ];
    expect(assessDegradation(tools)).toBe("degraded");
  });

  it("returns minimal when tools present but no read or write match", () => {
    const tools = [
      { name: "desktop" },
      { name: "cron" },
    ];
    expect(assessDegradation(tools)).toBe("minimal");
  });

  it("returns nominal for a full tool set", () => {
    const tools = [
      { name: "read" },
      { name: "write" },
      { name: "exec" },
      { name: "web_fetch" },
      { name: "browser" },
      { name: "skill_run" },
    ];
    expect(assessDegradation(tools)).toBe("nominal");
  });

  it("detects read via list-containing names", () => {
    const tools = [{ name: "skills_list" }];
    expect(assessDegradation(tools)).toBe("degraded");
  });

  it("detects read via search-containing names", () => {
    const tools = [{ name: "web_search" }];
    expect(assessDegradation(tools)).toBe("degraded");
  });
});

describe("getDegradationSystemPrompt", () => {
  it("returns empty string for nominal", () => {
    expect(getDegradationSystemPrompt("nominal")).toBe("");
  });

  it("returns non-empty for degraded", () => {
    const prompt = getDegradationSystemPrompt("degraded");
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("temporarily unavailable");
  });

  it("returns non-empty for minimal", () => {
    const prompt = getDegradationSystemPrompt("minimal");
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("Critical tools");
  });

  it("returns non-empty for conversational", () => {
    const prompt = getDegradationSystemPrompt("conversational");
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("All tools are currently unavailable");
  });
});
