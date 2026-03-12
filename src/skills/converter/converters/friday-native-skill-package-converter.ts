/**
 * Native Friday package passthrough converter.
 *
 * Detects existing `skill.manifest.json` packages and passes them through
 * with validation — no transformation needed.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { FridayDomainError } from "#errors";

import { safeParseFridaySkillManifestV2 } from "../../manifest/friday-skill-manifest.schema.js";
import { applyFridaySkillManifestDefaults } from "../../manifest/friday-skill-manifest-defaults.js";
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

const CONVERTER_ID = "native-friday-package";
const CONVERTER_DISPLAY_NAME = "Native Friday Package";
const CONVERTER_PRIORITY = 100; // Highest priority — native is authoritative

// ─── Factory ───

export function createNativeSkillPackageConverter(): FridaySkillConverter {
  return {
    id: CONVERTER_ID,
    displayName: CONVERTER_DISPLAY_NAME,
    priority: CONVERTER_PRIORITY,

    async detect(source: FridaySkillConversionSource): Promise<FridaySkillConverterDetection | null> {
      if (!source.uri) {
        return null;
      }

      const manifestPath = resolveManifestPath(source.uri);
      if (!manifestPath) {
        return null;
      }

      // Verify it parses as valid JSON
      try {
        const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
        if (raw && typeof raw === "object" && raw.schemaVersion === "2.0") {
          return {
            converterId: CONVERTER_ID,
            format: "friday-package",
            confidence: 1.0,
            reasons: ["Found skill.manifest.json with schemaVersion 2.0"],
          };
        }

        // Has manifest but not v2 — lower confidence
        return {
          converterId: CONVERTER_ID,
          format: "friday-package",
          confidence: 0.6,
          reasons: ["Found skill.manifest.json but schemaVersion is not 2.0"],
        };
      } catch {
        return null;
      }
    },

    async convert(
      source: FridaySkillConversionSource,
      ctx: FridaySkillConverterContext,
    ): Promise<FridaySkillConverterResult> {
      if (!source.uri) {
        throw new FridayDomainError("VALIDATION_ERROR", "NativeSkillPackageConverter requires a source URI", { httpStatus: 400 });
      }

      const manifestPath = resolveManifestPath(source.uri);
      if (!manifestPath) {
        throw new FridayDomainError("CONVERTER_MANIFEST_NOT_FOUND", `skill.manifest.json not found at: ${source.uri}`, { httpStatus: 404 });
      }

      const skillDir = resolveSkillDir(source.uri);

      // Read and validate manifest
      const rawText = readFileSync(manifestPath, "utf-8");
      let rawObj: unknown;
      try {
        rawObj = JSON.parse(rawText);
      } catch {
        throw new FridayDomainError("PARSE_ERROR", `Invalid JSON in skill.manifest.json at: ${manifestPath}`, { httpStatus: 422 });
      }

      const defaulted = applyFridaySkillManifestDefaults(rawObj as Record<string, unknown>);
      const parseResult = safeParseFridaySkillManifestV2(defaulted);
      if (!parseResult.success) {
        const issues = parseResult.error.issues.map((i: { message: string }) => i.message).join("; ");
        throw new FridayDomainError("VALIDATION_ERROR", `Manifest validation failed: ${issues}`, { httpStatus: 422 });
      }

      const manifest: SkillManifestV2 = parseResult.data;
      const warnings: string[] = [];

      // Read UI schema
      const uiSchemaPath = join(skillDir, "skill.ui.json");
      let uiSchema: FridaySkillUiSchemaV1;

      if (existsSync(uiSchemaPath)) {
        try {
          uiSchema = JSON.parse(readFileSync(uiSchemaPath, "utf-8")) as FridaySkillUiSchemaV1;
        } catch {
          throw new FridayDomainError("PARSE_ERROR", `Invalid JSON in skill.ui.json at: ${uiSchemaPath}`, { httpStatus: 422 });
        }
      } else {
        warnings.push("skill.ui.json not found — generating minimal UI schema");
        uiSchema = buildMinimalUiSchema(manifest);
      }

      // Collect all files in the directory
      const files = collectFiles(skillDir);

      const conversionReport = {
        sourceFormat: "friday-package" as const,
        sourceRef: source.uri,
        convertedAt: ctx.nowIso(),
        converterId: CONVERTER_ID,
      };

      const draft: FridayConvertedSkillDraft = {
        manifest,
        uiSchema,
        files,
        warnings,
        conversionReport,
      };

      return {
        converterId: CONVERTER_ID,
        detectedFormat: "friday-package",
        drafts: [draft],
      };
    },
  };
}

// ─── Helpers ───

function resolveManifestPath(uri: string): string | null {
  // If URI points directly to the manifest file
  if (uri.endsWith("skill.manifest.json") && existsSync(uri)) {
    return uri;
  }

  // If URI is a directory, look for manifest inside
  const manifestInDir = join(uri, "skill.manifest.json");
  if (existsSync(manifestInDir)) {
    return manifestInDir;
  }

  return null;
}

function resolveSkillDir(uri: string): string {
  if (uri.endsWith("skill.manifest.json")) {
    return join(uri, "..");
  }
  return uri;
}

function collectFiles(dir: string): FridayConvertedSkillFile[] {
  const files: FridayConvertedSkillFile[] = [];
  collectFilesRecursive(dir, dir, files);
  return files;
}

function collectFilesRecursive(
  baseDir: string,
  currentDir: string,
  files: FridayConvertedSkillFile[],
): void {
  const entries = readdirSync(currentDir);

  for (const entry of entries) {
    // Skip hidden files and node_modules
    if (entry.startsWith(".") || entry === "node_modules") {
      continue;
    }

    const fullPath = join(currentDir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      collectFilesRecursive(baseDir, fullPath, files);
    } else if (stat.isFile()) {
      const relativePath = relative(baseDir, fullPath);
      const content = readFileSync(fullPath, "utf-8");
      const executable = (stat.mode & 0o111) !== 0;

      files.push({
        path: relativePath,
        content,
        ...(executable ? { executable: true } : {}),
      });
    }
  }
}

function buildMinimalUiSchema(manifest: SkillManifestV2): FridaySkillUiSchemaV1 {
  const fields: FridaySkillUiSchemaV1["fields"] = manifest.inputs.map((input) => ({
    id: `field-${input.key}`,
    inputKey: input.key,
    kind: "text" as const,
    label: input.label,
    required: input.required,
    help: input.help,
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
