/**
 * Package archiver — creates and extracts .friday.tgz skill archives.
 *
 * - packSkill(): Create .friday.tgz from skill directory
 * - unpackSkill(): Extract .friday.tgz to directory
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { FridayDomainError } from "#errors";

// ─── Types ───

export interface FridaySkillPackResult {
  packageFile: string;
  checksumSha256: string;
}

export interface FridaySkillPackageArchiver {
  packSkill(skillDir: string, outputFile: string): FridaySkillPackResult;
  unpackSkill(archivePath: string, outputDir: string): void;
}

// ─── Implementation ───

export function createFridaySkillPackageArchiver(): FridaySkillPackageArchiver {
  return {
    packSkill(skillDir: string, outputFile: string): FridaySkillPackResult {
      if (!existsSync(skillDir)) {
        throw new FridayDomainError("ARCHIVE_NOT_FOUND", `Skill directory not found: ${skillDir}`, { httpStatus: 404 });
      }
      validateSkillDirectoryForArchive(skillDir);

      // Ensure output directory exists
      const outputDir = dirname(outputFile);
      mkdirSync(outputDir, { recursive: true });

      // Ensure output file ends with .friday.tgz
      // If it already ends with .friday.tgz, use as-is.
      // Otherwise strip common archive extensions before appending.
      const finalOutputFile = outputFile.endsWith(".friday.tgz")
        ? outputFile
        : `${outputFile.replace(/\.(tar\.gz|tgz|tar|zip)$/i, "")}.friday.tgz`;

      // Create tar.gz archive from the skill directory contents
      // We cd into the skill dir so paths in the archive are relative
      const skillDirName = basename(skillDir);
      const parentDir = dirname(skillDir);

      execFileSync("tar", [
        "-czf", finalOutputFile,
        "-C", parentDir,
        skillDirName,
      ], { stdio: "pipe" });

      // Compute SHA-256 checksum
      const archiveContent = readFileSync(finalOutputFile);
      const hash = createHash("sha256").update(archiveContent).digest("hex");

      return {
        packageFile: finalOutputFile,
        checksumSha256: hash,
      };
    },

    unpackSkill(archivePath: string, outputDir: string): void {
      if (!existsSync(archivePath)) {
        throw new FridayDomainError("ARCHIVE_NOT_FOUND", `Archive not found: ${archivePath}`, { httpStatus: 404 });
      }

      mkdirSync(outputDir, { recursive: true });
      validateArchiveEntries(archivePath);

      // Extract the archive into the output directory
      // Use --strip-components=1 to remove the top-level directory
      execFileSync("tar", [
        "-xzf", archivePath,
        "-C", outputDir,
        "--strip-components=1",
      ], { stdio: "pipe" });
    },
  };
}

function validateSkillDirectoryForArchive(skillDir: string): void {
  const root = normalize(skillDir);
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    const stat = lstatSync(current);
    const rel = relative(root, current);
    if (rel && isUnsafeRelativePath(rel)) {
      throw new FridayDomainError("ARCHIVE_UNSAFE_PATH", `Unsafe skill path: ${rel}`, { httpStatus: 400 });
    }
    if (stat.isSymbolicLink()) {
      throw new FridayDomainError("ARCHIVE_UNSUPPORTED_ENTRY", `Skill archives must not contain symbolic links: ${rel || basename(current)}`, { httpStatus: 400 });
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(current)) {
        stack.push(join(current, entry));
      }
      continue;
    }
    if (!stat.isFile()) {
      throw new FridayDomainError("ARCHIVE_UNSUPPORTED_ENTRY", `Skill archives must contain only regular files and directories: ${rel || basename(current)}`, { httpStatus: 400 });
    }
  }
}

function validateArchiveEntries(archivePath: string): void {
  const listing = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8", stdio: "pipe" });
  const verboseListing = execFileSync("tar", ["-tvzf", archivePath], { encoding: "utf8", stdio: "pipe" });
  const unsupportedEntryLine = verboseListing
    .split(/\r?\n/)
    .find((line) => {
      if (!line.trim()) return false;
      const type = line[0];
      return type !== "-" && type !== "d";
    });
  if (unsupportedEntryLine) {
    throw new FridayDomainError("ARCHIVE_UNSUPPORTED_ENTRY", `Archive contains unsupported entry type: ${unsupportedEntryLine}`, { httpStatus: 400 });
  }

  for (const rawEntry of listing.split(/\r?\n/)) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const stripped = stripArchiveTopLevelComponent(entry);
    if (stripped === null) continue;
    if (isUnsafeRelativePath(stripped)) {
      throw new FridayDomainError("ARCHIVE_UNSAFE_PATH", `Unsafe archive entry: ${entry}`, { httpStatus: 400 });
    }
  }
}

function stripArchiveTopLevelComponent(entry: string): string | null {
  const normalizedEntry = normalizeArchiveEntry(entry);
  const parts = normalizedEntry.split("/").filter(Boolean);
  if (parts.length <= 1) return null;
  return parts.slice(1).join("/");
}

function normalizeArchiveEntry(entry: string): string {
  if (entry.includes("\0") || entry.includes("\\")) {
    throw new FridayDomainError("ARCHIVE_UNSAFE_PATH", `Unsafe archive entry: ${entry}`, { httpStatus: 400 });
  }
  let normalizedEntry = entry;
  while (normalizedEntry.startsWith("./")) {
    normalizedEntry = normalizedEntry.slice(2);
  }
  if (
    normalizedEntry.startsWith("/") ||
    /^[A-Za-z]:/.test(normalizedEntry) ||
    normalizedEntry.split("/").some((part) => part === "..")
  ) {
    throw new FridayDomainError("ARCHIVE_UNSAFE_PATH", `Unsafe archive entry: ${entry}`, { httpStatus: 400 });
  }
  return normalizedEntry;
}

function isUnsafeRelativePath(rel: string): boolean {
  const normalizedRel = normalize(rel);
  return (
    normalizedRel === ".." ||
    normalizedRel.startsWith(`..${sep}`) ||
    isAbsolute(normalizedRel) ||
    normalizedRel.includes("\0")
  );
}
