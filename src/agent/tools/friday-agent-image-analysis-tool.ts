import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import type { FridayProviderTenantContext } from "#providers";
import {
  errorResult,
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";
import {
  validateAndNormalizeImages,
  validateDetail,
} from "./friday-agent-image-analysis-helpers.js";
import type { ImageDetail } from "./friday-agent-image-analysis-helpers.js";

// ─── Types ───

export interface CreateFridayAgentImageAnalysisToolOptions {
  /**
   * Callable that performs the vision model request.
   * Injected so the tool is provider-agnostic.
   */
  analyzeImages: FridayImageAnalysisFn;
  /** Default model to use when none specified. */
  defaultModel?: string;
  /** Workspace root directory — local file reads are restricted to this dir + temp. */
  workspaceRoot?: string;
}

export interface FridayImageAnalysisRequest {
  prompt: string;
  images: FridayImageAnalysisInput[];
  providerId?: string;
  model?: string;
  detail: ImageDetail;
  maxTokens?: number;
  tenantContext?: FridayProviderTenantContext;
}

export interface FridayImageAnalysisInput {
  type: "base64" | "url";
  mimeType?: string;
  data?: string;
  url?: string;
}

export interface FridayImageAnalysisResult {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

export type FridayImageAnalysisFn = (
  request: FridayImageAnalysisRequest,
  signal: AbortSignal,
) => Promise<FridayImageAnalysisResult>;

// ─── Factory ───

export function createFridayAgentImageAnalysisTool(
  options: CreateFridayAgentImageAnalysisToolOptions,
): FridayAgentToolDefinition {
  const { analyzeImages, defaultModel, workspaceRoot } = options;

  return {
    name: "image_analysis",
    description:
      "Analyze one or more images using a vision model. " +
      "Accepts local file paths, URLs, or data URIs. " +
      "Returns the model's analysis text and metadata.",
    parameters: {
      properties: {
        prompt: {
          type: "string",
          description: "The analysis prompt / question about the image(s).",
        },
        images: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of image inputs: local file paths, HTTP(S) URLs, or data URIs.",
        },
        model: {
          type: "string",
          description: "Vision model to use (optional, uses default if omitted).",
        },
        detail: {
          type: "string",
          enum: ["low", "high", "auto"],
          description: "Image detail level (default: auto).",
        },
        maxTokens: {
          type: "number",
          description: "Maximum tokens for the response.",
        },
      },
      required: ["prompt", "images"],
    },

    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const prompt = readStringParam(args, "prompt", { required: true });
      const rawImages = readStringArrayParam(args, "images", { required: true });
      const model = readStringParam(args, "model") ?? defaultModel;
      const rawDetail = readStringParam(args, "detail");
      const maxTokens = readNumberParam(args, "maxTokens", { integer: true });

      // Validate detail
      let detail: ImageDetail;
      try {
        detail = validateDetail(rawDetail);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(message);
      }

      // Validate and normalize images (with workspace boundary check)
      const validation = validateAndNormalizeImages(rawImages, { workspaceRoot });
      if (!validation.valid || !validation.images) {
        return errorResult(validation.error ?? "Invalid images input.");
      }

      try {
        const result = await analyzeImages(
          {
            prompt,
            images: validation.images,
            model,
            detail,
            maxTokens,
          },
          signal,
        );

        return jsonResult({
          analysis: result.text,
          model: result.model,
          imageCount: validation.images.length,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("aborted") || message.includes("abort")) {
          return errorResult("Image analysis aborted.");
        }
        return errorResult(`Image analysis failed: ${message}`);
      }
    },
  };
}
