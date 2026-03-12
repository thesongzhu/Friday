/**
 * Hub audit log writer — legacy compatibility wrapper around the hardened
 * security audit log writer.
 *
 * Delegates to `src/security/friday-audit-log.ts` for actual writes.
 * Accepts the legacy `FridayAuditLogWrite` type from hub memory state types
 * and converts to `FridayAuditRecord` for the security layer.
 */

import {
  appendFridayAuditLog as appendSecurityAuditLog,
  buildFridayAuditRecordBase,
  resolveFridayAuditLogPath as resolveSecurityAuditLogPath,
} from "../../security/friday-audit-log.js";
import type { FridayAuditRecord, FridayAuditLogWriterOptions as SecurityWriterOptions } from "../../security/friday-audit-log.js";
import type { FridayAuditLogWrite } from "./friday-hub-memory-state.types.js";

// ─── Types (legacy compatibility re-export) ───

export interface FridayAuditLogWriterOptions {
  /** Maximum file size in bytes before rotation. Default: 10MB. */
  maxBytes?: number;
  /** Number of most-recent lines to keep after rotation. Default: 1000. */
  keepLines?: number;
}

// ─── Path helper (legacy compatibility re-export) ───

/**
 * Resolve the audit log path within a state directory.
 */
export function resolveFridayAuditLogPath(stateDir: string): string {
  return resolveSecurityAuditLogPath(stateDir);
}

// ─── Adapter ───

/**
 * Convert a legacy `FridayAuditLogWrite` entry to the enriched `FridayAuditRecord`.
 */
function toAuditRecord(entry: FridayAuditLogWrite): FridayAuditRecord {
  return buildFridayAuditRecordBase({
    id: entry.id,
    ts: entry.ts,
    actorType: entry.actorType,
    actorId: entry.actorId,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    requestId: entry.requestId,
    traceId: entry.traceId,
    details: entry.details,
    result: entry.result,
    errorCode: entry.errorCode,
    errorMessage: entry.errorMessage,
    caller: entry.caller,
  });
}

// ─── Writer (legacy compatibility wrapper) ───

/**
 * Append an audit log entry as a JSONL line.
 *
 * Delegates to the hardened security audit writer with forensic metadata
 * and secure file permissions.
 */
export async function appendFridayAuditLog(
  filePath: string,
  entry: FridayAuditLogWrite,
  options?: FridayAuditLogWriterOptions,
): Promise<void> {
  const record = toAuditRecord(entry);
  const securityOptions: SecurityWriterOptions | undefined = options
    ? { maxBytes: options.maxBytes, keepLines: options.keepLines }
    : undefined;
  await appendSecurityAuditLog(filePath, record, securityOptions);
}
