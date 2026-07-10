import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("friday-ui-device-proof-readiness CLI timeout contract", () => {
  it("pins shell-executing readiness CLI cases to an explicit extended timeout", () => {
    const source = readFileSync("test/unit/qa/friday-ui-device-proof-readiness-cli.test.ts", "utf8");
    const timeoutConstPattern = new RegExp([
      "const\\s+UI_DEVICE_READINESS_CLI_TEST_TIMEOUT_MS",
      "\\s*=\\s*60_000\\s*;",
    ].join(""));

    expect(source).toMatch(timeoutConstPattern);
    expect(source).toContain("function readinessCliIt(");

    const helperCalls = source.match(/^\s*readinessCliIt\(/gm) ?? [];
    expect(helperCalls.length).toBeGreaterThanOrEqual(19);

    expect(source).not.toMatch(/^\s*it\("discovers .*execFileSync\("bash"/ms);
    expect(source).not.toMatch(/^\s*it\("reports blocked .*execFileSync\("bash"/ms);
    expect(source).not.toMatch(/^\s*it\("can derive .*execFileSync\("bash"/ms);
  });
});
