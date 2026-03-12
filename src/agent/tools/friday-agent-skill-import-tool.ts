import type { FridaySkillConverterService } from "../../skills/converter/services/friday-skill-converter-service.types.js";
import { FRIDAY_SKILL_SOURCE_FORMATS } from "../../skills/converter/model/friday-skill-converter.types.js";

import type { FridayAgentToolDefinition } from "../model/friday-agent.types.js";
import {
  errorResult,
  jsonResult,
  readBooleanParam,
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
      "Import and convert external skills/automations into Friday format. Actions: " +
      "list_converters (show available converters and supported formats), " +
      "detect (auto-detect the format of a source), " +
      "import (convert and install a skill from an external source). " +
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
          description: "Installation target: 'managed' (default), 'workspace', or a custom directory path.",
        },
        replace: {
          type: "boolean",
          description: "If true, overwrite existing skill with same ID (default: false).",
        },
        dryRun: {
          type: "boolean",
          description: "If true, validate only without installing (default: false).",
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
            const targetStr = readStringParam(args, "target");
            const replace = readBooleanParam(args, "replace") ?? false;
            const dryRun = readBooleanParam(args, "dryRun") ?? false;

            if (!uri && !contentBase64) {
              return errorResult("Either 'uri' or 'contentBase64' is required for import.");
            }

            // Resolve target
            let target: "managed" | "workspace" | { path: string } = "managed";
            if (targetStr === "workspace") {
              target = "workspace";
            } else if (targetStr && targetStr !== "managed") {
              target = { path: targetStr };
            }

            const result = await converterService.import({
              source: {
                uri: uri ?? undefined,
                contentBase64: contentBase64 ?? undefined,
              },
              formatHint: (formatHint ?? "auto") as "auto",
              target,
              replace,
              dryRun,
              refreshRegistry: !dryRun,
            });

            return jsonResult({
              converterId: result.converterId,
              detectedFormat: result.detectedFormat,
              imports: result.imports.map((imp) => ({
                skillId: imp.skillId,
                skillDir: imp.skillDir,
                installed: imp.installed,
                issueCount: imp.issues.length,
                issues: imp.issues.slice(0, 5),
              })),
              registryRefreshed: result.registryRefreshed,
            });
          }

          default:
            return errorResult(`Unknown action "${String(action)}".`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(`skill_import ${action} failed: ${message}`);
      }
    },
  };
}
