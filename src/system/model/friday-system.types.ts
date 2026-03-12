import type { FridayDesktopPlatform, FridayDesktopRiskLevel } from "../../desktop/model/friday-desktop.types.js";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

export type UUID = string;
export type ISODateTime = string;

export const FRIDAY_SYSTEM_HEALTH_STATES = [
  "healthy",
  "degraded",
  "safe_mode",
  "unavailable",
] as const;

export const FRIDAY_SYSTEM_INTENT_ACTIONS = [
  "snapshot",
  "open",
  "focus",
  "arrange_windows",
  "launch_app",
  "close_app",
  "open_url",
  "open_project",
  "search_file",
  "handoff_to_browser",
  "handoff_to_terminal",
  "read_notification",
  "notification_list",
  "notification_act",
  "triage_notifications",
  "resume_task",
  "recover_ui",
  "clipboard_read",
  "clipboard_write",
  "request_control",
  "release_control",
  "approve",
  "deny",
] as const;

export const FRIDAY_SYSTEM_INTENT_STATUSES = [
  "completed",
  "blocked",
  "failed",
  "unavailable",
  "queued",
] as const;

export const FRIDAY_SYSTEM_APPROVAL_DECISIONS = [
  "allow",
  "deny",
  "prompt",
] as const;

export const FRIDAY_SYSTEM_REMOTE_DEVICE_STATUSES = [
  "active",
  "revoked",
] as const;

export const FRIDAY_SYSTEM_TRUSTED_DEVICE_PLATFORMS = [
  "browser",
  "ios",
  "android",
] as const;

export const FRIDAY_SYSTEM_REMOTE_SESSION_STATUSES = [
  "active",
  "closed",
] as const;

export const FRIDAY_SYSTEM_REMOTE_AUTH_CHALLENGE_KINDS = [
  "register",
  "assert",
] as const;

export const FRIDAY_SYSTEM_NOTIFICATION_ACTIONS = [
  "open",
  "dismiss",
  "mark_read",
] as const;

export const FRIDAY_SYSTEM_WINDOW_LAYOUTS = [
  "single_focus",
  "dual_pane",
  "triad",
] as const;

export const FRIDAY_SYSTEM_CAPABILITY_AVAILABILITIES = [
  "supported",
  "fallback",
  "unsupported",
] as const;

export const FRIDAY_SYSTEM_COMPANION_RUNTIME_KINDS = [
  "embedded",
  "node_daemon",
  "swift_binary",
  "swift_app",
  "dotnet_winui_app",
  "rust_gtk_app",
] as const;

export const FRIDAY_SYSTEM_COMPANION_ACTIONS = [
  "snapshot",
  "launch_app",
  "focus",
  "open_url",
  "open_project",
  "handoff_to_browser",
  "handoff_to_terminal",
  "arrange_windows",
  "notification_list",
  "read_notification",
  "notification_act",
  "recover_ui",
] as const;

export const FRIDAY_SYSTEM_EVENT_NAMES = [
  "system.session.started",
  "system.health.updated",
  "system.snapshot.updated",
  "system.task.updated",
  "system.intent.completed",
  "system.intent.blocked",
  "system.intent.failed",
  "system.control.acquired",
  "system.control.released",
  "system.approval.updated",
  "system.remote_device.registered",
  "system.remote_device.revoked",
  "system.remote_session.started",
  "system.remote_session.heartbeat",
  "system.remote_session.closed",
  "system.remote_passkey.registered",
  "system.remote_passkey.asserted",
  "system.remote_passkey.cleared",
  "system.companion.connected",
  "system.companion.disconnected",
  "system.companion.heartbeat_stale",
  "system.companion.permissions_changed",
  "system.safe_mode.entered",
  "system.safe_mode.exited",
] as const;

export type FridaySystemHealthState = (typeof FRIDAY_SYSTEM_HEALTH_STATES)[number];
export type FridaySystemIntentAction = (typeof FRIDAY_SYSTEM_INTENT_ACTIONS)[number];
export type FridaySystemIntentStatus = (typeof FRIDAY_SYSTEM_INTENT_STATUSES)[number];
export type FridaySystemApprovalDecision = (typeof FRIDAY_SYSTEM_APPROVAL_DECISIONS)[number];
export type FridaySystemRemoteDeviceStatus = (typeof FRIDAY_SYSTEM_REMOTE_DEVICE_STATUSES)[number];
export type FridayTrustedDevicePlatform = (typeof FRIDAY_SYSTEM_TRUSTED_DEVICE_PLATFORMS)[number];
export type FridaySystemRemoteSessionStatus = (typeof FRIDAY_SYSTEM_REMOTE_SESSION_STATUSES)[number];
export type FridaySystemRemoteAuthChallengeKind = (typeof FRIDAY_SYSTEM_REMOTE_AUTH_CHALLENGE_KINDS)[number];
export type FridaySystemEventName = (typeof FRIDAY_SYSTEM_EVENT_NAMES)[number];
export type FridaySystemNotificationAction = (typeof FRIDAY_SYSTEM_NOTIFICATION_ACTIONS)[number];
export type FridaySystemWindowLayout = (typeof FRIDAY_SYSTEM_WINDOW_LAYOUTS)[number];
export type FridaySystemCapabilityAvailability = (typeof FRIDAY_SYSTEM_CAPABILITY_AVAILABILITIES)[number];
export type FridaySystemCompanionRuntimeKind = (typeof FRIDAY_SYSTEM_COMPANION_RUNTIME_KINDS)[number];
export type FridaySystemCompanionAction = (typeof FRIDAY_SYSTEM_COMPANION_ACTIONS)[number];
export type FridaySystemRemotePasskeyDeviceType = "singleDevice" | "multiDevice";

export type FridaySystemControlLeaseOwnerKind =
  | "agent"
  | "api"
  | "remote"
  | "system";

export type FridaySystemMode = "agent_os";
export type FridaySystemRemoteMode = "trusted_private_network" | "disabled";
export type FridaySystemCloudPlanningMode = "local_only" | "opt_in" | "hybrid";
export type FridaySystemTransportMode = "in_process" | "unix_socket" | "named_pipe";

export interface FridaySystemBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FridaySystemAppRef {
  id: string;
  name: string;
  bundleId?: string;
  pid?: number;
  running: boolean;
  frontmost: boolean;
}

export interface FridaySystemWindowRef {
  id: string;
  appId: string;
  title: string;
  focused: boolean;
  bounds?: FridaySystemBounds;
}

export interface FridaySystemNotificationRef {
  id: string;
  sourceApp?: string;
  title: string;
  body?: string;
  deepLinkUrl?: string;
  receivedAt: ISODateTime;
  read: boolean;
}

export interface FridaySystemPermissionGrant {
  id: string;
  permission: string;
  status: "granted" | "denied" | "not_determined" | "restricted" | "not_applicable";
  grantInstructions?: string;
}

export interface FridaySystemControlLease {
  id: UUID;
  ownerId: string;
  ownerKind: FridaySystemControlLeaseOwnerKind;
  reason?: string;
  acquiredAt: ISODateTime;
  expiresAt?: ISODateTime;
  revokedAt?: ISODateTime;
  revokedReason?: string;
}

export interface FridaySystemApprovalRule {
  id: UUID;
  appIdentifier?: string;
  action: FridaySystemIntentAction | string;
  riskLevel: FridayDesktopRiskLevel;
  decision: FridaySystemApprovalDecision;
  rationale?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  lastUsedAt?: ISODateTime;
}

export interface FridaySystemRemoteDevice {
  id: UUID;
  label: string;
  fingerprint: string;
  platform: FridayTrustedDevicePlatform;
  credentialId?: string;
  passkeyRegisteredAt?: ISODateTime;
  passkeyLastUsedAt?: ISODateTime;
  passkeyBackedUp?: boolean;
  passkeyDeviceType?: FridaySystemRemotePasskeyDeviceType;
  trustScope: FridaySystemRemoteMode;
  status: FridaySystemRemoteDeviceStatus;
  registeredAt: ISODateTime;
  lastSeenAt?: ISODateTime;
  revokedAt?: ISODateTime;
}

export interface FridaySystemRemoteSession {
  id: UUID;
  deviceId: UUID;
  devicePlatform?: FridayTrustedDevicePlatform;
  status: FridaySystemRemoteSessionStatus;
  connectedAt: ISODateTime;
  lastSeenAt: ISODateTime;
  closedAt?: ISODateTime;
  closedReason?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface FridaySystemRemotePasskey {
  deviceId: UUID;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  deviceType?: FridaySystemRemotePasskeyDeviceType;
  backedUp: boolean;
  registeredAt: ISODateTime;
  updatedAt: ISODateTime;
  lastUsedAt?: ISODateTime;
}

export interface FridaySystemRemoteAuthChallenge {
  id: UUID;
  deviceId: UUID;
  kind: FridaySystemRemoteAuthChallengeKind;
  challenge: string;
  rpId: string;
  origin: string;
  createdAt: ISODateTime;
  expiresAt: ISODateTime;
  usedAt?: ISODateTime;
}

export interface FridaySystemRemoteAssertionGrant {
  id: UUID;
  deviceId: UUID;
  createdAt: ISODateTime;
  expiresAt: ISODateTime;
  consumedAt?: ISODateTime;
  ipAddress?: string;
  userAgent?: string;
}

export interface FridaySystemTransport {
  mode: FridaySystemTransportMode;
  protocol: "jsonrpc-2.0";
  authenticated: boolean;
  socketPath?: string;
  pipeName?: string;
}

export type FridaySystemCompanionActionCapabilities = Record<
  FridaySystemCompanionAction,
  FridaySystemCapabilityAvailability
>;

export interface FridaySystemCompanionSurfaceCapabilities {
  launchAtLogin: boolean;
  menuBar: boolean;
  overlay: boolean;
  globalHotkey: boolean;
  windowInventory: boolean;
  notificationIntake: boolean;
  screenCapture: boolean;
}

export interface FridaySystemCompanionCapabilities {
  surfaces: FridaySystemCompanionSurfaceCapabilities;
  actions: FridaySystemCompanionActionCapabilities;
}

export interface FridaySystemCompanionStatus {
  id: string;
  platform: FridayDesktopPlatform | "unknown";
  runtimeKind: FridaySystemCompanionRuntimeKind;
  connected: boolean;
  transport: FridaySystemTransport;
  launchAtLoginEnabled: boolean;
  panicHotkey: string;
  safeMode: boolean;
  overlayVisible: boolean;
  lastHeartbeatAt: ISODateTime;
  capabilities: FridaySystemCompanionCapabilities;
  permissions: FridaySystemPermissionGrant[];
}

export interface FridaySystemHealth {
  status: FridaySystemHealthState;
  safeMode: boolean;
  desktopConnected: boolean;
  companionConnected: boolean;
  reasons: string[];
  updatedAt: ISODateTime;
}

export interface FridaySystemSnapshot {
  capturedAt: ISODateTime;
  platform: FridayDesktopPlatform | "unknown";
  workspaceRoot: string;
  apps: FridaySystemAppRef[];
  windows: FridaySystemWindowRef[];
  notifications: FridaySystemNotificationRef[];
  permissions: FridaySystemPermissionGrant[];
  mountedRoots: string[];
  frontmostAppId?: string;
  frontmostWindowId?: string;
  activeTask?: string;
  clipboard?: {
    available: boolean;
    textPreview?: string;
  };
  health: FridaySystemHealth;
  companion: FridaySystemCompanionStatus;
  controlLease: FridaySystemControlLease | null;
  approvalsSummary: {
    total: number;
    highRiskAllowed: number;
  };
  remoteDevicesSummary: {
    total: number;
    active: number;
  };
  remoteSessionsSummary: {
    total: number;
    active: number;
    latestSeenAt?: ISODateTime;
  };
}

export interface FridaySystemSession {
  id: UUID;
  mode: FridaySystemMode;
  workspaceRoot: string;
  remoteMode: FridaySystemRemoteMode;
  cloudPlanningMode: FridaySystemCloudPlanningMode;
  startedAt: ISODateTime;
  companion: FridaySystemCompanionStatus;
  health: FridaySystemHealth;
}

export interface FridaySystemRemotePasskeyRegistrationOptions {
  challengeId: UUID;
  deviceId: UUID;
  rpId: string;
  origin: string;
  expiresAt: ISODateTime;
  options: PublicKeyCredentialCreationOptionsJSON;
}

export interface FridaySystemRemotePasskeyRegistrationResult {
  device: FridaySystemRemoteDevice;
  credentialId: string;
  verifiedAt: ISODateTime;
}

export interface FridaySystemRemotePasskeyAssertionOptions {
  challengeId: UUID;
  deviceId: UUID;
  rpId: string;
  origin: string;
  expiresAt: ISODateTime;
  options: PublicKeyCredentialRequestOptionsJSON;
}

export interface FridaySystemRemotePasskeyAssertionResult {
  device: FridaySystemRemoteDevice;
  assertionToken: string;
  expiresAt: ISODateTime;
  verifiedAt: ISODateTime;
}

export interface FridaySystemIntentInput {
  action: FridaySystemIntentAction;
  actorId?: string;
  actorKind?: FridaySystemControlLeaseOwnerKind;
  target?: string;
  targetKind?: "app" | "url" | "project";
  appIdentifier?: string;
  url?: string;
  projectPath?: string;
  query?: string;
  value?: string;
  notificationId?: UUID;
  notificationAction?: FridaySystemNotificationAction;
  approvalId?: UUID;
  deviceId?: UUID;
  riskLevel?: FridayDesktopRiskLevel;
  reason?: string;
  force?: boolean;
  leaseTtlMs?: number;
  layout?: FridaySystemWindowLayout;
  assertionToken?: string;
}

export interface FridaySystemIntentResult {
  id: UUID;
  action: FridaySystemIntentAction;
  status: FridaySystemIntentStatus;
  message: string;
  performedAt: ISODateTime;
  payload?: Record<string, unknown>;
  approvalRuleId?: UUID;
  controlLeaseId?: UUID;
}

export interface FridaySystemEvent {
  id: UUID;
  seq: number;
  event: FridaySystemEventName;
  emittedAt: ISODateTime;
  payload: Record<string, unknown>;
}

export interface FridaySystemApprovalRuleRecord {
  id: string;
  app_identifier: string | null;
  action: string;
  risk_level: FridayDesktopRiskLevel;
  decision: FridaySystemApprovalDecision;
  rationale: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

export interface FridaySystemRemoteDeviceRecord {
  id: string;
  label: string;
  fingerprint: string;
  platform: FridayTrustedDevicePlatform;
  credential_id: string | null;
  trust_scope: FridaySystemRemoteMode;
  status: FridaySystemRemoteDeviceStatus;
  registered_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export interface FridaySystemRemoteSessionRecord {
  id: string;
  device_id: string;
  device_platform?: FridayTrustedDevicePlatform | null;
  status: FridaySystemRemoteSessionStatus;
  connected_at: string;
  last_seen_at: string;
  closed_at: string | null;
  closed_reason: string | null;
  ip_address: string | null;
  user_agent: string | null;
}

export interface FridaySystemRemotePasskeyRecord {
  device_id: string;
  credential_id: string;
  public_key_b64u: string;
  counter: number;
  transports_json: string | null;
  device_type: FridaySystemRemotePasskeyDeviceType | null;
  backed_up: number;
  registered_at: string;
  updated_at: string;
  last_used_at: string | null;
}

export interface FridaySystemRemoteAuthChallengeRecord {
  id: string;
  device_id: string;
  kind: FridaySystemRemoteAuthChallengeKind;
  challenge: string;
  rp_id: string;
  origin: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

export interface FridaySystemRemoteAssertionGrantRecord {
  id: string;
  device_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  ip_address: string | null;
  user_agent: string | null;
}

export interface FridaySystemRemotePasskeyRegistrationVerificationInput {
  deviceId: UUID;
  challengeId: UUID;
  response: RegistrationResponseJSON;
  origin?: string;
}

export interface FridaySystemRemotePasskeyAssertionVerificationInput {
  deviceId: UUID;
  challengeId: UUID;
  response: AuthenticationResponseJSON;
  origin?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface FridaySystemControlLeaseRecord {
  id: string;
  owner_id: string;
  owner_kind: FridaySystemControlLeaseOwnerKind;
  reason: string | null;
  acquired_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
}

export interface FridaySystemEventRecord {
  id: string;
  seq: number;
  event_name: FridaySystemEventName;
  payload_json: string;
  emitted_at: string;
}
