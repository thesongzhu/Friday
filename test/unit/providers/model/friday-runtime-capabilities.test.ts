import { describe, expect, it } from "vitest";

import type { FridayProviderProfile, FridayResolvedProviderRoute } from "#providers";
import {
  buildFridayRuntimeCapabilityMatrix,
  filterFridayProviderRoutesByRequiredCapabilities,
} from "#providers";

const NOW = "2026-04-25T12:00:00.000Z";

function makeProvider(
  overrides: Partial<FridayProviderProfile> & {
    config?: Partial<FridayProviderProfile["config"]>;
  } = {},
): FridayProviderProfile {
  const { config: configOverrides, ...profileOverrides } = overrides;
  return {
    id: "provider-1",
    kind: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com",
    enabled: true,
    defaultModel: "gpt-4o",
    config: {
      api: "openai-completions",
      authMode: "api-key",
      keySource: { kind: "env-ref", envVar: "OPENAI_API_KEY" },
      supportedModels: ["gpt-4o"],
      validation: { status: "ok", checkedAt: NOW },
      ...configOverrides,
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...profileOverrides,
  };
}

function getCapability(
  matrix: ReturnType<typeof buildFridayRuntimeCapabilityMatrix>,
  capability: string,
) {
  const item = matrix.items.find((candidate) => candidate.capability === capability);
  expect(item).toBeTruthy();
  return item!;
}

describe("friday-runtime-capabilities", () => {
  it("builds a conservative matrix from providers and runtime tools", () => {
    const matrix = buildFridayRuntimeCapabilityMatrix({
      nowIso: NOW,
      readOnly: true,
      providers: [
        makeProvider({
          config: {
            runtimeCapabilities: [
              { capability: "ocr", model: "gpt-4o", status: "declared" },
            ],
          },
        }),
      ],
      webSearch: {
        provider: "auto",
        latestness: "unverified",
        warning: "Default search freshness is unverified.",
      },
      pdfParseEnabled: true,
      browserEnabled: true,
      browserVerified: true,
      mcpServerCount: 0,
      skillCount: 2,
      ttsEnabled: false,
    });

    expect(matrix.schemaVersion).toBe("1.0");
    expect(getCapability(matrix, "text").state).toBe("configured_but_unverified");
    expect(getCapability(matrix, "vision").state).toBe("configured_but_unverified");
    expect(getCapability(matrix, "tts").repairOptions[0]?.setupHref).toBe(
      "/setup?step=provider&providerKind=openai&recipeId=provider-openai",
    );
    expect(getCapability(matrix, "ocr").state).toBe("configured_but_unverified");
    expect(getCapability(matrix, "file_write").state).toBe("unsupported");
    expect(getCapability(matrix, "browser").state).toBe("available");
    expect(getCapability(matrix, "pdf_parse").state).toBe("available");
    expect(getCapability(matrix, "skills").state).toBe("available");
    expect(getCapability(matrix, "custom").state).toBe("buildable_with_approval");
    expect(getCapability(matrix, "custom").repairOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "generate_tool",
          setupHref: "/setup?recipeId=capability-custom&targetService=custom",
        }),
        expect.objectContaining({ kind: "install_mcp" }),
      ]),
    );
    expect(matrix.summary.needsVerification).toBeGreaterThan(0);
  });

  it("does not mark text or skills available until a verified source exists", () => {
    const matrix = buildFridayRuntimeCapabilityMatrix({
      nowIso: NOW,
      providers: [makeProvider()],
      skillCount: 0,
    });

    expect(getCapability(matrix, "text").state).toBe("configured_but_unverified");
    expect(getCapability(matrix, "skills").state).toBe("installable_with_approval");
  });

  it("keeps configured browser and MCP sources unverified until they pass a runtime probe", () => {
    const matrix = buildFridayRuntimeCapabilityMatrix({
      nowIso: NOW,
      providers: [],
      browserEnabled: true,
      browserVerified: false,
      mcpServerCount: 2,
      mcpVerifiedServerCount: 1,
    });

    expect(getCapability(matrix, "browser").state).toBe("configured_but_unverified");
    expect(getCapability(matrix, "mcp").state).toBe("available");
    expect(getCapability(matrix, "mcp").sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "mcp:verified", status: "verified" }),
        expect.objectContaining({ id: "mcp:configured", status: "unverified" }),
      ]),
    );
  });

  it("offers MCP and file-write repair paths with the correct approval boundary", () => {
    const matrix = buildFridayRuntimeCapabilityMatrix({
      nowIso: NOW,
      readOnly: true,
      providers: [],
      mcpServerCount: 0,
    });

    expect(getCapability(matrix, "mcp").state).toBe("installable_with_approval");
    expect(getCapability(matrix, "mcp").repairOptions[0]).toEqual(
      expect.objectContaining({
        kind: "install_mcp",
        setupHref: "/setup?recipeId=capability-mcp&targetService=mcp",
      }),
    );
    expect(getCapability(matrix, "file_write").repairOptions[0]).toEqual(
      expect.objectContaining({
        id: "enable-write-mode",
        kind: "custom",
      }),
    );
  });

  it("filters provider routes by required runtime capabilities", () => {
    const textOnlyProvider = makeProvider({
      id: "text-provider",
      name: "Text Provider",
      defaultModel: "gpt-3.5-turbo",
      config: {
        supportedModels: ["gpt-3.5-turbo"],
        runtimeCapabilities: [
          { capability: "text", model: "gpt-3.5-turbo", status: "verified" },
        ],
      },
    });
    const visionProvider = makeProvider({
      id: "vision-provider",
      name: "Vision Provider",
      defaultModel: "gpt-4o",
      config: {
        supportedModels: ["gpt-4o"],
        runtimeCapabilities: [
          { capability: "text", model: "gpt-4o", status: "verified" },
          { capability: "vision", model: "gpt-4o", status: "verified" },
        ],
      },
    });
    const routes: FridayResolvedProviderRoute[] = [
      { provider: textOnlyProvider, model: "gpt-3.5-turbo" },
      { provider: visionProvider, model: "gpt-4o" },
    ];

    expect(filterFridayProviderRoutesByRequiredCapabilities(routes, ["text"]).map((route) => route.provider.id)).toEqual([
      "text-provider",
      "vision-provider",
    ]);
    expect(filterFridayProviderRoutesByRequiredCapabilities(routes, ["vision"]).map((route) => route.provider.id)).toEqual([
      "vision-provider",
    ]);
    expect(filterFridayProviderRoutesByRequiredCapabilities(routes, ["ocr"])).toEqual([]);
  });

  it("does not route explicitly verified local/keyless capabilities until the provider validates", () => {
    const provider = makeProvider({
      kind: "ollama",
      name: "Local Ollama",
      baseUrl: "http://127.0.0.1:11434",
      defaultModel: "llama3.1",
      config: {
        authMode: "none",
        keySource: { kind: "none" },
        supportedModels: ["llama3.1"],
        validation: { status: "never" },
        runtimeCapabilities: [
          { capability: "text", model: "llama3.1", status: "verified", verifiedAt: NOW },
        ],
      },
    });
    const routes: FridayResolvedProviderRoute[] = [{ provider, model: "llama3.1" }];

    expect(filterFridayProviderRoutesByRequiredCapabilities(routes, ["text"])).toEqual([]);
  });

  it("does not expose shadow or canary provider capabilities as available", () => {
    const provider = makeProvider({
      promotionChannel: "shadow",
      config: {
        runtimeCapabilities: [
          { capability: "text", model: "gpt-4o", status: "verified", verifiedAt: NOW },
        ],
      },
    });
    const matrix = buildFridayRuntimeCapabilityMatrix({
      nowIso: NOW,
      providers: [provider],
    });
    const routes: FridayResolvedProviderRoute[] = [{ provider, model: "gpt-4o" }];

    expect(getCapability(matrix, "text").state).toBe("configured_but_unverified");
    expect(filterFridayProviderRoutesByRequiredCapabilities(routes, ["text"])).toEqual([]);
  });

  it("treats failed capability doctor declarations as blockers", () => {
    const provider = makeProvider({
      config: {
        runtimeCapabilities: [
          {
            capability: "vision",
            model: "gpt-4o",
            status: "failed",
            notes: "Capability probe failed with HTTP 400.",
          },
        ],
      },
    });
    const matrix = buildFridayRuntimeCapabilityMatrix({
      nowIso: NOW,
      providers: [provider],
    });
    const routes: FridayResolvedProviderRoute[] = [
      { provider, model: "gpt-4o" },
    ];

    expect(getCapability(matrix, "vision").state).toBe("failed_verification");
    expect(filterFridayProviderRoutesByRequiredCapabilities(routes, ["vision"])).toEqual([]);
  });

  it("does not expose stale verified provider capabilities after provider validation fails", () => {
    const provider = makeProvider({
      config: {
        validation: {
          status: "failed",
          checkedAt: NOW,
          errorCode: "invalid_api_key",
          errorMessage: "Provider returned 401",
          httpStatus: 401,
        },
        runtimeCapabilities: [
          { capability: "text", model: "gpt-4o", status: "verified", verifiedAt: NOW },
          { capability: "ocr", model: "gpt-4o", status: "verified", verifiedAt: NOW },
        ],
      },
    });
    const matrix = buildFridayRuntimeCapabilityMatrix({
      nowIso: NOW,
      providers: [provider],
    });
    const routes: FridayResolvedProviderRoute[] = [{ provider, model: "gpt-4o" }];

    expect(getCapability(matrix, "text").state).toBe("failed_verification");
    expect(getCapability(matrix, "ocr").state).toBe("failed_verification");
    expect(getCapability(matrix, "text").sources).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "failed" })]),
    );
    expect(filterFridayProviderRoutesByRequiredCapabilities(routes, ["text"])).toEqual([]);
  });
});
