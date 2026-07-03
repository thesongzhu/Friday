import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ciWorkflowPath = path.join(process.cwd(), ".github", "workflows", "ci.yml");

describe("CI npm dependency installation", () => {
  it("uses bounded npm ci retry settings for every dependency install step", () => {
    const workflow = readFileSync(ciWorkflowPath, "utf8");
    const installStepCount = (workflow.match(/- name: Install dependencies/g) ?? []).length;

    expect(installStepCount).toBeGreaterThan(0);
    expect(workflow).not.toMatch(/^\s*run:\s+npm ci\s*$/m);
    expect(workflow.match(/npm_config_fetch_retries:\s+5/g) ?? []).toHaveLength(installStepCount);
    expect(workflow.match(/npm_config_fetch_retry_mintimeout:\s+10000/g) ?? []).toHaveLength(installStepCount);
    expect(workflow.match(/npm_config_fetch_retry_maxtimeout:\s+120000/g) ?? []).toHaveLength(installStepCount);
    expect(workflow.match(/for attempt in 1 2 3;/g) ?? []).toHaveLength(installStepCount);
  });

  it("does not fail-open when every npm ci retry attempt fails", () => {
    const workflow = readFileSync(ciWorkflowPath, "utf8");

    expect(workflow).not.toMatch(/fi\n\s+status=\$\?/);
    expect(workflow.match(/else\n\s+status=\$\?/g) ?? []).toHaveLength(
      (workflow.match(/- name: Install dependencies/g) ?? []).length,
    );
  });
});
