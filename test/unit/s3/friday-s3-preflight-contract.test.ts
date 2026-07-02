import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

function readRepoFile(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function extractorBlocks(source: string, factoryName: string): string[] {
  const pattern = new RegExp(`const\\s+\\w+\\s*=\\s*${factoryName}\\(\\{[\\s\\S]*?\\n\\s*\\}\\);`, "g");
  return source.match(pattern) ?? [];
}

describe("S3 pre-PR contract", () => {
  it("A3: dogfood reflex extractors explicitly opt in to legacy TS memory writes", () => {
    const targets = [
      "test/e2e/api/friday-api-dp10-reflex-organic-candidate.probe.test.ts",
      "test/e2e/ui/friday-reflex-review-center-real-browser.e2e.test.ts",
    ];

    for (const target of targets) {
      const source = readRepoFile(target);
      for (const factoryName of ["createFridayEpisodeExtractor", "createFridayPatternExtractor"]) {
        const blocks = extractorBlocks(source, factoryName);
        expect(blocks.length, `${target} ${factoryName} constructor count`).toBeGreaterThan(0);
        for (const block of blocks) {
          expect(block, `${target} ${factoryName} must set test-only A3 write opt-in`)
            .toContain("tsMemoryWritesEnabled: true");
        }
      }
    }
  });

  it("A7: non-Darwin trusted shell metadata reports open sandbox, not fail-closed", () => {
    const source = readRepoFile("test/unit/skills/executor/friday-skill-executor.test.ts");
    const firstMetadataAssertion = source.slice(
      source.indexOf("expect(snapshot?.metadata?.sandbox).toMatchObject({"),
      source.indexOf("it(\"A7: fails closed for isolated shell skills"),
    );

    expect(firstMetadataAssertion).toContain(": \"open_no_os_sandbox\"");
    expect(firstMetadataAssertion).toContain("required: process.platform === \"darwin\"");
    expect(firstMetadataAssertion).not.toContain(": \"os_sandbox_unavailable_fail_closed\"");
  });
});
