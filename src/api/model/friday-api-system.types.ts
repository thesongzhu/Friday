import type {
  AuthenticationResponseJSON,
  FridaySystemApprovalDecision,
  FridaySystemApprovalRule,
  FridaySystemEvent,
  FridaySystemIntentAction,
  FridaySystemIntentResult,
  FridaySystemNotificationAction,
  FridaySystemRemoteDevice,
  FridaySystemRemoteSession,
  FridaySystemSession,
  FridaySystemSnapshot,
  FridaySystemWindowLayout,
  FridayTrustedDevicePlatform,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  UUID,
} from "../../system/model/friday-system.types.js";
import type { FridayDesktopRiskLevel } from "../../desktop/model/friday-desktop.types.js";

export interface FridayGetSystemSessionResponse {
  session: FridaySystemSession;
}

export interface FridayGetSystemStateResponse {
  snapshot: FridaySystemSnapshot;
}

export interface FridayExecuteSystemIntentRequest {
  action: FridaySystemIntentAction;
  actorId?: string;
  actorKind?: "agent" | "api" | "remote" | "system";
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
  idempotencyKey?: string;
}

export interface FridayExecuteSystemIntentResponse {
  result: FridaySystemIntentResult;
}

export interface FridayListSystemApprovalsQuery {
  action?: string;
  appIdentifier?: string;
  decision?: FridaySystemApprovalDecision;
  limit?: number | string;
  cursor?: string;
}

export interface FridayListSystemApprovalsResponse {
  items: FridaySystemApprovalRule[];
  nextCursor?: string;
}

export interface FridayUpdateSystemApprovalRequest {
  decision?: FridaySystemApprovalDecision;
  rationale?: string;
  idempotencyKey?: string;
}

export interface FridayUpdateSystemApprovalResponse {
  approval: FridaySystemApprovalRule;
}

export interface FridayListSystemEventsQuery {
  afterSeq?: number | string;
  limit?: number | string;
  stream?: string;
}

export interface FridayListSystemEventsResponse {
  items: FridaySystemEvent[];
  nextAfterSeq?: number;
}

export interface FridayListSystemRemoteDevicesResponse {
  items: FridaySystemRemoteDevice[];
}

export interface FridayListSystemRemoteSessionsQuery {
  deviceId?: UUID;
  status?: "active" | "closed";
  limit?: number | string;
}

export interface FridayListSystemRemoteSessionsResponse {
  items: FridaySystemRemoteSession[];
}

export interface FridayRegisterSystemRemoteDeviceRequest {
  label: string;
  fingerprint: string;
  platform?: FridayTrustedDevicePlatform;
  credentialId?: string;
  idempotencyKey?: string;
}

export interface FridayRegisterSystemRemoteDeviceResponse {
  device: FridaySystemRemoteDevice;
}

export interface FridayDeleteSystemRemoteDeviceResponse {
  revoked: boolean;
  deviceId: UUID;
}

export interface FridayDeleteSystemRemotePasskeyResponse {
  cleared: boolean;
  deviceId: UUID;
  device: FridaySystemRemoteDevice;
}

export interface FridayCreateSystemRemoteSessionRequest {
  deviceId: UUID;
  assertionToken: string;
  idempotencyKey?: string;
}

export interface FridayCreateSystemRemoteSessionResponse {
  session: FridaySystemRemoteSession;
}

export interface FridayHeartbeatSystemRemoteSessionRequest {
  idempotencyKey?: string;
}

export interface FridayHeartbeatSystemRemoteSessionResponse {
  session: FridaySystemRemoteSession | null;
}

export interface FridayDeleteSystemRemoteSessionResponse {
  closed: boolean;
  sessionId: UUID;
}

export interface FridayBeginSystemRemotePasskeyRegistrationRequest {
  deviceId: UUID;
  idempotencyKey?: string;
}

export interface FridayBeginSystemRemotePasskeyRegistrationResponse {
  challengeId: UUID;
  deviceId: UUID;
  rpId: string;
  origin: string;
  expiresAt: string;
  options: PublicKeyCredentialCreationOptionsJSON;
}

export interface FridayVerifySystemRemotePasskeyRegistrationRequest {
  deviceId: UUID;
  challengeId: UUID;
  response: RegistrationResponseJSON;
  idempotencyKey?: string;
}

export interface FridayVerifySystemRemotePasskeyRegistrationResponse {
  device: FridaySystemRemoteDevice;
  credentialId: string;
  verifiedAt: string;
}

export interface FridayBeginSystemRemotePasskeyAssertionRequest {
  deviceId: UUID;
  idempotencyKey?: string;
}

export interface FridayBeginSystemRemotePasskeyAssertionResponse {
  challengeId: UUID;
  deviceId: UUID;
  rpId: string;
  origin: string;
  expiresAt: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}

export interface FridayVerifySystemRemotePasskeyAssertionRequest {
  deviceId: UUID;
  challengeId: UUID;
  response: AuthenticationResponseJSON;
  idempotencyKey?: string;
}

export interface FridayVerifySystemRemotePasskeyAssertionResponse {
  device: FridaySystemRemoteDevice;
  assertionToken: string;
  expiresAt: string;
  verifiedAt: string;
}
