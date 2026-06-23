import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createFridayProviderBackedTtsService } from "../../../src/media/friday-provider-backed-tts-service.js";
import type { FridayProviderService, FridayResolvedProviderRoute } from "#providers";

describe("createFridayProviderBackedTtsService", () => {
  it("routes through a verified TTS provider and writes audio", async () => {
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-tts-"));
    const fetchImpl = vi.fn(async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      }),
    ) as typeof fetch;
    const providerService = createProviderServiceWithRoute(createTtsRoute());
    const service = createFridayProviderBackedTtsService({
      providerService,
      artifactDir,
      fetchImpl,
    });

    const result = await service.synthesize({
      text: "hello",
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      format: "mp3",
    }, new AbortController().signal);

    expect(result.bytes).toBe(3);
    expect(fs.existsSync(result.filePath)).toBe(true);
    expect(providerService.runWithFallback).toHaveBeenCalledWith(expect.objectContaining({
      requestedModel: "gpt-4o-mini-tts",
      routingContext: expect.objectContaining({ requiredCapabilities: ["tts"] }),
    }));
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.openai.com/v1/audio/speech",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
      }),
    );
  });

  it("rejects non OpenAI-compatible TTS providers without calling fetch", async () => {
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-tts-"));
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))) as typeof fetch;
    const service = createFridayProviderBackedTtsService({
      providerService: createProviderServiceWithRoute(createTtsRoute({ api: "anthropic-messages" })),
      artifactDir,
      fetchImpl,
    });

    await expect(service.synthesize({
      text: "hello",
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      format: "mp3",
    }, new AbortController().signal)).rejects.toMatchObject({
      code: "PROVIDER_UNKNOWN_ERROR",
      httpStatus: 400,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fs.readdirSync(artifactDir)).toEqual([]);
  });

  it("maps provider authentication failures and does not write an artifact", async () => {
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-tts-"));
    const fetchImpl = vi.fn(async () =>
      new Response("bad key", { status: 401 }),
    ) as typeof fetch;
    const service = createFridayProviderBackedTtsService({
      providerService: createProviderServiceWithRoute(createTtsRoute()),
      artifactDir,
      fetchImpl,
    });

    await expect(service.synthesize({
      text: "hello",
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      format: "mp3",
    }, new AbortController().signal)).rejects.toMatchObject({
      code: "PROVIDER_AUTH_INVALID",
      httpStatus: 401,
    });

    expect(fs.readdirSync(artifactDir)).toEqual([]);
  });

  it("rejects empty provider audio responses and does not write an artifact", async () => {
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-tts-"));
    const fetchImpl = vi.fn(async () =>
      new Response(new Uint8Array(), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      }),
    ) as typeof fetch;
    const service = createFridayProviderBackedTtsService({
      providerService: createProviderServiceWithRoute(createTtsRoute()),
      artifactDir,
      fetchImpl,
    });

    await expect(service.synthesize({
      text: "hello",
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      format: "mp3",
    }, new AbortController().signal)).rejects.toMatchObject({
      code: "PROVIDER_UNKNOWN_ERROR",
      httpStatus: 502,
    });

    expect(fs.readdirSync(artifactDir)).toEqual([]);
  });
});

function createTtsRoute(options: {
  api?: "openai-responses" | "openai-completions" | "anthropic-messages";
} = {}): FridayResolvedProviderRoute {
  return {
    model: "gpt-4o-mini-tts",
    provider: {
      id: "provider-1",
      kind: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com",
      enabled: true,
      defaultModel: "gpt-4o-mini-tts",
      config: {
        api: options.api ?? "openai-responses",
        authMode: "api-key",
        keySource: { kind: "env-ref", envVar: "OPENAI_API_KEY" },
        supportedModels: ["gpt-4o-mini-tts"],
        validation: { status: "ok" },
        runtimeCapabilities: [
          { capability: "tts", model: "gpt-4o-mini-tts", status: "verified" },
        ],
      },
      createdAt: "2026-04-25T00:00:00.000Z",
      updatedAt: "2026-04-25T00:00:00.000Z",
    },
  };
}

function createProviderServiceWithRoute(route: FridayResolvedProviderRoute): FridayProviderService {
  return {
    runWithFallback: vi.fn(async (params: {
      run: (route: FridayResolvedProviderRoute, credential: string | null) => Promise<unknown>;
    }) => ({
      result: await params.run(route, "secret"),
      route,
      attempts: [],
      routingDecision: {
        selected: {
          providerId: route.provider.id,
          model: route.model,
          backendKind: "http",
        },
        candidates: [],
        rejected: [],
        warnings: [],
      },
    })),
  } as unknown as FridayProviderService;
}
