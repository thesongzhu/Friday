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

  it("exposes DeepSeek V4 model defaults and OpenAI-compatible base URL", () => {
    const deepseek = getFridayProviderTemplate("deepseek");

    expect(deepseek).toMatchObject({
      id: "deepseek",
      providerKind: "deepseek",
      tier: "verified",
      status: "ready",
      // DeepSeek only ships /v1/chat/completions, not /v1/responses; using
      // openai-responses here would 404 at runtime even though /v1/models validates ok.
      api: "openai-completions",
    });
    expect(deepseek?.baseUrlHints).toContain("https://api.deepseek.com");
    expect(deepseek?.modelDefaults.recommended).toBe("deepseek-v4-pro");
    expect(deepseek?.modelDefaults.fallback).toBe("deepseek-v4-flash");
    expect(deepseek?.modelDefaults.examples).toEqual(
      expect.arrayContaining(["deepseek-v4-pro", "deepseek-v4-flash"]),
    );
    expect(deepseek?.authModes).toContain("api-key");
    expect(deepseek?.requiredSecrets.some((req) => req.key === "apiKey")).toBe(true);
  });

  it("keeps setup-visible OpenAI-compatible providers on the chat completions runtime path", () => {
    for (const kind of ["openrouter", "xai", "mistral", "groq", "moonshot", "qwen"] as const) {
      expect(getFridayProviderTemplate(kind)).toMatchObject({
        providerKind: kind,
        api: "openai-completions",
      });
    }
  });
});
