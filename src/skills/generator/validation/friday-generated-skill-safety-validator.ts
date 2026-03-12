import { extname } from "node:path";

import type { SkillManifestV2 } from "#skills";

import type {
  FridayGeneratedSkillFile,
  FridayGeneratedSkillValidationIssue,
} from "../model/friday-skill-generator.types.js";

// ─── Constants ───

const MAX_FILE_COUNT = 20;
const MAX_FILE_SIZE_BYTES = 512 * 1024; // 512 KB per file

// ─── Language detection from file extension ───

type DetectedLanguage = "javascript" | "typescript" | "bash" | "json" | "markdown" | "unknown";

function detectLanguageFromExtension(filePath: string): DetectedLanguage {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".sh":
    case ".bash":
      return "bash";
    case ".json":
      return "json";
    case ".md":
    case ".mdx":
      return "markdown";
    default:
      return "unknown";
  }
}

// ─── Valid shell shebangs ───

const VALID_SHEBANGS: ReadonlyArray<string> = [
  "#!/bin/bash",
  "#!/bin/sh",
  "#!/usr/bin/env bash",
  "#!/usr/bin/env sh",
];

// ─── Shell command allowlist ───

const SHELL_COMMAND_ALLOWLIST: ReadonlySet<string> = new Set([
  "curl", "wget", "jq", "echo", "cat", "grep", "sed", "awk",
  "date", "printf", "test", "read", "tr", "sort", "uniq",
  "head", "tail", "wc", "cut", "paste", "tee", "xargs",
  "basename", "dirname", "mktemp", "mkdir", "cp", "mv", "ls",
  "find", "touch", "sleep", "true", "false", "exit", "return",
  "export", "local", "set", "unset", "shift", "if", "then",
  "else", "elif", "fi", "for", "do", "done", "while", "until",
  "case", "esac", "function", "source", "cd", "pwd", "trap",
  "wait", "getopts", "declare", "readonly", "typeset",
]);

// ─── Dangerous Node imports ───

const DANGEROUS_NODE_IMPORTS: ReadonlyArray<{
  pattern: RegExp;
  module: string;
  requiredResource: string;
  requiredAction: string;
}> = [
  {
    pattern: /\b(?:require\s*\(\s*['"](?:node:)?child_process['"]|import\b.*['"](?:node:)?child_process['"])/,
    module: "child_process",
    requiredResource: "shell",
    requiredAction: "execute",
  },
  {
    pattern: /\b(?:require\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]|import\b.*['"](?:node:)?fs(?:\/promises)?['"])/,
    module: "fs",
    requiredResource: "filesystem",
    requiredAction: "read",
  },
  {
    pattern: /\b(?:require\s*\(\s*['"](?:node:)?net['"]|import\b.*['"](?:node:)?net['"])/,
    module: "net",
    requiredResource: "network",
    requiredAction: "connect",
  },
];

// ─── Dangerous shell patterns ───

const DANGEROUS_SHELL_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  description: string;
}> = [
  { pattern: /\brm\s+-rf\s+\//, description: "Recursive delete from root" },
  { pattern: /\b(?:sudo|su)\b/, description: "Privilege escalation" },
  { pattern: /\b(?:chmod|chown)\s+.*(?:777|666)/, description: "Dangerous permission change" },
  { pattern: />\s*\/dev\/sd[a-z]/, description: "Direct device write" },
  { pattern: /\b(?:mkfs|dd\s+if=)/, description: "Disk formatting / raw block write" },
  { pattern: /\beval\s+/, description: "Shell eval with dynamic input" },
  { pattern: /\$\(.*\bcat\b.*\/etc\/(?:passwd|shadow)\b/, description: "Credential file access" },
  { pattern: /\bcurl\b.*\|\s*(?:bash|sh|zsh)/, description: "Pipe remote script to shell" },
  { pattern: /\bwget\b.*\|\s*(?:bash|sh|zsh)/, description: "Pipe remote download to shell" },
];

// ─── Path traversal check ───

function hasPathTraversal(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return true;
  if (normalized.includes("../")) return true;
  if (normalized.includes("..\\")) return true;
  return false;
}

// ─── Permission check against PermissionPolicyV2 grants ───

function hasGrant(
  manifest: SkillManifestV2,
  resource: string,
  action: string,
): boolean {
  return manifest.permissions.grants.some(
    (g) => g.resource === resource && g.action === action,
  );
}

// ─── Extract leading commands from shell lines ───

function extractShellCommands(content: string): string[] {
  const commands: string[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip comments, empty lines, shebangs, and pure variable assignments
    if (!trimmed || trimmed.startsWith("#") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) {
      continue;
    }
    // Handle piped commands: extract each command in the pipeline
    const segments = trimmed.split(/[|;&]+/);
    for (const seg of segments) {
      const clean = seg.trim();
      // Strip leading $(, backticks, and subshell parens
      const cmdMatch = /^(?:\$\(|\(|`)?([A-Za-z_][A-Za-z0-9_./-]*)/.exec(clean);
      if (cmdMatch?.[1]) {
        commands.push(cmdMatch[1]);
      }
    }
  }
  return commands;
}

// ─── Main validation function ───

export function validateGeneratedCode(
  files: FridayGeneratedSkillFile[],
  manifest: SkillManifestV2,
): FridayGeneratedSkillValidationIssue[] {
  const issues: FridayGeneratedSkillValidationIssue[] = [];
  const runtimeKind = manifest.runtime.kind;

  // File count check
  if (files.length > MAX_FILE_COUNT) {
    issues.push({
      code: "FILE_COUNT_EXCEEDED",
      severity: "error",
      message: `Too many files: ${files.length} exceeds limit of ${MAX_FILE_COUNT}`,
    });
  }

  if (files.length === 0) {
    issues.push({
      code: "NO_FILES",
      severity: "error",
      message: "No files generated",
    });
  }

  // Build set of generated file paths to verify entrypoint exists
  const generatedPaths = new Set(files.map((f) => f.path));

  // Verify manifest entrypoint file exists in generated files
  const entrypoint = manifest.runtime.entrypoint;
  if (entrypoint && files.length > 0 && !generatedPaths.has(entrypoint)) {
    issues.push({
      code: "ENTRYPOINT_MISSING",
      severity: "error",
      message: `Manifest entrypoint "${entrypoint}" not found in generated files`,
      path: entrypoint,
    });
  }

  for (const file of files) {
    // Detect language from file extension, do NOT trust model-supplied file.language
    const detectedLang = detectLanguageFromExtension(file.path);

    // Path traversal
    if (hasPathTraversal(file.path)) {
      issues.push({
        code: "PATH_TRAVERSAL",
        severity: "error",
        message: `Path traversal detected in file path: ${file.path}`,
        path: file.path,
      });
    }

    // File size
    const sizeBytes = new TextEncoder().encode(file.content).length;
    if (sizeBytes > MAX_FILE_SIZE_BYTES) {
      issues.push({
        code: "FILE_SIZE_EXCEEDED",
        severity: "error",
        message: `File ${file.path} exceeds size limit (${sizeBytes} > ${MAX_FILE_SIZE_BYTES} bytes)`,
        path: file.path,
      });
    }

    // Node-specific checks — use detected language
    if (
      runtimeKind === "node" &&
      (detectedLang === "javascript" || detectedLang === "typescript")
    ) {
      for (const check of DANGEROUS_NODE_IMPORTS) {
        if (check.pattern.test(file.content)) {
          if (!hasGrant(manifest, check.requiredResource, check.requiredAction)) {
            issues.push({
              code: "DANGEROUS_IMPORT",
              severity: "error",
              message: `File ${file.path} uses "${check.module}" without matching permission grant (${check.requiredResource}.${check.requiredAction})`,
              path: file.path,
            });
          }
        }
      }
    }

    // Shell-specific checks — use detected language
    if (runtimeKind === "shell" && detectedLang === "bash") {
      // Shebang enforcement: first line must be a valid shebang
      const firstLine = file.content.split("\n")[0]?.trim() ?? "";
      if (!VALID_SHEBANGS.some((s) => firstLine.startsWith(s))) {
        issues.push({
          code: "SHELL_MISSING_SHEBANG",
          severity: "error",
          message: `File ${file.path}: must start with a valid shebang (#!/bin/bash, #!/bin/sh, or #!/usr/bin/env bash)`,
          path: file.path,
        });
      }

      // Dangerous pattern blacklist
      for (const check of DANGEROUS_SHELL_PATTERNS) {
        if (check.pattern.test(file.content)) {
          issues.push({
            code: "DANGEROUS_SHELL_PATTERN",
            severity: "error",
            message: `File ${file.path}: ${check.description}`,
            path: file.path,
          });
        }
      }

      // Command allowlist check — warn on unknown commands
      const usedCommands = extractShellCommands(file.content);
      for (const cmd of usedCommands) {
        if (!SHELL_COMMAND_ALLOWLIST.has(cmd)) {
          issues.push({
            code: "SHELL_COMMAND_NOT_IN_ALLOWLIST",
            severity: "warning",
            message: `File ${file.path}: command "${cmd}" is not in the shell allowlist`,
            path: file.path,
          });
        }
      }
    }
  }

  return issues;
}
