/**
 * Clawdbot SKILL.md → Friday Package converter.
 *
 * Detects legacy SKILL.md files with frontmatter and converts them into
 * a full Friday skill package (manifest, run.sh, skill.ui.json, conversion report).
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { FridayDomainError } from "#errors";

import { parseFridaySkillFrontmatter } from "../../manifest/friday-skill-frontmatter-parser.js";
import type { ParsedSkillFrontmatter } from "../../manifest/friday-skill-frontmatter-parser.js";
import { extractMarkdownCommands } from "../utils/friday-markdown-command-extractor.js";
import type { ExtractedCommand } from "../utils/friday-markdown-command-extractor.js";
import type { SkillManifestV2 } from "../../model/friday-skill-manifest-v2.types.js";
import type { FridaySkillUiSchemaV1 } from "../../generator/model/friday-skill-ui-schema.types.js";
import type {
  FridayConvertedSkillDraft,
  FridayConvertedSkillFile,
  FridaySkillConversionSource,
  FridaySkillConverter,
  FridaySkillConverterContext,
  FridaySkillConverterDetection,
  FridaySkillConverterResult,
} from "../model/friday-skill-converter.types.js";

// ─── Constants ───

const CONVERTER_ID = "clawdbot-skill-md";
const CONVERTER_DISPLAY_NAME = "Clawdbot SKILL.md";
const CONVERTER_PRIORITY = 50;

// ─── Factory ───

export function createClawdbotSkillMdConverter(): FridaySkillConverter {
  return {
    id: CONVERTER_ID,
    displayName: CONVERTER_DISPLAY_NAME,
    priority: CONVERTER_PRIORITY,

    async detect(source: FridaySkillConversionSource): Promise<FridaySkillConverterDetection | null> {
      if (!source.uri) {
        return null;
      }

      const skillMdPath = resolveSkillMdPath(source.uri);
      if (!skillMdPath) {
        return null;
      }

      let content: string;
      try {
        content = readFileSync(skillMdPath, "utf-8");
      } catch (err) {
      console.warn("[friday][clawdbot-skill-md-converter] operation failed:", err instanceof Error ? err.message : String(err));
        return null;
      }

      const parseResult = parseFridaySkillFrontmatter(content);
      if (!parseResult.ok) {
        return null;
      }

      const { frontmatter } = parseResult.value;
      const hasFrontmatter = Object.keys(frontmatter).length > 0;

      // SKILL.md with frontmatter is high confidence
      if (hasFrontmatter) {
        return {
          converterId: CONVERTER_ID,
          format: "clawdbot-skill-md",
          confidence: 0.9,
          reasons: ["Found SKILL.md with YAML frontmatter"],
        };
      }

      // SKILL.md without frontmatter is lower confidence but still valid
      return {
        converterId: CONVERTER_ID,
        format: "clawdbot-skill-md",
        confidence: 0.5,
        reasons: ["Found SKILL.md without frontmatter"],
      };
    },

    async convert(
      source: FridaySkillConversionSource,
      ctx: FridaySkillConverterContext,
    ): Promise<FridaySkillConverterResult> {
      if (!source.uri) {
        throw new FridayDomainError("VALIDATION_ERROR", "ClawdbotSkillMdConverter requires a source URI", { httpStatus: 400 });
      }

      const skillMdPath = resolveSkillMdPath(source.uri);
      if (!skillMdPath) {
        throw new FridayDomainError("CONVERTER_SOURCE_NOT_FOUND", `SKILL.md not found at: ${source.uri}`, { httpStatus: 404 });
      }

      const content = readFileSync(skillMdPath, "utf-8");
      const parseResult = parseFridaySkillFrontmatter(content);
      if (!parseResult.ok) {
        throw new FridayDomainError("PARSE_ERROR", `Failed to parse SKILL.md frontmatter: ${parseResult.error.message}`, { httpStatus: 422 });
      }

      const { frontmatter, body } = parseResult.value;
      const commands = extractMarkdownCommands(body);
      const dirName = basename(resolveSkillDir(source.uri));
      const warnings: string[] = [];

      // Build manifest
      const manifest = buildManifest(frontmatter, body, dirName, commands, warnings);

      // Build UI schema
      const uiSchema = buildUiSchema(manifest, commands);

      // Build files
      const files: FridayConvertedSkillFile[] = [];

      // run.sh
      const runSh = buildRunSh(commands);
      files.push({
        path: "run.sh",
        content: runSh,
        executable: true,
      });

      // skill.manifest.json
      files.push({
        path: "skill.manifest.json",
        content: JSON.stringify(manifest, null, 2),
      });

      // skill.ui.json
      files.push({
        path: "skill.ui.json",
        content: JSON.stringify(uiSchema, null, 2),
      });

      // SKILL.md (preserve original)
      files.push({
        path: "SKILL.md",
        content,
      });

      const conversionReport = {
        sourceFormat: "clawdbot-skill-md" as const,
        sourceRef: source.uri,
        convertedAt: ctx.nowIso(),
        converterId: CONVERTER_ID,
      };

      // conversion.report.json
      files.push({
        path: "conversion.report.json",
        content: JSON.stringify(conversionReport, null, 2),
      });

      const draft: FridayConvertedSkillDraft = {
        manifest,
        uiSchema,
        files,
        warnings,
        conversionReport,
      };

      return {
        converterId: CONVERTER_ID,
        detectedFormat: "clawdbot-skill-md",
        drafts: [draft],
      };
    },
  };
}

// ─── Helpers ───

function resolveSkillMdPath(uri: string): string | null {
  // If URI points directly to SKILL.md
  if (uri.endsWith("SKILL.md") && existsSync(uri)) {
    return uri;
  }

  // If URI is a directory, look for SKILL.md inside
  const skillMdInDir = join(uri, "SKILL.md");
  if (existsSync(skillMdInDir)) {
    return skillMdInDir;
  }

  return null;
}

function resolveSkillDir(uri: string): string {
  if (uri.endsWith("SKILL.md")) {
    return join(uri, "..");
  }
  return uri;
}

function buildManifest(
  frontmatter: ParsedSkillFrontmatter,
  body: string,
  dirName: string,
  commands: ExtractedCommand[],
  warnings: string[],
): SkillManifestV2 {
  const skillId = frontmatter.skillKey ?? dirName;
  const skillName = frontmatter.name ?? skillId;
  const description = body.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";

  // Extract placeholders from all commands for inputs
  const placeholders = extractPlaceholders(commands);

  // Build inputs from placeholders
  const inputs: SkillManifestV2["inputs"] = [];

  // Add command selector input if multiple commands
  if (commands.length > 1) {
    inputs.push({
      key: "command",
      type: "string",
      required: true,
      label: "Command",
      help: "Select which command to run",
      validation: {
        enum: commands.map((c) => c.label),
      },
    });
  }

  // Add placeholder inputs
  for (const placeholder of placeholders) {
    inputs.push({
      key: placeholder,
      type: "string",
      required: false,
      label: placeholder.charAt(0).toUpperCase() + placeholder.slice(1),
      help: `Value for {{${placeholder}}}`,
    });
  }

  // Parse OS requirements
  const osRaw = frontmatter.os?.split(",").map((o) => o.trim()).filter(Boolean) ?? [];
  const validOs = new Set<string>(["darwin", "linux", "win32"]);
  const os = osRaw.filter((o) => validOs.has(o)) as Array<"darwin" | "linux" | "win32">;
  if (os.length === 0) {
    os.push("darwin", "linux", "win32");
  }

  // Parse bins
  const bins = frontmatter["requires.bins"]?.split(",").map((b) => b.trim()).filter(Boolean) ?? [];

  // Parse env
  const envVars: string[] = [];
  if (frontmatter.primaryEnv) {
    envVars.push(frontmatter.primaryEnv);
  }
  const extraEnv = frontmatter["requires.env"]?.split(",").map((e) => e.trim()).filter(Boolean) ?? [];
  for (const e of extraEnv) {
    if (!envVars.includes(e)) {
      envVars.push(e);
    }
  }

  // Parse config
  const config = frontmatter["requires.config"]?.split(",").map((c) => c.trim()).filter(Boolean) ?? [];

  // Invocation policy
  const userInvocable = frontmatter.userInvocable !== "false";
  const modelInvocable = frontmatter.disableModelInvocation !== "true";

  if (!modelInvocable) {
    warnings.push("Model invocation disabled — skill will only be usable via direct user action.");
  }

  if (commands.length === 0) {
    warnings.push("No executable command blocks found in SKILL.md body.");
  }

  return {
    schemaVersion: "2.0",
    id: skillId,
    name: skillName,
    description,
    version: "1.0.0",
    kind: "conversation",
    category: "utility",
    author: { name: frontmatter.author ?? "unknown" },
    homepage: frontmatter.homepage,
    license: frontmatter.license,
    tags: frontmatter.tags?.split(",").map((t) => t.trim()).filter(Boolean) ?? [],
    runtime: {
      kind: "shell",
      entrypoint: "run.sh",
      minHubVersion: "1.0.0",
      apiVersion: "1",
      timeoutMsDefault: 30_000,
    },
    triggers: {
      intents: [],
      phrases: [],
      channels: ["*"],
    },
    invocation: {
      userInvocable,
      modelInvocable,
      priority: 50,
      modes: ["intent"],
    },
    requirements: {
      bins,
      env: envVars,
      config,
      os,
    },
    inputs,
    outputs: [
      { key: "stdout", type: "string", description: "Command standard output" },
      { key: "stderr", type: "string", description: "Command standard error" },
      { key: "exitCode", type: "number", description: "Command exit code" },
    ],
    permissions: {
      grants: [
        {
          id: "shell.execute",
          resource: "shell",
          action: "execute",
          required: true,
          reason: "Converted shell skill — executes commands via run.sh",
        },
      ],
      promptOn: ["shell.execute"],
    },
    schemas: { input: null, state: null, output: null },
    flow: null,
    executionTargets: {
      allowedSatelliteTypes: ["phone", "desktop", "rpi", "cloud-vm"],
      requiredCapabilities: [],
    },
    telemetry: { events: [] },
  };
}

function buildUiSchema(
  manifest: SkillManifestV2,
  commands: ExtractedCommand[],
): FridaySkillUiSchemaV1 {
  const fields: FridaySkillUiSchemaV1["fields"] = [];
  const fieldIds: string[] = [];

  for (const input of manifest.inputs) {
    const fieldId = `field-${input.key}`;
    fieldIds.push(fieldId);

    fields.push({
      id: fieldId,
      inputKey: input.key,
      kind: input.key === "command" ? "select" : "text",
      label: input.label,
      required: input.required,
      help: input.help,
      placeholder: input.key === "command"
        ? "Select a command…"
        : `Enter ${input.label.toLowerCase()}…`,
      validation: input.validation,
    });
  }

  return {
    schemaVersion: "1.0",
    title: manifest.name,
    description: manifest.description || undefined,
    sections: [
      {
        id: "main",
        label: "Configuration",
        fieldIds,
      },
    ],
    fields,
    outputs: manifest.outputs.map((o) => ({
      id: `output-${o.key}`,
      outputKey: o.key,
      label: o.description ?? o.key,
      widget: o.type === "number" ? "text" as const : "text" as const,
    })),
    actions: [
      { id: "run", label: "Run", style: "primary" },
      { id: "reset", label: "Reset", style: "secondary" },
    ],
  };
}

function buildRunSh(commands: ExtractedCommand[]): string {
  const lines: string[] = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
  ];

  if (commands.length === 0) {
    lines.push('echo "No commands available"');
    lines.push("exit 1");
    return lines.join("\n") + "\n";
  }

  if (commands.length === 1) {
    lines.push("# Single command — run directly");
    lines.push(commandToEnvRefs(commands[0]!.command));
    return lines.join("\n") + "\n";
  }

  // Multiple commands — dispatch based on FRIDAY_INPUT_COMMAND
  lines.push('COMMAND="${FRIDAY_INPUT_COMMAND:-}"');
  lines.push("");
  lines.push('case "$COMMAND" in');

  for (const cmd of commands) {
    // Escape the label for use in a shell case pattern
    const safeLabel = escapeCaseLabel(cmd.label);
    lines.push(`  "${safeLabel}")`);
    // Apply placeholder substitution and indent each line of the command
    const substitutedCommand = commandToEnvRefs(cmd.command);
    for (const cmdLine of substitutedCommand.split("\n")) {
      lines.push(`    ${cmdLine}`);
    }
    lines.push("    ;;");
  }

  lines.push("  *)");
  lines.push('    echo "Unknown command: $COMMAND" >&2');
  lines.push('    echo "Available commands:" >&2');
  for (const cmd of commands) {
    const safeLabel = escapeCaseLabel(cmd.label);
    lines.push(`    echo "  - ${safeLabel}" >&2`);
  }
  lines.push("    exit 1");
  lines.push("    ;;");
  lines.push("esac");

  return lines.join("\n") + "\n";
}

/**
 * Sanitizes a command label for use as a shell case pattern.
 * Strips/escapes characters that could cause injection: quotes, backticks, $, etc.
 */
function escapeCaseLabel(label: string): string {
  return label.replace(/["`$\\!;|&()<>{}[\]*?~#']/g, "");
}

/**
 * Replaces `{{variable}}` placeholders with shell env-var references.
 */
function commandToEnvRefs(command: string): string {
  return command.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return `"$FRIDAY_INPUT_${key.toUpperCase()}"`;
  });
}

/**
 * Extracts unique placeholder names from all commands.
 */
function extractPlaceholders(commands: ExtractedCommand[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const cmd of commands) {
    const matches = cmd.command.matchAll(/\{\{(\w+)\}\}/g);
    for (const match of matches) {
      const name = match[1]!;
      if (!seen.has(name)) {
        seen.add(name);
        result.push(name);
      }
    }
  }

  return result;
}
