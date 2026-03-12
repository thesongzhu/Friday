import { describe, expect, it } from "vitest";

import {
  FRIDAY_PROVIDER_CAPABILITIES,
  FRIDAY_PROVIDER_KINDS,
  FRIDAY_PROVIDER_PRESETS,
  getFridayProviderCapability,
  isFridayProviderApiSupportedForKind,
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
        isFridayProviderAuthModeSupportedForKind(kind, preset.authMode),
        `${kind} preset authMode ${preset.authMode} must be allowed by capabilities`,
      ).toBe(true);
    }
  });

  it("allows oauth only where implemented", () => {
    expect(isFridayProviderAuthModeSupportedForKind("anthropic", "oauth")).toBe(true);
    expect(isFridayProviderAuthModeSupportedForKind("openai", "oauth")).toBe(false);
    expect(isFridayProviderAuthModeSupportedForKind("google", "oauth")).toBe(false);
  });

  it("supports keyless openai-compatible gateways but not cloud openai", () => {
    expect(isFridayProviderAuthModeSupportedForKind("openai-compatible", "none")).toBe(true);
    expect(isFridayProviderAuthModeSupportedForKind("openai", "none")).toBe(false);
  });

  it("marks custom adapters as requiring explicit baseUrl", () => {
    expect(getFridayProviderCapability("openai-compatible").requiresBaseUrl).toBe(true);
    expect(getFridayProviderCapability("openai").requiresBaseUrl).toBe(false);
  });
});
