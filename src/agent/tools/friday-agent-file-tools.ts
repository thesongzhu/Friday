import { FridayDomainError } from "#errors";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";

import { FRIDAY_AGENT_READ_MAX_BYTES } from "../friday-agent.constants.js";
import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import { FridaySafeOpenError, isWithinBase, openFileWithinRoot } from "../../utilities/friday-path-safety.js";
import {
  errorResult,
  readNumberParam,
  readStringParam,
  textResult,
  truncateOutput,
} from "./friday-agent-tool-helpers.js";
import { getApprovalRequiredReasonForFileMutation } from "../runtime/friday-agent-tool-risk.js";

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return Boolean(err && typeof err === "object" && "code" in (err as Record<string, unknown>));
}

function openWritableFileNoFollow(filePath: string, options?: { create?: boolean }): number {
  const supportsNoFollow = process.platform !== "win32" && "O_NOFOLLOW" in fsSync.constants;
  const baseFlags = fsSync.constants.O_WRONLY;
  const createFlag = options?.create ? fsSync.constants.O_CREAT : 0;
  const noFollowFlag = supportsNoFollow ? fsSync.constants.O_NOFOLLOW : 0;
  const flags = baseFlags | createFlag | noFollowFlag;
  const mode = 0o600;

  try {
    return fsSync.openSync(filePath, flags, mode);
  } catch (err) {
    // Fallback path if platform rejects O_NOFOLLOW with EINVAL/ENOTSUP.
    if (supportsNoFollow && isNodeError(err) && (err.code === "EINVAL" || err.code === "ENOTSUP")) {
      try {
        const st = fsSync.lstatSync(filePath);
        if (st.isSymbolicLink()) {
          throw new FridayDomainError("VALIDATION_ERROR", `Path is a symlink (rejected): ${filePath}`, { httpStatus: 400 });
        }
      } catch (lstatErr) {
        if (isNodeError(lstatErr) && lstatErr.code === "ENOENT" && options?.create) {
          // Create-on-write path; allow fallback open to create.
        } else if (lstatErr instanceof Error) {
          throw lstatErr;
        }
      }
      const fallbackFlags = baseFlags | createFlag;
      return fsSync.openSync(filePath, fallbackFlags, mode);
    }
    throw err;
  }
}

// ─── Options ───

export interface CreateFridayAgentFileToolsOptions {
  /** Root directory for workspace sandboxing. File operations outside this path are rejected. */
  workspaceRoot?: string;
}

// ─── Path validation ───

/**
 * Returns true if any segment of the raw path is exactly "." or "..".
 */
function hasTraversalSegments(rawPath: string): boolean {
  return rawPath
    .split(/[\\/]+/)
    .some((segment) => segment === "." || segment === "..");
}

/**
 * Validates that a file path is within the allowed workspace root.
 * Rejects absolute paths outside workspace and `.` / `..` traversal.
 */
function validateFilePath(filePath: string, workspaceRoot: string): string | null {
  // Reject paths with `.` or `..` segments to prevent traversal
  if (hasTraversalSegments(filePath)) {
    return `Path "${filePath}" contains "." or ".." segments which are not allowed.`;
  }

  // Resolve workspace root via realpath to follow symlinks
  let resolvedRoot: string;
  try {
    resolvedRoot = fsSync.realpathSync(workspaceRoot);
  } catch (err) {
    console.warn("[friday][file-tools] realpath-workspace-root:", err instanceof Error ? err.message : String(err));
    resolvedRoot = path.resolve(workspaceRoot);
  }

  // Resolve the target path via realpath to follow symlinks.
  // If the path doesn't exist yet (e.g. write), walk up to the nearest existing ancestor.
  let resolved: string;
  try {
    resolved = fsSync.realpathSync(filePath);
  } catch (err) {
    // Path doesn't exist — walk up to the nearest existing ancestor and resolve from there
    if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      console.warn("[friday][file-tools] realpath-target:", err instanceof Error ? err.message : String(err));
    }
    const absolute = path.resolve(filePath);
    let ancestor = path.dirname(absolute);
    let tail = path.basename(absolute);

    // Walk up until we find an existing directory
    while (true) {
      try {
        const resolvedAncestor = fsSync.realpathSync(ancestor);
        resolved = path.join(resolvedAncestor, tail);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
          console.warn("[friday][file-tools] realpath-ancestor:", err instanceof Error ? err.message : String(err));
        }
        tail = path.join(path.basename(ancestor), tail);
        const parent = path.dirname(ancestor);
        if (parent === ancestor) {
          // Reached filesystem root — fall back to lexical resolve
          resolved = absolute;
          break;
        }
        ancestor = parent;
      }
    }
  }

  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    return `Path "${filePath}" is outside the allowed workspace root "${workspaceRoot}".`;
  }

  return null; // valid
}

// ─── Factory ───

export function createFridayAgentFileTools(
  options?: CreateFridayAgentFileToolsOptions,
): FridayAgentToolDefinition[] {
  const workspaceRoot = options?.workspaceRoot ?? process.cwd();

  return [
    createReadTool(workspaceRoot),
    createWriteTool(workspaceRoot),
    createEditTool(workspaceRoot),
  ];
}

// ─── Read tool ───

function createReadTool(workspaceRoot: string): FridayAgentToolDefinition {
  return {
    name: "read",
    description:
      "Read the contents of a file. Supports offset/limit for large files. " +
      "Output is truncated to 50KB.",
    parameters: {
      properties: {
        path: { type: "string", description: "Path to the file to read" },
        offset: { type: "number", description: "Line number to start from (1-indexed)" },
        limit: { type: "number", description: "Maximum number of lines to read" },
      },
      required: ["path"],
    },
    async execute(
      args: Record<string, unknown>,
      _signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const filePath = readStringParam(args, "path", { required: true });
      const offset = readNumberParam(args, "offset", { integer: true });
      const limit = readNumberParam(args, "limit", { integer: true });

      // Security: resolve relative to workspace and validate containment
      const resolved = path.resolve(workspaceRoot, filePath);
      const relative = path.relative(workspaceRoot, resolved);

      // If path is absolute and points outside workspace, compute relative for safe-open
      // For safe-open we need a relative path from the workspace root
      let relativePath: string;
      if (path.isAbsolute(filePath)) {
        // Check that it's within workspace
        const pathError = validateFilePath(filePath, workspaceRoot);
        if (pathError) return errorResult(pathError);
        relativePath = relative;
      } else {
        relativePath = filePath;
      }

      // Use safe-open with symlink + ancestor protection
      let fd: number;
      let resolvedPath: string;
      try {
        const result = openFileWithinRoot({ rootDir: workspaceRoot, relativePath });
        fd = result.fd;
        resolvedPath = result.resolvedPath;
      } catch (err) {
        if (err instanceof FridaySafeOpenError) {
          return errorResult(err.kind === "not-found"
            ? `Failed to read file: File not found: ${filePath}`
            : `Path "${filePath}" is not allowed: ${err.message}`);
        }
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Failed to read file: ${message}`);
      }

      try {
        const content = fsSync.readFileSync(fd, "utf8");
        let lines = content.split("\n");

        if (offset !== undefined && offset > 0) {
          lines = lines.slice(offset - 1);
        }

        if (limit !== undefined && limit > 0) {
          lines = lines.slice(0, limit);
        }

        const result = lines.join("\n");
        return textResult(truncateOutput(result, FRIDAY_AGENT_READ_MAX_BYTES));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(`Failed to read file: ${message}`);
      } finally {
        fsSync.closeSync(fd);
      }
    },
  };
}

// ─── Write tool ───

function createWriteTool(workspaceRoot: string): FridayAgentToolDefinition {
  return {
    name: "write",
    description:
      "Write content to a file. Creates the file if it doesn't exist. " +
      "Automatically creates parent directories.",
    parameters: {
      properties: {
        path: { type: "string", description: "Path to the file to write" },
        content: { type: "string", description: "Content to write to the file" },
      },
      required: ["path", "content"],
    },
    async execute(
      args: Record<string, unknown>,
      _signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const filePath = readStringParam(args, "path", { required: true });
      const content = readStringParam(args, "content", { required: true });

      // Security: validate path is within workspace
      const pathError = validateFilePath(filePath, workspaceRoot);
      if (pathError) {
        return errorResult(pathError);
      }

      const approvalReason = getApprovalRequiredReasonForFileMutation(filePath, [content]);
      if (approvalReason) {
        return errorResult(`Approval required before execution. ${approvalReason}`);
      }

      try {
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });

        // Post-mkdir containment re-check: resolve the directory via realpath
        // to detect symlink swap attacks between validateFilePath and here.
        let resolvedRoot: string;
        try {
          resolvedRoot = fsSync.realpathSync(workspaceRoot);
        } catch (err) {
          console.warn("[friday][file-tools] realpath-write-root:", err instanceof Error ? err.message : String(err));
          resolvedRoot = path.resolve(workspaceRoot);
        }
        const resolvedDir = fsSync.realpathSync(dir);
        if (!isWithinBase(resolvedRoot, resolvedDir)) {
          return errorResult(
            `Path "${filePath}" escapes workspace root after directory creation (possible symlink swap).`,
          );
        }

        // Write via verified fd with O_NOFOLLOW to prevent final-component symlink swap
        const safePath = path.join(resolvedDir, path.basename(filePath));
        let fd: number | null = null;
        try {
          fd = openWritableFileNoFollow(safePath, { create: true });
          const fdStat = fsSync.fstatSync(fd);
          const fileStat = fsSync.statSync(safePath);
          if (fdStat.ino !== fileStat.ino || fdStat.dev !== fileStat.dev) {
            throw new FridayDomainError("CONFLICT", `File identity mismatch (TOCTOU): ${safePath}`, { httpStatus: 409 });
          }
          // Truncate only after identity checks to avoid destructive partial failures.
          fsSync.ftruncateSync(fd, 0);
          fsSync.writeFileSync(fd, content, "utf8");
        } finally {
          if (fd !== null) {
            try {
              fsSync.closeSync(fd);
            } catch (err) {
              // Best-effort close
              console.warn("[friday][file-tools] close-write-fd:", err instanceof Error ? err.message : String(err));
            }
          }
        }
        const bytes = Buffer.byteLength(content, "utf8");
        return textResult(`Wrote ${String(bytes)} bytes to ${filePath}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(`Failed to write file: ${message}`);
      }
    },
  };
}

// ─── Edit tool ───

function createEditTool(workspaceRoot: string): FridayAgentToolDefinition {
  return {
    name: "edit",
    description:
      "Edit a file by replacing exact text. The oldText must match exactly " +
      "(including whitespace).",
    parameters: {
      properties: {
        path: { type: "string", description: "Path to the file to edit" },
        oldText: { type: "string", description: "Exact text to find and replace" },
        newText: { type: "string", description: "New text to replace the old text with" },
      },
      required: ["path", "oldText", "newText"],
    },
    async execute(
      args: Record<string, unknown>,
      _signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const filePath = readStringParam(args, "path", { required: true });

      // Security: validate path is within workspace
      const pathError = validateFilePath(filePath, workspaceRoot);
      if (pathError) {
        return errorResult(pathError);
      }

      // Do not trim oldText/newText — exact matching requires preserving whitespace
      if (typeof args.oldText !== "string" || !args.oldText) {
        return errorResult("oldText is required");
      }
      const oldText = args.oldText;
      const newText = typeof args.newText === "string" ? args.newText : "";

      const approvalReason = getApprovalRequiredReasonForFileMutation(filePath, [oldText, newText]);
      if (approvalReason) {
        return errorResult(`Approval required before execution. ${approvalReason}`);
      }

      try {
        let resolvedRoot: string;
        try {
          resolvedRoot = fsSync.realpathSync(workspaceRoot);
        } catch (err) {
          console.warn("[friday][file-tools] realpath-edit-root:", err instanceof Error ? err.message : String(err));
          resolvedRoot = path.resolve(workspaceRoot);
        }
        const resolvedFile = fsSync.realpathSync(filePath);
        if (!isWithinBase(resolvedRoot, resolvedFile)) {
          return errorResult(`Path "${filePath}" escapes workspace root (possible symlink).`);
        }

        const beforeStat = fsSync.statSync(resolvedFile);
        const content = await fs.readFile(resolvedFile, "utf8");

        if (!content.includes(oldText)) {
          return errorResult(
            `oldText not found in ${filePath}. Make sure it matches exactly.`,
          );
        }

        // Replace first occurrence only, write back via verified fd
        const updated = content.replace(oldText, newText);
        let fd: number | null = null;
        try {
          fd = openWritableFileNoFollow(resolvedFile, { create: false });
          const fdStat = fsSync.fstatSync(fd);
          if (fdStat.ino !== beforeStat.ino || fdStat.dev !== beforeStat.dev) {
            throw new FridayDomainError("CONFLICT", `File identity mismatch (TOCTOU): ${resolvedFile}`, { httpStatus: 409 });
          }
          // Truncate only after identity checks to avoid destructive partial failures.
          fsSync.ftruncateSync(fd, 0);
          fsSync.writeFileSync(fd, updated, "utf8");
        } finally {
          if (fd !== null) {
            try {
              fsSync.closeSync(fd);
            } catch (err) {
              // Best-effort close
              console.warn("[friday][file-tools] close-edit-fd:", err instanceof Error ? err.message : String(err));
            }
          }
        }
        return textResult(`Edited ${filePath}: replaced ${String(oldText.length)} chars`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(`Failed to edit file: ${message}`);
      }
    },
  };
}
