import type { SkillManifestV2 } from "./friday-skill-manifest-v2.types.js";
import type { SkillLifecycleStatus } from "./friday-skill-lifecycle.types.js";
import type { SkillOrigin, SkillSource } from "./friday-skill-source.types.js";
import type { SkillTrustTier } from "./friday-skill-trust.types.js";

// ─── Re-export foundational value types ───

export type UUID = string;
export type ISODateTime = string;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

// ─── Marketplace Enums ───

export type FridayMarketplaceTrustPolicy = "strict" | "warn" | "permissive";
export type FridayMarketplaceSignatureAlgorithm = "ed25519" | "rsa-sha256" | "rsa-pss-sha256";
export type FridaySkillInstallationStatus =
  | "installing"
  | "installed"
  | "failed"
  | "uninstalling"
  | "uninstalled";

// ─── Row Types (SQLite shape) ───

export interface FridayMarketplaceSourceRow {
  id: string;
  name: string;
  base_url: string;
  enabled: number;
  trust_policy: string;
  pinned_key_ids_json: string;
  created_at: string;
  updated_at: string;
}

export interface FridayMarketplaceCacheRow {
  id: string;
  source_id: string;
  skill_id: string;
  version: string;
  manifest_json: string;
  signature_valid: number;
  indexed_at: string;
  trust_score: number;
  created_at: string;
  updated_at: string;
}

export interface FridaySkillRow {
  id: string;
  name: string;
  source: string;
  origin: string;
  publisher: string | null;
  latest_version: string | null;
  installed_version: string | null;
  status: string;
  current_manifest_json: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface FridaySkillVersionRow {
  id: string;
  skill_id: string;
  version: string;
  checksum: string;
  package_url: string | null;
  signature_key_id: string | null;
  signature_algorithm: string | null;
  signature_value: string | null;
  manifest_json: string;
  released_at: string;
  yanked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FridaySkillInstallationRow {
  id: string;
  skill_id: string;
  version: string;
  satellite_id: string | null;
  status: string;
  permissions_granted_json: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Entity Types (Application shape) ───

export interface FridayMarketplaceSourceEntity {
  id: UUID;
  name: string;
  baseUrl: string;
  enabled: boolean;
  trustPolicy: FridayMarketplaceTrustPolicy;
  pinnedKeyIds: string[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface FridayMarketplaceSourceCatalogSummary {
  cachedSkillCount: number;
  cachedVersionCount: number;
  verifiedVersionCount: number;
  unsignedVersionCount: number;
  latestIndexedAt?: ISODateTime;
  stale: boolean;
}

export interface FridayMarketplaceSourceTrustSummary {
  policy: FridayMarketplaceTrustPolicy;
  pinnedKeyCount: number;
  pinned: boolean;
}

export interface FridayMarketplaceSourceHealthSummary {
  status: "healthy" | "warning";
  reasons: string[];
}

export interface FridayMarketplaceSourceView extends FridayMarketplaceSourceEntity {
  trustSummary: FridayMarketplaceSourceTrustSummary;
  catalogSummary: FridayMarketplaceSourceCatalogSummary;
  healthSummary: FridayMarketplaceSourceHealthSummary;
}

export interface FridayMarketplaceCacheEntity {
  id: UUID;
  sourceId: UUID;
  skillId: string;
  version: string;
  manifestJson: JsonValue;
  signatureValid: boolean;
  indexedAt: ISODateTime;
  trustScore: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface FridaySkillEntity {
  id: string;
  name: string;
  source: SkillSource;
  origin: SkillOrigin;
  publisher?: string;
  latestVersion?: string;
  installedVersion?: string;
  status: SkillLifecycleStatus;
  currentManifest?: SkillManifestV2;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  deletedAt?: ISODateTime;
  deletedBy?: string;
}

export interface FridaySkillSignature {
  keyId: string;
  algorithm: FridayMarketplaceSignatureAlgorithm;
  value: string; // base64
}

export interface FridaySkillVersionEntity {
  id: UUID;
  skillId: string;
  version: string;
  checksum: string;
  packageUrl?: string;
  signature?: FridaySkillSignature;
  manifest: SkillManifestV2;
  releasedAt: ISODateTime;
  yankedAt?: ISODateTime;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface FridaySkillInstallationEntity {
  id: UUID;
  skillId: string;
  version: string;
  satelliteId?: UUID;
  status: FridaySkillInstallationStatus;
  permissionsGranted: string[];
  lastError?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ─── Input / Query Types ───

export interface FridayMarketplaceSourceCreateInput {
  name: string;
  baseUrl: string;
  trustPolicy: FridayMarketplaceTrustPolicy;
  pinnedKeyIds: string[];
}

export interface FridayMarketplaceSourcePatchInput {
  name?: string;
  baseUrl?: string;
  enabled?: boolean;
  trustPolicy?: FridayMarketplaceTrustPolicy;
  pinnedKeyIds?: string[];
}

export interface FridaySkillCatalogQuery {
  sourceId?: string;
  q?: string;
  category?: string;
  cursor?: string;
  limit?: number;
  includeStale?: boolean;
}

export interface FridaySkillCatalogItem {
  sourceId: string;
  skillId: string;
  skillName: string;
  publisher?: string;
  version: string;
  category?: string;
  releasedAt?: string;
  signatureValid: boolean;
  trustScore: number;
  starter: boolean;
  manifest: SkillManifestV2;
  trustTier?: SkillTrustTier;
  implementationStatus?: "bundled" | "installed" | "catalog-only" | "generated-draft";
  blockedReasons?: string[];
  shadowedBy?: string[];
  recommendedNextAction?: string;
  firstUsePrompts?: string[];
}

export type FridaySkillVerificationStatus =
  | "local"
  | "trusted"
  | "warning"
  | "blocked"
  | "unverified";

export interface FridaySkillRequirementPreview {
  bins: string[];
  env: string[];
  config: string[];
  supportedOs: Array<"darwin" | "linux" | "win32">;
  requiredCapabilities: string[];
  missingBins: string[];
  missingEnv: string[];
  unresolvedConfig: string[];
  unsupportedOs: boolean;
}

export interface FridaySkillPermissionPreviewGrant {
  id: string;
  token: string;
  resource: string;
  action: string;
  required: boolean;
  reason: string;
  selectors?: Record<string, JsonValue | undefined>;
}

export interface FridaySkillPermissionPreview {
  required: string[];
  optional: string[];
  promptOn: string[];
  grants: FridaySkillPermissionPreviewGrant[];
}

export interface FridaySkillEligibility {
  verdict: "eligible" | "needs_configuration" | "blocked";
  installable: boolean;
  reviewRequired: boolean;
  reasons: string[];
}

export interface FridaySkillInstallPlanSummary {
  strategy: "install" | "update";
  targetVersion?: string;
  sourceId?: string;
  sourceTrustPolicy?: FridayMarketplaceTrustPolicy;
  targetCount: number;
  verificationStatus: FridaySkillVerificationStatus;
  eligibility: FridaySkillEligibility;
  requirements: FridaySkillRequirementPreview;
  permissions: FridaySkillPermissionPreview;
}

export interface FridaySkillFailureEvidenceSummary {
  installationId: string;
  version: string;
  message: string;
  failedAt: ISODateTime;
  satelliteId?: UUID;
}

// ─── Remote Index Documents ───

export interface FridayMarketplaceIndexDocument {
  generatedAt: ISODateTime;
  skills: Array<{
    id: string;
    name: string;
    publisher?: string;
    latestVersion: string;
    versions: Array<{
      version: string;
      checksum: string;
      releasedAt: ISODateTime;
      manifestUrl: string;
      packageUrl: string;
      signatureUrl: string;
    }>;
  }>;
}

export interface FridayMarketplaceSignatureDocument {
  skillId: string;
  version: string;
  keyId: string;
  algorithm: FridayMarketplaceSignatureAlgorithm;
  value: string; // base64
}

export interface FridayMarketplacePublisherKeyDocument {
  keyId: string;
  algorithm: FridayMarketplaceSignatureAlgorithm;
  publicKeyPem?: string;
  publicKeyJwk?: JsonValue;
  rotatedAt?: ISODateTime;
  revokedAt?: ISODateTime;
}

// ─── Verification & Trust ───

export interface FridaySignatureVerificationResult {
  integrityValid: boolean;
  signatureValid: boolean;
  checks: string[];
  keyId?: string;
  algorithm?: FridayMarketplaceSignatureAlgorithm;
  reason?: string;
}

export interface FridayTrustScoreBreakdown {
  total: number;
  signature: number;
  integrity: number;
  keyPinning: number;
  sourcePolicy: number;
  publisher: number;
  freshness: number;
  reasons: string[];
}

// ─── Version Resolution ───

export interface FridaySkillVersionResolutionInput {
  skillId: string;
  requestedVersion?: string;
  strategy: "install" | "upgrade" | "rollback";
  sourceId?: string;
  satelliteId?: string;
  allowYanked?: boolean;
}

export interface FridaySkillVersionResolutionResult {
  skillId: string;
  version: string;
  sourceId: string;
  manifest: SkillManifestV2;
  checksum: string;
  packageUrl: string;
  signature?: FridaySkillSignature;
  reason: string;
}

// ─── Installation ───

export interface FridaySkillInstallRequest {
  skillId: string;
  version?: string;
  targetSatelliteIds?: string[];
  grantPermissions?: string[];
  sourceId?: string;
}

export interface FridaySkillInstallResult {
  installationIds: string[];
  resolvedVersion: string;
  verification: FridaySignatureVerificationResult;
  trust: FridayTrustScoreBreakdown;
}
