import { describe, expect, it } from "vitest";

import { FRIDAY_BUILTIN_RECIPES } from "../../../src/setup/index.js";

describe("friday setup built-in recipes", () => {
  it("registers provider and capability setup recipes used by capability repair options", () => {
    const recipeIds = FRIDAY_BUILTIN_RECIPES.map((recipe) => recipe.id);

    expect(recipeIds).toContain("provider-google");
    expect(recipeIds).toContain("provider-volcengine");
    expect(recipeIds).toContain("provider-qwen");
    expect(recipeIds).toContain("provider-minimax");
    expect(recipeIds).toContain("capability-text");
    expect(recipeIds).toContain("capability-vision");
    expect(recipeIds).toContain("capability-embedding");
    expect(recipeIds).toContain("capability-ocr");
    expect(recipeIds).toContain("capability-pdf-parse");
    expect(recipeIds).toContain("capability-tts");
    expect(recipeIds).toContain("capability-web-search");
    expect(recipeIds).toContain("capability-browser");
    expect(recipeIds).toContain("capability-mcp");
    expect(recipeIds).toContain("capability-skills");
    expect(recipeIds).toContain("capability-custom");
  });
});
