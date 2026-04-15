> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

I’ll read only the specified marketplace-related sections and schema/types, then immediately produce the Phase 4 implementation plan aligned to your constraints (V001 tables only, `FridaySqliteLayer`, no new deps).

---

I have the section indexes; next I’m pulling the exact marketplace protocol, schema fields, and API contracts so the plan maps directly to existing table shapes and naming.

---

I’ve captured the schema and protocol constraints; I’m taking one quick pass over directory layout (not source internals) to keep the proposed file paths aligned with current structure.

---

I’m done gathering constraints from schema, runtime patterns, and existing skill modules; next response is the single-pass implementation plan document with the exact 10 sections.

---

**1. File Structure**
New files:
- `src/skills/model/friday-skill-marketplace.types.ts`
- `src/skills/persistence/friday-marketplace-source-repository.ts`
- `src/skills/persistence/friday-marketplace-cache-repository.ts`
- `src/skills/persistence/friday-skill-repository.ts`
- `src/skills/persistence/friday-skill-version-repository.ts`
- `src/skills/persistence/friday-skill-installation-repository.ts`
- `src/skills/services/friday-marketplace-http-client.ts`
- `src/skills/services/friday-marketplace-source-service.ts`
- `src/skills/services/friday-marketplace-cache-service.ts`
- `src/skills/services/friday-marketplace-discovery-service.ts`
- `src/skills/services/friday-marketplace-sync-service.ts`
- `src/skills/services/friday-skill-signature-verifier.ts`
- `src/skills/services/friday-skill-trust-scoring-service.ts`
- `src/skills/services/friday-skill-version-resolution-service.ts`
- `src/skills/services/friday-skill-permission-check-service.ts`
- `src/skills/services/friday-skill-package-installer.ts`
- `src/skills/services/friday-skill-installation-service.ts`
- `src/skills/runtime/friday-skill-marketplace-runtime.types.ts`
- `src/skills/runtime/friday-skill-marketplace-runtime.ts`
- `src/jobs/marketplace/friday-marketplace-sync.types.ts`
- `src/jobs/marketplace/friday-marketplace-sync-job.ts`

Existing files to extend:
- `src/skills/model/friday-skill-manifest-v2.types.ts`
- `src/skills/manifest/friday-skill-manifest.schema.ts`
- `src/skills/index.ts`
- `src/jobs/index.ts`

**2. Type Definitions**
```ts
import type Database from "better-sqlite3";
import type { SkillManifestV2 } from "./friday-skill-manifest-v2.types.js";
import type { SkillLifecycleStatus } from "./friday-skill-lifecycle.types.js";
import type { SkillOrigin, SkillSource } from "./friday-skill-source.types.js";
import type { UUID, ISODateTime, JsonValue } from "../../workflows/model/friday-workflow.types.js";

export type FridayMarketplaceTrustPolicy = "strict" | "warn" | "permissive";
export type FridayMarketplaceSignatureAlgorithm = "ed25519" | "rsa-sha256" | "rsa-pss-sha256";
export type FridaySkillInstallationStatus =
  | "installing"
  | "installed"
  | "failed"
  | "uninstalling"
  | "uninstalled";

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
  manifest: SkillManifestV2;
}

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

export interface FridaySkillVersionResolutionInput {
  skillId: string;
  requestedVersion?: string; // exact or semver range
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
```

**3. Persistence Repositories**
Use table-backed repositories in `src/skills/persistence/*`, each method receiving `Database.Database` and called from services via `FridaySqliteLayer.withReadConnection`/`withWriteTransaction`.

- `FridayMarketplaceSourceRepository`: `insertSource`, `getSourceById`, `listSources`, `updateSource`, `setEnabled`, `deleteSource` (delete cache first, then source).
- `FridayMarketplaceCacheRepository`: `upsertCacheEntry`, `upsertCacheBatch`, `getCachedVersion`, `listCatalog`, `listStaleSourceIds`, `deleteBySourceId`, `pruneOlderThan`.
- `FridaySkillRepository`: `upsertSkillFromMarketplace`, `updateLifecycleStatus`, `setInstalledVersion`, `clearInstalledVersion`, `getSkillById`, `listInstalled`.
- `FridaySkillVersionRepository`: `upsertVersion`, `getVersion`, `listVersions`, `listVersionsForResolution`, `markYanked`, `clearYanked`, `setSignatureFields`.
- `FridaySkillInstallationRepository`: `insertInstallation`, `setInstallationStatus`, `setInstallationError`, `listBySkill`, `listInstalledHistory`, `listBySatelliteAndStatus`.

**4. Services**
- `FridayMarketplaceSourceService`: add/remove/enable/disable/update/list marketplace sources.
- `FridayMarketplaceHttpClient`: fetch `/index.json`, `/manifest.json`, `/signature.json`, `/package.tgz`, `/keys/:keyId` with timeout and typed parse.
- `FridayMarketplaceSyncService`: refresh enabled sources, upsert `skills`, `skill_versions`, `marketplace_cache`, compute trust scores.
- `FridayMarketplaceCacheService`: TTL checks, stale handling, prune policy.
- `FridayMarketplaceDiscoveryService`: search/browse/filter catalog from cache + skills table, pagination.
- `FridaySkillSignatureVerifier`: checksum + signature verification for Ed25519/RSA.
- `FridaySkillTrustScoringService`: deterministic trust score + policy decision.
- `FridaySkillVersionResolutionService`: install/upgrade/rollback target selection using `semver`.
- `FridaySkillPermissionCheckService`: required permission grant validation against manifest.
- `FridaySkillPackageInstaller`: stage, extract, atomic move to managed skill root.
- `FridaySkillInstallationService`: orchestrates pipeline and writes `skill_installations`, updates skill lifecycle/version state.

**5. Signature Verification Algorithm**
1. Download package bytes from resolved `packageUrl`.
2. Compute `sha256(packageBytes)` with `node:crypto`.
3. Compare digest to `skill_versions.checksum`; fail hard on mismatch.
4. Build canonical payload string:
   `friday-skill-signature-v1\n${skillId}\n${version}\n${checksumHex}`.
5. Fetch signature doc and key doc (`/skills/:id/versions/:version/signature.json`, `/keys/:keyId`).
6. Enforce key pinning from `marketplace_sources.pinned_key_ids_json`.
7. Verify by algorithm:
   - `ed25519`: `verify(null, payloadBuffer, publicKey, signatureBuffer)`
   - `rsa-sha256`: `verify("sha256", payloadBuffer, { key, padding: RSA_PKCS1_PADDING }, sig)`
   - `rsa-pss-sha256`: `verify("sha256", payloadBuffer, { key, padding: RSA_PKCS1_PSS_PADDING, saltLength: 32 }, sig)`
8. Return `FridaySignatureVerificationResult` with `checks[]`.
9. Policy gate:
   - `strict`: block if missing/invalid signature or pin mismatch.
   - `warn`: allow with warning only if integrity passes and trust threshold met.
   - `permissive`: allow if integrity passes; never allow explicit signature mismatch.

**6. Trust Scoring Model**
Store final score in `marketplace_cache.trust_score` (0-100), with component breakdown:
- Signature validity: `0` or `40`
- Integrity/checksum validity: `0` or `15`
- Key pinning: `0`, `10`, or `20`
- Source trust policy baseline: `strict=15`, `warn=10`, `permissive=5`
- Publisher reputation: `0..10` from historical successful installs (`skill_installations` + `skills.publisher`)
- Freshness: `0..10` from `indexed_at` age vs TTL

Decision thresholds:
- `strict`: require score `>=85` and valid signature/integrity
- `warn`: require score `>=70`; emit warning when `<85`
- `permissive`: require score `>=55`; still reject tamper/signature-fraud

**7. Installation Pipeline**
1. Resolve source + version (`install`, `upgrade`, `rollback`) via `FridaySkillVersionResolutionService`.
2. Insert one `skill_installations` row per target (`status="installing"`).
3. Download package and signature artifacts once (hub-side).
4. Run integrity + signature verification.
5. Compute trust score and enforce source policy.
6. Load/validate manifest via existing manifest validation pipeline.
7. Run permission check against `grantPermissions`.
8. Upsert `skills` and `skill_versions` metadata.
9. Stage/extract package into managed dir (`managedSkillsDir/<skillId>/<version>`), atomic activate.
10. Update `skills.installed_version`, `skills.status`, `skills.current_manifest_json`.
11. Mark installation rows `installed`; on failures mark `failed` + `last_error`.
12. Trigger registry refresh so installed managed skill becomes discoverable immediately.
13. Upgrade uses same pipeline with `strategy="upgrade"`.
14. Rollback resolves previous successful version from `skill_installations` history and re-runs install pipeline.

**8. Cache Strategy**
- Cache table is authoritative local manifest index: `marketplace_cache`.
- TTL policy (configurable): `fresh=6h`, `stale-serve=24h`, `prune=30d`.
- Discovery reads enabled sources only and prefers fresh rows.
- If only stale rows exist, return stale results with flag and enqueue async refresh.
- Sync upserts `(source_id, skill_id, version)` rows using existing unique constraint.
- Disabled sources are skipped for sync/discovery but retained.
- Removed source flow: delete cache rows for source, then delete source row.
- Prune job removes old cache rows not tied to installed versions.
- No schema change, no migration, no new dependency.

**9. Runtime Compositor**
Create `createFridaySkillMarketplaceRuntime` in `src/skills/runtime/friday-skill-marketplace-runtime.ts`:
- Inputs: `db: FridaySqliteLayer`, `idGenerator`, `nowIso`, `fetchFn`, `managedSkillsDir`, optional `publishEvent`.
- Wires repositories, then services, then sync job.
- Exposes runtime surface in `friday-skill-marketplace-runtime.types.ts`:
  - `sources`
  - `discovery`
  - `cache`
  - `sync`
  - `versions`
  - `installations`
  - `verify`
  - `trust`
  - `syncJob`
- Integrates with existing composition pattern used by `createFridayWorkflowRuntime` and `createFridaySatelliteRuntime`.

**10. Unit Test Plan (Files + Cases)**
- `test/skills/persistence/friday-marketplace-source-repository.test.ts`: create/list/update/enable/disable/delete source; pinned keys JSON round-trip.
- `test/skills/persistence/friday-marketplace-cache-repository.test.ts`: upsert conflict updates, list filters, stale detection, prune behavior.
- `test/skills/persistence/friday-skill-version-repository.test.ts`: upsert/get/list, yanked mark/clear, signature field persistence.
- `test/skills/persistence/friday-skill-installation-repository.test.ts`: insert/status transitions/error recording/history retrieval.
- `test/skills/services/friday-skill-signature-verifier.test.ts`: Ed25519 valid/invalid, RSA PKCS#1 valid/invalid, RSA-PSS valid/invalid, pin mismatch.
- `test/skills/services/friday-skill-trust-scoring-service.test.ts`: score component math, threshold decisions per trust policy.
- `test/skills/services/friday-skill-version-resolution-service.test.ts`: exact version install, semver range select, upgrade selection, rollback selection, yanked exclusion.
- `test/skills/services/friday-marketplace-sync-service.test.ts`: enabled source sync success, partial source failure isolation, disabled source skip, DB upsert correctness.
- `test/skills/services/friday-marketplace-discovery-service.test.ts`: q/category/source filters, pagination cursor, stale fallback behavior.
- `test/skills/services/friday-skill-installation-service.test.ts`: full happy-path install, checksum fail, signature fail, permission deny, rollback success.
- `test/jobs/marketplace/friday-marketplace-sync-job.test.ts`: interval + jitter scheduling, runOnce execution, error backoff.
- `test/skills/runtime/friday-skill-marketplace-runtime.test.ts`: compositor wiring and dependency injection.
- `test/skills/integration/friday-marketplace-installation.integration.test.ts`: end-to-end download→verify→install against fixture HTTP registry and in-memory SQLite with V001 migration.