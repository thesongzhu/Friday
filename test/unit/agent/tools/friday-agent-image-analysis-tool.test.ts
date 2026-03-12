import { describe, it, expect, vi } from "vitest";
import { createFridayAgentImageAnalysisTool } from "#agent";
import type { FridayImageAnalysisFn, FridayImageAnalysisResult } from "#agent";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function mockAnalyze(
  overrides?: Partial<FridayImageAnalysisResult>,
): FridayImageAnalysisFn {
  return vi.fn().mockResolvedValue({
    text: "A cat sitting on a mat.",
    model: "gpt-4o",
    inputTokens: 100,
    outputTokens: 25,
    ...overrides,
  } satisfies FridayImageAnalysisResult);
}

describe("FridayAgentImageAnalysisTool", () => {
  // ─── Definition ───

  it("has correct name and parameters", () => {
    const tool = createFridayAgentImageAnalysisTool({ analyzeImages: mockAnalyze() });
    expect(tool.name).toBe("image_analysis");
    expect(tool.description).toBeTruthy();
    expect(tool.parameters).toBeDefined();
    expect(tool.parameters.required).toContain("prompt");
    expect(tool.parameters.required).toContain("images");
  });

  // ─── Happy path ───

  it("returns analysis result for URL images", async () => {
    const analyze = mockAnalyze();
    const tool = createFridayAgentImageAnalysisTool({ analyzeImages: analyze });

    const result = await tool.execute(
      {
        prompt: "Describe this image",
        images: ["https://example.com/photo.jpg"],
      },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      analysis: "A cat sitting on a mat.",
      model: "gpt-4o",
      imageCount: 1,
      inputTokens: 100,
      outputTokens: 25,
    });
    expect(analyze).toHaveBeenCalledOnce();
  });

  it("passes detail parameter correctly", async () => {
    const analyze = mockAnalyze();
    const tool = createFridayAgentImageAnalysisTool({ analyzeImages: analyze });

    await tool.execute(
      {
        prompt: "What is this?",
        images: ["https://example.com/img.png"],
        detail: "high",
      },
      signal(),
    );

    expect(analyze).toHaveBeenCalledWith(
      expect.objectContaining({ detail: "high" }),
      expect.any(AbortSignal),
    );
  });

  it("uses default model when not specified", async () => {
    const analyze = mockAnalyze();
    const tool = createFridayAgentImageAnalysisTool({
      analyzeImages: analyze,
      defaultModel: "claude-3-opus",
    });

    await tool.execute(
      {
        prompt: "Describe",
        images: ["https://example.com/img.png"],
      },
      signal(),
    );

    expect(analyze).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-3-opus" }),
      expect.any(AbortSignal),
    );
  });

  // ─── Parameter validation ───

  it("throws on missing prompt", async () => {
    const tool = createFridayAgentImageAnalysisTool({ analyzeImages: mockAnalyze() });
    await expect(
      tool.execute({ images: ["https://example.com/img.png"] }, signal()),
    ).rejects.toThrow("prompt is required");
  });

  it("throws on missing images", async () => {
    const tool = createFridayAgentImageAnalysisTool({ analyzeImages: mockAnalyze() });
    await expect(
      tool.execute({ prompt: "describe" }, signal()),
    ).rejects.toThrow("images is required");
  });

  it("returns error for invalid detail value", async () => {
    const tool = createFridayAgentImageAnalysisTool({ analyzeImages: mockAnalyze() });
    const result = await tool.execute(
      {
        prompt: "describe",
        images: ["https://example.com/img.png"],
        detail: "ultra",
      },
      signal(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid detail");
  });

  it("throws for empty images array (required param)", async () => {
    const tool = createFridayAgentImageAnalysisTool({ analyzeImages: mockAnalyze() });
    await expect(
      tool.execute({ prompt: "describe", images: [] }, signal()),
    ).rejects.toThrow("images is required");
  });

  // ─── Error handling ───

  it("returns error when analyzeImages throws", async () => {
    const analyze = vi.fn().mockRejectedValue(new Error("Provider unavailable"));
    const tool = createFridayAgentImageAnalysisTool({ analyzeImages: analyze });

    const result = await tool.execute(
      {
        prompt: "describe",
        images: ["https://example.com/img.png"],
      },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Provider unavailable");
  });

  it("returns abort error when aborted", async () => {
    const analyze = vi.fn().mockRejectedValue(new Error("Request was aborted"));
    const tool = createFridayAgentImageAnalysisTool({ analyzeImages: analyze });

    const result = await tool.execute(
      {
        prompt: "describe",
        images: ["https://example.com/img.png"],
      },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("aborted");
  });
});
