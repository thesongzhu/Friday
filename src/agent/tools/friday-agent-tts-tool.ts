import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import {
  errorResult,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";
import type { FridayTtsService } from "../../media/friday-tts-service.js";

// ─── Types ───

export interface CreateFridayAgentTtsToolOptions {
  ttsService: FridayTtsService;
}

// ─── Factory ───

export function createFridayAgentTtsTool(
  options: CreateFridayAgentTtsToolOptions,
): FridayAgentToolDefinition {
  const { ttsService } = options;

  return {
    name: "tts",
    description:
      "Convert text to speech. Returns the path to the generated audio file, MIME type, and byte size. " +
      "Supports multiple voices, formats (mp3/wav/opus), and speed control.",
    parameters: {
      properties: {
        text: {
          type: "string",
          description: "The text to convert to speech.",
        },
        voice: {
          type: "string",
          description: "Voice identifier (provider-specific). Default: alloy.",
        },
        format: {
          type: "string",
          enum: ["mp3", "wav", "opus"],
          description: "Output audio format (default: mp3).",
        },
        speed: {
          type: "number",
          description: "Playback speed (0.25 - 4.0, default: 1.0).",
        },
        model: {
          type: "string",
          description: "TTS model to use (optional).",
        },
      },
      required: ["text"],
    },

    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const text = readStringParam(args, "text", { required: true });
      const voice = readStringParam(args, "voice");
      const format = readStringParam(args, "format") as "mp3" | "wav" | "opus" | undefined;
      const speed = readNumberParam(args, "speed");
      const model = readStringParam(args, "model");

      try {
        const result = await ttsService.synthesize(
          { text, voice, format, speed, model },
          signal,
        );

        return jsonResult({
          filePath: result.filePath,
          mimeType: result.mimeType,
          bytes: result.bytes,
          voice: result.voice,
          model: result.model,
          format: result.format,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("aborted") || message.includes("abort")) {
          return errorResult("TTS synthesis aborted.");
        }
        return errorResult(`TTS failed: ${message}`);
      }
    },
  };
}
