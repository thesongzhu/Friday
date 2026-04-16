import { describe, expect, it } from "vitest";

import { inferFridayTaskRequiresNativeTools } from "../../../../src/agent/runtime/friday-agent-runtime.js";

describe("inferFridayTaskRequiresNativeTools", () => {
  it("keeps summary prompts read-only when they only mention workflow as content", () => {
    expect(inferFridayTaskRequiresNativeTools({
      task: "Summarize this note in 3 bullet points only: Friday should answer normal summaries directly and must not enter workflow generation or approval planning mode.",
      readOnly: true,
    })).toBe(false);
  });

  it("treats real-world validation judge prompts as text-only even when evidence mentions files", () => {
    expect(inferFridayTaskRequiresNativeTools({
      task: [
        "You are validating a Friday real-world scenario run.",
        "Do not call tools.",
        "Output:",
        "The top H1 heading in the README.md file is:",
        "# Friday",
      ].join("\n"),
      readOnly: true,
    })).toBe(false);
  });

  it("marks filesystem prompts as requiring native tools", () => {
    expect(inferFridayTaskRequiresNativeTools({
      task: "Use the filesystem to read README.md from the current workspace root and answer with its top H1 heading only.",
      readOnly: true,
    })).toBe(true);
  });

  it("always requires native tools for non-read-only runs", () => {
    expect(inferFridayTaskRequiresNativeTools({
      task: "Reply with one sentence: what is the default reply language in this workspace?",
      readOnly: false,
    })).toBe(true);
  });
});
