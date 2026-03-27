/**
 * Hardened audit log writer with forensic metadata and secure file permissions.
 *
 * Design:
 *   - Serialized writes per path (no concurrent writes to same file).
 *   - Rotation when file exceeds maxBytes: truncate to keepLines most recent.
 *   - JSONL format (one JSON object per line).
 *   - Forensic metadata: caller, request context, timing, process/runtime.
 *   - Secure file permissions: directories 0o700, files 0o600.
 *   - Outcome taxonomy: success | failure | denied | error.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

// ─── Outcome Taxonomy ───

export type FridayAuditOutcome = "success" | "failure" | "denied" | "error";

// ─── Forensic Audit Record ───

export interface FridayAuditRecord {
  /** Unique identifier for this audit entry. */
  id: string;
  /** ISO 8601 timestamp. */
  ts: string;
  /** Actor type. */
  actorType: "user" | "satellite" | "service" | "workflow-runner";
  /** Actor identifier. */
  actorId?: string;
  /** The action being audited. */
  action: string;
  /** Resource type affected. */
  resourceType: string;
  /** Resource identifier. */
  resourceId?: string;

  // ─── Request context ───
  /** Request ID for correlation. */
  requestId?: string;
  /** Distributed trace ID. */
  traceId?: string;

  // ─── Outcome taxonomy ───
  /** Outcome of the action. */
  result?: FridayAuditOutcome;
  /** Machine-readable error code (when result is "error" or "denied"). */
  errorCode?: string;
  /** Human-readable error description. */
  errorMessage?: string;

  // ─── Forensic metadata ───
  /** Caller identifier (function, module, service). */
  caller?: string;
  /** IP address of the request originator. */
  ip?: string;
  /** User agent string. */
  userAgent?: string;
  /** Duration of the operation in milliseconds. */
  durationMs?: number;
  /** Process ID. */
  pid?: number;
  /** Node.js version. */
  nodeVersion?: string;
  /** Platform identifier. */
  platform?: string;

  /** Arbitrary structured context for debugging / logging. */
  details?: Record<string, unknown>;
}

// ─── Build helpers ───

/**
 * Build a base audit record with guaranteed forensic metadata.
 *
 * Fills in `ts`, `pid`, `nodeVersion`, and `platform` automatically.
 * Callers provide the action-specific fields.
 */
export function buildFridayAuditRecordBase(
  fields: Omit<FridayAuditRecord, "ts" | "pid" | "nodeVersion" | "platform"> & {
    ts?: string;
  },
): FridayAuditRecord {
  return {
    ...fields,
    ts: fields.ts ?? new Date().toISOString(),
    pid: process.pid,
    nodeVersion: process.version,
    platform: process.platform,
  };
}

// ─── Writer Options ───

export interface FridayAuditLogWriterOptions {
  /** Maximum file size in bytes before rotation. Default: 10MB. */
  maxBytes?: number;
  /** Number of most-recent lines to keep after rotation. Default: 1000. */
  keepLines?: number;
}

// ─── Constants ───

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10MB
const DEFAULT_KEEP_LINES = 1000;
const AUDIT_LOG_FILENAME = "audit.jsonl";

/** Secure directory permission (owner only). */
const DIR_MODE = 0o700;
/** Secure file permission (owner read/write only). */
const FILE_MODE = 0o600;

// ─── Serialization map ───

const writeLocks = new Map<string, Promise<void>>();

async function serializedWrite(filePath: string, fn: () => Promise<void>): Promise<void> {
  const existing = writeLocks.get(filePath) ?? Promise.resolve();
  const next = existing.then(fn, fn); // Always execute, even if previous failed
  writeLocks.set(filePath, next);
  try {
    await next;
  } finally {
    // Clean up if this is still the last queued write
    if (writeLocks.get(filePath) === next) {
      writeLocks.delete(filePath);
    }
  }
}

// ─── Path helper ───

/**
 * Resolve the audit log path within a state directory.
 */
export function resolveFridayAuditLogPath(stateDir: string): string {
  return path.join(stateDir, ".friday", AUDIT_LOG_FILENAME);
}

// ─── Best-effort chmod ───

async function bestEffortChmod(filePath: string, mode: number): Promise<void> {
  try {
    await fs.chmod(filePath, mode);
  } catch (err) {
    // Best-effort — some filesystems don't support chmod
    console.warn("[friday][audit-log] chmod failed:", err instanceof Error ? err.message : String(err));
  }
}

// ─── Writer ───

/**
 * Append an audit log entry as a JSONL line with hardened file permissions.
 *
 * Writes are serialized per file path to prevent interleaving.
 * Performs rotation (truncation to keepLines) when the file exceeds maxBytes.
 *
 * Security hardening:
 *   - Directories created with mode 0o700 (owner-only).
 *   - Files written/appended with mode 0o600 (owner read/write only).
 *   - Post-write best-effort chmod to enforce permissions even on pre-existing files.
 */
export async function appendFridayAuditLog(
  filePath: string,
  entry: FridayAuditRecord,
  options?: FridayAuditLogWriterOptions,
): Promise<void> {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const keepLines = options?.keepLines ?? DEFAULT_KEEP_LINES;

  await serializedWrite(filePath, async () => {
    // Ensure directory exists with secure permissions
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });

    // Serialize entry as single JSONL line
    const line = JSON.stringify(entry) + "\n";

    // Append with secure permissions
    await fs.appendFile(filePath, line, { encoding: "utf8", mode: FILE_MODE });

    // Best-effort chmod to enforce permissions on pre-existing files
    await bestEffortChmod(filePath, FILE_MODE);

    // Check rotation
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > maxBytes) {
        // Rotate: keep only the most recent N lines
        const content = await fs.readFile(filePath, "utf8");
        const lines = content.split("\n").filter((l) => l.trim().length > 0);
        const kept = lines.slice(-keepLines);
        await fs.writeFile(filePath, kept.join("\n") + "\n", { encoding: "utf8", mode: FILE_MODE });
        await bestEffortChmod(filePath, FILE_MODE);
      }
    } catch (err) {
      // Rotation failure is non-fatal — log continues to work
      console.warn("[friday][audit-log] rotation failed:", err instanceof Error ? err.message : String(err));
    }
  });
}
