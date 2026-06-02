import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

function readRepoSource(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), "utf8");
}

const SETTINGS_PAGE_SRC = readRepoSource("ui/src/routes/settings-page.tsx");
const REFLEX_PAGE_SRC = readRepoSource("ui/src/routes/reflex-page.tsx");
const SOURCE_OF_TRUTH_SRC = readRepoSource("docs/current-source-of-truth.md");

describe("Phase 21E memory and preference truth entrypoints", () => {
  it("shows learned-fact prompt, memory, review, and revocation boundaries in Settings", () => {
    expect(SETTINGS_PAGE_SRC).toContain("/v1/uix/learned-facts");
    expect(SETTINGS_PAGE_SRC).toContain("promptInjectionBoundary");
    expect(SETTINGS_PAGE_SRC).toContain("not_direct_prompt_injection");
    expect(SETTINGS_PAGE_SRC).toContain("reviewBoundary");
    expect(SETTINGS_PAGE_SRC).toContain("review_center_confirmed");
    expect(SETTINGS_PAGE_SRC).toContain("not_review_center_confirmed");
    expect(SETTINGS_PAGE_SRC).toContain("revocationBoundary");
    expect(SETTINGS_PAGE_SRC).toContain("not injected into prompts as raw learned facts");
    expect(SETTINGS_PAGE_SRC).toContain("Review Center confirmation before entering prompts as Reflex preferences");
  });

  it("labels Reflex preferences as confirmed state, not raw learned-fact prompt injection", () => {
    expect(REFLEX_PAGE_SRC).toContain("Confirmed preferences; prompt use still follows boundaries");
    expect(REFLEX_PAGE_SRC).toContain("not raw learned facts");
    expect(REFLEX_PAGE_SRC).toContain("Review Center confirmation and persistence");
    expect(REFLEX_PAGE_SRC).toContain("do not become Reflex prompt preferences before confirmation");
  });

  it("documents that the production prompt path is a non-claim for raw learned facts", () => {
    expect(SOURCE_OF_TRUTH_SRC).toContain("Raw learned facts are not blanket prompt injection");
    expect(SOURCE_OF_TRUTH_SRC).toContain("createFridayPreferenceInjector");
    expect(SOURCE_OF_TRUTH_SRC).toContain("current hub prompt wiring uses the communication prompt builder");
    expect(SOURCE_OF_TRUTH_SRC).toContain("must be confirmed through Review Center");
  });
});
