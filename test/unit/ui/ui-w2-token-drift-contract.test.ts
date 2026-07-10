import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DRIFT_TARGETS = [
  "ui/src/routes/workflows-page.tsx",
  "ui/src/routes/mcp-page.tsx",
  "ui/src/routes/first-run-passphrase-gate.tsx",
  "ui/src/routes/cloud-workers-page.tsx",
  "ui/src/router.tsx",
] as const;

describe("UI-W2 token drift contract", () => {
  it("keeps legacy served-web screens on the selected design token palette", () => {
    const violations = DRIFT_TARGETS.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const hits = [
        ...source.matchAll(/\b(?:bg|border|text|ring|from|to|via|decoration|outline|shadow)-(?:emerald|amber|red|green|yellow|rose)-\d{2,3}(?:\/\d+)?\b/g),
        ...source.matchAll(/#[0-9a-fA-F]{3,8}\b/g),
      ].map((match) => match[0]);
      return hits.map((hit) => `${file}: ${hit}`);
    });

    expect(violations).toEqual([]);
  });
});
