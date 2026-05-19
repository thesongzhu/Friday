/**
 * Import installer — stages, validates, and installs converted skill drafts.
 *
 * Flow:
 *   1. Stage draft files to temp dir
 *   2. Run loadFridaySkillPackage + validateFridaySkillPackage
 *   3. Copy to final directory (managed/workspace/custom)
 *   4. Set executable bits on shell files
 *   5. Return install result
 */

import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

import { FridayDomainError } from "#errors";
import { normalizeInstallId, resolveSafeInstallDir, resolveSafePath, validateInstallId } from "#utilities";
import { loadFridaySkillPackage } from "../../manifest/friday-skill-package-loader.js";
import { validateFridaySkillPackage } from "../../validation/friday-skill-validation-pipeline.js";
import type { FridaySkillValidationIssue } from "../../validation/friday-skill-validation.types.js";
import type { FridayConvertedSkillDraft } from "../model/friday-skill-converter.types.js";

// ─── Types ───

export type FridaySkillInstallTarget =
  | "managed"
  | "workspace"
  | { path: string };

export interface FridaySkillInstallOptions {
  replace?: boolean;
  workspaceDir: string;
  managedSkillsDir: string;
  hubVersion?: string;
  supportedApiVersions?: string[];
}

export interface FridaySkillInstallResult {
  skillId: string;
  skillDir: string;
  installed: boolean;
  issues: FridaySkillValidationIssue[];
}

// ─── Service interface ───

export interface FridaySkillImportInstaller {
  installConvertedSkill(
    draft: FridayConvertedSkillDraft,
    target: FridaySkillInstallTarget,
    options: FridaySkillInstallOptions,
  ): FridaySkillInstallResult;
}

// ─── Implementation ───

export function createFridaySkillImportInstaller(): FridaySkillImportInstaller {
  return {
    installConvertedSkill(
      draft: FridayConvertedSkillDraft,
      target: FridaySkillInstallTarget,
      options: FridaySkillInstallOptions,
    ): FridaySkillInstallResult {
      const skillId = draft.manifest.id;
      const stagingDir = createStagingDir();

      try {
        // Step 1: Stage files to temp dir
        stageFiles(stagingDir, draft);

        // Step 2: Validate staged package
        const validationIssues = validateStagedPackage(stagingDir, options);

        // Collect errors (but not warnings)
        const errors = validationIssues.filter((i) => i.severity === "error");
        if (errors.length > 0) {
          return {
            skillId,
            skillDir: "",
            installed: false,
            issues: validationIssues,
          };
        }

        // Step 3: Resolve final target directory
        const targetDir = resolveTargetDir(skillId, target, options);

        // Step 4: Handle collision
        if (existsSync(targetDir)) {
          if (!options.replace) {
            return {
              skillId,
              skillDir: targetDir,
              installed: false,
              issues: [
                ...validationIssues,
                {
                  stage: "required-files",
                  severity: "error",
                  code: "SKILL_DIR_EXISTS",
                  message: `Target directory already exists: ${targetDir}. Use replace option to overwrite.`,
                  path: targetDir,
                },
              ],
            };
          }
          rmSync(targetDir, { recursive: true, force: true });
        }

        // Step 5: Copy staged files to final directory
        mkdirSync(targetDir, { recursive: true });
        cpSync(stagingDir, targetDir, { recursive: true });

        // Step 6: Set executable bits
        setExecutableBits(targetDir, draft);

        return {
          skillId,
          skillDir: targetDir,
          installed: true,
          issues: validationIssues,
        };
      } finally {
        // Clean up staging dir
        rmSync(stagingDir, { recursive: true, force: true });
      }
    },
  };
}

// ─── Helpers ───

function createStagingDir(): string {
  return mkdtempSync(join(tmpdir(), "friday-install-"));
}

function stageFiles(stagingDir: string, draft: FridayConvertedSkillDraft): void {
  for (const file of draft.files) {
    const filePath = resolveSafePath(stagingDir, file.path);
    mkdirSync(dirname(filePath), { recursive: true });
    const content = sanitizeDraftFileContent(file.path, file.content);
    writeFileSync(filePath, content, "utf-8");

    if (file.executable) {
      chmodSync(filePath, 0o755);
    }
  }
}

function sanitizeDraftFileContent(relativePath: string, content: string): string {
  if (!relativePath.endsWith("conversion.report.json")) {
    return content;
  }

  try {
    const parsed = JSON.parse(content) as { sourceRef?: unknown };
    if (!parsed || typeof parsed !== "object" || typeof parsed.sourceRef !== "string") {
      return content;
    }

    const sourceRef = parsed.sourceRef.trim();
    if (!isLocalAbsolutePath(sourceRef)) {
      return content;
    }

    const leaf = basename(sourceRef.replace(/[\\/]+$/, ""));
    parsed.sourceRef = leaf.length > 0 ? `local:${leaf}` : "local:redacted";
    return JSON.stringify(parsed, null, 2);
  } catch (err) {
    console.warn("[friday][skill-import-installer] operation failed:", err instanceof Error ? err.message : String(err));
    return content;
  }
}

function isLocalAbsolutePath(value: string): boolean {
  if (value.length === 0) return false;
  if (/^[a-z]+:\/\//i.test(value)) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  return isAbsolute(value);
}

function validateStagedPackage(
  stagingDir: string,
  options: FridaySkillInstallOptions,
): FridaySkillValidationIssue[] {
  const loadResult = loadFridaySkillPackage({
    skillDir: stagingDir,
    workspaceDir: options.workspaceDir,
  });

  if (!loadResult.ok) {
    return [
      {
        stage: "manifest",
        severity: "error",
        code: "PACKAGE_LOAD_FAILED",
        message: `Failed to load skill package: ${loadResult.error.message}`,
      },
    ];
  }

  const validationResult = validateFridaySkillPackage({
    loaded: loadResult.value,
    workspaceDir: options.workspaceDir,
    hubVersion: options.hubVersion ?? "1.0.0",
    supportedApiVersions: options.supportedApiVersions ?? ["1"],
  });

  return validationResult.issues;
}

function resolveTargetDir(
  skillId: string,
  target: FridaySkillInstallTarget,
  options: FridaySkillInstallOptions,
): string {
  const normalizedSkillId = validateTargetSkillId(skillId);
  if (target === "managed") {
    return resolveSafeInstallDir(options.managedSkillsDir, normalizedSkillId);
  }

  if (target === "workspace") {
    return resolveSafeInstallDir(join(options.workspaceDir, "skills"), normalizedSkillId);
  }

  return resolveSafeInstallDir(target.path, normalizedSkillId);
}

function validateTargetSkillId(skillId: string): string {
  const error = validateInstallId(skillId);
  if (error) {
    throw new FridayDomainError("INSTALL_INVALID_ID", error, { httpStatus: 400 });
  }
  return normalizeInstallId(skillId);
}

function setExecutableBits(
  targetDir: string,
  draft: FridayConvertedSkillDraft,
): void {
  for (const file of draft.files) {
    if (file.executable) {
      const filePath = join(targetDir, file.path);
      if (existsSync(filePath)) {
        chmodSync(filePath, 0o755);
      }
    }
  }
}
