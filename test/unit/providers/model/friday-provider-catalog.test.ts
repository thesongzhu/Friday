import { describe, it, expect } from "vitest";

import {
  FRIDAY_PROVIDER_KINDS,
  FRIDAY_PROVIDER_KIND_SET,
  detectFridayProviderKindFromApiKey,
  getFridayProviderPreset,
  isFridayProviderKind,
} from "#providers";

describe("friday-provider-catalog", () => {
  it("contains core OpenClaw-compatible provider kinds", () => {
    expect(FRIDAY_PROVIDER_KIND_SET.has("openrouter")).toBe(true);
    expect(FRIDAY_PROVIDER_KIND_SET.has("groq")).toBe(true);
    expect(FRIDAY_PROVIDER_KIND_SET.has("xai")).toBe(true);
    expect(FRIDAY_PROVIDER_KIND_SET.has("mistral")).toBe(true);
    expect(FRIDAY_PROVIDER_KIND_SET.has("moonshot")).toBe(true);
    expect(FRIDAY_PROVIDER_KIND_SET.has("qwen")).toBe(true);
    expect(FRIDAY_PROVIDER_KIND_SET.has("zai")).toBe(true);
    expect(FRIDAY_PROVIDER_KIND_SET.has("vllm")).toBe(true);
    expect(FRIDAY_PROVIDER_KIND_SET.has("litellm")).toBe(true);
  });

  it("has no duplicate provider kind entries", () => {
    expect(new Set(FRIDAY_PROVIDER_KINDS).size).toBe(FRIDAY_PROVIDER_KINDS.length);
  });

  it("returns openai-compatible preset for openrouter", () => {
    const preset = getFridayProviderPreset("openrouter");
    expect(preset.api).toBe("openai-responses");
    expect(preset.authMode).toBe("bearer-token");
    expect(preset.baseUrl).toBe("https://openrouter.ai/api");
  });

  it("detects key prefixes for common providers", () => {
    expect(detectFridayProviderKindFromApiKey("sk-ant-xxx").kind).toBe("anthropic");
    expect(detectFridayProviderKindFromApiKey("sk-or-v1-xxx").kind).toBe("openrouter");
    expect(detectFridayProviderKindFromApiKey("gsk_xxx").kind).toBe("groq");
    expect(detectFridayProviderKindFromApiKey("sk-proj-example").kind).toBe("openai");
    expect(detectFridayProviderKindFromApiKey("sk-xxx").kind).toBe("openai");
  });

  it("detects DeepSeek-style hex keys before the generic OpenAI sk fallback", () => {
    const fixtureKey = "sk-0123456789abcdef0123456789abcdef"; // fixture, not a real provider key

    expect(detectFridayProviderKindFromApiKey(fixtureKey)).toEqual({ kind: "deepseek", confidence: "medium" });
  });

  it("validates provider kind strings", () => {
    expect(isFridayProviderKind("openrouter")).toBe(true);
    expect(isFridayProviderKind("not-a-provider")).toBe(false);
  });
});
