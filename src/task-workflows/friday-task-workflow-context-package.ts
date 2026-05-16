/**
 * Phase 13.5A context package validation.
 *
 * Context packages must enumerate scoped files/tools/APIs. Whole-repo
 * sentinels such as `**` or a single `*` are refused — that boundary
 * exists to prevent executors and CLI lanes from receiving the entire
 * repo by default.
 *
 * @module task-workflows/friday-task-workflow-context-package
 */

import { FridayDomainError } from "#errors";

import { isFridayKnownBoundary } from "./friday-task-workflow-boundaries.js";
import type { FridayTaskWorkflowContextPackage } from "./friday-task-workflow.types.js";

/**
 * Pattern fragments that effectively grant whole-repo access. Any
 * `allowedFiles` entry matching one of these (after trimming and removing
 * leading `./`) is refused with a structured 400.
 */
const WHOLE_REPO_SENTINELS: readonly string[] = [
  "**",
  "**/*",
  "**/**",
  "*",
  "*.*",
  "./**",
  "./**/*",
  "src/**",
  "src/**/*",
  "/**",
  "/**/*",
];

function normalizeAllowedFile(value: string): string {
  return value.trim().replace(/^\.\//, "");
}

function isWholeRepoSentinel(value: string): boolean {
  const normalized = normalizeAllowedFile(value);
  return WHOLE_REPO_SENTINELS.includes(normalized);
}

/** Throws `CONTEXT_PACKAGE_WHOLE_REPO_REFUSED` if the package would expose
 *  the whole repo, or `CONTEXT_PACKAGE_INVALID` for other shape errors. */
export function validateFridayTaskWorkflowContextPackage(
  raw: unknown,
): FridayTaskWorkflowContextPackage {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FridayDomainError(
      "CONTEXT_PACKAGE_INVALID",
      "contextPackage must be a JSON object.",
      { httpStatus: 400 },
    );
  }

  const obj = raw as Record<string, unknown>;
  const allowedFiles = readStringArray(obj.allowedFiles, "allowedFiles");
  const allowedTools = readStringArray(obj.allowedTools, "allowedTools");
  const allowedApis = readStringArray(obj.allowedApis, "allowedApis");
  const boundaryIds = readStringArray(obj.boundaryIds, "boundaryIds");

  if (allowedFiles.length === 0) {
    throw new FridayDomainError(
      "CONTEXT_PACKAGE_INVALID",
      "contextPackage.allowedFiles must enumerate at least one scoped path; whole-repo defaults are refused.",
      { httpStatus: 400 },
    );
  }

  for (const entry of allowedFiles) {
    if (isWholeRepoSentinel(entry)) {
      throw new FridayDomainError(
        "CONTEXT_PACKAGE_WHOLE_REPO_REFUSED",
        `contextPackage.allowedFiles entry "${entry}" expands to the whole repository. Enumerate the scoped paths required for the task instead.`,
        { httpStatus: 400, details: { rejectedEntry: entry } },
      );
    }
  }

  for (const boundaryId of boundaryIds) {
    if (!isFridayKnownBoundary(boundaryId)) {
      throw new FridayDomainError(
        "CONTEXT_PACKAGE_INVALID",
        `contextPackage.boundaryIds contains unknown boundary "${boundaryId}".`,
        { httpStatus: 400, details: { rejectedBoundary: boundaryId } },
      );
    }
  }

  return {
    allowedFiles,
    allowedTools,
    allowedApis,
    boundaryIds,
  };
}

function readStringArray(value: unknown, field: string): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new FridayDomainError(
      "CONTEXT_PACKAGE_INVALID",
      `contextPackage.${field} must be a string array when provided.`,
      { httpStatus: 400 },
    );
  }
  const out: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new FridayDomainError(
        "CONTEXT_PACKAGE_INVALID",
        `contextPackage.${field}[${index}] must be a non-empty string.`,
        { httpStatus: 400 },
      );
    }
    out.push(entry.trim());
  }
  return out;
}
