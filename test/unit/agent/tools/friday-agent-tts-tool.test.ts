import { describe, it, expect, vi } from "vitest";
import { createFridayAgentTtsTool } from "#agent";
import type { FridayTtsService, FridayTtsServiceResult } from "../../../../src/media/friday-tts-service.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function makeTtsResult(overrides?: Partial<FridayTtsServiceResult>): FridayTtsServiceResult {
  return {
    filePath: "/tmp/tts-12345.mp3",
    mimeType: "audio/mpeg",
    bytes: 4096,
    voice: "alloy",
    model: "tts-1",
    format: "mp3",
    ...overrides,
  };
}

function mockTtsService(result?: FridayTtsServiceResult): FridayTtsService {
  return {
    synthesize: vi.fn().mockResolvedValue(result ?? makeTtsResult()),
  };
}

describe("FridayAgentTtsTool", () => {
  // ─── Definition ───

  it("has correct name and parameters", () => {
    const tool = createFridayAgentTtsTool({ ttsService: mockTtsService() });
    expect(tool.name).toBe("tts");
    expect(tool.description).toBeTruthy();
    expect(tool.parameters).toBeDefined();
    expect(tool.parameters.required).toContain("text");
  });

  // ─── Happy path ───

  it("returns file path and metadata on success", async () => {
    const svc = mockTtsService();
    const tool = createFridayAgentTtsTool({ ttsService: svc });

    const result = await tool.execute({ text: "Hello world" }, signal());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      filePath: "/tmp/tts-12345.mp3",
      mimeType: "audio/mpeg",
      bytes: 4096,
      voice: "alloy",
      model: "tts-1",
      format: "mp3",
    });
  });

  it("passes voice, format, speed, and model to service", async () => {
    const svc = mockTtsService();
    const tool = createFridayAgentTtsTool({ ttsService: svc });

    await tool.execute(
      { text: "Hello", voice: "nova", format: "wav", speed: 1.5, model: "tts-1-hd" },
      signal(),
    );

    expect(svc.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Hello",
        voice: "nova",
        format: "wav",
        speed: 1.5,
        model: "tts-1-hd",
      }),
      expect.any(AbortSignal),
    );
  });

  // ─── Parameter validation ───

  it("throws on missing text", async () => {
    const tool = createFridayAgentTtsTool({ ttsService: mockTtsService() });
    await expect(tool.execute({}, signal())).rejects.toThrow("text is required");
  });

  it("throws on empty text", async () => {
    const tool = createFridayAgentTtsTool({ ttsService: mockTtsService() });
    await expect(tool.execute({ text: "" }, signal())).rejects.toThrow("text is required");
  });

  // ─── Error handling ───

  it("returns error when TTS service fails", async () => {
    const svc: FridayTtsService = {
      synthesize: vi.fn().mockRejectedValue(new Error("API rate limit exceeded")),
    };
    const tool = createFridayAgentTtsTool({ ttsService: svc });

    const result = await tool.execute({ text: "Hello" }, signal());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("API rate limit exceeded");
  });

  it("returns abort error when aborted", async () => {
    const svc: FridayTtsService = {
      synthesize: vi.fn().mockRejectedValue(new Error("Request aborted")),
    };
    const tool = createFridayAgentTtsTool({ ttsService: svc });

    const result = await tool.execute({ text: "Hello" }, signal());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("aborted");
  });
});
