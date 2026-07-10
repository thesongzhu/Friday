import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("friday-served-ui-design-fidelity CLI timeout contract", () => {
  it("pins shell-executing fidelity CLI cases to an explicit extended timeout", () => {
    const source = readFileSync("test/unit/qa/friday-served-ui-design-fidelity-cli.test.ts", "utf8");
    const timeoutConstPattern = new RegExp([
      "const\\s+SERVED_UI_DESIGN_FIDELITY_CLI_TEST_TIMEOUT_MS",
      "\\s*=\\s*60_000\\s*;",
    ].join(""));

    expect(source).toMatch(timeoutConstPattern);
    expect(source).toContain("function servedUiDesignFidelityCliIt(");

    const helperCalls = source.match(/^\s*servedUiDesignFidelityCliIt\(/gm) ?? [];
    expect(helperCalls.length).toBeGreaterThanOrEqual(15);

    expect(source).not.toMatch(/^\s*it\("fails Gate D .*run\(/ms);
    expect(source).not.toMatch(/^\s*it\("writes and parses .*run\(/ms);
    expect(source).not.toMatch(/^\s*it\("fails an explicitly supplied .*run\(/ms);
  });
});
