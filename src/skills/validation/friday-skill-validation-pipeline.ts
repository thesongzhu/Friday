import { existsSync } from "node:fs";
import { join } from "node:path";
import { safeParseFridaySkillManifestV2 } from "../manifest/friday-skill-manifest.schema.js";
import type { FridayLoadedSkillPackage } from "../manifest/friday-skill-package-loader.js";
import { compileFridaySkillSchemas } from "./friday-skill-schema-compiler.js";
import type { FridayCompiledSkillSchemas } from "./friday-skill-schema-compiler.js";
import type {
  FridaySkillValidationIssue,
  FridaySkillValidationResult,
} from "./friday-skill-validation.types.js";
import { validateFridaySkillStepGraph } from "./friday-skill-step-graph-validator.js";
import { validateFridaySkillEngineCompatibility } from "./friday-skill-engine-compat-validator.js";
import { validateFridayManifestFilesystemScopes } from "./friday-skill-filesystem-scope-validator.js";

export interface ValidateFridaySkillPackageOptions {
  loaded: FridayLoadedSkillPackage;
  workspaceDir: string;
  hubVersion: string;
  supportedApiVersions: string[];
}

/**
 * Runs the 6-stage validation pipeline per §2.7.2:
 *   1. Manifest defaulting + schema validation
 *   2. Required files check
 *   3. Filesystem scope validation
 *   4. Step graph validation
 *   5. Schema compilation
 *   6. Engine compatibility
 */
export function validateFridaySkillPackage(
  options: ValidateFridaySkillPackageOptions,
): FridaySkillValidationResult & { compiledSchemas: FridayCompiledSkillSchemas } {
  const { loaded, workspaceDir, hubVersion, supportedApiVersions } = options;
  const { manifest, skillDir, loadMode } = loaded;
  const issues: FridaySkillValidationIssue[] = [];

  // ── Stage 1: Manifest defaulting + schema validation ──
  // The manifest has already been defaulted during loading, but we
  // re-validate the schema to ensure correctness and collect issues.
  const schemaResult = safeParseFridaySkillManifestV2(manifest);
  if (!schemaResult.success) {
    for (const zodIssue of schemaResult.error.issues) {
      issues.push({
        stage: "manifest",
        severity: "error",
        code: "MANIFEST_SCHEMA_INVALID",
        message: `${zodIssue.path.join(".")}: ${zodIssue.message}`,
        path: zodIssue.path.join("."),
      });
    }
  }

  // ── Stage 2: Required files check ──
  // Check skill.manifest.json or SKILL.md (in legacy mode), plus all
  // declared schema and prompt files.
  if (loadMode === "manifest-v2") {
    const manifestFile = join(skillDir, "skill.manifest.json");
    if (!existsSync(manifestFile)) {
      issues.push({
        stage: "required-files",
        severity: "error",
        code: "MANIFEST_FILE_MISSING",
        message: `Manifest file not found: ${manifestFile}`,
        path: "skill.manifest.json",
      });
    }
  } else if (loadMode === "legacy-skill-md") {
    const skillMdFile = loaded.skillMdPath ?? join(skillDir, "SKILL.md");
    if (!existsSync(skillMdFile)) {
      issues.push({
        stage: "required-files",
        severity: "error",
        code: "SKILL_MD_MISSING",
        message: `SKILL.md not found: ${skillMdFile}`,
        path: "SKILL.md",
      });
    }
  }

  // Check entrypoint (warning, not error — builtin skills may have empty entrypoint)
  const entrypoint = manifest.runtime.entrypoint;
  if (entrypoint) {
    const entrypointPath = join(skillDir, entrypoint);
    if (!existsSync(entrypointPath)) {
      issues.push({
        stage: "required-files",
        severity: "warning",
        code: "ENTRYPOINT_NOT_FOUND",
        message: `Entrypoint file not found: ${entrypointPath}`,
        path: "runtime.entrypoint",
      });
    }
  }

  // Check declared schema files
  if (manifest.schemas) {
    for (const [key, schemaPath] of Object.entries(manifest.schemas)) {
      if (schemaPath) {
        const fullPath = join(skillDir, schemaPath);
        if (!existsSync(fullPath)) {
          issues.push({
            stage: "required-files",
            severity: "warning",
            code: "SCHEMA_FILE_MISSING",
            message: `Schema file not found: ${fullPath}`,
            path: `schemas.${key}`,
          });
        }
      }
    }
  }

  // Check declared prompt files
  if (manifest.flow?.steps) {
    for (const step of manifest.flow.steps) {
      if (step.prompt) {
        const promptPath = join(skillDir, step.prompt);
        if (!existsSync(promptPath)) {
          issues.push({
            stage: "required-files",
            severity: "warning",
            code: "PROMPT_FILE_MISSING",
            message: `Prompt file not found: ${promptPath}`,
            path: `flow.steps[${step.id}].prompt`,
          });
        }
      }
    }
  }

  // ── Stage 3: Filesystem scope validation ──
  const filesystemScopeIssues = validateFridayManifestFilesystemScopes(
    manifest,
    skillDir,
    workspaceDir,
  );
  issues.push(...filesystemScopeIssues);

  // ── Stage 4: Step graph validation ──
  const stepGraphIssues = validateFridaySkillStepGraph(manifest.flow);
  issues.push(...stepGraphIssues);

  // ── Stage 5: Schema compilation ──
  const { compiled: compiledSchemas, issues: schemaIssues } = compileFridaySkillSchemas({
    manifest,
    skillDir,
  });
  issues.push(...schemaIssues);

  // ── Stage 6: Engine compatibility ──
  const compatIssues = validateFridaySkillEngineCompatibility(manifest, {
    hubVersion,
    supportedApiVersions,
  });
  issues.push(...compatIssues);

  const hasErrors = issues.some((i) => i.severity === "error");

  return {
    ok: !hasErrors,
    issues,
    compiledSchemas,
  };
}
