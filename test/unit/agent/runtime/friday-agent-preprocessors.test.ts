import { describe, expect, it } from "vitest";
import { preprocessFridayAgentContent } from "#agent";

describe("preprocessFridayAgentContent", () => {
  it("compresses test output to failure-relevant lines", () => {
    const result = preprocessFridayAgentContent({
      kind: "test_output",
      content: [
        "PASS a.test.ts",
        "FAIL b.test.ts",
        "expected 1 to equal 2",
        "at stack frame",
      ].join("\n"),
    });

    expect(result.applied).toBe(true);
    expect(result.content).toContain("FAIL b.test.ts");
    expect(result.content).toContain("expected 1 to equal 2");
    expect(result.content).not.toContain("PASS a.test.ts");
  });

  it("falls back to original content when filtering removes everything", () => {
    const result = preprocessFridayAgentContent({
      kind: "log_excerpt",
      content: "all good\nservice healthy",
    });

    expect(result.content).toBe("all good\nservice healthy");
    expect(result.outputChars).toBe(result.content.length);
  });
});
