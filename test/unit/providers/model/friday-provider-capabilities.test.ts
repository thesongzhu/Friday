import { describe, expect, it } from "vitest";

import {
  FRIDAY_PROVIDER_CAPABILITIES,
  FRIDAY_PROVIDER_KINDS,
  FRIDAY_PROVIDER_PRESETS,
  getFridayProviderCapability,
  getFridayProviderAuthModesForBackend,
  isFridayProviderApiSupportedForKind,
  isFridayProviderAuthModeSupportedForKindAndBackend,
  isFridayProviderBackendKindSupportedForKind,
  isFridayProviderAuthModeSupportedForKind,
} from "#providers";

describe("friday-provider-capabilities", () => {
  it("covers every provider kind", () => {
    expect(Object.keys(FRIDAY_PROVIDER_CAPABILITIES).sort()).toEqual(
      [...FRIDAY_PROVIDER_KINDS].sort(),
    );
  });

  it("keeps presets compatible with capability matrix", () => {
    for (const kind of FRIDAY_PROVIDER_KINDS) {
      const preset = FRIDAY_PROVIDER_PRESETS[kind];
      expect(
        isFridayProviderApiSupportedForKind(kind, preset.api),
        `${kind} preset api ${preset.api} must be allowed by capabilities`,
      ).toBe(true);
      expect(
        isFridayProviderBackendKindSupportedForKind(kind, preset.backendKind),
        `${kind} preset backend ${preset.backendKind} must be allowed by capabilities`,
      ).toBe(true);
      expect(
        isFridayProviderAuthModeSupportedForKindAndBackend(kind, preset.backendKind, preset.authMode),
        `${kind} preset authMode ${preset.authMode} must be allowed by backend-aware capabilities`,
      ).toBe(true);
    }
  });

  it("allows oauth only where implemented", () => {
    expect(isFridayProviderAuthModeSupportedForKind("anthropic", "api-key")).toBe(true);
    expect(isFridayProviderAuthModeSupportedForKind("anthropic", "oauth")).toBe(false);
    expect(isFridayProviderAuthModeSupportedForKind("anthropic", "token")).toBe(false);
    expect(isFridayProviderAuthModeSupportedForKind("openai", "oauth")).toBe(false);
    expect(isFridayProviderAuthModeSupportedForKind("openai", "token")).toBe(false);
    expect(isFridayProviderAuthModeSupportedForKind("google", "oauth")).toBe(false);
  });

  it("supports keyless openai-compatible gateways but not cloud openai", () => {
    expect(isFridayProviderAuthModeSupportedForKind("openai-compatible", "none")).toBe(true);
    expect(isFridayProviderAuthModeSupportedForKind("openai", "none")).toBe(false);
  });

  it("treats Codex CLI as the only first-class CLI backend", () => {
    expect(isFridayProviderBackendKindSupportedForKind("openai", "cli")).toBe(true);
    expect(isFridayProviderBackendKindSupportedForKind("anthropic", "cli")).toBe(false);
    expect(isFridayProviderAuthModeSupportedForKindAndBackend("openai", "cli", "external-session")).toBe(true);
    expect(isFridayProviderAuthModeSupportedForKindAndBackend("anthropic", "cli", "external-session")).toBe(false);
    expect(isFridayProviderAuthModeSupportedForKindAndBackend("openai", "cli", "oauth")).toBe(false);
  });

  it("surfaces backend-specific auth modes", () => {
    expect(getFridayProviderAuthModesForBackend("anthropic", "http")).toEqual(["api-key"]);
    expect(getFridayProviderAuthModesForBackend("anthropic", "cli")).toEqual([]);
    expect(getFridayProviderAuthModesForBackend("ollama", "http")).toEqual(
      expect.arrayContaining(["none"]),
    );
  });

  it("marks custom adapters as requiring explicit baseUrl", () => {
    expect(getFridayProviderCapability("openai-compatible").requiresBaseUrl).toBe(true);
    expect(getFridayProviderCapability("openai").requiresBaseUrl).toBe(false);
  });
});
