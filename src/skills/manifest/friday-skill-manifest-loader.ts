import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import { applyFridaySkillManifestDefaults } from "./friday-skill-manifest-defaults.js";
import { safeParseFridaySkillManifestV2 } from "./friday-skill-manifest.schema.js";

export interface LoadFridaySkillManifestOptions {
  skillDir: string;
  manifestFileName?: "skill.manifest.json";
}

export interface LoadedFridaySkillManifest {
  manifestPath: string;
  raw: Record<string, unknown>;
  manifest: SkillManifestV2;
}

export interface FridaySkillManifestLoadError {
  code:
    | "MANIFEST_NOT_FOUND"
    | "MANIFEST_READ_FAILED"
    | "MANIFEST_PARSE_FAILED"
    | "MANIFEST_VALIDATION_FAILED";
  message: string;
  path?: string;
  cause?: unknown;
}

export type LoadFridaySkillManifestResult =
  | { ok: true; value: LoadedFridaySkillManifest }
  | { ok: false; error: FridaySkillManifestLoadError };

/** Loads and validates `skill.manifest.json` from a skill directory. */
export function loadFridaySkillManifest(
  options: LoadFridaySkillManifestOptions,
): LoadFridaySkillManifestResult {
  const fileName = options.manifestFileName ?? "skill.manifest.json";
  const manifestPath = join(options.skillDir, fileName);

  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      error: {
        code: "MANIFEST_NOT_FOUND",
        message: `Manifest file not found: ${manifestPath}`,
        path: manifestPath,
      },
    };
  }

  let rawText: string;
  try {
    rawText = readFileSync(manifestPath, "utf-8");
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: "MANIFEST_READ_FAILED",
        message: `Failed to read manifest file: ${manifestPath}`,
        path: manifestPath,
        cause,
      },
    };
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawText) as Record<string, unknown>;
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: "MANIFEST_PARSE_FAILED",
        message: `Invalid JSON in manifest file: ${manifestPath}`,
        path: manifestPath,
        cause,
      },
    };
  }

  const defaulted = applyFridaySkillManifestDefaults(raw);
  const result = safeParseFridaySkillManifestV2(defaulted);

  if (!result.success) {
    return {
      ok: false,
      error: {
        code: "MANIFEST_VALIDATION_FAILED",
        message: `Manifest validation failed: ${result.error.issues.map((i: { message: string }) => i.message).join("; ")}`,
        path: manifestPath,
        cause: result.error,
      },
    };
  }

  return {
    ok: true,
    value: {
      manifestPath,
      raw,
      manifest: result.data,
    },
  };
}
