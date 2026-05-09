import type { FridaySkillConverterService } from "../../skills/converter/services/friday-skill-converter-service.types.js";
import { FRIDAY_SKILL_SOURCE_FORMATS } from "../../skills/converter/model/friday-skill-converter.types.js";
import {
  redactFridaySkillSourceText,
  redactFridaySkillSourceValue,
} from "../../skills/converter/services/friday-skill-candidate-store.js";

import type { FridayAgentToolDefinition } from "../model/friday-agent.types.js";
import {
  errorResult,
  jsonResult,
  readStringParam,
} from "./friday-agent-tool-helpers.js";

// ─── Factory deps ───

export interface CreateFridayAgentSkillImportToolDeps {
  converterService: FridaySkillConverterService;
}

// ─── Actions ───

type SkillImportAction = "list_converters" | "detect" | "import";

const VALID_ACTIONS = new Set<SkillImportAction>(["list_converters", "detect", "import"]);

// ─── Factory ───

export function createFridayAgentSkillImportTool(
  deps: CreateFridayAgentSkillImportToolDeps,
): FridayAgentToolDefinition {
  const { converterService } = deps;
  const supportedFormats = FRIDAY_SKILL_SOURCE_FORMATS
    .filter((format) => format !== "unknown")
    .join(", ");

  return {
    name: "skill_import",
    description:
      "Preview and convert external skills/automations into Friday draft candidates. Actions: " +
      "list_converters (show available converters and supported formats), " +
      "detect (auto-detect the format of a source), " +
      "import (agent preview only: convert to draft candidates without staging, installing, or making available). " +
      `Supported formats: ${supportedFormats}.`,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...VALID_ACTIONS],
          description: "The action to perform.",
        },
        uri: {
          type: "string",
          description: "Source URI — file path, URL, or git repository (for detect/import).",
        },
        contentBase64: {
          type: "string",
          description: "Base64-encoded source content, alternative to uri (for detect/import).",
        },
        formatHint: {
          type: "string",
          description: "Optional format hint to skip auto-detection (e.g. 'n8n-node', 'openai-gpt-action').",
        },
        target: {
          type: "string",
          description: "Ignored by the agent preview path; staging must go through user-authorized lifecycle routes.",
        },
        replace: {
          type: "boolean",
          description: "Ignored by the agent preview path; replacement requires lifecycle promotion.",
        },
        dryRun: {
          type: "boolean",
          description: "Always treated as true; agent imports are preview-only.",
        },
      },
      required: ["action"],
    },

    async execute(args) {
      const action = readStringParam(args, "action", { required: true }) as SkillImportAction;

      if (!VALID_ACTIONS.has(action)) {
        return errorResult(`Invalid action "${action}". Must be one of: ${[...VALID_ACTIONS].join(", ")}`);
      }

      try {
        switch (action) {
          case "list_converters": {
            const converters = converterService.listConverters();
            return jsonResult({
              converters: converters.map((c) => ({
                id: c.id,
                displayName: c.displayName,
                sourceFormats: c.sourceFormats,
              })),
            });
          }

          case "detect": {
            const uri = readStringParam(args, "uri");
            const contentBase64 = readStringParam(args, "contentBase64");

            if (!uri && !contentBase64) {
              return errorResult("Either 'uri' or 'contentBase64' is required for detect.");
            }

            const detection = await converterService.detect({
              uri: uri ?? undefined,
              contentBase64: contentBase64 ?? undefined,
            });

            if (!detection) {
              return jsonResult({
                detected: false,
                message: "Could not detect format. Try providing a formatHint.",
              });
            }

            return jsonResult({
              detected: true,
              converterId: detection.converterId,
              format: detection.format,
              confidence: detection.confidence,
            });
          }

          case "import": {
            const uri = readStringParam(args, "uri");
            const contentBase64 = readStringParam(args, "contentBase64");
            const formatHint = readStringParam(args, "formatHint");

            if (!uri && !contentBase64) {
              return errorResult("Either 'uri' or 'contentBase64' is required for import.");
            }

            const source = {
              uri: uri ?? undefined,
              contentBase64: contentBase64 ?? undefined,
            };
            const result = await converterService.convert({
              source,
              formatHint: (formatHint ?? "auto") as "auto",
              dryRun: true,
            });
            const safeResult = redactFridaySkillSourceValue(result, source) as typeof result;

            return jsonResult({
              applied: false,
              directInstallRetired: true,
              message: "Agent preview produced draft candidates only. User-authorized staging and lifecycle promotion are required before the skill can run.",
              converterId: safeResult.converterId,
              detectedFormat: safeResult.detectedFormat,
              drafts: safeResult.drafts.map((draft) => ({
                skillId: draft.manifest.id,
                installed: false,
                warningCount: draft.warnings.length,
                warnings: draft.warnings.slice(0, 5),
              })),
              validation: safeResult.validation.map((entry) => ({
                skillId: entry.skillId,
                ok: entry.ok,
                issueCount: entry.issues.length,
                issues: entry.issues.slice(0, 5),
              })),
              registryRefreshed: false,
            });
          }

          default:
            return errorResult(`Unknown action "${String(action)}".`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const uri = readStringParam(args, "uri");
        const contentBase64 = readStringParam(args, "contentBase64");
        return errorResult(`skill_import ${action} failed: ${redactFridaySkillSourceText(message, {
          uri: uri ?? undefined,
          contentBase64: contentBase64 ?? undefined,
        })}`);
      }
    },
  };
}
