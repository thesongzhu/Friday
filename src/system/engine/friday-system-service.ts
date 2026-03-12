import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";

import type { DesktopSessionManager } from "../../desktop/engine/session-manager.js";
import type {
  FridayDesktopAction,
  FridayDesktopPermission,
  FridayDesktopRiskLevel,
} from "../../desktop/model/friday-desktop.types.js";
import type {
  FridaySystemApprovalDecision,
  FridaySystemApprovalRule,
  FridaySystemCapabilityAvailability,
  FridaySystemCloudPlanningMode,
  FridaySystemCompanionStatus,
  FridaySystemControlLease,
  FridaySystemControlLeaseOwnerKind,
  FridaySystemEvent,
  FridaySystemEventName,
  FridaySystemHealth,
  FridaySystemIntentAction,
  FridaySystemIntentInput,
  FridaySystemIntentResult,
  FridaySystemMode,
  FridaySystemNotificationAction,
  FridaySystemPermissionGrant,
  FridaySystemRemoteAssertionGrant,
  FridaySystemRemoteAuthChallenge,
  FridaySystemRemoteDevice,
  FridaySystemRemoteMode,
  FridaySystemRemotePasskey,
  FridaySystemRemotePasskeyAssertionOptions,
  FridaySystemRemotePasskeyAssertionResult,
  FridaySystemRemotePasskeyRegistrationOptions,
  FridaySystemRemotePasskeyRegistrationResult,
  FridaySystemRemoteSession,
  FridaySystemRemoteSessionStatus,
  FridaySystemSession,
  FridaySystemSnapshot,
  FridaySystemWindowLayout,
  FridayTrustedDevicePlatform,
  ISODateTime,
  UUID,
} from "../model/friday-system.types.js";
import type { FridaySystemCompanionBridge } from "../companion/friday-system-companion.types.js";
import {
  createFridaySystemRemoteAuthAdapter,
  type FridaySystemRemoteAuthAdapter,
} from "../auth/friday-system-remote-auth.js";
import {
  createFridaySystemRepository,
  type FridaySystemApprovalRuleFilters,
} from "../persistence/friday-system-repository.js";

const execFileAsync = promisify(execFile);

const DEFAULT_LEASE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_EVENT_LIMIT = 100;
const MAX_FILE_SEARCH_RESULTS = 50;
const DEFAULT_COMPANION_HEARTBEAT_STALE_MS = 30_000;
const DEFAULT_REMOTE_AUTH_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_REMOTE_ASSERTION_TTL_MS = 2 * 60 * 1000;

const HIGH_RISK_INTENTS = new Set<FridaySystemIntentAction>([
  "close_app",
  "clipboard_read",
  "notification_act",
]);

const MUTATING_INTENTS = new Set<FridaySystemIntentAction>([
  "open",
  "focus",
  "arrange_windows",
  "launch_app",
  "close_app",
  "open_url",
  "open_project",
  "handoff_to_browser",
  "handoff_to_terminal",
  "notification_act",
  "resume_task",
  "recover_ui",
  "clipboard_read",
  "clipboard_write",
]);

export interface FridaySystemExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CreateFridaySystemServiceDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => ISODateTime;
  workspaceRoot: string;
  companionBridge: FridaySystemCompanionBridge;
  remoteAuthAdapter?: FridaySystemRemoteAuthAdapter;
  desktopSessionManager?: DesktopSessionManager;
  execCommand?: (command: string, args: string[]) => Promise<FridaySystemExecResult>;
  mode?: FridaySystemMode;
  remoteMode?: FridaySystemRemoteMode;
  cloudPlanningMode?: FridaySystemCloudPlanningMode;
  defaultLeaseTtlMs?: number;
  companionHeartbeatStaleMs?: number;
  remoteAuth?: {
    rpName?: string;
    rpId?: string;
    origin?: string;
    challengeTtlMs?: number;
    assertionTtlMs?: number;
  };
}

export type FridaySystemEventListener = (event: FridaySystemEvent) => void;

export interface FridaySystemService {
  getSession(): Promise<FridaySystemSession>;
  getState(): Promise<FridaySystemSnapshot>;
  executeIntent(input: FridaySystemIntentInput): Promise<FridaySystemIntentResult>;
  listApprovalRules(filters?: FridaySystemApprovalRuleFilters): FridaySystemApprovalRule[];
  updateApprovalRule(
    id: UUID,
    patch: Partial<Pick<FridaySystemApprovalRule, "decision" | "rationale" | "lastUsedAt">>,
  ): FridaySystemApprovalRule | null;
  upsertApprovalRule(input: {
    action: FridaySystemIntentAction | string;
    appIdentifier?: string;
    riskLevel: FridayDesktopRiskLevel;
    decision: FridaySystemApprovalDecision;
    rationale?: string;
  }): FridaySystemApprovalRule;
  listRemoteDevices(): FridaySystemRemoteDevice[];
  registerRemoteDevice(input: {
    label: string;
    fingerprint: string;
    platform?: FridayTrustedDevicePlatform;
    credentialId?: string;
  }): FridaySystemRemoteDevice;
  beginRemotePasskeyRegistration(input: {
    deviceId: UUID;
    origin?: string;
  }): Promise<FridaySystemRemotePasskeyRegistrationOptions>;
  verifyRemotePasskeyRegistration(input: {
    deviceId: UUID;
    challengeId: UUID;
    response: Parameters<FridaySystemRemoteAuthAdapter["verifyRegistration"]>[0]["response"];
    origin?: string;
  }): Promise<FridaySystemRemotePasskeyRegistrationResult>;
  beginRemotePasskeyAssertion(input: {
    deviceId: UUID;
    origin?: string;
  }): Promise<FridaySystemRemotePasskeyAssertionOptions>;
  verifyRemotePasskeyAssertion(input: {
    deviceId: UUID;
    challengeId: UUID;
    response: Parameters<FridaySystemRemoteAuthAdapter["verifyAuthentication"]>[0]["response"];
    origin?: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<FridaySystemRemotePasskeyAssertionResult>;
  clearRemoteDevicePasskey(id: UUID): Promise<FridaySystemRemoteDevice>;
  revokeRemoteDevice(id: UUID): FridaySystemRemoteDevice | null;
  listRemoteSessions(input?: {
    deviceId?: UUID;
    status?: FridaySystemRemoteSessionStatus;
    limit?: number;
  }): FridaySystemRemoteSession[];
  openRemoteSession(input: {
    deviceId: UUID;
    assertionToken: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<FridaySystemRemoteSession>;
  touchRemoteSession(
    id: UUID,
    input?: {
      ipAddress?: string;
      userAgent?: string;
    },
  ): Promise<FridaySystemRemoteSession | null>;
  closeRemoteSession(id: UUID, reason?: string): Promise<FridaySystemRemoteSession | null>;
  listEvents(input?: { afterSeq?: number; limit?: number }): FridaySystemEvent[];
  subscribe(listener: FridaySystemEventListener): () => void;
}

function resolveRiskLevel(action: FridaySystemIntentAction): FridayDesktopRiskLevel {
  if (action === "close_app" || action === "notification_act") return "high";
  if (action === "clipboard_read") return "high";
  if (action === "clipboard_write" || action === "launch_app") return "medium";
  return "low";
}

function defaultExecCommand(command: string, args: string[]): Promise<FridaySystemExecResult> {
  return execFileAsync(command, args)
    .then(({ stdout, stderr }) => ({
      exitCode: 0,
      stdout: stdout ?? "",
      stderr: stderr ?? "",
    }))
    .catch((error: unknown) => {
      const err = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
      };
      return {
        exitCode: typeof err.code === "number" ? err.code : 1,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message ?? String(error),
      };
    });
}

function sanitizeTextPreview(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
}

function requireNonEmpty(value: string | undefined, field: string): string {
  if (!value || value.trim().length === 0) {
    throw new FridayDomainError("VALIDATION_ERROR", `${field} is required`, { httpStatus: 400 });
  }
  return value.trim();
}

function normalizeRemoteAddress(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const first = value.split(",")[0]?.trim();
  if (!first) {
    return undefined;
  }
  const withoutPort = first.startsWith("[")
    ? first.replace(/^\[([^\]]+)\](?::\d+)?$/, "$1")
    : first.includes(":") && first.split(":").length === 2 && first.includes(".")
      ? first.split(":")[0]
      : first;
  return withoutPort.trim().toLowerCase() || undefined;
}

function isTrustedPrivateNetworkAddress(value: string | undefined): boolean {
  const normalized = normalizeRemoteAddress(value);
  if (!normalized) {
    return false;
  }
  if (normalized === "localhost" || normalized === "localhost.localdomain") {
    return true;
  }
  const parts = normalized.split(".");
  if (parts.length === 4 && parts.every((part) => /^\d+$/.test(part))) {
    const octets = parts.map((part) => Number.parseInt(part, 10));
    if (octets[0] === 10) return true;
    if (octets[0] === 127) return true;
    if (octets[0] === 192 && octets[1] === 168) return true;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
    if (octets[0] === 169 && octets[1] === 254) return true;
    if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return true;
    return false;
  }
  return normalized === "::1"
    || normalized === "::"
    || normalized.startsWith("fe80:")
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("::ffff:127.")
    || normalized.startsWith("::ffff:10.")
    || normalized.startsWith("::ffff:192.168.")
    || /^::ffff:172\.(1[6-9]|2\d|3[0-1])\./.test(normalized)
    || normalized.startsWith("::ffff:169.254.");
}

function hashAssertionToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function isLeaseExpired(lease: FridaySystemControlLease | null, nowIso: string): boolean {
  if (!lease?.expiresAt) return false;
  return new Date(lease.expiresAt).getTime() <= new Date(nowIso).getTime();
}

function mapDesktopPermissions(
  permissions: readonly FridayDesktopPermission[],
  idGenerator: () => string,
): FridaySystemPermissionGrant[] {
  return permissions.map((permission) => ({
    id: idGenerator(),
    permission: permission.permissionType,
    status: permission.status,
    grantInstructions: permission.grantInstructions,
  }));
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const resolved = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(resolved));
      continue;
    }
    if (entry.isFile()) {
      files.push(resolved);
    }
  }
  return files;
}

export async function createFridaySystemService(
  deps: CreateFridaySystemServiceDeps,
): Promise<FridaySystemService> {
  const repository = createFridaySystemRepository();
  const listeners = new Set<FridaySystemEventListener>();
  const execCommand = deps.execCommand ?? defaultExecCommand;
  const mode = deps.mode ?? "agent_os";
  const remoteMode = deps.remoteMode ?? "trusted_private_network";
  const cloudPlanningMode = deps.cloudPlanningMode ?? "opt_in";
  const leaseTtlMs = deps.defaultLeaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const companionHeartbeatStaleMs = deps.companionHeartbeatStaleMs ?? DEFAULT_COMPANION_HEARTBEAT_STALE_MS;
  const remoteAuthAdapter = deps.remoteAuthAdapter ?? createFridaySystemRemoteAuthAdapter();
  const remoteAuthRpName = deps.remoteAuth?.rpName ?? "Friday Agent OS";
  const remoteAuthOrigin = deps.remoteAuth?.origin ?? "http://localhost:3141";
  const remoteAuthRpId = deps.remoteAuth?.rpId ?? "localhost";
  const remoteAuthChallengeTtlMs = deps.remoteAuth?.challengeTtlMs ?? DEFAULT_REMOTE_AUTH_CHALLENGE_TTL_MS;
  const remoteAssertionTtlMs = deps.remoteAuth?.assertionTtlMs ?? DEFAULT_REMOTE_ASSERTION_TTL_MS;
  const sessionId = deps.idGenerator();
  const startedAt = deps.nowIso();
  const lastTaskEvent = deps.db.withReadConnection((db) =>
    repository.findLatestEventByName(db, "system.task.updated"),
  );
  const lastSafeModeEnteredEvent = deps.db.withReadConnection((db) =>
    repository.findLatestEventByName(db, "system.safe_mode.entered"),
  );
  const lastSafeModeExitedEvent = deps.db.withReadConnection((db) =>
    repository.findLatestEventByName(db, "system.safe_mode.exited"),
  );
  let activeTask = typeof lastTaskEvent?.payload.activeTask === "string"
    ? lastTaskEvent.payload.activeTask
    : undefined;
  let safeMode = lastSafeModeEnteredEvent !== null
    && (
      lastSafeModeExitedEvent === null
      || lastSafeModeEnteredEvent.seq > lastSafeModeExitedEvent.seq
    );
  let activeLease = deps.db.withReadConnection((db) =>
    repository.getLatestActiveControlLease(db, deps.nowIso()),
  );
  let lastHealthFingerprint = "";
  let lastCompanionConnected: boolean | undefined;
  let lastCompanionHeartbeatStale: boolean | undefined;
  let lastCompanionSafeMode: boolean | undefined;
  let lastPermissionFingerprint = "";

  await deps.companionBridge.connect();

  async function emitEvent(
    event: FridaySystemEventName,
    payload: Record<string, unknown>,
  ): Promise<FridaySystemEvent> {
    const record = deps.db.withWriteTransaction((db) =>
      repository.appendEvent(db, {
        id: deps.idGenerator(),
        event,
        payload,
        emittedAt: deps.nowIso(),
      }),
    );
    for (const listener of listeners) {
      listener(record);
    }
    return record;
  }

  function isCompanionHeartbeatStale(lastHeartbeatAt: string): boolean {
    return new Date(deps.nowIso()).getTime() - new Date(lastHeartbeatAt).getTime() > companionHeartbeatStaleMs;
  }

  async function emitCompanionEventsIfChanged(
    companion: FridaySystemCompanionStatus,
    permissions: readonly FridaySystemPermissionGrant[],
  ): Promise<void> {
    if (lastCompanionConnected === undefined || lastCompanionConnected !== companion.connected) {
      await emitEvent(
        companion.connected ? "system.companion.connected" : "system.companion.disconnected",
        {
          companionId: companion.id,
          transportMode: companion.transport.mode,
          authenticated: companion.transport.authenticated,
        },
      );
      lastCompanionConnected = companion.connected;
    }

    const heartbeatStale = isCompanionHeartbeatStale(companion.lastHeartbeatAt);
    if (heartbeatStale && lastCompanionHeartbeatStale !== true) {
      await emitEvent("system.companion.heartbeat_stale", {
        companionId: companion.id,
        lastHeartbeatAt: companion.lastHeartbeatAt,
      });
    }
    lastCompanionHeartbeatStale = heartbeatStale;

    if (lastCompanionSafeMode !== companion.safeMode) {
      const previousEffectiveSafeMode = safeMode || (lastCompanionSafeMode ?? false);
      const nextEffectiveSafeMode = safeMode || companion.safeMode;
      if (companion.safeMode) {
        const lease = normalizeActiveLease();
        if (lease) {
          deps.db.withWriteTransaction((db) => {
            repository.revokeControlLease(db, lease.id, deps.nowIso(), "companion_panic_override");
          });
          activeLease = null;
          await emitEvent("system.control.released", {
            leaseId: lease.id,
            ownerId: lease.ownerId,
            ownerKind: lease.ownerKind,
            reason: "companion_panic_override",
          });
        }
      }
      if (!previousEffectiveSafeMode && nextEffectiveSafeMode) {
        await emitEvent("system.safe_mode.entered", {
          companionId: companion.id,
          reason: "companion_panic_override",
        });
      } else if (previousEffectiveSafeMode && !nextEffectiveSafeMode) {
        await emitEvent("system.safe_mode.exited", {
          companionId: companion.id,
          reason: "companion_safe_mode_cleared",
        });
      }
      lastCompanionSafeMode = companion.safeMode;
    }

    const permissionFingerprint = JSON.stringify(
      permissions
        .map((permission) => `${permission.permission}:${permission.status}`)
        .sort(),
    );
    if (lastPermissionFingerprint !== "" && lastPermissionFingerprint !== permissionFingerprint) {
      await emitEvent("system.companion.permissions_changed", {
        companionId: companion.id,
        permissions,
      });
    }
    lastPermissionFingerprint = permissionFingerprint;
  }

  async function emitHealthIfChanged(reason?: string): Promise<void> {
    const health = await readHealth();
    const fingerprint = JSON.stringify({
      status: health.status,
      safeMode: health.safeMode,
      desktopConnected: health.desktopConnected,
      companionConnected: health.companionConnected,
      reasons: [...health.reasons].sort(),
    });
    if (fingerprint === lastHealthFingerprint) {
      return;
    }
    lastHealthFingerprint = fingerprint;
    await emitEvent("system.health.updated", {
      health,
      ...(reason ? { reason } : {}),
    });
  }

  function normalizeActiveLease(nowIso = deps.nowIso()): FridaySystemControlLease | null {
    if (activeLease && isLeaseExpired(activeLease, nowIso)) {
      deps.db.withWriteTransaction((db) => {
        repository.revokeControlLease(db, activeLease!.id, nowIso, "lease_expired");
      });
      activeLease = null;
    }
    return activeLease;
  }

  async function readPermissions(
    companionPermissions: readonly FridaySystemPermissionGrant[] = [],
  ): Promise<FridaySystemPermissionGrant[]> {
    if (!deps.desktopSessionManager || !deps.desktopSessionManager.isConnected()) {
      return [...companionPermissions];
    }
    const permissions = await deps.desktopSessionManager.checkPermissions().catch(() => []);
    if (permissions.length === 0) {
      return [...companionPermissions];
    }
    return mapDesktopPermissions(permissions, deps.idGenerator);
  }

  async function readHealth(
    companion?: FridaySystemCompanionStatus,
    permissions?: FridaySystemPermissionGrant[],
  ): Promise<FridaySystemHealth> {
    const companionStatus = companion ?? await deps.companionBridge.getStatus();
    const grants = permissions ?? await readPermissions(companionStatus.permissions);
    const desktopConnected = deps.desktopSessionManager?.isConnected() ?? false;
    const reasons: string[] = [];

    if (!companionStatus.connected) {
      reasons.push("companion_disconnected");
    }
    if (!companionStatus.transport.authenticated) {
      reasons.push("companion_transport_unauthenticated");
    }
    if (companionStatus.safeMode) {
      reasons.push("companion_safe_mode");
    }
    if (isCompanionHeartbeatStale(companionStatus.lastHeartbeatAt)) {
      reasons.push("companion_heartbeat_stale");
    }
    if (!desktopConnected) {
      reasons.push("desktop_session_unavailable");
    }
    for (const grant of grants) {
      if (grant.status === "denied" || grant.status === "restricted") {
        reasons.push(`permission_denied:${grant.permission}`);
      } else if (grant.status === "not_determined") {
        reasons.push(`permission_pending:${grant.permission}`);
      }
    }

    return {
      status: (safeMode || companionStatus.safeMode)
        ? "safe_mode"
        : reasons.length === 0
          ? "healthy"
          : (companionStatus.connected || desktopConnected)
            ? "degraded"
            : "unavailable",
      safeMode: safeMode || companionStatus.safeMode,
      desktopConnected,
      companionConnected: companionStatus.connected,
      reasons,
      updatedAt: deps.nowIso(),
    };
  }

  async function buildSnapshot(): Promise<FridaySystemSnapshot> {
    const companion = await deps.companionBridge.getStatus();
    const companionSnapshot = await deps.companionBridge.captureSnapshot();
    const permissions = await readPermissions(companion.permissions);
    await emitCompanionEventsIfChanged(companion, permissions);
    const approvals = deps.db.withReadConnection((db) => repository.listApprovalRules(db));
    const remoteDevices = deps.db.withReadConnection((db) => repository.listRemoteDevices(db));
    const remoteSessions = deps.db.withReadConnection((db) => repository.listRemoteSessions(db, { limit: 200 }));
    const health = await readHealth(companion, permissions);
    const latestSeenAt = remoteSessions.reduce<string | undefined>((latest, session) => {
      if (!latest) {
        return session.lastSeenAt;
      }
      return new Date(session.lastSeenAt).getTime() > new Date(latest).getTime()
        ? session.lastSeenAt
        : latest;
    }, undefined);

    return {
      capturedAt: deps.nowIso(),
      platform: companion.platform,
      workspaceRoot: deps.workspaceRoot,
      apps: companionSnapshot.apps,
      windows: companionSnapshot.windows,
      notifications: companionSnapshot.notifications,
      permissions,
      mountedRoots: [deps.workspaceRoot],
      frontmostAppId: companionSnapshot.frontmostAppId,
      frontmostWindowId: companionSnapshot.frontmostWindowId,
      activeTask,
      clipboard: {
        available: deps.desktopSessionManager?.isConnected() ?? false,
      },
      health,
      companion,
      controlLease: normalizeActiveLease(),
      approvalsSummary: {
        total: approvals.length,
        highRiskAllowed: approvals.filter((item) =>
          (item.riskLevel === "high" || item.riskLevel === "critical") && item.decision === "allow"
        ).length,
      },
      remoteDevicesSummary: {
        total: remoteDevices.length,
        active: remoteDevices.filter((item) => item.status === "active").length,
      },
      remoteSessionsSummary: {
        total: remoteSessions.length,
        active: remoteSessions.filter((item) => item.status === "active").length,
        latestSeenAt,
      },
    };
  }

  function resolveProjectPath(rawPath: string | undefined): string {
    const target = requireNonEmpty(rawPath, "projectPath");
    const resolved = path.isAbsolute(target)
      ? path.resolve(target)
      : path.resolve(deps.workspaceRoot, target);
    const relative = path.relative(deps.workspaceRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        "projectPath must stay within the configured workspace root",
        { httpStatus: 400 },
      );
    }
    return resolved;
  }

  async function searchFiles(root: string, query: string): Promise<string[]> {
    const targetQuery = query.trim().toLowerCase();
    if (targetQuery.length === 0) {
      return [];
    }

    const rgResult = await execCommand("rg", ["--files", root]);
    const candidates = rgResult.exitCode === 0
      ? rgResult.stdout.split("\n")
      : await listFilesRecursive(root);

    return candidates
      .map((item) => item.trim())
      .filter((item) => item.length > 0 && item.toLowerCase().includes(targetQuery))
      .slice(0, MAX_FILE_SEARCH_RESULTS);
  }

  async function openTarget(target: string): Promise<void> {
    const command = process.platform === "darwin"
      ? { bin: "open", args: [target] }
      : process.platform === "win32"
        ? { bin: "cmd", args: ["/c", "start", "", target] }
        : { bin: "xdg-open", args: [target] };
    const result = await execCommand(command.bin, command.args);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Failed to open target: ${target}`);
    }
  }

  async function launchAppViaCompanion(appIdentifier: string): Promise<Record<string, unknown> | null> {
    const result = await deps.companionBridge.launchApp(appIdentifier);
    if (!result) {
      return null;
    }
    return result as unknown as Record<string, unknown>;
  }

  async function focusTargetViaCompanion(
    input: { appIdentifier?: string; windowId?: string },
  ): Promise<Record<string, unknown> | null> {
    const result = await deps.companionBridge.focusTarget(input);
    if (!result) {
      return null;
    }
    return result as unknown as Record<string, unknown>;
  }

  async function openUrlViaCompanion(url: string): Promise<Record<string, unknown> | null> {
    const result = await deps.companionBridge.openUrl(url);
    if (!result) {
      return null;
    }
    return result as unknown as Record<string, unknown>;
  }

  async function openProjectViaCompanion(projectPath: string): Promise<Record<string, unknown> | null> {
    const result = await deps.companionBridge.openProject(projectPath);
    if (!result) {
      return null;
    }
    return result as unknown as Record<string, unknown>;
  }

  function readCompanionActionAvailability(
    companion: FridaySystemCompanionStatus,
    action: keyof FridaySystemCompanionStatus["capabilities"]["actions"],
  ): FridaySystemCapabilityAvailability {
    return companion.capabilities.actions[action];
  }

  function companionAllowsFallback(
    companion: FridaySystemCompanionStatus,
    action: keyof FridaySystemCompanionStatus["capabilities"]["actions"],
  ): boolean {
    return readCompanionActionAvailability(companion, action) === "fallback";
  }

  function companionSupportsAction(
    companion: FridaySystemCompanionStatus,
    action: keyof FridaySystemCompanionStatus["capabilities"]["actions"],
  ): boolean {
    return readCompanionActionAvailability(companion, action) === "supported";
  }

  async function buildUnavailableIntentResult(
    input: FridaySystemIntentInput,
    message: string,
    reason: string,
    payload: Record<string, unknown> = {},
    approvalRuleId?: UUID,
    controlLeaseId?: UUID,
  ): Promise<FridaySystemIntentResult> {
    await emitEvent("system.intent.blocked", {
      action: input.action,
      reason,
      ...payload,
    });
    return buildIntentResult(
      input,
      "unavailable",
      message,
      undefined,
      approvalRuleId,
      controlLeaseId,
    );
  }

  async function runDesktopAction(action: FridayDesktopAction): Promise<Record<string, unknown>> {
    if (!deps.desktopSessionManager || !deps.desktopSessionManager.isConnected()) {
      throw new FridayDomainError(
        "SYSTEM_UNAVAILABLE",
        "Desktop session is not connected",
        { httpStatus: 503 },
      );
    }

    const result = await deps.desktopSessionManager.executeAction(action);
    if (result.status !== "success") {
      safeMode = true;
      await emitEvent("system.safe_mode.entered", {
        reason: result.errorMessage ?? result.status,
        actionType: result.action.type,
      });
      await emitHealthIfChanged("desktop_action_failed");
      throw new FridayDomainError(
        "SYSTEM_ACTION_FAILED",
        result.errorMessage ?? `Desktop action failed: ${result.status}`,
        { httpStatus: 502 },
      );
    }

    return {
      actionId: result.id,
      actionType: result.action.type,
      durationMs: result.durationMs,
      clipboardContent: result.clipboardContent ?? undefined,
      fileData: result.fileData ?? undefined,
      screenshotBase64: result.screenshotBase64 ?? undefined,
    };
  }

  function assertApprovalAllowed(
    action: FridaySystemIntentAction,
    appIdentifier?: string,
  ): FridaySystemApprovalRule | null {
    if (!HIGH_RISK_INTENTS.has(action)) {
      return null;
    }
    const existing = deps.db.withReadConnection((db) =>
      repository.findMatchingApprovalRule(db, { action, appIdentifier }),
    );
    if (!existing || existing.decision !== "allow") {
      throw new FridayDomainError(
        "SYSTEM_APPROVAL_REQUIRED",
        `Approval required for ${action}${appIdentifier ? ` on ${appIdentifier}` : ""}`,
        { httpStatus: 403 },
      );
    }
    deps.db.withWriteTransaction((db) =>
      repository.updateApprovalRule(db, existing.id, {
        lastUsedAt: deps.nowIso(),
        updatedAt: deps.nowIso(),
      }),
    );
    return existing;
  }

  async function ensureControlLease(
    input: FridaySystemIntentInput,
  ): Promise<FridaySystemControlLease | null> {
    if (!MUTATING_INTENTS.has(input.action)) {
      return normalizeActiveLease();
    }

    const now = deps.nowIso();
    const current = normalizeActiveLease(now);
    const actorId = input.actorId ?? "system-api";
    const actorKind = input.actorKind ?? "api";
    if (current) {
      if (current.ownerId === actorId && current.ownerKind === actorKind) {
        return current;
      }
      throw new FridayDomainError(
        "SYSTEM_CONTROL_BUSY",
        `Control lease is currently held by ${current.ownerKind}:${current.ownerId}`,
        { httpStatus: 409 },
      );
    }

    activeLease = deps.db.withWriteTransaction((db) =>
      repository.insertControlLease(db, {
        id: deps.idGenerator(),
        ownerId: actorId,
        ownerKind: actorKind,
        reason: input.reason ?? `auto:${input.action}`,
        acquiredAt: now,
        expiresAt: new Date(new Date(now).getTime() + (input.leaseTtlMs ?? leaseTtlMs)).toISOString(),
      }),
    );
    await emitEvent("system.control.acquired", {
      leaseId: activeLease.id,
      ownerId: activeLease.ownerId,
      ownerKind: activeLease.ownerKind,
      action: input.action,
    });
    return activeLease;
  }

  async function acquireExplicitControlLease(
    input: FridaySystemIntentInput,
  ): Promise<FridaySystemControlLease> {
    const now = deps.nowIso();
    const current = normalizeActiveLease(now);
    const actorId = input.actorId ?? "system-api";
    const actorKind = input.actorKind ?? "api";
    if (current) {
      if (current.ownerId === actorId && current.ownerKind === actorKind) {
        return current;
      }
      throw new FridayDomainError(
        "SYSTEM_CONTROL_BUSY",
        `Control lease is currently held by ${current.ownerKind}:${current.ownerId}`,
        { httpStatus: 409 },
      );
    }
    activeLease = deps.db.withWriteTransaction((db) =>
      repository.insertControlLease(db, {
        id: deps.idGenerator(),
        ownerId: actorId,
        ownerKind: actorKind,
        reason: input.reason ?? "explicit_control_request",
        acquiredAt: now,
        expiresAt: new Date(new Date(now).getTime() + (input.leaseTtlMs ?? leaseTtlMs)).toISOString(),
      }),
    );
    await emitEvent("system.control.acquired", {
      leaseId: activeLease.id,
      ownerId: activeLease.ownerId,
      ownerKind: activeLease.ownerKind,
      action: input.action,
    });
    return activeLease;
  }

  function buildIntentResult(
    input: FridaySystemIntentInput,
    status: FridaySystemIntentResult["status"],
    message: string,
    payload?: Record<string, unknown>,
    approvalRuleId?: string,
    controlLeaseId?: string,
  ): FridaySystemIntentResult {
    return {
      id: deps.idGenerator(),
      action: input.action,
      status,
      message,
      performedAt: deps.nowIso(),
      payload,
      approvalRuleId,
      controlLeaseId,
    };
  }

  await emitEvent("system.session.started", {
    workspaceRoot: deps.workspaceRoot,
    mode,
    remoteMode,
    cloudPlanningMode,
  });
  await emitHealthIfChanged("service_started");

  const getSession = async (): Promise<FridaySystemSession> => {
    const companion = await deps.companionBridge.getStatus();
    const permissions = await readPermissions(companion.permissions);
    await emitCompanionEventsIfChanged(companion, permissions);
    const health = await readHealth(companion, permissions);
    return {
      id: sessionId,
      mode,
      workspaceRoot: deps.workspaceRoot,
      remoteMode,
      cloudPlanningMode,
      startedAt,
      companion,
      health,
    };
  };

  const getState = async (): Promise<FridaySystemSnapshot> => {
    const snapshot = await buildSnapshot();
    await emitHealthIfChanged("state_requested");
    return snapshot;
  };

  const listApprovalRules = (filters?: FridaySystemApprovalRuleFilters): FridaySystemApprovalRule[] =>
    deps.db.withReadConnection((db) => repository.listApprovalRules(db, filters));

  const updateApprovalRule = (
    id: UUID,
    patch: Partial<Pick<FridaySystemApprovalRule, "decision" | "rationale" | "lastUsedAt">>,
  ): FridaySystemApprovalRule | null =>
    deps.db.withWriteTransaction((db) =>
      repository.updateApprovalRule(db, id, {
        decision: patch.decision,
        rationale: patch.rationale,
        lastUsedAt: patch.lastUsedAt,
        updatedAt: deps.nowIso(),
      }),
    );

  const upsertApprovalRule = (input: {
    action: FridaySystemIntentAction | string;
    appIdentifier?: string;
    riskLevel: FridayDesktopRiskLevel;
    decision: FridaySystemApprovalDecision;
    rationale?: string;
  }): FridaySystemApprovalRule => {
    const now = deps.nowIso();
    const existing = deps.db.withReadConnection((db) =>
      repository.findMatchingApprovalRule(db, {
        action: input.action,
        appIdentifier: input.appIdentifier,
      }),
    );
    if (existing) {
      return deps.db.withWriteTransaction((db) =>
        repository.updateApprovalRule(db, existing.id, {
          decision: input.decision,
          rationale: input.rationale,
          riskLevel: input.riskLevel,
          updatedAt: now,
        })!,
      );
    }
    return deps.db.withWriteTransaction((db) =>
      repository.insertApprovalRule(db, {
        id: deps.idGenerator(),
        action: input.action,
        appIdentifier: input.appIdentifier,
        riskLevel: input.riskLevel,
        decision: input.decision,
        rationale: input.rationale,
        createdAt: now,
        updatedAt: now,
      }),
    );
  };

  function hydrateRemoteDeviceWithDb(
    db: Parameters<typeof repository.findRemotePasskeyByDeviceId>[0],
    device: FridaySystemRemoteDevice,
  ): FridaySystemRemoteDevice {
    const passkey = repository.findRemotePasskeyByDeviceId(db, device.id);
    if (!passkey) {
      return device;
    }
    return {
      ...device,
      credentialId: passkey.credentialId,
      passkeyRegisteredAt: passkey.registeredAt,
      passkeyLastUsedAt: passkey.lastUsedAt,
      passkeyBackedUp: passkey.backedUp,
      passkeyDeviceType: passkey.deviceType,
    };
  }

  const listRemoteDevices = (): FridaySystemRemoteDevice[] =>
    deps.db.withReadConnection((db) =>
      repository.listRemoteDevices(db).map((device) => hydrateRemoteDeviceWithDb(db, device)),
    );

  function assertRemoteModeEnabled(): void {
    if (remoteMode === "disabled") {
      throw new FridayDomainError(
        "SYSTEM_REMOTE_DISABLED",
        "Trusted-device remote access is disabled for this deployment",
        { httpStatus: 503 },
      );
    }
  }

  function assertTrustedRemoteNetwork(ipAddress: string | undefined): string {
    const normalized = normalizeRemoteAddress(ipAddress);
    if (remoteMode !== "trusted_private_network") {
      return normalized ?? "";
    }
    if (!isTrustedPrivateNetworkAddress(normalized)) {
      throw new FridayDomainError(
        "SYSTEM_REMOTE_NETWORK_FORBIDDEN",
        "Trusted-device remote access is restricted to private-network clients",
        { httpStatus: 403 },
      );
    }
    return normalized!;
  }

  function resolveRemoteAuthOrigin(inputOrigin?: string): string {
    if (inputOrigin && inputOrigin.trim().length > 0) {
      return inputOrigin.trim();
    }
    return remoteAuthOrigin;
  }

  function resolveRemoteAuthRpId(inputOrigin?: string): string {
    if (deps.remoteAuth?.rpId && deps.remoteAuth.rpId.trim().length > 0) {
      return deps.remoteAuth.rpId.trim();
    }
    const resolvedOrigin = resolveRemoteAuthOrigin(inputOrigin);
    try {
      const hostname = new URL(resolvedOrigin).hostname.trim();
      return hostname.length > 0 ? hostname : remoteAuthRpId;
    } catch {
      return remoteAuthRpId;
    }
  }

  function readActiveRemoteDevice(deviceId: UUID): FridaySystemRemoteDevice {
    const device = deps.db.withReadConnection((db) => {
      const found = repository.findRemoteDeviceById(db, deviceId);
      return found ? hydrateRemoteDeviceWithDb(db, found) : null;
    },
    );
    if (!device) {
      throw new FridayDomainError("SYSTEM_REMOTE_DEVICE_NOT_FOUND", "Trusted device not found", {
        httpStatus: 404,
      });
    }
    if (device.status !== "active") {
      throw new FridayDomainError("SYSTEM_REMOTE_DEVICE_REVOKED", "Trusted device has been revoked", {
        httpStatus: 403,
      });
    }
    return device;
  }

  function readRemotePasskey(deviceId: UUID): FridaySystemRemotePasskey {
    const passkey = deps.db.withReadConnection((db) =>
      repository.findRemotePasskeyByDeviceId(db, deviceId),
    );
    if (!passkey) {
      throw new FridayDomainError(
        "SYSTEM_REMOTE_PASSKEY_REQUIRED",
        "A verified passkey is required for this trusted device",
        { httpStatus: 403 },
      );
    }
    return passkey;
  }

  function readValidRemoteAuthChallenge(
    challengeId: UUID,
    deviceId: UUID,
    expectedKind: FridaySystemRemoteAuthChallenge["kind"],
  ): FridaySystemRemoteAuthChallenge {
    const challenge = deps.db.withReadConnection((db) =>
      repository.findRemoteAuthChallengeById(db, challengeId),
    );
    if (!challenge || challenge.deviceId !== deviceId || challenge.kind !== expectedKind) {
      throw new FridayDomainError("SYSTEM_REMOTE_AUTH_CHALLENGE_NOT_FOUND", "Auth challenge not found", {
        httpStatus: 404,
      });
    }
    if (challenge.usedAt) {
      throw new FridayDomainError("SYSTEM_REMOTE_AUTH_CHALLENGE_USED", "Auth challenge has already been used", {
        httpStatus: 409,
      });
    }
    if (new Date(challenge.expiresAt).getTime() <= new Date(deps.nowIso()).getTime()) {
      throw new FridayDomainError("SYSTEM_REMOTE_AUTH_CHALLENGE_EXPIRED", "Auth challenge has expired", {
        httpStatus: 410,
      });
    }
    return challenge;
  }

  function readValidAssertionGrant(deviceId: UUID, assertionToken: string): FridaySystemRemoteAssertionGrant {
    const token = requireNonEmpty(assertionToken, "assertionToken");
    const grant = deps.db.withReadConnection((db) =>
      repository.findRemoteAssertionGrantByTokenHash(db, hashAssertionToken(token), deps.nowIso()),
    );
    if (!grant || grant.deviceId !== deviceId) {
      throw new FridayDomainError(
        "SYSTEM_REMOTE_ASSERTION_REQUIRED",
        "A verified passkey assertion is required before opening a remote session",
        { httpStatus: 403 },
      );
    }
    return grant;
  }

  const registerRemoteDevice = (input: {
    label: string;
    fingerprint: string;
    platform?: FridayTrustedDevicePlatform;
    credentialId?: string;
  }): FridaySystemRemoteDevice => {
    assertRemoteModeEnabled();
    const platform = input.platform ?? "browser";
    const existing = deps.db.withReadConnection((db) =>
      repository.findRemoteDeviceByFingerprint(db, input.fingerprint),
    );
    if (existing && existing.status === "active") {
      const device = deps.db.withWriteTransaction((db) =>
        repository.touchRemoteDevice(db, existing.id, deps.nowIso())!,
      );
      return readActiveRemoteDevice(device.id);
    }
    if (existing && existing.status === "revoked") {
      const device = deps.db.withWriteTransaction((db) =>
        repository.reactivateRemoteDevice(db, existing.id, {
          label: input.label,
          platform,
          credentialId: input.credentialId,
          lastSeenAt: deps.nowIso(),
        })!,
      );
      return readActiveRemoteDevice(device.id);
    }
    const device = deps.db.withWriteTransaction((db) =>
      repository.insertRemoteDevice(db, {
        id: deps.idGenerator(),
        label: input.label,
        fingerprint: input.fingerprint,
        platform,
        credentialId: input.credentialId,
        trustScope: remoteMode,
        status: "active",
        registeredAt: deps.nowIso(),
        lastSeenAt: deps.nowIso(),
      }),
    );
    void emitEvent("system.remote_device.registered", {
      deviceId: device.id,
      label: device.label,
      platform: device.platform,
    });
    return readActiveRemoteDevice(device.id);
  };

  const beginRemotePasskeyRegistration = async (input: {
    deviceId: UUID;
    origin?: string;
  }): Promise<FridaySystemRemotePasskeyRegistrationOptions> => {
    assertRemoteModeEnabled();
    const device = readActiveRemoteDevice(input.deviceId);
    const existingPasskey = deps.db.withReadConnection((db) =>
      repository.findRemotePasskeyByDeviceId(db, device.id),
    );
    const origin = resolveRemoteAuthOrigin(input.origin);
    const rpId = resolveRemoteAuthRpId(origin);
    const options = await remoteAuthAdapter.generateRegistrationOptions({
      rpName: remoteAuthRpName,
      rpId,
      userId: device.id,
      userName: device.fingerprint,
      userDisplayName: device.label,
      excludeCredentialIds: existingPasskey ? [existingPasskey.credentialId] : [],
    });
    const createdAt = deps.nowIso();
    const expiresAt = new Date(new Date(createdAt).getTime() + remoteAuthChallengeTtlMs).toISOString();
    const challengeId = deps.idGenerator();
    deps.db.withWriteTransaction((db) =>
      repository.insertRemoteAuthChallenge(db, {
        id: challengeId,
        deviceId: device.id,
        kind: "register",
        challenge: options.challenge,
        rpId,
        origin,
        createdAt,
        expiresAt,
      }),
    );
    return {
      challengeId,
      deviceId: device.id,
      rpId,
      origin,
      expiresAt,
      options,
    };
  };

  const verifyRemotePasskeyRegistration = async (input: {
    deviceId: UUID;
    challengeId: UUID;
    response: Parameters<FridaySystemRemoteAuthAdapter["verifyRegistration"]>[0]["response"];
    origin?: string;
  }): Promise<FridaySystemRemotePasskeyRegistrationResult> => {
    assertRemoteModeEnabled();
    const device = readActiveRemoteDevice(input.deviceId);
    const challenge = readValidRemoteAuthChallenge(input.challengeId, device.id, "register");
    const existingPasskey = deps.db.withReadConnection((db) =>
      repository.findRemotePasskeyByDeviceId(db, device.id),
    );
    const verification = await remoteAuthAdapter.verifyRegistration({
      response: input.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: resolveRemoteAuthOrigin(input.origin ?? challenge.origin),
      expectedRpId: challenge.rpId,
    });
    if (!verification.verified || !verification.credentialId || !verification.publicKey) {
      throw new FridayDomainError(
        "SYSTEM_REMOTE_PASSKEY_REGISTRATION_FAILED",
        "Passkey registration verification failed",
        { httpStatus: 400 },
      );
    }
    const credentialId = verification.credentialId;
    const publicKey = verification.publicKey;
    const verifiedAt = deps.nowIso();
    const updatedDevice = deps.db.withWriteTransaction((db) => {
      repository.markRemoteAuthChallengeUsed(db, challenge.id, verifiedAt);
      repository.upsertRemotePasskey(db, {
        deviceId: device.id,
        credentialId,
        publicKey,
        counter: verification.counter ?? 0,
        transports: verification.transports,
        deviceType: verification.deviceType,
        backedUp: verification.backedUp ?? false,
        registeredAt: existingPasskey?.registeredAt ?? verifiedAt,
        updatedAt: verifiedAt,
        lastUsedAt: undefined,
      });
      return repository.setRemoteDeviceCredential(db, device.id, {
        credentialId,
        lastSeenAt: verifiedAt,
      })!;
    });
    await emitEvent("system.remote_passkey.registered", {
      deviceId: updatedDevice.id,
      credentialId,
    });
    return {
      device: readActiveRemoteDevice(updatedDevice.id),
      credentialId,
      verifiedAt,
    };
  };

  const beginRemotePasskeyAssertion = async (input: {
    deviceId: UUID;
    origin?: string;
  }): Promise<FridaySystemRemotePasskeyAssertionOptions> => {
    assertRemoteModeEnabled();
    const device = readActiveRemoteDevice(input.deviceId);
    const passkey = readRemotePasskey(device.id);
    const origin = resolveRemoteAuthOrigin(input.origin);
    const rpId = resolveRemoteAuthRpId(origin);
    const options = await remoteAuthAdapter.generateAuthenticationOptions({
      rpId,
      credentialId: passkey.credentialId,
      transports: passkey.transports,
    });
    const createdAt = deps.nowIso();
    const expiresAt = new Date(new Date(createdAt).getTime() + remoteAuthChallengeTtlMs).toISOString();
    const challengeId = deps.idGenerator();
    deps.db.withWriteTransaction((db) =>
      repository.insertRemoteAuthChallenge(db, {
        id: challengeId,
        deviceId: device.id,
        kind: "assert",
        challenge: options.challenge,
        rpId,
        origin,
        createdAt,
        expiresAt,
      }),
    );
    return {
      challengeId,
      deviceId: device.id,
      rpId,
      origin,
      expiresAt,
      options,
    };
  };

  const verifyRemotePasskeyAssertion = async (input: {
    deviceId: UUID;
    challengeId: UUID;
    response: Parameters<FridaySystemRemoteAuthAdapter["verifyAuthentication"]>[0]["response"];
    origin?: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<FridaySystemRemotePasskeyAssertionResult> => {
    assertRemoteModeEnabled();
    const device = readActiveRemoteDevice(input.deviceId);
    const passkey = readRemotePasskey(device.id);
    const challenge = readValidRemoteAuthChallenge(input.challengeId, device.id, "assert");
    const verification = await remoteAuthAdapter.verifyAuthentication({
      response: input.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: resolveRemoteAuthOrigin(input.origin ?? challenge.origin),
      expectedRpId: challenge.rpId,
      passkey,
    });
    if (!verification.verified || !verification.credentialId) {
      throw new FridayDomainError(
        "SYSTEM_REMOTE_PASSKEY_ASSERTION_FAILED",
        "Passkey assertion verification failed",
        { httpStatus: 400 },
      );
    }
    const credentialId = verification.credentialId;
    const verifiedAt = deps.nowIso();
    const expiresAt = new Date(new Date(verifiedAt).getTime() + remoteAssertionTtlMs).toISOString();
    const assertionToken = crypto.randomBytes(32).toString("base64url");
    deps.db.withWriteTransaction((db) => {
      repository.markRemoteAuthChallengeUsed(db, challenge.id, verifiedAt);
      repository.touchRemotePasskey(db, device.id, {
        counter: verification.newCounter ?? passkey.counter,
        backedUp: verification.backedUp,
        lastUsedAt: verifiedAt,
      });
      repository.insertRemoteAssertionGrant(db, {
        id: deps.idGenerator(),
        deviceId: device.id,
        tokenHash: hashAssertionToken(assertionToken),
        createdAt: verifiedAt,
        expiresAt,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });
      repository.touchRemoteDevice(db, device.id, verifiedAt);
    });
    const updatedDevice = readActiveRemoteDevice(device.id);
    await emitEvent("system.remote_passkey.asserted", {
      deviceId: device.id,
      credentialId,
      ipAddress: normalizeRemoteAddress(input.ipAddress),
    });
    return {
      device: updatedDevice,
      assertionToken,
      expiresAt,
      verifiedAt,
    };
  };

  const revokeRemoteDevice = (id: UUID): FridaySystemRemoteDevice | null => {
    const now = deps.nowIso();
    deps.db.withWriteTransaction((db) => {
      repository.revokeRemoteAssertionGrantsForDevice(db, id, now);
    });
    const closedSessions = deps.db.withWriteTransaction((db) =>
      repository.closeActiveRemoteSessionsForDevice(db, id, {
        closedAt: now,
        closedReason: "device_revoked",
      }),
    );
    const revoked = deps.db.withWriteTransaction((db) =>
      repository.revokeRemoteDevice(db, id, now),
    );
    if (revoked) {
      void emitEvent("system.remote_device.revoked", {
        deviceId: revoked.id,
        label: revoked.label,
      });
      for (const session of closedSessions) {
        void emitEvent("system.remote_session.closed", {
          sessionId: session.id,
          deviceId: session.deviceId,
          reason: session.closedReason,
        });
      }
    }
    return revoked
      ? deps.db.withReadConnection((db) => hydrateRemoteDeviceWithDb(db, revoked))
      : null;
  };

  const clearRemoteDevicePasskey = async (id: UUID): Promise<FridaySystemRemoteDevice> => {
    assertRemoteModeEnabled();
    const device = readActiveRemoteDevice(id);
    const now = deps.nowIso();
    const result = deps.db.withWriteTransaction((db) => {
      const hadPasskey = repository.findRemotePasskeyByDeviceId(db, device.id) !== null;
      repository.deleteRemotePasskeyByDeviceId(db, device.id);
      repository.clearRemoteDeviceCredential(db, device.id, now);
      repository.deleteRemoteAuthChallengesForDevice(db, device.id);
      repository.revokeRemoteAssertionGrantsForDevice(db, device.id, now);
      const closedSessions = repository.closeActiveRemoteSessionsForDevice(db, device.id, {
        closedAt: now,
        closedReason: "passkey_cleared",
      });
      const updatedDevice = repository.findRemoteDeviceById(db, device.id)!;
      return {
        hadPasskey,
        closedSessions,
        updatedDevice,
      };
    });

    await emitEvent("system.remote_passkey.cleared", {
      deviceId: result.updatedDevice.id,
      credentialId: device.credentialId ?? null,
      hadPasskey: result.hadPasskey,
    });
    for (const session of result.closedSessions) {
      await emitEvent("system.remote_session.closed", {
        sessionId: session.id,
        deviceId: session.deviceId,
        reason: session.closedReason,
      });
    }
    return deps.db.withReadConnection((db) => hydrateRemoteDeviceWithDb(db, result.updatedDevice));
  };

  const listRemoteSessions = (input?: {
    deviceId?: UUID;
    status?: FridaySystemRemoteSessionStatus;
    limit?: number;
  }): FridaySystemRemoteSession[] =>
    deps.db.withReadConnection((db) =>
      repository.listRemoteSessions(db, {
        deviceId: input?.deviceId,
        status: input?.status,
        limit: input?.limit,
      }));

  const openRemoteSession = async (input: {
    deviceId: UUID;
    assertionToken: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<FridaySystemRemoteSession> => {
    assertRemoteModeEnabled();
    const ipAddress = assertTrustedRemoteNetwork(input.ipAddress);
    const device = readActiveRemoteDevice(input.deviceId);
    const assertionGrant = readValidAssertionGrant(device.id, input.assertionToken);
    const now = deps.nowIso();
    const closedSessions = deps.db.withWriteTransaction((db) =>
      repository.closeActiveRemoteSessionsForDevice(db, input.deviceId, {
        closedAt: now,
        closedReason: "replaced_by_new_session",
      }),
    );
    const session = deps.db.withWriteTransaction((db) => {
      repository.consumeRemoteAssertionGrant(db, assertionGrant.id, now);
      repository.touchRemoteDevice(db, device.id, now);
      return repository.insertRemoteSession(db, {
        id: deps.idGenerator(),
        deviceId: device.id,
        status: "active",
        connectedAt: now,
        lastSeenAt: now,
        ipAddress,
        userAgent: input.userAgent,
      });
    });
    for (const closed of closedSessions) {
      void emitEvent("system.remote_session.closed", {
        sessionId: closed.id,
        deviceId: closed.deviceId,
        reason: closed.closedReason,
      });
    }
    await emitEvent("system.remote_session.started", {
      sessionId: session.id,
      deviceId: session.deviceId,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
    });
    return session;
  };

  const touchRemoteSession = async (
    id: UUID,
    input?: {
      ipAddress?: string;
      userAgent?: string;
    },
  ): Promise<FridaySystemRemoteSession | null> => {
    const existing = deps.db.withReadConnection((db) => repository.findRemoteSessionById(db, id));
    if (!existing) {
      return null;
    }
    if (existing.status !== "active") {
      return existing;
    }
    assertRemoteModeEnabled();
    assertTrustedRemoteNetwork(input?.ipAddress ?? existing.ipAddress);
    const device = deps.db.withReadConnection((db) =>
      repository.findRemoteDeviceById(db, existing.deviceId),
    );
    if (!device || device.status !== "active") {
      const closed = deps.db.withWriteTransaction((db) =>
        repository.closeRemoteSession(db, id, {
          closedAt: deps.nowIso(),
          closedReason: "device_unavailable",
        }),
      );
      if (closed) {
        await emitEvent("system.remote_session.closed", {
          sessionId: closed.id,
          deviceId: closed.deviceId,
          reason: closed.closedReason,
        });
      }
      return closed;
    }
    const touchedAt = deps.nowIso();
    const session = deps.db.withWriteTransaction((db) => {
      repository.touchRemoteDevice(db, existing.deviceId, touchedAt);
      return repository.touchRemoteSession(db, id, touchedAt);
    });
    if (session) {
      await emitEvent("system.remote_session.heartbeat", {
        sessionId: session.id,
        deviceId: session.deviceId,
        userAgent: input?.userAgent ?? existing.userAgent,
      });
    }
    return session;
  };

  const closeRemoteSession = async (
    id: UUID,
    reason?: string,
  ): Promise<FridaySystemRemoteSession | null> => {
    const closed = deps.db.withWriteTransaction((db) =>
      repository.closeRemoteSession(db, id, {
        closedAt: deps.nowIso(),
        closedReason: reason ?? "closed_by_request",
      }),
    );
    if (closed) {
      await emitEvent("system.remote_session.closed", {
        sessionId: closed.id,
        deviceId: closed.deviceId,
        reason: closed.closedReason,
      });
    }
    return closed;
  };

  const listEvents = (input?: { afterSeq?: number; limit?: number }): FridaySystemEvent[] =>
    deps.db.withReadConnection((db) =>
      repository.listEvents(db, {
        afterSeq: input?.afterSeq,
        limit: input?.limit ?? DEFAULT_EVENT_LIMIT,
      }),
    );

  const subscribe = (listener: FridaySystemEventListener): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const executeIntent = async (
    input: FridaySystemIntentInput,
  ): Promise<FridaySystemIntentResult> => {
      const controlLease = await ensureControlLease(input);
      const companion = await deps.companionBridge.getStatus();

      try {
        switch (input.action) {
          case "snapshot": {
            const snapshot = await buildSnapshot();
            await emitHealthIfChanged("snapshot_requested");
            const result = buildIntentResult(input, "completed", "System snapshot captured", { snapshot });
            await emitEvent("system.snapshot.updated", {
              capturedAt: snapshot.capturedAt,
              health: snapshot.health.status,
            });
            return result;
          }

          case "request_control": {
            const lease = await acquireExplicitControlLease(input);
            const result = buildIntentResult(
              input,
              "completed",
              "Control lease acquired",
              { lease },
              undefined,
              lease?.id,
            );
            return result;
          }

          case "release_control": {
            const lease = normalizeActiveLease();
            if (!lease) {
              return buildIntentResult(input, "completed", "No active control lease");
            }
            deps.db.withWriteTransaction((db) => {
              repository.revokeControlLease(db, lease.id, deps.nowIso(), input.reason ?? "released_by_request");
            });
            activeLease = null;
            await emitEvent("system.control.released", {
              leaseId: lease.id,
              ownerId: lease.ownerId,
              ownerKind: lease.ownerKind,
            });
            return buildIntentResult(input, "completed", "Control lease released", { leaseId: lease.id });
          }

          case "approve":
          case "deny": {
            const decision = input.action === "approve" ? "allow" : "deny";
            const targetAction = requireNonEmpty(input.target, "target");
            const approval = input.approvalId
              ? updateApprovalRule(input.approvalId, {
                decision,
                rationale: input.reason,
              })
              : upsertApprovalRule({
                action: targetAction,
                appIdentifier: input.appIdentifier,
                riskLevel: input.riskLevel ?? resolveRiskLevel(targetAction as FridaySystemIntentAction),
                decision,
                rationale: input.reason,
              });
            if (!approval) {
              throw new FridayDomainError("SYSTEM_APPROVAL_NOT_FOUND", "Approval rule not found", {
                httpStatus: 404,
              });
            }
            await emitEvent("system.approval.updated", {
              approvalId: approval.id,
              action: approval.action,
              decision: approval.decision,
            });
            return buildIntentResult(
              input,
              "completed",
              `Approval updated to ${approval.decision}`,
              { approval },
              approval.id,
            );
          }

          case "launch_app": {
            const appIdentifier = requireNonEmpty(input.appIdentifier ?? input.target, "appIdentifier");
            const companionPayload = await launchAppViaCompanion(appIdentifier);
            const payload = companionPayload
              ?? (companionAllowsFallback(companion, "launch_app")
                ? (deps.desktopSessionManager
                  ? await runDesktopAction({ type: "launch_app", appIdentifier })
                  : (await openTarget(appIdentifier), { appIdentifier }))
                : null);
            if (!payload) {
              return buildUnavailableIntentResult(
                input,
                "App launch is unavailable for the current companion/platform",
                companionSupportsAction(companion, "launch_app")
                  ? "companion_launch_failed_without_fallback"
                  : "app_launch_unavailable",
                { appIdentifier },
                undefined,
                controlLease?.id,
              );
            }
            await emitEvent("system.intent.completed", {
              action: input.action,
              appIdentifier,
            });
            return buildIntentResult(input, "completed", `Launched ${appIdentifier}`, payload, undefined, controlLease?.id);
          }

          case "close_app": {
            const appIdentifier = requireNonEmpty(input.appIdentifier ?? input.target, "appIdentifier");
            const approval = assertApprovalAllowed("close_app", appIdentifier);
            const payload = await runDesktopAction({
              type: "close_app",
              appIdentifier,
              force: input.force ?? false,
            });
            await emitEvent("system.intent.completed", {
              action: input.action,
              appIdentifier,
            });
            return buildIntentResult(
              input,
              "completed",
              `Closed ${appIdentifier}`,
              payload,
              approval?.id,
              controlLease?.id,
            );
          }

          case "open_url": {
            const url = requireNonEmpty(input.url ?? input.target, "url");
            new URL(url);
            const companionPayload = await openUrlViaCompanion(url);
            const payload = companionPayload
              ?? (companionAllowsFallback(companion, "open_url")
                ? (await openTarget(url), { url })
                : null);
            if (!payload) {
              return buildUnavailableIntentResult(
                input,
                "URL open is unavailable for the current companion/platform",
                companionSupportsAction(companion, "open_url")
                  ? "companion_open_url_failed_without_fallback"
                  : "open_url_unavailable",
                { url },
                undefined,
                controlLease?.id,
              );
            }
            await emitEvent("system.intent.completed", { action: input.action, url });
            return buildIntentResult(input, "completed", `Opened ${url}`, payload, undefined, controlLease?.id);
          }

          case "open_project": {
            const projectPath = resolveProjectPath(input.projectPath ?? input.target);
            await fs.stat(projectPath);
            const companionPayload = await openProjectViaCompanion(projectPath);
            const payload = companionPayload
              ?? (companionAllowsFallback(companion, "open_project")
                ? (await openTarget(projectPath), { projectPath })
                : null);
            if (!payload) {
              return buildUnavailableIntentResult(
                input,
                "Project open is unavailable for the current companion/platform",
                companionSupportsAction(companion, "open_project")
                  ? "companion_open_project_failed_without_fallback"
                  : "open_project_unavailable",
                { projectPath },
                undefined,
                controlLease?.id,
              );
            }
            activeTask = `open_project:${projectPath}`;
            await emitEvent("system.task.updated", {
              activeTask,
              action: input.action,
              projectPath,
            });
            await emitEvent("system.intent.completed", { action: input.action, projectPath });
            return buildIntentResult(
              input,
              "completed",
              `Opened project ${projectPath}`,
              { ...payload, activeTask },
              undefined,
              controlLease?.id,
            );
          }

          case "search_file": {
            const root = input.projectPath ? resolveProjectPath(input.projectPath) : deps.workspaceRoot;
            const query = requireNonEmpty(input.query ?? input.target, "query");
            const matches = await searchFiles(root, query);
            return buildIntentResult(input, "completed", `Found ${matches.length} file(s)`, {
              root,
              matches,
            });
          }

          case "open": {
            if (input.targetKind === "url" || input.url || (input.target?.startsWith("http://") ?? false) || (input.target?.startsWith("https://") ?? false)) {
              return executeIntent({ ...input, action: "open_url" });
            }
            if (input.targetKind === "project" || input.projectPath || input.target?.includes("/") || input.target?.startsWith(".") || false) {
              return executeIntent({ ...input, action: "open_project" });
            }
            return executeIntent({
              ...input,
              action: "launch_app",
              appIdentifier: input.appIdentifier ?? input.target,
            });
          }

          case "focus": {
            const appIdentifier = input.appIdentifier ?? input.target;
            const payload = await focusTargetViaCompanion({
              appIdentifier,
              windowId: input.targetKind === "app" ? undefined : input.target,
            });
            if (!payload) {
              if (!companionAllowsFallback(companion, "focus")) {
                return buildUnavailableIntentResult(
                  input,
                  "Focus is unavailable for the current companion/platform",
                  companionSupportsAction(companion, "focus")
                    ? "companion_focus_failed_without_fallback"
                    : "focus_unavailable",
                  { appIdentifier: appIdentifier ?? "" },
                  undefined,
                  controlLease?.id,
                );
              }
              return executeIntent({
                ...input,
                action: "launch_app",
                appIdentifier,
              });
            }
            await emitEvent("system.intent.completed", {
              action: input.action,
              appIdentifier,
            });
            return buildIntentResult(input, "completed", `Focused ${appIdentifier ?? "target"}`, payload, undefined, controlLease?.id);
          }

          case "handoff_to_browser": {
            const targetUrl = input.url ?? input.target;
            if (targetUrl) {
              return executeIntent({ ...input, action: "open_url", url: targetUrl });
            }
            const companionPayload = await launchAppViaCompanion("Safari");
            const payload = companionPayload
              ?? (companionAllowsFallback(companion, "handoff_to_browser")
                ? (await openTarget("/Applications/Safari.app"), { appIdentifier: "Safari" })
                : null);
            if (!payload) {
              return buildUnavailableIntentResult(
                input,
                "Browser handoff is unavailable for the current companion/platform",
                companionSupportsAction(companion, "handoff_to_browser")
                  ? "companion_browser_handoff_failed_without_fallback"
                  : "browser_handoff_unavailable",
                { appIdentifier: "Safari" },
                undefined,
                controlLease?.id,
              );
            }
            return buildIntentResult(input, "completed", "Handed off to browser", payload, undefined, controlLease?.id);
          }

          case "handoff_to_terminal": {
            const terminal = input.appIdentifier ?? input.target ?? "Terminal";
            return executeIntent({ ...input, action: "launch_app", appIdentifier: terminal });
          }

          case "clipboard_read": {
            const approval = assertApprovalAllowed("clipboard_read", input.appIdentifier);
            const payload = deps.desktopSessionManager
              ? await runDesktopAction({ type: "clipboard", operation: "read" })
              : await execCommand("pbpaste", []);
            const content = "clipboardContent" in payload
              ? String(payload.clipboardContent ?? "")
              : String(payload.stdout ?? "");
            await emitEvent("system.intent.completed", { action: input.action });
            return buildIntentResult(input, "completed", "Clipboard read", {
              content,
              textPreview: sanitizeTextPreview(content),
            }, approval?.id, controlLease?.id);
          }

          case "clipboard_write": {
            const value = requireNonEmpty(input.value ?? input.target, "value");
            if (deps.desktopSessionManager) {
              await runDesktopAction({ type: "clipboard", operation: "write", content: value });
            } else {
              const result = await execCommand("bash", ["-lc", `printf %s "$1" | pbcopy`, "--", value]);
              if (result.exitCode !== 0) {
                throw new Error(result.stderr || "Clipboard write failed");
              }
            }
            await emitEvent("system.intent.completed", { action: input.action });
            return buildIntentResult(input, "completed", "Clipboard updated", undefined, undefined, controlLease?.id);
          }

          case "notification_list": {
            if (readCompanionActionAvailability(companion, "notification_list") === "unsupported") {
              return buildUnavailableIntentResult(
                input,
                "Notification listing is unavailable for the current companion/platform",
                "notification_list_unavailable",
                {},
                undefined,
                controlLease?.id,
              );
            }
            const notifications = await deps.companionBridge.listNotifications();
            return buildIntentResult(input, "completed", `Loaded ${notifications.length} notification(s)`, {
              notifications,
            });
          }

          case "read_notification": {
            if (readCompanionActionAvailability(companion, "read_notification") === "unsupported") {
              return buildUnavailableIntentResult(
                input,
                "Notification reading is unavailable for the current companion/platform",
                "read_notification_unavailable",
                {},
                undefined,
                controlLease?.id,
              );
            }
            const notificationId = requireNonEmpty(input.notificationId, "notificationId");
            const notifications = await deps.companionBridge.listNotifications();
            const notification = notifications.find((item) => item.id === notificationId);
            if (!notification) {
              throw new FridayDomainError("SYSTEM_NOTIFICATION_NOT_FOUND", "Notification not found", {
                httpStatus: 404,
              });
            }
            return buildIntentResult(input, "completed", "Notification loaded", { notification });
          }

          case "triage_notifications": {
            if (readCompanionActionAvailability(companion, "notification_list") === "unsupported") {
              return buildUnavailableIntentResult(
                input,
                "Notification triage is unavailable for the current companion/platform",
                "notification_triage_unavailable",
                {},
                undefined,
                controlLease?.id,
              );
            }
            const notifications = await deps.companionBridge.listNotifications();
            return buildIntentResult(input, "completed", "Notification triage complete", {
              total: notifications.length,
              unread: notifications.filter((item) => !item.read).length,
            });
          }

          case "notification_act": {
            const approval = assertApprovalAllowed("notification_act", input.appIdentifier);
            const notificationId = requireNonEmpty(input.notificationId, "notificationId");
            const action = (input.notificationAction ?? "open") as FridaySystemNotificationAction;
            if (readCompanionActionAvailability(companion, "notification_act") === "unsupported") {
              return buildUnavailableIntentResult(
                input,
                "Notification action is unavailable for the current companion/platform",
                "notification_action_unavailable",
                {
                  notificationId,
                  notificationAction: action,
                },
                approval?.id,
                controlLease?.id,
              );
            }
            const result = await deps.companionBridge.actOnNotification({
              notificationId,
              action,
            });
            if (!result) {
              return buildUnavailableIntentResult(
                input,
                "Notification action is unavailable for the current companion/platform",
                companionSupportsAction(companion, "notification_act")
                  ? "companion_notification_action_failed_without_fallback"
                  : "notification_action_unavailable",
                {
                  notificationId,
                  notificationAction: action,
                },
                approval?.id,
                controlLease?.id,
              );
            }
            await emitEvent("system.intent.completed", {
              action: input.action,
              notificationId,
              notificationAction: action,
            });
            return buildIntentResult(
              input,
              "completed",
              `Notification ${action} completed`,
              result as unknown as Record<string, unknown>,
              approval?.id,
              controlLease?.id,
            );
          }

          case "resume_task": {
            activeTask = requireNonEmpty(input.value ?? input.target ?? input.query, "value");
            await emitEvent("system.task.updated", {
              activeTask,
              action: input.action,
            });
            await emitEvent("system.intent.completed", {
              action: input.action,
              activeTask,
            });
            return buildIntentResult(input, "completed", `Active task set to ${activeTask}`, {
              activeTask,
            });
          }

          case "recover_ui": {
            const hadSafeMode = safeMode;
            safeMode = false;
            const lease = normalizeActiveLease();
            if (lease) {
              deps.db.withWriteTransaction((db) => {
                repository.revokeControlLease(db, lease.id, deps.nowIso(), "recover_ui");
              });
              activeLease = null;
              await emitEvent("system.control.released", {
                leaseId: lease.id,
                ownerId: lease.ownerId,
                ownerKind: lease.ownerKind,
              });
            }
            await deps.companionBridge.setOverlayVisible(false);
            const companion = await deps.companionBridge.getStatus();
            const permissions = await readPermissions(companion.permissions);
            await emitCompanionEventsIfChanged(companion, permissions);
            if (hadSafeMode && !companion.safeMode) {
              await emitEvent("system.safe_mode.exited", { action: input.action });
            }
            await emitHealthIfChanged("recover_ui");
            const snapshot = await buildSnapshot();
            return buildIntentResult(input, "completed", "UI recovery completed", { snapshot });
          }

          case "arrange_windows": {
            if (readCompanionActionAvailability(companion, "arrange_windows") === "unsupported") {
              return buildUnavailableIntentResult(
                input,
                "Window arrangement is unavailable for the current companion/platform",
                "window_arrangement_unavailable",
                {},
                undefined,
                controlLease?.id,
              );
            }
            const arrangement = await deps.companionBridge.arrangeWindows(input.layout as FridaySystemWindowLayout | undefined);
            if (!arrangement || arrangement.arrangedWindowIds.length === 0) {
              return buildUnavailableIntentResult(
                input,
                "Window arrangement is unavailable for the current companion/platform",
                companionSupportsAction(companion, "arrange_windows")
                  ? "companion_window_arrangement_failed_without_fallback"
                  : "window_arrangement_unavailable",
                {},
                undefined,
                controlLease?.id,
              );
            }
            await emitEvent("system.intent.completed", {
              action: input.action,
              layout: arrangement.layout,
              arrangedWindowIds: arrangement.arrangedWindowIds,
            });
            return buildIntentResult(
              input,
              "completed",
              `Arranged ${arrangement.arrangedWindowIds.length} window(s)`,
              arrangement as unknown as Record<string, unknown>,
              undefined,
              controlLease?.id,
            );
          }

          default: {
            const exhaustive: never = input.action;
            return buildIntentResult(
              input,
              "failed",
              `Unhandled system intent: ${String(exhaustive)}`,
            );
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await emitEvent(
          error instanceof FridayDomainError && error.code === "SYSTEM_APPROVAL_REQUIRED"
            ? "system.intent.blocked"
            : "system.intent.failed",
          {
            action: input.action,
            message,
          },
        );
        if (error instanceof FridayDomainError && error.code === "SYSTEM_APPROVAL_REQUIRED") {
          return buildIntentResult(input, "blocked", message, undefined, undefined, controlLease?.id);
        }
        if (error instanceof FridayDomainError && error.code === "SYSTEM_CONTROL_BUSY") {
          return buildIntentResult(input, "blocked", message, undefined, undefined, controlLease?.id);
        }
        if (error instanceof FridayDomainError) {
          throw error;
        }
        safeMode = true;
        await emitEvent("system.safe_mode.entered", {
          action: input.action,
          reason: message,
        });
        await emitHealthIfChanged("safe_mode_entered");
        return buildIntentResult(input, "failed", message, undefined, undefined, controlLease?.id);
      }
    };

  return {
    getSession,
    getState,
    executeIntent,
    listApprovalRules,
    updateApprovalRule,
    upsertApprovalRule,
    listRemoteDevices,
    registerRemoteDevice,
    beginRemotePasskeyRegistration,
    verifyRemotePasskeyRegistration,
    beginRemotePasskeyAssertion,
    verifyRemotePasskeyAssertion,
    clearRemoteDevicePasskey,
    revokeRemoteDevice,
    listRemoteSessions,
    openRemoteSession,
    touchRemoteSession,
    closeRemoteSession,
    listEvents,
    subscribe,
  };
}
