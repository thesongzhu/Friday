import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import { adaptFridayLegacySkill } from "./friday-skill-legacy-adapter.js";
import type { AdaptedFridayLegacySkill } from "./friday-skill-legacy-adapter.js";
import { loadFridaySkillManifest } from "./friday-skill-manifest-loader.js";

export type FridaySkillLoadMode = "manifest-v2" | "legacy-skill-md";

export interface LoadFridaySkillPackageOptions {
  skillDir: string;
  workspaceDir: string;
}

export interface FridayLoadedSkillPackage {
  skillDir: string;
  loadMode: FridaySkillLoadMode;
  manifest: SkillManifestV2;
  manifestPath?: string;
  skillMdPath?: string;
  declaredFiles: string[];
  legacy?: AdaptedFridayLegacySkill;
}

export type LoadFridaySkillPackageResult =
  | { ok: true; value: FridayLoadedSkillPackage }
  | { ok: false; error: Error };

/** Loads one skill package using manifest-first, then legacy SKILL.md fallback. */
export function loadFridaySkillPackage(
  options: LoadFridaySkillPackageOptions,
): LoadFridaySkillPackageResult {
  const { skillDir, workspaceDir } = options;

  // Try manifest-first
  const manifestResult = loadFridaySkillManifest({ skillDir });
  if (manifestResult.ok) {
    const { manifestPath, manifest } = manifestResult.value;
    const declaredFiles = resolveFridaySkillDeclaredFiles({
      skillDir,
      manifest,
      loadMode: "manifest-v2",
    });

    return {
      ok: true,
      value: {
        skillDir,
        loadMode: "manifest-v2",
        manifest,
        manifestPath,
        declaredFiles,
      },
    };
  }

  // Only fall back to legacy if the manifest was simply not found
  if (manifestResult.error.code !== "MANIFEST_NOT_FOUND") {
    return {
      ok: false,
      error: new Error(manifestResult.error.message),
    };
  }

  // Fallback to SKILL.md
  const legacyResult = adaptFridayLegacySkill({ skillDir, workspaceDir });
  if (!legacyResult.ok) {
    return {
      ok: false,
      error: legacyResult.error,
    };
  }

  const legacy = legacyResult.value;
  const declaredFiles = resolveFridaySkillDeclaredFiles({
    skillDir,
    manifest: legacy.manifest,
    loadMode: "legacy-skill-md",
    skillMdPath: legacy.skillMdPath,
  });

  return {
    ok: true,
    value: {
      skillDir,
      loadMode: "legacy-skill-md",
      manifest: legacy.manifest,
      skillMdPath: legacy.skillMdPath,
      declaredFiles,
      legacy,
    },
  };
}

/** Resolves all files that must be watched for hot-reload for one skill package. */
export function resolveFridaySkillDeclaredFiles(input: {
  skillDir: string;
  manifest: SkillManifestV2;
  loadMode: FridaySkillLoadMode;
  skillMdPath?: string;
}): string[] {
  const files: string[] = [];

  if (input.loadMode === "manifest-v2") {
    files.push(join(input.skillDir, "skill.manifest.json"));

    // In manifest mode, SKILL.md is optional but if present should be watched
    const skillMdInManifestMode = input.skillMdPath ?? join(input.skillDir, "SKILL.md");
    if (existsSync(skillMdInManifestMode)) {
      files.push(skillMdInManifestMode);
    }
  }

  if (input.skillMdPath) {
    if (!files.includes(input.skillMdPath)) {
      files.push(input.skillMdPath);
    }
  } else if (input.loadMode === "legacy-skill-md") {
    files.push(join(input.skillDir, "SKILL.md"));
  }

  // Add skill.ui.json if present
  const uiJsonPath = join(input.skillDir, "skill.ui.json");
  if (existsSync(uiJsonPath)) {
    files.push(uiJsonPath);
  }

  // Add entrypoint
  const entrypoint = input.manifest.runtime.entrypoint;
  if (entrypoint) {
    files.push(join(input.skillDir, entrypoint));
  }

  // Add schema files
  if (input.manifest.schemas) {
    for (const schemaPath of Object.values(input.manifest.schemas)) {
      if (schemaPath) {
        files.push(join(input.skillDir, schemaPath));
      }
    }
  }

  // Add flow step prompt files per §2.7.4
  if (input.manifest.flow?.steps) {
    for (const step of input.manifest.flow.steps) {
      if (step.prompt) {
        files.push(join(input.skillDir, step.prompt));
      }
    }
  }

  return files;
}
