import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { FridayDomainError } from "#errors";
import { safeDirName, validateInstallId } from "#utilities";
import {
  createFridaySkillPackageArchiver,
  type FridaySkillPackageArchiver,
} from "../converter/services/friday-skill-package-archive.js";

// ─── Interface ───

export interface FridaySkillPackageInstaller {
  /** Stage package bytes to a temporary directory. */
  stage(skillId: string, version: string, packageBytes: Buffer): string;
  /** Activate a staged package by moving it to the final location. */
  activate(skillId: string, version: string): string;
  /** Remove installed package directory. */
  remove(skillId: string, version: string): void;
}

// ─── Dependencies ───

export interface CreateSkillPackageInstallerDeps {
  managedSkillsDir: string;
  archiver?: FridaySkillPackageArchiver;
}

// ─── Containment check using path.relative ───

function assertWithinBase(resolvedPath: string, resolvedBase: string, label: string): void {
  const rel = relative(resolvedBase, resolvedPath);
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw new FridayDomainError("PACKAGE_PATH_TRAVERSAL", `Path traversal detected in ${label}: path escapes managed directory`, { httpStatus: 400 });
  }
}

// ─── Pre-resolution validation ───

function validateSegment(value: string, label: string, allowScoped = true): void {
  const error = validateInstallId(value, { allowScoped });
  if (error) {
    throw new FridayDomainError("PACKAGE_VALIDATION_ERROR", `Invalid ${label}: ${error}`, { httpStatus: 400 });
  }
}

// ─── Factory ───

export function createFridaySkillPackageInstaller(
  deps: CreateSkillPackageInstallerDeps,
): FridaySkillPackageInstaller {
  const baseDir = deps.managedSkillsDir;
  const resolvedBase = resolve(baseDir);
  const archiver = deps.archiver ?? createFridaySkillPackageArchiver();

  function validateInputs(skillId: string, version: string): void {
    validateSegment(skillId, "skillId");
    validateSegment(version, "version", false);
  }

  function stagingDir(skillId: string, version: string): string {
    const safeId = safeDirName(skillId);
    const safeVersion = safeDirName(version);
    const dir = join(baseDir, ".staging", safeId, safeVersion);
    assertWithinBase(resolve(dir), resolvedBase, "staging path");
    return dir;
  }

  function finalDir(skillId: string, version: string): string {
    const safeId = safeDirName(skillId);
    const safeVersion = safeDirName(version);
    const dir = join(baseDir, safeId, safeVersion);
    assertWithinBase(resolve(dir), resolvedBase, "final path");
    return dir;
  }

  function activatingDir(skillId: string, version: string): string {
    const safeId = safeDirName(skillId);
    const safeVersion = safeDirName(version);
    const dir = join(baseDir, ".activating", safeId, `${safeVersion}-${randomUUID()}`);
    assertWithinBase(resolve(dir), resolvedBase, "activating path");
    return dir;
  }

  function backupDir(skillId: string, version: string): string {
    const safeId = safeDirName(skillId);
    const safeVersion = safeDirName(version);
    const dir = join(baseDir, ".backup", safeId, `${safeVersion}-${randomUUID()}`);
    assertWithinBase(resolve(dir), resolvedBase, "backup path");
    return dir;
  }

  return {
    stage(skillId, version, packageBytes) {
      validateInputs(skillId, version);
      const dir = stagingDir(skillId, version);
      mkdirSync(dir, { recursive: true });
      const packagePath = join(dir, "package.tgz");
      writeFileSync(packagePath, packageBytes);
      return dir;
    },

    activate(skillId, version) {
      validateInputs(skillId, version);
      const src = stagingDir(skillId, version);
      const dest = finalDir(skillId, version);
      const archivePath = join(src, "package.tgz");
      const activating = activatingDir(skillId, version);
      const backup = backupDir(skillId, version);
      let backupCreated = false;
      let activated = false;

      mkdirSync(join(baseDir, safeDirName(skillId)), { recursive: true });

      try {
        archiver.unpackSkill(archivePath, activating);
        if (!existsSync(join(activating, "skill.manifest.json"))) {
          throw new FridayDomainError(
            "PACKAGE_VALIDATION_ERROR",
            "Installed package is missing skill.manifest.json",
            { httpStatus: 400 },
          );
        }
        copyFileSync(archivePath, join(activating, "package.tgz"));

        if (existsSync(dest)) {
          mkdirSync(join(baseDir, ".backup", safeDirName(skillId)), { recursive: true });
          renameSync(dest, backup);
          backupCreated = true;
        }

        renameSync(activating, dest);
        activated = true;

        try {
          if (backupCreated && existsSync(backup)) {
            rmSync(backup, { recursive: true, force: true });
          }
          rmSync(src, { recursive: true, force: true });
        } catch {
          // Activation already succeeded; lingering temp paths are safe to clean later.
        }
      } catch (err) {
        if (!activated && existsSync(activating)) {
          rmSync(activating, { recursive: true, force: true });
        }
        if (backupCreated && !existsSync(dest) && existsSync(backup)) {
          renameSync(backup, dest);
        }
        throw err;
      }
      return dest;
    },

    remove(skillId, version) {
      validateInputs(skillId, version);
      const dir = finalDir(skillId, version);
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
      // Clean up staging too
      const staging = stagingDir(skillId, version);
      if (existsSync(staging)) {
        rmSync(staging, { recursive: true, force: true });
      }
    },
  };
}
