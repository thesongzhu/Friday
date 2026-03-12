/**
 * Package archiver — creates and extracts .friday.tgz skill archives.
 *
 * - packSkill(): Create .friday.tgz from skill directory
 * - unpackSkill(): Extract .friday.tgz to directory
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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

      // Ensure output directory exists
      const outputDir = dirname(outputFile);
      mkdirSync(outputDir, { recursive: true });

      // Ensure output file ends with .friday.tgz
      const finalOutputFile = outputFile.endsWith(".friday.tgz")
        ? outputFile
        : `${outputFile}.friday.tgz`;

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
