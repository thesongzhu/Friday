export type FridaySatelliteType = "phone" | "desktop" | "rpi" | "cloud-vm" | "custom";

export type FridaySatellitePairingStatus =
  | "pending"
  | "paired"
  | "online"
  | "degraded"
  | "offline"
  | "revoked";

export type FridaySatelliteTrustLevel = "restricted" | "trusted";

export interface FridaySatelliteRuntimeInfo {
  platform: string;
  arch: string;
  appVersion: string;
  nodeVersion: string;
}

export interface FridaySatelliteRegistrationInput {
  type: FridaySatelliteType;
  displayName: string;
  publicKey: string;
  runtime: FridaySatelliteRuntimeInfo;
  transport: "ws" | "http-poll" | "mixed";
  requestedByIp?: string;
  requestedByUserAgent?: string;
  capabilityReport?: FridaySatelliteCapabilityReport;
}

export interface FridaySatelliteCapabilityReport {
  satelliteId: string;
  revision: number;
  generatedAt: string;
  runtime: { os: string; arch: string; appVersion: string; nodeVersion: string };
  capabilities: FridaySatelliteCapabilityEntry[];
}

export interface FridaySatelliteCapabilityEntry {
  key: string;
  available: boolean;
  metadata?: Record<string, unknown>;
  limits?: { maxConcurrency?: number; timeoutMs?: number; maxPayloadBytes?: number };
}

export interface FridaySatelliteHeartbeatInput {
  satelliteId: string;
  ts: string;
  metrics?: { cpuPercent?: number; memoryPercent?: number; loadAvg1m?: number };
  queueDepth?: number;
  activeRuns?: number;
  lastSuccessfulCommandAt?: string;
  failureRate1m?: number;
  explicitDisconnect?: boolean;
  details?: Record<string, unknown>;
}

export interface FridaySatelliteRow {
  id: string;
  type: FridaySatelliteType;
  display_name: string;
  pairing_status: FridaySatellitePairingStatus;
  trust_level: FridaySatelliteTrustLevel;
  public_key: string;
  token_version: number;
  local_ip: string | null;
  external_ip: string | null;
  transport: string;
  platform: string;
  arch: string;
  app_version: string;
  node_version: string;
  tags_json: string;
  metadata_json: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface FridaySatellitePairingRequestRow {
  id: string;
  satellite_id: string;
  code: string;
  nonce: string;
  requested_by_ip: string | null;
  requested_by_user_agent: string | null;
  status: "pending" | "approved" | "rejected" | "expired";
  expires_at: string;
  resolved_at: string | null;
  resolver_user_id: string | null;
  satellite_payload_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface FridayApiTokenRow {
  id: string;
  user_id: string | null;
  principal_type: string;
  label: string;
  token_hash: string;
  scopes_json: string;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}
