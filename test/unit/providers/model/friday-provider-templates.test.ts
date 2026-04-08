import { describe, expect, it } from "vitest";

import {
  FRIDAY_PROVIDER_KINDS,
  getFridayProviderTemplate,
  listFridayProviderTemplates,
} from "#providers";

describe("friday-provider-templates", () => {
  it("covers every canonical provider kind exactly once", () => {
    const templates = listFridayProviderTemplates();
    const templateIds = templates.map((template) => template.id);

    expect(new Set(templateIds).size).toBe(templateIds.length);
    expect(templateIds.sort()).toEqual([...FRIDAY_PROVIDER_KINDS].sort());
  });

  it("returns stable lookup results for known templates", () => {
    const openai = getFridayProviderTemplate("openai");

    expect(openai).toMatchObject({
      id: "openai",
      providerKind: "openai",
      tier: "official",
      status: "ready",
      backendKind: "http",
    });
    expect(openai?.authModes).toContain("api-key");
    expect(openai?.modelDefaults.recommended).toBeTruthy();
    expect(openai?.modelDefaults.examples.length).toBeGreaterThan(0);
  });

  it("keeps setup-relevant template fields populated", () => {
    const templates = listFridayProviderTemplates();

    for (const template of templates) {
      expect(template.displayName.trim().length).toBeGreaterThan(0);
      expect(template.description.trim().length).toBeGreaterThan(0);
      expect(template.authModes.length).toBeGreaterThan(0);
      expect(template.reasoningHints.length).toBeGreaterThan(0);

      if (template.status === "ready" && template.providerKind !== "github-copilot") {
        expect(
          template.baseUrlHints.length > 0 || template.deploymentKind === "consumer-cli" || template.deploymentKind === "local",
        ).toBe(true);
      }

      if (template.authModes.includes("api-key") || template.authModes.includes("bearer-token") || template.authModes.includes("token")) {
        expect(template.requiredSecrets.length).toBeGreaterThan(0);
      }
    }
  });

  it("marks compatibility-only Copilot routing as experimental", () => {
    expect(getFridayProviderTemplate("github-copilot")).toMatchObject({
      tier: "experimental",
      status: "experimental",
    });
  });
});
