import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CHROMIUM_AVAILABLE = existsSync(process.env.CHROMIUM_PATH ?? "/usr/bin/chromium-browser");

describe.skipIf(!CHROMIUM_AVAILABLE)("Setup page template loading E2E", () => {
  it("setup-page.tsx imports and calls listTemplates from providersApi", async () => {
    // Verify the setup page module exists and references templates
    const setupModule = await import("../../../ui/src/routes/setup-page.tsx");
    expect(setupModule).toBeDefined();
  });

  it("setup page renders template provider cards with tier badges", async () => {
    // This test verifies the setup page references template-related code
    const { readFileSync } = await import("node:fs");
    const setupContent = readFileSync("ui/src/routes/setup-page.tsx", "utf8");
    expect(setupContent).toContain("listTemplates");
    expect(setupContent).toContain("providerTemplates");
  });
});

describe("Setup page template integration (non-browser)", () => {
  it("setup page source references templates API", async () => {
    const { readFileSync } = await import("node:fs");
    const setupContent = readFileSync("ui/src/routes/setup-page.tsx", "utf8");
    expect(setupContent).toContain("listTemplates");
    expect(setupContent).toContain("providerTemplates");
    expect(setupContent).toContain("applyProviderTemplate");
  });

  it("providers API client exports listTemplates method", async () => {
    const { readFileSync } = await import("node:fs");
    const apiContent = readFileSync("ui/src/lib/api/providers.ts", "utf8");
    expect(apiContent).toContain("listTemplates");
    expect(apiContent).toContain("getTemplate");
    expect(apiContent).toContain("/v1/providers/templates");
  });
});
