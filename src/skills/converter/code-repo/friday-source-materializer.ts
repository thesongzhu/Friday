import { execSync } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, extname, join, normalize, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

import { FridayDomainError } from "#errors";
import { isWithinBase } from "#utilities";

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
  const lower = sourceUri.toLowerCase();
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
    console.warn("[friday][source-materializer] operation failed:", err instanceof Error ? err.message : String(err));
    throw new FridayDomainError(
      "CONVERTER_SOURCE_NOT_FOUND",
      `Code repository source not found: ${sourceUri}`,
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
    console.warn("[friday][source-materializer] operation failed:", err instanceof Error ? err.message : String(err));
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
    console.warn("[friday][source-materializer] operation failed:", err instanceof Error ? err.message : String(err));
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
    execSync(
      `git clone --depth 1 --single-branch --no-recurse-submodules ${escapeShellArg(sourceUri)} ${escapeShellArg(tempDir)}`,
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
      `Failed to clone git repository: ${sourceUri}`,
      {
        httpStatus: 422,
        details: { sourceUri, error: err instanceof Error ? err.message : String(err) },
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
      `Archive file not found: ${sourceUri}`,
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
  const lower = sourceUri.toLowerCase();

  try {
    if (lower.endsWith(".zip")) {
      extractZip(archivePath, tempDir);
    } else if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
      extractTarGz(archivePath, tempDir);
    } else if (lower.endsWith(".tar")) {
      extractTar(archivePath, tempDir);
    } else {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `Unsupported archive format: ${extname(sourceUri)}`,
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
      `Failed to extract archive: ${sourceUri}`,
      {
        httpStatus: 422,
        details: { sourceUri, error: err instanceof Error ? err.message : String(err) },
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
  execSync(
    `unzip -q -o ${escapeShellArg(archivePath)} -d ${escapeShellArg(destDir)}`,
    {
      encoding: "utf-8",
      timeout: EXTRACT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function extractTarGz(archivePath: string, destDir: string): void {
  execSync(
    `tar -xzf ${escapeShellArg(archivePath)} -C ${escapeShellArg(destDir)}`,
    {
      encoding: "utf-8",
      timeout: EXTRACT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function extractTar(archivePath: string, destDir: string): void {
  execSync(
    `tar -xf ${escapeShellArg(archivePath)} -C ${escapeShellArg(destDir)}`,
    {
      encoding: "utf-8",
      timeout: EXTRACT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

// ─── Safety Helpers ───

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
      if (!fullPath.startsWith(resolvedBase)) {
        throw new FridayDomainError(
          "CONVERTER_PATH_TRAVERSAL",
          `Extracted path escapes workspace: ${entry.name}`,
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

// ─── Shell Helpers ───

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
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
