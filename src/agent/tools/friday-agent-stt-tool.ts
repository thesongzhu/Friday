import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import {
  errorResult,
  jsonResult,
  readStringParam,
} from "./friday-agent-tool-helpers.js";
import type { FridaySttService } from "../../media/friday-stt-service.js";

// ─── Types ───

export interface CreateFridayAgentSttToolOptions {
  sttService: FridaySttService;
}

// ─── Factory ───

export function createFridayAgentSttTool(
  options: CreateFridayAgentSttToolOptions,
): FridayAgentToolDefinition {
  const { sttService } = options;

  return {
    name: "stt",
    description:
      "Convert speech to text (transcription). Accepts audio files " +
      "(mp3, wav, m4a, ogg, flac, webm, etc.) and returns the transcribed text. " +
      "Max file size: 25MB. Supports language hints for better accuracy.",
    parameters: {
      properties: {
        audioFilePath: {
          type: "string",
          description: "Path to the audio file to transcribe.",
        },
        language: {
          type: "string",
          description: "Language hint in ISO 639-1 format (e.g. 'en', 'zh', 'ja'). Optional.",
        },
        model: {
          type: "string",
          description: "STT model to use (optional).",
        },
        prompt: {
          type: "string",
          description: "Optional prompt to guide the transcription (provide context or expected words).",
        },
      },
      required: ["audioFilePath"],
    },

    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const audioFilePath = readStringParam(args, "audioFilePath", { required: true });
      const language = readStringParam(args, "language");
      const model = readStringParam(args, "model");
      const prompt = readStringParam(args, "prompt");

      try {
        const result = await sttService.transcribe(
          { audioFilePath, language, model, prompt },
          signal,
        );

        return jsonResult({
          text: result.text,
          model: result.model,
          language: result.language,
          durationSeconds: result.durationSeconds,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("aborted") || message.includes("abort")) {
          return errorResult("Speech-to-text aborted.");
        }
        return errorResult(`STT failed: ${message}`);
      }
    },
  };
}
