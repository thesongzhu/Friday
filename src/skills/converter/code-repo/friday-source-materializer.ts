import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

import { FridayDomainError } from "#errors";
import { isWithinBase } from "#utilities";

import {
  redactFridaySkillCandidateSourceUri,
  redactFridaySkillSourceText,
} from "../services/friday-skill-candidate-store.js";
import type { FridayCodeRepoFile, FridayCodeRepoMaterializedSource } from "./friday-code-repo.types.js";

// ─── Defaults ───

const DEFAULT_MAX_FILES = 600;
const DEFAULT_MAX_FILE_BYTES = 128_000;
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_TOTAL_BYTES = 50_000_000; // 50 MB
const GIT_CLONE_TIMEOUT_MS = 60_000;
const EXTRACT_TIMEOUT_MS = 30_000;

const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".cache",
  ".venv",
  "venv",
  "target",
  "coverage",
  ".idea",
  ".vscode",
]);

const ALLOWED_FILE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".swift",
  ".sh",
  ".bash",
  ".zsh",
  ".yaml",
  ".yml",
  ".json",
  ".toml",
  ".md",
  ".txt",
  ".sql",
]);

const ALLOWED_FILE_NAMES = new Set([
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "go.mod",
  "Cargo.toml",
  "Makefile",
  "README.md",
  "readme.md",
  "composer.json",
  "Gemfile",
  "build.gradle",
]);

// ─── Source Protocol Detection ───

export type FridayCodeRepoSourceProtocol = "local" | "git" | "archive";

export function detectSourceProtocol(sourceUri: string): FridayCodeRepoSourceProtocol {
  // Git URLs
  if (
    sourceUri.startsWith("git@") ||
    sourceUri.startsWith("git://") ||
    sourceUri.endsWith(".git") ||
    /^https?:\/\/(?:github\.com|gitlab\.com|bitbucket\.org)\//.test(sourceUri)
  ) {
    return "git";
  }

  // Archive files
  const lower = normalizedSourcePathForProtocol(sourceUri);
  if (
    lower.endsWith(".zip") ||
    lower.endsWith(".tar.gz") ||
    lower.endsWith(".tgz") ||
    lower.endsWith(".tar")
  ) {
    return "archive";
  }

  return "local";
}

function normalizedSourcePathForProtocol(sourceUri: string): string {
  try {
    return new URL(sourceUri).pathname.toLowerCase();
  } catch {
    return sourceUri.toLowerCase();
  }
}

// ─── Options ───

export interface FridaySourceMaterializerOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxDepth?: number;
  maxTotalBytes?: number;
}

// ─── Main Materializer ───

export function materializeFridayCodeRepoSource(
  sourceUri: string,
  options: FridaySourceMaterializerOptions = {},
): FridayCodeRepoMaterializedSource {
  const protocol = detectSourceProtocol(sourceUri);

  switch (protocol) {
    case "git":
      return materializeGitSource(sourceUri, options);
    case "archive":
      return materializeArchiveSource(sourceUri, options);
    case "local":
    default:
      return materializeLocalSource(sourceUri, options);
  }
}

// ─── Local Directory Materializer ───

function materializeLocalSource(
  sourceUri: string,
  options: FridaySourceMaterializerOptions,
): FridayCodeRepoMaterializedSource {
  const rootPath = resolve(sourceUri);
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
  const maxFileBytes = Math.max(1024, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
  const maxDepth = Math.max(1, options.maxDepth ?? DEFAULT_MAX_DEPTH);

  let rootStats;
  try {
    rootStats = statSync(rootPath);
  } catch (err) {
    console.warn("[friday][source-materializer] operation failed:", redactSourceErrorMessage(err, sourceUri));
    throw new FridayDomainError(
      "CONVERTER_SOURCE_NOT_FOUND",
      `Code repository source not found: ${redactFridaySkillCandidateSourceUri(sourceUri)}`,
      { httpStatus: 404 },
    );
  }

  if (!rootStats.isDirectory()) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "Local source must be a directory",
      { httpStatus: 400 },
    );
  }

  const files: FridayCodeRepoFile[] = [];
  walk(rootPath, 0);

  return { rootPath, files };

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth || files.length >= maxFiles) {
      return;
    }

    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      console.warn("[friday][source-materializer] operation failed:", redactSourceErrorMessage(err, sourceUri));
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) break;

      const name = entry.name;
      if (name.startsWith(".") && name !== ".env.example") {
        if (name !== ".github") continue;
      }

      const absolute = join(dir, name);
      if (!isWithinBase(rootPath, absolute)) continue;

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(name)) continue;
        walk(absolute, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!shouldIncludeFile(name)) continue;

      const rel = normalize(relative(rootPath, absolute)).replace(/\\/g, "/");
      if (rel.length === 0 || rel.startsWith("../")) continue;

      let content = "";
      try {
        const raw = readFileSync(absolute, "utf-8");
        content = raw.slice(0, maxFileBytes);
      } catch (err) {
        console.warn("[friday][source-materializer] operation failed:", redactSourceErrorMessage(err, sourceUri));
        continue;
      }

      if (content.trim().length === 0) continue;
      files.push({ relativePath: rel, content });
    }
  }
}

// ─── Git Source Materializer ───

function materializeGitSource(
  sourceUri: string,
  options: FridaySourceMaterializerOptions,
): FridayCodeRepoMaterializedSource {
  const tempDir = createTempWorkspace("friday-git-");

  try {
    // Shallow clone (depth=1) without submodules for safety
    execFileSync(
      "git",
      ["clone", "--depth", "1", "--single-branch", "--no-recurse-submodules", sourceUri, tempDir],
      {
        encoding: "utf-8",
        timeout: GIT_CLONE_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (err) {
    cleanupTempWorkspace(tempDir);
    throw new FridayDomainError(
      "CONVERTER_GIT_CLONE_FAILED",
      `Failed to clone git repository: ${redactFridaySkillCandidateSourceUri(sourceUri)}`,
      {
        httpStatus: 422,
        details: {
          sourceUri: redactFridaySkillCandidateSourceUri(sourceUri),
          error: redactSourceErrorMessage(err, sourceUri),
        },
      },
    );
  }

  // Enforce total size limit
  const totalSize = calculateDirSize(tempDir, options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES);
  if (totalSize > (options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES)) {
    cleanupTempWorkspace(tempDir);
    throw new FridayDomainError(
      "CONVERTER_SIZE_LIMIT_EXCEEDED",
      `Cloned repository exceeds size limit (${totalSize} bytes)`,
      { httpStatus: 422, details: { totalSize, limit: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES } },
    );
  }

  try {
    const result = materializeLocalSource(tempDir, options);
    return { ...result, rootPath: tempDir };
  } catch (err) {
    cleanupTempWorkspace(tempDir);
    throw err;
  }
}

// ─── Archive Source Materializer ───

function materializeArchiveSource(
  sourceUri: string,
  options: FridaySourceMaterializerOptions,
): FridayCodeRepoMaterializedSource {
  const archivePath = resolve(sourceUri);

  if (!existsSync(archivePath)) {
    throw new FridayDomainError(
      "CONVERTER_SOURCE_NOT_FOUND",
      `Archive file not found: ${redactFridaySkillCandidateSourceUri(sourceUri)}`,
      { httpStatus: 404 },
    );
  }

  const archiveSize = statSync(archivePath).size;
  const maxTotal = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  if (archiveSize > maxTotal) {
    throw new FridayDomainError(
      "CONVERTER_SIZE_LIMIT_EXCEEDED",
      `Archive file exceeds size limit (${archiveSize} bytes)`,
      { httpStatus: 422, details: { archiveSize, limit: maxTotal } },
    );
  }

  const tempDir = createTempWorkspace("friday-archive-");
  const lower = normalizedSourcePathForProtocol(sourceUri);

  try {
    if (lower.endsWith(".zip")) {
      validateZipArchiveEntries(archivePath);
      extractZip(archivePath, tempDir);
    } else if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
      validateTarArchiveEntries(archivePath, true);
      extractTarGz(archivePath, tempDir);
    } else if (lower.endsWith(".tar")) {
      validateTarArchiveEntries(archivePath, false);
      extractTar(archivePath, tempDir);
    } else {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `Unsupported archive format for source: ${redactFridaySkillCandidateSourceUri(sourceUri)}`,
        { httpStatus: 400 },
      );
    }
  } catch (err) {
    if (err instanceof FridayDomainError) {
      cleanupTempWorkspace(tempDir);
      throw err;
    }
    cleanupTempWorkspace(tempDir);
    throw new FridayDomainError(
      "CONVERTER_ARCHIVE_EXTRACT_FAILED",
      `Failed to extract archive: ${redactFridaySkillCandidateSourceUri(sourceUri)}`,
      {
        httpStatus: 422,
        details: {
          sourceUri: redactFridaySkillCandidateSourceUri(sourceUri),
          error: redactSourceErrorMessage(err, sourceUri),
        },
      },
    );
  }

  // Verify path safety: no extracted file escapes the temp dir
  validateExtractedPaths(tempDir);

  // If the archive extracted into a single subdirectory, use that as root
  const extractRoot = findExtractRoot(tempDir);

  try {
    const result = materializeLocalSource(extractRoot, options);
    return { ...result, rootPath: extractRoot };
  } catch (err) {
    cleanupTempWorkspace(tempDir);
    throw err;
  }
}

// ─── Archive Extraction Helpers ───

function extractZip(archivePath: string, destDir: string): void {
  execFileSync(
    "unzip",
    ["-q", "-o", archivePath, "-d", destDir],
    {
      encoding: "utf-8",
      timeout: EXTRACT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function redactSourceErrorMessage(err: unknown, sourceUri: string): string {
  const message = err instanceof Error ? err.message : String(err);
  const redactedSource = redactFridaySkillCandidateSourceUri(sourceUri);
  return redactFridaySkillSourceText(message, { uri: sourceUri })
    .split(resolve(sourceUri)).join(redactedSource);
}

function extractTarGz(archivePath: string, destDir: string): void {
  execFileSync(
    "tar",
    ["-xzf", archivePath, "-C", destDir],
    {
      encoding: "utf-8",
      timeout: EXTRACT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function extractTar(archivePath: string, destDir: string): void {
  execFileSync(
    "tar",
    ["-xf", archivePath, "-C", destDir],
    {
      encoding: "utf-8",
      timeout: EXTRACT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

// ─── Safety Helpers ───

function validateZipArchiveEntries(archivePath: string): void {
  const listing = execFileSync("unzip", ["-Z1", archivePath], {
    encoding: "utf8",
    stdio: "pipe",
  });
  for (const rawEntry of listing.split(/\r?\n/)) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    validateArchiveEntryPath(entry);
  }
}

function validateTarArchiveEntries(archivePath: string, gzipped: boolean): void {
  const listArgs = gzipped ? ["-tzf", archivePath] : ["-tf", archivePath];
  const verboseArgs = gzipped ? ["-tvzf", archivePath] : ["-tvf", archivePath];
  const listing = execFileSync("tar", listArgs, { encoding: "utf8", stdio: "pipe" });
  const verboseListing = execFileSync("tar", verboseArgs, { encoding: "utf8", stdio: "pipe" });
  const unsupportedEntryLine = verboseListing
    .split(/\r?\n/)
    .find((line) => {
      if (!line.trim()) return false;
      const type = line[0];
      return type !== "-" && type !== "d";
    });
  if (unsupportedEntryLine) {
    throw new FridayDomainError("CONVERTER_UNSUPPORTED_ARCHIVE_ENTRY", `Archive contains unsupported entry type: ${unsupportedEntryLine}`, { httpStatus: 422 });
  }

  for (const rawEntry of listing.split(/\r?\n/)) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    validateArchiveEntryPath(entry);
  }
}

function validateArchiveEntryPath(entry: string): void {
  const normalizedEntry = normalizeArchiveEntry(entry);
  if (isUnsafeRelativePath(normalizedEntry)) {
    throw new FridayDomainError("CONVERTER_PATH_TRAVERSAL", `Unsafe archive entry: ${entry}`, { httpStatus: 422 });
  }
}

function normalizeArchiveEntry(entry: string): string {
  if (entry.includes("\0") || entry.includes("\\")) {
    throw new FridayDomainError("CONVERTER_PATH_TRAVERSAL", `Unsafe archive entry: ${entry}`, { httpStatus: 422 });
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
    throw new FridayDomainError("CONVERTER_PATH_TRAVERSAL", `Unsafe archive entry: ${entry}`, { httpStatus: 422 });
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

function validateExtractedPaths(baseDir: string): void {
  const resolvedBase = resolve(baseDir);
  walkValidate(resolvedBase);

  function walkValidate(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
    console.warn("[friday][source-materializer] operation failed:", err instanceof Error ? err.message : String(err));
      return;
    }

    for (const entry of entries) {
      const fullPath = resolve(join(dir, entry.name));
      if (!isWithinBase(resolvedBase, fullPath)) {
        throw new FridayDomainError(
          "CONVERTER_PATH_TRAVERSAL",
          `Extracted path escapes workspace: ${entry.name}`,
          { httpStatus: 422 },
        );
      }
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        throw new FridayDomainError(
          "CONVERTER_UNSUPPORTED_ARCHIVE_ENTRY",
          `Archive contains unsupported symbolic link: ${entry.name}`,
          { httpStatus: 422 },
        );
      }
      if (entry.isDirectory()) {
        walkValidate(fullPath);
      }
    }
  }
}

function findExtractRoot(dir: string): string {
  const entries = readdirSync(dir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  const files = entries.filter((e) => e.isFile());

  // If there's exactly one subdirectory and no files, use that as root
  if (dirs.length === 1 && files.length === 0) {
    return join(dir, dirs[0].name);
  }

  return dir;
}

function calculateDirSize(dir: string, limit: number): number {
  let total = 0;

  function walk(d: string): void {
    if (total > limit) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch (err) {
    console.warn("[friday][source-materializer] operation failed:", err instanceof Error ? err.message : String(err));
      return;
    }
    for (const entry of entries) {
      if (total > limit) return;
      const fullPath = join(d, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(fullPath);
      } else if (entry.isFile()) {
        try {
          total += statSync(fullPath).size;
        } catch (err) {
    console.warn("[friday][source-materializer] operation failed:", err instanceof Error ? err.message : String(err));
          // skip
        }
      }
    }
  }

  walk(dir);
  return total;
}

// ─── Temp Workspace ───

function createTempWorkspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupTempWorkspace(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn("[friday][source-materializer] operation failed:", err instanceof Error ? err.message : String(err));
    // Best effort cleanup
  }
}

// ─── File Filter ───

function shouldIncludeFile(name: string): boolean {
  if (ALLOWED_FILE_NAMES.has(name)) return true;
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return false;
  const ext = lower.slice(dot);
  return ALLOWED_FILE_EXTENSIONS.has(ext);
}
