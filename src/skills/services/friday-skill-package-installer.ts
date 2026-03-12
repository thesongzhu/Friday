import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { FridayDomainError } from "#errors";
import { safeDirName, validateInstallId } from "#utilities";
import { createFridaySkillPackageArchiver } from "../converter/services/friday-skill-package-archive.js";

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
  const archiver = createFridaySkillPackageArchiver();

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

      // Remove existing destination if present
      if (existsSync(dest)) {
        rmSync(dest, { recursive: true, force: true });
      }

      mkdirSync(join(baseDir, safeDirName(skillId)), { recursive: true });
      mkdirSync(dest, { recursive: true });
      archiver.unpackSkill(archivePath, dest);
      copyFileSync(archivePath, join(dest, "package.tgz"));
      rmSync(src, { recursive: true, force: true });
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
