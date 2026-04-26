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
    const route: FridayResolvedProviderRoute = {
      model: "gpt-4o-mini-tts",
      provider: {
        id: "provider-1",
        kind: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com",
        enabled: true,
        defaultModel: "gpt-4o-mini-tts",
        config: {
          api: "openai-responses",
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
    const providerService = {
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
});
