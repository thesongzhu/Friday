import type { LoadedFridayConfig } from "#config";
import type { FridayConfigRevisionRecord } from "#hub";
import type { FridaySearchAuditEntriesQuery, FridaySearchAuditEntriesResponse } from "../../observability/api/friday-observability-api.types.js";

export interface FridayGetVersionResponse {
  version: string;
  apiVersion: "v1";
}

export interface FridayGetConfigQuery {
  keys?: string[];
}

export interface FridayGetConfigResponse {
  revision: number;
  settings: Record<string, unknown>;
  currentConfig: LoadedFridayConfig;
}

export interface FridayUpdateConfigRequest {
  expectedRevision: number;
  patch: Record<string, unknown>;
  reason?: string;
}

export interface FridayUpdateConfigResponse {
  revision: number;
  changedKeys: string[];
  validation: {
    valid: true;
    errors: [];
  };
}

export interface FridayListConfigRevisionsQuery {
  cursor?: string;
  limit?: number;
}

export interface FridayListConfigRevisionsResponse {
  items: FridayConfigRevisionRecord[];
  nextCursor?: string;
}

export interface FridayRevertConfigRequest {
  toRevision: number;
}

export interface FridayRevertConfigResponse {
  revision: number;
  changedKeys: string[];
  revertedFrom: number;
}

export type FridayListAuditLogsQuery = FridaySearchAuditEntriesQuery;
export type FridayListAuditLogsResponse = FridaySearchAuditEntriesResponse;

export interface FridaySecretSummary {
  id: string;
  scope: string;
  refKey: string;
  keyId: string;
  expiresAt?: string;
  rotatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FridayListSecretsQuery {
  scope?: string;
  refKey?: string;
  limit?: number;
}

export interface FridayListSecretsResponse {
  items: FridaySecretSummary[];
}

export interface FridayGetSecretResponse {
  secret: FridaySecretSummary;
}

export interface FridayCreateSecretRequest {
  scope: string;
  refKey: string;
  value: string;
  expiresAt?: string;
}

export interface FridayCreateSecretResponse {
  secret: FridaySecretSummary;
}

export interface FridayUpdateSecretRequest {
  refKey?: string;
  value?: string;
  expiresAt?: string | null;
}

export interface FridayUpdateSecretResponse {
  secret: FridaySecretSummary;
}

export interface FridayDeleteSecretResponse {
  deleted: boolean;
}
