import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import {
  errorResult,
  imageResultFromFile,
  readStringParam,
} from "./friday-agent-tool-helpers.js";
import type { FridayImageGenerateService } from "../../media/friday-image-generate-service.js";
import type { FridayImageGenerateSize, FridayImageGenerateStyle, FridayImageGenerateQuality } from "../../media/friday-image-generate-service.js";

// ─── Types ───

export interface CreateFridayAgentImageGenerateToolOptions {
  imageGenerateService: FridayImageGenerateService;
}

// ─── Factory ───

export function createFridayAgentImageGenerateTool(
  options: CreateFridayAgentImageGenerateToolOptions,
): FridayAgentToolDefinition {
  const { imageGenerateService } = options;

  return {
    name: "image_generate",
    description:
      "Generate images from text prompts using AI models (DALL-E, Stable Diffusion, Flux). " +
      "Returns the generated image file path and metadata. " +
      "Supports different sizes, styles, and quality levels.",
    parameters: {
      properties: {
        prompt: {
          type: "string",
          description: "The text prompt describing the image to generate.",
        },
        negativePrompt: {
          type: "string",
          description: "Things to exclude from the generated image (optional).",
        },
        size: {
          type: "string",
          enum: ["256x256", "512x512", "1024x1024", "1024x1792", "1792x1024"],
          description: "Image dimensions (default: 1024x1024).",
        },
        style: {
          type: "string",
          enum: ["natural", "vivid"],
          description: "Image style: natural or vivid (default: natural).",
        },
        quality: {
          type: "string",
          enum: ["standard", "hd"],
          description: "Image quality: standard or hd (default: standard).",
        },
        model: {
          type: "string",
          description: "Model to use for generation (optional).",
        },
      },
      required: ["prompt"],
    },

    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const prompt = readStringParam(args, "prompt", { required: true });
      const negativePrompt = readStringParam(args, "negativePrompt");
      const size = readStringParam(args, "size") as FridayImageGenerateSize | undefined;
      const style = readStringParam(args, "style") as FridayImageGenerateStyle | undefined;
      const quality = readStringParam(args, "quality") as FridayImageGenerateQuality | undefined;
      const model = readStringParam(args, "model");

      try {
        const result = await imageGenerateService.generate(
          { prompt, negativePrompt, size, style, quality, model },
          signal,
        );

        return imageResultFromFile(
          result.filePath,
          result.mimeType,
          `Generated image: ${result.filePath} (${result.model}, ${result.bytes} bytes)${result.revisedPrompt ? ` — revised prompt: ${result.revisedPrompt}` : ""}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("aborted") || message.includes("abort")) {
          return errorResult("Image generation aborted.");
        }
        return errorResult(`Image generation failed: ${message}`);
      }
    },
  };
}
