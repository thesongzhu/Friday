/**
 * ADK Agent Skills → Friday Package converter.
 *
 * Detects skills following the open Agent Skills specification
 * (SKILL.md with standard YAML frontmatter: name, description, plus optional
 * references/, assets/, scripts/ directories) and converts them into
 * a full Friday skill package (manifest, entrypoint, skill.ui.json, conversion report).
 *
 * @see https://agentskills.io/specification
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { FridayDomainError } from "#errors";

import { parseFridaySkillFrontmatter } from "../../manifest/friday-skill-frontmatter-parser.js";
import type { SkillDesignPattern, SkillManifestV2 } from "../../model/friday-skill-manifest-v2.types.js";
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

const CONVERTER_ID = "adk-skill";
const CONVERTER_DISPLAY_NAME = "ADK Agent Skill";
const CONVERTER_PRIORITY = 45; // Higher than clawdbot (50) — more specific detection

/** ADK spec recognizes exactly these frontmatter fields. */
const ADK_KNOWN_FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
]);

/** Directories defined by the Agent Skills specification. */
const ADK_DIRECTORIES = ["references", "assets", "scripts"] as const;

// ─── Factory ───

export function createFridayAdkSkillConverter(): FridaySkillConverter {
  return {
    id: CONVERTER_ID,
    displayName: CONVERTER_DISPLAY_NAME,
    priority: CONVERTER_PRIORITY,

    async detect(source: FridaySkillConversionSource): Promise<FridaySkillConverterDetection | null> {
      if (!source.uri) {
        return null;
      }

      const skillDir = resolveSkillDir(source.uri);
      const skillMdPath = resolveSkillMdPath(source.uri);
      if (!skillMdPath) {
        return null;
      }

      let content: string;
      try {
        content = readFileSync(skillMdPath, "utf-8");
      } catch {
        return null;
      }

      const parseResult = parseFridaySkillFrontmatter(content);
      if (!parseResult.ok) {
        return null;
      }

      const { frontmatter } = parseResult.value;
      const fmKeys = Object.keys(frontmatter);

      // Must have `name` and `description` (required by ADK spec)
      const hasRequiredKeys = fmKeys.includes("name") && fmKeys.includes("description");
      if (!hasRequiredKeys) {
        return null;
      }

      // All frontmatter keys must be in the ADK known set
      const allKeysAreAdkSpec = fmKeys.every((k) => ADK_KNOWN_FRONTMATTER_KEYS.has(k));

      // Check for ADK-standard directories
      const hasAdkDirs = ADK_DIRECTORIES.some(
        (dir) => existsSync(join(skillDir, dir)) && statSync(join(skillDir, dir)).isDirectory(),
      );

      if (allKeysAreAdkSpec && hasAdkDirs) {
        return {
          converterId: CONVERTER_ID,
          format: "adk-skill",
          confidence: 0.95,
          reasons: [
            "SKILL.md with ADK-spec frontmatter (name + description)",
            `ADK directories found: ${ADK_DIRECTORIES.filter((d) => existsSync(join(skillDir, d))).join(", ")}`,
          ],
        };
      }

      if (allKeysAreAdkSpec) {
        return {
          converterId: CONVERTER_ID,
          format: "adk-skill",
          confidence: 0.75,
          reasons: ["SKILL.md with ADK-spec frontmatter (name + description), no ADK directories"],
        };
      }

      return null;
    },

    async convert(
      source: FridaySkillConversionSource,
      ctx: FridaySkillConverterContext,
    ): Promise<FridaySkillConverterResult> {
      if (!source.uri) {
        throw new FridayDomainError("VALIDATION_ERROR", "AdkSkillConverter requires a source URI", { httpStatus: 400 });
      }

      const skillDir = resolveSkillDir(source.uri);
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
      const dirName = basename(skillDir);
      const warnings: string[] = [];

      // Detect design patterns from the SKILL.md body
      const designPatterns = detectDesignPatterns(body);

      // Collect all files from ADK directories
      const supplementaryFiles = collectAdkDirectoryFiles(skillDir, warnings);

      // Detect scripts for runtime
      const scripts = collectScripts(skillDir);
      const hasScripts = scripts.length > 0;
      const runtimeKind = inferRuntimeKind(scripts);

      // Build manifest
      const manifest = buildManifest(frontmatter, body, dirName, designPatterns, runtimeKind, hasScripts, warnings);

      // Build UI schema
      const uiSchema = buildUiSchema(manifest);

      // Build files array
      const files: FridayConvertedSkillFile[] = [];

      // Preserve original SKILL.md
      files.push({ path: "SKILL.md", content });

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

      // Include all supplementary files (references, assets, scripts)
      for (const file of supplementaryFiles) {
        files.push(file);
      }

      // Generate entrypoint if scripts exist
      if (hasScripts) {
        const entrypoint = buildEntrypoint(scripts);
        files.push({
          path: manifest.runtime.entrypoint,
          content: entrypoint,
          executable: true,
        });
      }

      const conversionReport = {
        sourceFormat: "adk-skill" as const,
        sourceRef: source.uri,
        convertedAt: ctx.nowIso(),
        converterId: CONVERTER_ID,
      };

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
        detectedFormat: "adk-skill",
        drafts: [draft],
      };
    },
  };
}

// ─── Design Pattern Detection ───

/**
 * Detects which of the 5 ADK design patterns a SKILL.md body uses.
 *
 * Patterns:
 *   tool-wrapper  — references conventions/docs, no templates, no pipeline steps
 *   generator     — references a template in assets/, fills structured output
 *   reviewer      — references a checklist, evaluates against it by severity
 *   inversion     — structured interview phases with a "DO NOT" gate before acting
 *   pipeline      — numbered sequential steps with explicit gate conditions
 */
function detectDesignPatterns(body: string): SkillDesignPattern[] {
  const patterns: SkillDesignPattern[] = [];
  const lower = body.toLowerCase();

  // Reviewer: checklist reference + severity grouping
  if (
    (lower.includes("checklist") || lower.includes("review-checklist")) &&
    (lower.includes("severity") || lower.includes("critical") && lower.includes("high") && lower.includes("medium"))
  ) {
    patterns.push("reviewer");
  }

  // Inversion: interview phases + gate
  if (
    (lower.includes("phase") || lower.includes("interview")) &&
    (lower.includes("do not") && (lower.includes("until") || lower.includes("before")))
  ) {
    patterns.push("inversion");
  }

  // Pipeline: sequential steps with gate conditions
  if (
    (lower.includes("step 1") || lower.includes("step 2") || lower.includes("## step")) &&
    (lower.includes("do not proceed") || lower.includes("gate") || lower.includes("confirm"))
  ) {
    patterns.push("pipeline");
  }

  // Generator: template reference in assets/
  if (
    (lower.includes("template") && (lower.includes("assets/") || lower.includes("fill"))) ||
    (lower.includes("generation protocol") || lower.includes("output template"))
  ) {
    patterns.push("generator");
  }

  // Tool Wrapper: conventions/rules reference, no template, no pipeline
  if (
    (lower.includes("conventions") || lower.includes("best practices") || lower.includes("rules")) &&
    lower.includes("references/") &&
    patterns.length === 0 // tool-wrapper is the simplest — only if no other pattern matched
  ) {
    patterns.push("tool-wrapper");
  }

  return patterns;
}

// ─── File Collection ───

function collectAdkDirectoryFiles(
  skillDir: string,
  warnings: string[],
): FridayConvertedSkillFile[] {
  const files: FridayConvertedSkillFile[] = [];

  for (const dirName of ADK_DIRECTORIES) {
    const dirPath = join(skillDir, dirName);
    if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
      continue;
    }

    let entries: string[];
    try {
      entries = readdirSync(dirPath);
    } catch {
      warnings.push(`Could not read ADK directory: ${dirName}/`);
      continue;
    }

    for (const entry of entries) {
      const filePath = join(dirPath, entry);
      if (!statSync(filePath).isFile()) {
        continue;
      }

      try {
        const content = readFileSync(filePath, "utf-8");
        const isScript = dirName === "scripts";
        files.push({
          path: `${dirName}/${entry}`,
          content,
          executable: isScript ? true : undefined,
        });
      } catch {
        warnings.push(`Could not read file: ${dirName}/${entry}`);
      }
    }
  }

  return files;
}

function collectScripts(skillDir: string): string[] {
  const scriptsDir = join(skillDir, "scripts");
  if (!existsSync(scriptsDir) || !statSync(scriptsDir).isDirectory()) {
    return [];
  }

  try {
    return readdirSync(scriptsDir).filter((f: string) => {
      const full = join(scriptsDir, f);
      return statSync(full).isFile();
    });
  } catch {
    return [];
  }
}

function inferRuntimeKind(scripts: string[]): "shell" | "node" | "python" {
  const exts = scripts.map((s) => extname(s).toLowerCase());

  if (exts.some((e) => e === ".py")) return "python";
  if (exts.some((e) => e === ".js" || e === ".mjs" || e === ".ts")) return "node";
  return "shell";
}

// ─── Manifest ───

function buildManifest(
  frontmatter: Record<string, string>,
  body: string,
  dirName: string,
  designPatterns: SkillDesignPattern[],
  runtimeKind: "shell" | "node" | "python",
  hasScripts: boolean,
  warnings: string[],
): SkillManifestV2 {
  const skillId = dirName;
  const skillName = frontmatter.name ?? dirName;
  const description = frontmatter.description
    ?? body.split("\n").find((line) => line.trim().length > 0 && !line.startsWith("#"))?.trim()
    ?? "";

  if (!frontmatter.description) {
    warnings.push("No description in frontmatter — extracted from body.");
  }

  const entrypoint = runtimeKind === "node"
    ? "index.mjs"
    : runtimeKind === "python"
      ? "scripts/main.py"
      : "run.sh";

  const manifest: SkillManifestV2 = {
    schemaVersion: "2.0",
    id: skillId,
    name: skillName,
    description,
    version: "1.0.0",
    kind: "conversation",
    category: "utility",
    author: { name: "unknown" },
    license: frontmatter.license,
    tags: [],
    designPatterns: designPatterns.length > 0 ? designPatterns : undefined,
    runtime: {
      kind: runtimeKind,
      entrypoint,
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
      userInvocable: true,
      modelInvocable: true,
      priority: 50,
      modes: ["intent"],
    },
    requirements: {
      bins: [],
      env: [],
      config: [],
      os: ["darwin", "linux", "win32"],
    },
    inputs: [
      {
        key: "prompt",
        type: "string",
        required: false,
        label: "Prompt",
        help: "User input or context for the skill",
      },
    ],
    outputs: [
      { key: "result", type: "string", description: "Skill output" },
    ],
    permissions: {
      grants: hasScripts
        ? [{
            id: "shell.execute",
            resource: "shell",
            action: "execute",
            required: true,
            reason: "ADK skill includes executable scripts",
          }]
        : [],
      promptOn: hasScripts ? ["shell.execute"] : [],
    },
    schemas: { input: null, state: null, output: null },
    flow: null,
    executionTargets: {
      allowedSatelliteTypes: ["phone", "desktop", "rpi", "cloud-vm"],
      requiredCapabilities: [],
    },
    telemetry: { events: [] },
  };

  // Parse compatibility for OS requirements
  if (frontmatter.compatibility) {
    try {
      const compat = JSON.parse(frontmatter.compatibility);
      if (Array.isArray(compat?.os)) {
        const validOs = new Set(["darwin", "linux", "win32"]);
        manifest.requirements.os = compat.os.filter((o: string) => validOs.has(o));
      }
    } catch {
      warnings.push("Could not parse compatibility field from frontmatter.");
    }
  }

  return manifest;
}

// ─── UI Schema ───

function buildUiSchema(manifest: SkillManifestV2): FridaySkillUiSchemaV1 {
  const fields: FridaySkillUiSchemaV1["fields"] = manifest.inputs.map((input) => ({
    id: `field-${input.key}`,
    inputKey: input.key,
    kind: input.key === "prompt" ? "textarea" as const : "text" as const,
    label: input.label,
    required: input.required,
    help: input.help,
    placeholder: `Enter ${input.label.toLowerCase()}…`,
  }));

  return {
    schemaVersion: "1.0",
    title: manifest.name,
    description: manifest.description || undefined,
    sections: [
      {
        id: "main",
        label: "Configuration",
        fieldIds: fields.map((f) => f.id),
      },
    ],
    fields,
    outputs: manifest.outputs.map((o) => ({
      id: `output-${o.key}`,
      outputKey: o.key,
      label: o.description ?? o.key,
      widget: "text" as const,
    })),
    actions: [
      { id: "run", label: "Run", style: "primary" },
      { id: "reset", label: "Reset", style: "secondary" },
    ],
  };
}

// ─── Entrypoint ───

function buildEntrypoint(scripts: string[]): string {
  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "# Auto-generated entrypoint for ADK skill scripts",
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/scripts" && pwd)"',
    "",
  ];

  if (scripts.length === 1) {
    lines.push(`exec "$SCRIPT_DIR/${scripts[0]}"`);
  } else {
    lines.push('SCRIPT="${1:-}"');
    lines.push('if [ -z "$SCRIPT" ]; then');
    lines.push(`  echo "Available scripts: ${scripts.join(", ")}" >&2`);
    lines.push("  exit 1");
    lines.push("fi");
    lines.push('exec "$SCRIPT_DIR/$SCRIPT"');
  }

  return lines.join("\n") + "\n";
}

// ─── Path resolution ───

function resolveSkillMdPath(uri: string): string | null {
  if (uri.endsWith("SKILL.md") && existsSync(uri)) {
    return uri;
  }
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
