import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import viteConfig from "../../../ui/vite.config";

describe("Friday UI Vite dev server fs allow list", () => {
  it("allows symlinked node_modules font assets from temporary worktrees", () => {
    const repoRoot = realpathSync(resolve(__dirname, "../../.."));
    const nodeModulesRealPath = realpathSync(resolve(repoRoot, "node_modules"));
    const allowList = viteConfig.server?.fs?.allow ?? [];

    expect(allowList).toContain(repoRoot);
    expect(allowList).toContain(nodeModulesRealPath);
  });
});
