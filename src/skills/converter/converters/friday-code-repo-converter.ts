/**
 * Code repository converter.
 *
 * Scans code repositories (local directories, git URLs, zip/tar archives)
 * and generates skill drafts from discovered capabilities
 * (HTTP endpoints, CLI scripts, script tasks, library functions).
 */

import { basename } from "node:path";

import { FridayDomainError } from "#errors";

import type {
  FridaySkillConversionSource,
  FridaySkillConverter,
  FridaySkillConverterContext,
  FridaySkillConverterDetection,
  FridaySkillConverterResult,
} from "../model/friday-skill-converter.types.js";
import { cleanupTempWorkspace, detectSourceProtocol, materializeFridayCodeRepoSource } from "../code-repo/friday-source-materializer.js";
import { detectFridayCodeRepoLanguages } from "../code-repo/friday-language-detector.js";
import { extractFridayCodeRepoCapabilities } from "../code-repo/friday-capability-extractor.js";
import { compileFridayCodeRepoDraftPlan } from "../code-repo/friday-capability-to-draft-compiler.js";

const CONVERTER_ID = "code-repo";
const CONVERTER_DISPLAY_NAME = "Code Repository Analyzer";
const CONVERTER_PRIORITY = 45;

export function createFridayCodeRepoConverter(): FridaySkillConverter {
  return {
    id: CONVERTER_ID,
    displayName: CONVERTER_DISPLAY_NAME,
    priority: CONVERTER_PRIORITY,

    async detect(source: FridaySkillConversionSource): Promise<FridaySkillConverterDetection | null> {
      if (source.formatHint === "code-repo") {
        return {
          converterId: CONVERTER_ID,
          format: "code-repo",
          confidence: 0.99,
          reasons: ["Explicit format hint: code-repo"],
        };
      }

      if (!source.uri) {
        return null;
      }

      const protocol = detectSourceProtocol(source.uri);

      // For git URLs: detect by URL pattern without cloning
      if (protocol === "git") {
        return {
          converterId: CONVERTER_ID,
          format: "code-repo",
          confidence: 0.85,
          reasons: [`Git repository URL detected (${source.uri.split("/").slice(-2).join("/")})`],
        };
      }

      // For archives: detect by extension
      if (protocol === "archive") {
        return {
          converterId: CONVERTER_ID,
          format: "code-repo",
          confidence: 0.70,
          reasons: [`Archive source detected (${source.uri.split(".").pop()})`],
        };
      }

      // For local directories: full materialization check
      try {
        const materialized = materializeFridayCodeRepoSource(source.uri, {
          maxFiles: 120,
          maxDepth: 5,
          maxFileBytes: 40_000,
        });
        const languages = detectFridayCodeRepoLanguages(materialized);
        const capabilities = extractFridayCodeRepoCapabilities(materialized);

        if (languages.length === 0 || capabilities.length === 0) {
          return null;
        }

        return {
          converterId: CONVERTER_ID,
          format: "code-repo",
          confidence: Math.min(0.95, 0.55 + capabilities.length * 0.05),
          reasons: [
            `Source protocol: ${protocol}`,
            `Detected languages: ${languages.slice(0, 3).map((l) => l.language).join(", ")}`,
            `Detected capabilities: ${capabilities.length}`,
          ],
        };
      } catch (err) {
      console.warn("[friday][code-repo-converter] operation failed:", err instanceof Error ? err.message : String(err));
        return null;
      }
    },

    async convert(
      source: FridaySkillConversionSource,
      ctx: FridaySkillConverterContext,
    ): Promise<FridaySkillConverterResult> {
      if (!source.uri) {
        throw new FridayDomainError(
          "VALIDATION_ERROR",
          "code-repo converter requires a source URI (local dir, git URL, or archive path)",
          { httpStatus: 400 },
        );
      }

      const protocol = detectSourceProtocol(source.uri);
      const isRemote = protocol === "git" || protocol === "archive";
      let materialized;

      try {
        materialized = materializeFridayCodeRepoSource(source.uri);
      } catch (err) {
        if (err instanceof FridayDomainError) throw err;
        throw new FridayDomainError(
          "CONVERTER_MATERIALIZATION_FAILED",
          `Failed to materialize ${protocol} source: ${source.uri}`,
          { httpStatus: 422, cause: err },
        );
      }

      try {
        const languages = detectFridayCodeRepoLanguages(materialized);
        const capabilities = extractFridayCodeRepoCapabilities(materialized);
        if (capabilities.length === 0) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "code-repo converter found no capabilities in repository source",
            { httpStatus: 422 },
          );
        }

        const repoName = sanitizeRepoName(basename(materialized.rootPath));
        const plan = compileFridayCodeRepoDraftPlan({
          repoName,
          sourceRef: source.uri,
          capabilities,
          convertedAt: ctx.nowIso(),
        });

        // Merge repository-level warnings into each draft.
        const languageSummary = languages
          .slice(0, 5)
          .map((l) => `${l.language}:${String(l.fileCount)}`)
          .join(", ");
        const protocolNote = protocol !== "local" ? `Source protocol: ${protocol}` : "";
        const draftWarnings = [
          ...plan.warnings,
          languageSummary ? `Detected languages: ${languageSummary}` : "No language profile detected.",
          ...(protocolNote ? [protocolNote] : []),
        ];

        const drafts = plan.drafts.map((draft) => ({
          ...draft,
          warnings: [...new Set([...draft.warnings, ...draftWarnings])],
        }));

        return {
          converterId: CONVERTER_ID,
          detectedFormat: "code-repo",
          drafts,
        };
      } finally {
        // Cleanup temp workspaces for remote sources
        if (isRemote) {
          cleanupTempWorkspace(materialized.rootPath);
        }
      }
    },
  };
}

function sanitizeRepoName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "repo";
}

