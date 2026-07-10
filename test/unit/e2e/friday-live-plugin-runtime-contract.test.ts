import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const pluginLiveProofPath = path.join(
  repoRoot,
  "test/e2e/live/friday-self-upgrade-plugin-live.e2e.test.ts",
);

describe("Friday plugin self-upgrade live proof runtime config", () => {
  it("starts the isolated hub with the full plugin runtime enabled", () => {
    const source = readFileSync(pluginLiveProofPath, "utf8");

    expect(source).toContain("pluginRuntimeMode: \"full\"");
    expect(source).toContain("allowTestOnlyPluginExecution: true");
  });
});
