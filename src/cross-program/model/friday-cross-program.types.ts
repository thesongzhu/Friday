/**
 * Cross-Program Launch Readiness — Domain Model and Data Contract.
 *
 * Canonical types for Friday's cross-cutting launch readiness concerns:
 * product positioning & pricing (FRI-PLAT-901), data governance (FRI-PLAT-902),
 * developer platform (FRI-PLAT-903), and ecosystem program (FRI-PLAT-904).
 *
 * @module cross-program/model
 */

// ─── Foundational Value Types (local; mirrors packaging/marketplace/observability pattern) ───

/** UUID string identifier. */
export type UUID = string;

/** ISO 8601 date-time string. */
export type ISODateTime = string;

/** JSON-safe primitive value. */
export type JsonPrimitive = string | number | boolean | null;

/** Recursive JSON-safe value. */
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

/** JSON-safe object. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

// ═══════════════════════════════════════════════════════════════════════
// FRI-PLAT-901: PRODUCT POSITIONING & PRICING
// ═══════════════════════════════════════════════════════════════════════

// ─── Product Tiers ───

/**
 * Product tier keys.
 */
export const FRIDAY_PRODUCT_TIERS = [
  "free",
  "builder",
  "operator",
  "creator",
  "enterprise",
] as const;

/** Product tier union type. */
export type FridayProductTier = (typeof FRIDAY_PRODUCT_TIERS)[number];

/**
 * Seat model for a product tier.
 */
export const FRIDAY_SEAT_MODELS = [
  "single",
  "per_seat",
  "custom",
] as const;

/** Seat model union type. */
export type FridaySeatModel = (typeof FRIDAY_SEAT_MODELS)[number];

/**
 * A product tier definition.
 */
export interface FridayProductTierDefinition {
  /** Unique tier record identifier. */
  readonly id: UUID;
  /** Tier key (e.g. 'free', 'builder'). */
  readonly tierKey: FridayProductTier;
  /** Human-readable tier name. */
  readonly name: string;
  /** Tier description. */
  readonly description: string;
  /** Seat model for this tier. */
  readonly seatModel: FridaySeatModel;
  /** Whether this tier is currently active for new subscriptions. */
  readonly isActive: boolean;
  /** Display sort order. */
  readonly sortOrder: number;
  /** When this tier was created. */
  readonly createdAt: ISODateTime;
  /** When this tier was last updated. */
  readonly updatedAt: ISODateTime;
}

// ─── Feature Gates ───

/**
 * Value types for feature gates.
 */
export const FRIDAY_FEATURE_GATE_VALUE_TYPES = [
  "boolean",
  "numeric",
  "enum",
] as const;

/** Feature gate value type union. */
export type FridayFeatureGateValueType =
  (typeof FRIDAY_FEATURE_GATE_VALUE_TYPES)[number];

// ─── Typed Feature Gate Values (XPR-FIX-01) ───

/** A boolean gate value. */
export interface FridayGateValueBoolean {
  readonly valueType: "boolean";
  readonly value: boolean;
}

/** A numeric gate value. `null` value = unlimited; `isCustom` = enterprise-configurable limit. */
export interface FridayGateValueNumeric {
  readonly valueType: "numeric";
  /** Numeric limit. `null` represents an unlimited entitlement. */
  readonly value: number | null;
  /** When true, the limit is enterprise-configurable (custom negotiation). */
  readonly isCustom: boolean;
}

/** An enum gate value. */
export interface FridayGateValueEnum {
  readonly valueType: "enum";
  readonly value: string;
}

/** Discriminated union of typed gate values, keyed by `valueType`. */
export type FridayGateValue =
  | FridayGateValueBoolean
  | FridayGateValueNumeric
  | FridayGateValueEnum;

// ─── Typed Overage Rate Values (XPR-FIX-01) ───

/** No overage — used with hard_block and soft_warn policies. */
export interface FridayOverageRateNone {
  readonly overagePolicy: "hard_block" | "soft_warn";
}

/** Overage billing rate — used with overage_billing policy. */
export interface FridayOverageRateBilling {
  readonly overagePolicy: "overage_billing";
  /** Rate per unit above the limit. */
  readonly ratePerUnit: number;
  /** Currency code (e.g. 'USD'). */
  readonly currency: string;
}

/** Discriminated union of overage rate values, keyed by `overagePolicy`. */
export type FridayOverageRate =
  | FridayOverageRateNone
  | FridayOverageRateBilling;

/** Common fields shared by all feature gate variants. */
export interface FridayFeatureGateBase {
  /** Unique gate record identifier. */
  readonly id: UUID;
  /** Gate key (e.g. 'agent.create', 'workspace.count'). */
  readonly gateKey: string;
  /** Human-readable gate name. */
  readonly name: string;
  /** Gate description. */
  readonly description: string;
  /** When this gate was created. */
  readonly createdAt: ISODateTime;
  /** When this gate was last updated. */
  readonly updatedAt: ISODateTime;
}

/** A boolean feature gate (on/off capabilities). */
export interface FridayBooleanFeatureGate extends FridayFeatureGateBase {
  readonly valueType: "boolean";
  readonly defaultValue: FridayGateValueBoolean;
}

/** A numeric feature gate (quantity-limited capabilities). */
export interface FridayNumericFeatureGate extends FridayFeatureGateBase {
  readonly valueType: "numeric";
  readonly defaultValue: FridayGateValueNumeric;
}

/** An enum feature gate (string-keyed capability variants). */
export interface FridayEnumFeatureGate extends FridayFeatureGateBase {
  readonly valueType: "enum";
  readonly defaultValue: FridayGateValueEnum;
}

/**
 * A feature gate definition (discriminated union keyed by `valueType`).
 *
 * Feature gates control access to platform capabilities.
 * Each gate has a unique key (e.g. 'agent.create', 'workspace.count')
 * and a value type determining how entitlements are evaluated.
 * The `valueType` discriminant ensures `defaultValue` is type-linked.
 */
export type FridayFeatureGate =
  | FridayBooleanFeatureGate
  | FridayNumericFeatureGate
  | FridayEnumFeatureGate;

/**
 * A feature entitlement: the value of a gate for a specific tier.
 */
export interface FridayFeatureEntitlement {
  /** Unique entitlement record identifier. */
  readonly id: UUID;
  /** Feature gate ID. */
  readonly gateId: UUID;
  /** Product tier ID. */
  readonly tierId: UUID;
  /** Typed entitlement value. */
  readonly value: FridayGateValue;
  /** When this entitlement was created. */
  readonly createdAt: ISODateTime;
  /** When this entitlement was last updated. */
  readonly updatedAt: ISODateTime;
}

/**
 * A tenant-level entitlement override (for Enterprise custom limits).
 */
export interface FridayFeatureEntitlementOverride {
  /** Unique override record identifier. */
  readonly id: UUID;
  /** Feature gate ID. */
  readonly gateId: UUID;
  /** Tenant ID this override applies to. */
  readonly tenantId: string;
  /** Typed override value. */
  readonly value: FridayGateValue;
  /** Reason for the override. */
  readonly reason?: string;
  /** Principal who granted this override. */
  readonly grantedBy: string;
  /** When this override expires (null for permanent). */
  readonly expiresAt?: ISODateTime;
  /** When this override was created. */
  readonly createdAt: ISODateTime;
  /** When this override was last updated. */
  readonly updatedAt: ISODateTime;
}

// ─── Usage Metering ───

/**
 * Usage meter unit types.
 */
export const FRIDAY_USAGE_METER_UNITS = [
  "count",
  "bytes",
  "milliseconds",
] as const;

/** Usage meter unit union type. */
export type FridayUsageMeterUnit = (typeof FRIDAY_USAGE_METER_UNITS)[number];

/**
 * Aggregation methods for usage meters.
 */
export const FRIDAY_USAGE_AGGREGATIONS = [
  "sum",
  "max",
  "avg",
] as const;

/** Usage aggregation union type. */
export type FridayUsageAggregation = (typeof FRIDAY_USAGE_AGGREGATIONS)[number];

/**
 * Reset intervals for usage meters.
 */
export const FRIDAY_USAGE_RESET_INTERVALS = [
  "hourly",
  "daily",
  "monthly",
  "billing_period",
] as const;

/** Usage reset interval union type. */
export type FridayUsageResetInterval = (typeof FRIDAY_USAGE_RESET_INTERVALS)[number];

/**
 * A usage meter definition.
 *
 * Usage meters track billing-relevant consumption metrics.
 */
export interface FridayUsageMeter {
  /** Unique meter record identifier. */
  readonly id: UUID;
  /** Meter key (e.g. 'agent.runs', 'api.requests'). */
  readonly meterKey: string;
  /** Human-readable meter name. */
  readonly name: string;
  /** Meter description. */
  readonly description: string;
  /** Unit of measurement. */
  readonly unit: FridayUsageMeterUnit;
  /** Aggregation method. */
  readonly aggregation: FridayUsageAggregation;
  /** Reset interval for usage counters. */
  readonly resetInterval: FridayUsageResetInterval;
  /** When this meter was created. */
  readonly createdAt: ISODateTime;
  /** When this meter was last updated. */
  readonly updatedAt: ISODateTime;
}

/**
 * Overage policies for usage quotas.
 */
export const FRIDAY_OVERAGE_POLICIES = [
  "hard_block",
  "soft_warn",
  "overage_billing",
] as const;

/** Overage policy union type. */
export type FridayOveragePolicy = (typeof FRIDAY_OVERAGE_POLICIES)[number];

/**
 * A usage quota: the limit for a meter at a specific tier.
 */
export interface FridayUsageQuota {
  /** Unique quota record identifier. */
  readonly id: UUID;
  /** Usage meter ID. */
  readonly meterId: UUID;
  /** Product tier ID. */
  readonly tierId: UUID;
  /** Limit value (null = unlimited). */
  readonly limitValue: number | null;
  /** Overage policy and rate (discriminated by `overagePolicy`). */
  readonly overage: FridayOverageRate;
  /** When this quota was created. */
  readonly createdAt: ISODateTime;
  /** When this quota was last updated. */
  readonly updatedAt: ISODateTime;
}

/**
 * A usage record: a single metered event.
 */
export interface FridayUsageRecord {
  /** Unique record identifier. */
  readonly id: UUID;
  /** Usage meter ID. */
  readonly meterId: UUID;
  /** Tenant that generated this usage. */
  readonly tenantId: string;
  /** Measured value. */
  readonly value: number;
  /** When this usage was recorded. */
  readonly recordedAt: ISODateTime;
  /** Period key for aggregation (e.g. '2026-02' for monthly). */
  readonly periodKey: string;
  /** Source module that emitted this record. */
  readonly source: string;
  /** Additional context metadata (JSON). */
  readonly metadata?: JsonObject;
  /** When this record was created. */
  readonly createdAt: ISODateTime;
}

// ─── Pricing Models ───

/**
 * Pricing model types.
 */
export const FRIDAY_PRICING_MODEL_TYPES = [
  "flat_rate",
  "per_seat",
  "usage_based",
  "hybrid",
] as const;

/** Pricing model type union. */
export type FridayPricingModelType = (typeof FRIDAY_PRICING_MODEL_TYPES)[number];

/**
 * Billing intervals for pricing models.
 */
export const FRIDAY_BILLING_INTERVALS = [
  "monthly",
  "annual",
] as const;

/** Billing interval union type. */
export type FridayBillingInterval = (typeof FRIDAY_BILLING_INTERVALS)[number];

/** Common fields shared by all pricing model variants. */
export interface FridayPricingModelBase {
  /** Unique pricing model record identifier. */
  readonly id: UUID;
  /** Product tier this model applies to. */
  readonly tierId: UUID;
  /** Base price per billing interval (in minor units, e.g. cents). */
  readonly basePrice: number;
  /** Currency code (e.g. 'USD'). */
  readonly currency: string;
  /** Billing interval. */
  readonly billingInterval: FridayBillingInterval;
  /** Whether this pricing model is currently active. */
  readonly isActive: boolean;
  /** When this pricing model was created. */
  readonly createdAt: ISODateTime;
  /** When this pricing model was last updated. */
  readonly updatedAt: ISODateTime;
}

/** Flat-rate pricing model — no usage meter. */
export interface FridayFlatRatePricingModel extends FridayPricingModelBase {
  readonly modelType: "flat_rate";
  readonly meterId?: never;
}

/** Per-seat pricing model — no usage meter. */
export interface FridayPerSeatPricingModel extends FridayPricingModelBase {
  readonly modelType: "per_seat";
  readonly meterId?: never;
}

/** Usage-based pricing model — requires a usage meter. */
export interface FridayUsageBasedPricingModel extends FridayPricingModelBase {
  readonly modelType: "usage_based";
  /** Usage meter ID (required for usage-based billing). */
  readonly meterId: UUID;
}

/** Hybrid pricing model — base seat price + usage overage; requires a usage meter. */
export interface FridayHybridPricingModel extends FridayPricingModelBase {
  readonly modelType: "hybrid";
  /** Usage meter ID (required for hybrid billing). */
  readonly meterId: UUID;
}

/**
 * A pricing model definition (discriminated union keyed by `modelType`).
 *
 * Pricing models define how a product tier is billed. The `modelType`
 * discriminant determines whether `meterId` is required:
 * - `flat_rate` / `per_seat` → no meter (meterId absent)
 * - `usage_based` / `hybrid` → meter required (meterId: UUID)
 */
export type FridayPricingModel =
  | FridayFlatRatePricingModel
  | FridayPerSeatPricingModel
  | FridayUsageBasedPricingModel
  | FridayHybridPricingModel;

// ═══════════════════════════════════════════════════════════════════════
// FRI-PLAT-902: DATA GOVERNANCE
// ═══════════════════════════════════════════════════════════════════════

// ─── Retention Policies ───

/**
 * Retention actions.
 */
export const FRIDAY_RETENTION_ACTIONS = [
  "soft_delete",
  "hard_delete",
  "archive",
  "audit_only",
] as const;

/** Retention action union type. */
export type FridayRetentionAction = (typeof FRIDAY_RETENTION_ACTIONS)[number];

/**
 * A data retention policy for a specific object type.
 *
 * Policies are scoped per tenant (with platform defaults when tenantId is null).
 */
export interface FridayRetentionPolicy {
  /** Unique policy record identifier. */
  readonly id: UUID;
  /** Object type this policy applies to (e.g. 'audit_entry', 'trace_span'). */
  readonly objectType: string;
  /** Tenant ID (null = platform default). */
  readonly tenantId: string | null;
  /** Number of days to retain data. */
  readonly retentionDays: number;
  /** Minimum allowed retention days. */
  readonly minDays: number;
  /** Maximum allowed retention days. */
  readonly maxDays: number;
  /** Action taken when retention expires. */
  readonly action: FridayRetentionAction;
  /** Whether the tenant can configure this policy. */
  readonly isConfigurable: boolean;
  /** Storage region for future regional storage support. */
  readonly storageRegion?: string;
  /** Data residency requirement (e.g. 'none', 'country', 'region', 'custom'). Phase 2 regional governance. */
  readonly dataResidencyRequirement?: string;
  /** Allowed regions for data storage. Phase 2 regional governance. */
  readonly allowedRegions?: readonly string[];
  /** When this policy was created. */
  readonly createdAt: ISODateTime;
  /** When this policy was last updated. */
  readonly updatedAt: ISODateTime;
}

/**
 * A retention rule: a specific condition within a policy.
 *
 * Rules allow fine-grained retention overrides based on object metadata.
 */
export interface FridayRetentionRule {
  /** Unique rule record identifier. */
  readonly id: UUID;
  /** Parent retention policy ID. */
  readonly policyId: UUID;
  /** Human-readable rule name. */
  readonly name: string;
  /** JSON expression evaluated against object metadata. */
  readonly condition: string;
  /** Override retention days (null = use policy default). */
  readonly overrideDays: number | null;
  /** Rule evaluation priority (higher = evaluated first). */
  readonly priority: number;
  /** When this rule was created. */
  readonly createdAt: ISODateTime;
  /** When this rule was last updated. */
  readonly updatedAt: ISODateTime;
}

// ─── Object Lifecycle (XPR-FIX-04) ───

/**
 * Explicit lifecycle phases for all governance-tracked objects.
 */
export const FRIDAY_OBJECT_LIFECYCLE_PHASES = [
  "active",
  "soft_deleted",
  "hard_deleted",
  "audit_only",
] as const;

/** Object lifecycle phase union type. */
export type FridayObjectLifecyclePhase =
  (typeof FRIDAY_OBJECT_LIFECYCLE_PHASES)[number];

/**
 * Tombstone-specific lifecycle phases.
 *
 * Tombstones only exist after hard deletion, so they are constrained
 * to `hard_deleted` (data purged, tombstone active) or `audit_only`
 * (metadata-only retention for compliance). See RFC §5.2.
 */
export type FridayTombstonePhase = "hard_deleted" | "audit_only";

// ─── Deletion Lifecycle ───

/**
 * Deletion request states.
 */
export const FRIDAY_DELETION_STATES = [
  "pending",
  "processing",
  "completed",
  "failed",
  "cancelled",
] as const;

/** Deletion state union type. */
export type FridayDeletionState = (typeof FRIDAY_DELETION_STATES)[number];

/**
 * Valid deletion state transitions.
 */
export const FRIDAY_DELETION_STATE_TRANSITIONS: Readonly<
  Record<FridayDeletionState, readonly FridayDeletionState[]>
> = {
  pending: ["processing", "cancelled"],
  processing: ["completed", "failed"],
  completed: [],
  failed: ["pending"],
  cancelled: [],
} as const;

/**
 * A deletion request tracking the lifecycle of a data deletion.
 */
export interface FridayDeletionRequest {
  /** Unique request record identifier. */
  readonly id: UUID;
  /** Type of object being deleted. */
  readonly objectType: string;
  /** ID of the object being deleted. */
  readonly objectId: string;
  /** Tenant that owns the object. */
  readonly tenantId: string;
  /** Current deletion state. */
  readonly state: FridayDeletionState;
  /** Reason for deletion. */
  readonly reason: string;
  /** Principal who requested the deletion. */
  readonly requestedBy: string;
  /** Parent request ID (for bulk cascade deletions). */
  readonly parentRequest?: UUID;
  /** When the hard delete should execute. */
  readonly scheduledAt: ISODateTime;
  /** When processing started. */
  readonly startedAt?: ISODateTime;
  /** When processing completed. */
  readonly completedAt?: ISODateTime;
  /** Error message if failed. */
  readonly errorMessage?: string;
  /** Region where the object resides. Phase 2 regional governance. */
  readonly region?: string;
  /** When this request was created. */
  readonly createdAt: ISODateTime;
  /** When this request was last updated. */
  readonly updatedAt: ISODateTime;
}

// ─── Deletion Tombstones (XPR-FIX-04) ───

/**
 * A deletion tombstone: compliance-grade evidence that an object was deleted.
 *
 * Created when an object transitions from soft-deleted to hard-deleted.
 * The tombstone retains only the fact of deletion (no original data)
 * and is kept for the audit retention period.
 */
export interface FridayDeletionTombstone {
  /** Unique tombstone record identifier. */
  readonly id: UUID;
  /** Type of the deleted object. */
  readonly objectType: string;
  /** ID of the deleted object. */
  readonly objectId: string;
  /** Tenant that owned the object. */
  readonly tenantId: string;
  /** Current lifecycle phase of this tombstone (`hard_deleted` or `audit_only` only). */
  readonly lifecyclePhase: FridayTombstonePhase;
  /** ID of the deletion request that caused this tombstone. */
  readonly deletionRequestId: UUID;
  /** Principal who initiated the deletion. */
  readonly deletedBy: string;
  /** When the soft delete occurred. */
  readonly softDeletedAt: ISODateTime;
  /** When the hard delete (data purge) occurred. */
  readonly hardDeletedAt: ISODateTime;
  /** When this tombstone transitions to audit-only (metadata-only retention). */
  readonly auditOnlyAt?: ISODateTime;
  /** When this tombstone record was created. */
  readonly createdAt: ISODateTime;
}

// ─── Audit Export ───

/**
 * Supported audit export formats.
 */
export const FRIDAY_AUDIT_EXPORT_FORMATS = [
  "json_lines",
  "csv",
  "parquet",
] as const;

/** Audit export format union type. */
export type FridayAuditExportFormat = (typeof FRIDAY_AUDIT_EXPORT_FORMATS)[number];

/**
 * Audit export states.
 */
export const FRIDAY_AUDIT_EXPORT_STATES = [
  "pending",
  "running",
  "completed",
  "failed",
] as const;

/** Audit export state union type. */
export type FridayAuditExportState = (typeof FRIDAY_AUDIT_EXPORT_STATES)[number];

/**
 * Scope definition for an audit export.
 */
export interface FridayAuditExportScope {
  /** Start date (inclusive) for the export. */
  readonly startDate?: ISODateTime;
  /** End date (exclusive) for the export. */
  readonly endDate?: ISODateTime;
  /** Object types to include (empty = all). */
  readonly objectTypes?: readonly string[];
  /** Principal IDs to include (empty = all). */
  readonly principalIds?: readonly string[];
  /** Include deletion tombstone records in the export. Defaults to true. */
  readonly includeTombstones?: boolean;
}

/**
 * An audit export request/record.
 */
export interface FridayAuditExport {
  /** Unique export record identifier. */
  readonly id: UUID;
  /** Tenant requesting the export. */
  readonly tenantId: string;
  /** Export format. */
  readonly format: FridayAuditExportFormat;
  /** Export scope (date range, object types, principals). */
  readonly scope: FridayAuditExportScope;
  /** Cron schedule expression (null = on-demand). */
  readonly schedule?: string;
  /** Public key for encrypted export (null = unencrypted). */
  readonly encryptionKey?: string;
  /** Current export state. */
  readonly state: FridayAuditExportState;
  /** Output file path. */
  readonly outputPath?: string;
  /** Number of records in the export. */
  readonly recordCount?: number;
  /** Export file size in bytes. */
  readonly fileSizeBytes?: number;
  /** When export processing started. */
  readonly startedAt?: ISODateTime;
  /** When export processing completed. */
  readonly completedAt?: ISODateTime;
  /** Error message if failed. */
  readonly errorMessage?: string;
  /** Principal who requested the export. */
  readonly requestedBy: string;
  /** When this export was created. */
  readonly createdAt: ISODateTime;
  /** When this export was last updated. */
  readonly updatedAt: ISODateTime;
}

// ─── Compliance Frameworks ───

/**
 * Supported compliance framework identifiers.
 */
export const FRIDAY_COMPLIANCE_FRAMEWORKS = [
  "gdpr",
  "ccpa",
  "hipaa",
  "sox",
] as const;

/** Compliance framework union type. */
export type FridayComplianceFrameworkType =
  (typeof FRIDAY_COMPLIANCE_FRAMEWORKS)[number];

/**
 * Evidence types for compliance mappings.
 */
export const FRIDAY_COMPLIANCE_EVIDENCE_TYPES = [
  "automated",
  "manual",
  "audit_trail",
] as const;

/** Compliance evidence type union type. */
export type FridayComplianceEvidenceType =
  (typeof FRIDAY_COMPLIANCE_EVIDENCE_TYPES)[number];

/**
 * A compliance framework definition.
 */
export interface FridayComplianceFramework {
  /** Unique framework record identifier. */
  readonly id: UUID;
  /** Framework identifier (e.g. 'gdpr', 'ccpa'). */
  readonly framework: FridayComplianceFrameworkType;
  /** Framework version. */
  readonly version: string;
  /** Whether this framework version is active. */
  readonly isActive: boolean;
  /** When this framework was created. */
  readonly createdAt: ISODateTime;
  /** When this framework was last updated. */
  readonly updatedAt: ISODateTime;
}

/**
 * A mapping from a compliance requirement to a Friday capability.
 */
export interface FridayComplianceMapping {
  /** Unique mapping record identifier. */
  readonly id: UUID;
  /** Parent compliance framework ID. */
  readonly frameworkId: UUID;
  /** Regulation article/section reference (e.g. 'Art. 17', '§1798.105'). */
  readonly article: string;
  /** Human-readable requirement description. */
  readonly requirement: string;
  /** Friday capability that satisfies this requirement. */
  readonly capability: string;
  /** Owning module. */
  readonly module: string;
  /** Type of evidence required. */
  readonly evidenceType: FridayComplianceEvidenceType;
  /** Additional notes. */
  readonly notes?: string;
  /** When this mapping was created. */
  readonly createdAt: ISODateTime;
  /** When this mapping was last updated. */
  readonly updatedAt: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// FRI-PLAT-903: DEVELOPER PLATFORM
// ═══════════════════════════════════════════════════════════════════════

// ─── Package Templates ───

/**
 * Template categories for package scaffolding.
 */
export const FRIDAY_TEMPLATE_CATEGORIES = [
  "skill_pack",
  "workflow_pack",
  "full_agent",
  "provider_plugin",
  "starter",
] as const;

/** Template category union type. */
export type FridayTemplateCategory = (typeof FRIDAY_TEMPLATE_CATEGORIES)[number];

/**
 * A variable definition for template placeholder substitution.
 */
export interface FridayTemplateVariable {
  /** Variable key (used in template placeholders). */
  readonly key: string;
  /** Human-readable prompt for the variable. */
  readonly prompt: string;
  /** Default value. */
  readonly defaultValue?: string;
  /** Whether this variable is required. */
  readonly required: boolean;
  /** Validation pattern (regex). */
  readonly pattern?: string;
}

/**
 * A file entry in a template's file tree.
 */
export interface FridayTemplateFile {
  /** Relative file path (may contain template variables). */
  readonly path: string;
  /** File content (with template placeholders). */
  readonly content: string;
  /** Whether this file is executable. */
  readonly executable?: boolean;
}

/**
 * A package template for scaffolding new agent packages.
 */
export interface FridayPackageTemplate {
  /** Unique template record identifier. */
  readonly id: UUID;
  /** Template name (unique). */
  readonly name: string;
  /** Template category. */
  readonly category: FridayTemplateCategory;
  /** Human-readable description. */
  readonly description: string;
  /** Template version. */
  readonly version: string;
  /** Link to PKG registry entry (if published as a package). */
  readonly registryId?: UUID;
  /** Template manifest with placeholders (JSON). */
  readonly manifestJson: string;
  /** Variable definitions for placeholder substitution. */
  readonly variables: readonly FridayTemplateVariable[];
  /** File tree structure. */
  readonly files: readonly FridayTemplateFile[];
  /** Compatible Friday platform version range (aligned with PKG manifest naming). */
  readonly fridayVersionRange: string;
  /** Template author. */
  readonly author: string;
  /** When this template was created. */
  readonly createdAt: ISODateTime;
  /** When this template was last updated. */
  readonly updatedAt: ISODateTime;
}

// ─── Package Testing ───

/**
 * Test categories for package test suites.
 */
export const FRIDAY_PACKAGE_TEST_CATEGORIES = [
  "functional",
  "integration",
  "acceptance",
  "performance",
] as const;

/** Test category union type. */
export type FridayPackageTestCategory =
  (typeof FRIDAY_PACKAGE_TEST_CATEGORIES)[number];

/**
 * Test result statuses.
 */
export const FRIDAY_PACKAGE_TEST_STATUSES = [
  "pass",
  "fail",
  "error",
  "skip",
] as const;

/** Test result status union type. */
export type FridayPackageTestStatus =
  (typeof FRIDAY_PACKAGE_TEST_STATUSES)[number];

/**
 * A single test definition within a test suite.
 */
export interface FridayPackageTestDefinition {
  /** Test identifier (unique within suite). */
  readonly testId: string;
  /** Human-readable test name. */
  readonly name: string;
  /** Test category. */
  readonly category: FridayPackageTestCategory;
  /** Timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Test input data (JSON). */
  readonly inputs: JsonObject;
  /** Expected output patterns (JSON, partial match). */
  readonly expectedOutputs?: JsonObject;
  /** Assertion rules (JSON). */
  readonly assertions: readonly JsonObject[];
}

/**
 * A package test suite.
 */
export interface FridayPackageTestSuite {
  /** Unique suite record identifier. */
  readonly id: UUID;
  /** Package name under test. */
  readonly packageName: string;
  /** Package version under test. */
  readonly packageVersion: string;
  /** Suite name. */
  readonly suiteName: string;
  /** Test definitions. */
  readonly tests: readonly FridayPackageTestDefinition[];
  /** Overall suite timeout in milliseconds. */
  readonly timeoutMs: number;
  /** When this suite was created. */
  readonly createdAt: ISODateTime;
  /** When this suite was last updated. */
  readonly updatedAt: ISODateTime;
}

// ─── ACC-Compatible Test Result (XPR-FIX-02) ───

/**
 * Acceptance verdict outcome (mirrors ACC module's FridayAcceptanceVerdictOutcome).
 */
export type FridayXprAcceptanceVerdictOutcome = "pass" | "fail" | "warn";

/**
 * Acceptance verdict severity (mirrors ACC module's FridayAcceptanceSeverity).
 */
export type FridayXprAcceptanceSeverity = "critical" | "major" | "minor" | "info";

/**
 * Acceptance verdict carried on acceptance-category test results.
 * Lossless representation of ACC module verdicts within XPR.
 */
export interface FridayXprAcceptanceVerdict {
  /** Outcome of the acceptance check (pass, fail, or warn). */
  readonly verdict: FridayXprAcceptanceVerdictOutcome;
  /** Severity of the finding. */
  readonly severity: FridayXprAcceptanceSeverity;
  /** Evidence chain supporting the verdict. */
  readonly evidence: readonly JsonObject[];
}

/** Common fields shared by all test result variants. */
export interface FridayPackageTestResultBase {
  /** Unique result record identifier. */
  readonly id: UUID;
  /** Parent test suite ID. */
  readonly suiteId: UUID;
  /** Test name (from the definition). */
  readonly testName: string;
  /** Result status. */
  readonly status: FridayPackageTestStatus;
  /** Execution duration in milliseconds. */
  readonly durationMs: number;
  /** Human-readable result message. */
  readonly message?: string;
  /** Structured evidence (assertions, outputs). */
  readonly evidence?: JsonObject;
  /** When this test was executed. */
  readonly executedAt: ISODateTime;
  /** When this result was created. */
  readonly createdAt: ISODateTime;
}

/** Test result for acceptance-category tests — carries a full verdict. */
export interface FridayPackageTestResultAcceptance extends FridayPackageTestResultBase {
  readonly category: "acceptance";
  /** Full acceptance verdict with outcome, severity, and evidence. */
  readonly acceptanceVerdict: FridayXprAcceptanceVerdict;
}

/** Test result for non-acceptance categories (functional, integration, performance). */
export interface FridayPackageTestResultStandard extends FridayPackageTestResultBase {
  readonly category: Exclude<FridayPackageTestCategory, "acceptance">;
}

/**
 * A test result for a single test execution.
 *
 * Discriminated union keyed by `category`. When `category` is `"acceptance"`,
 * the result carries a `FridayXprAcceptanceVerdict` for lossless ACC→XPR compat.
 */
export type FridayPackageTestResult =
  | FridayPackageTestResultAcceptance
  | FridayPackageTestResultStandard;

// ─── Reference Packages ───

/**
 * A reference package entry for developer guidance.
 */
export interface FridayReferencePackage {
  /** Unique reference package record identifier. */
  readonly id: UUID;
  /** Reference package name (unique). */
  readonly name: string;
  /** Human-readable description. */
  readonly description: string;
  /** What this reference package demonstrates. */
  readonly demonstrates: string;
  /** Link to PKG registry entry. */
  readonly registryId?: UUID;
  /** Source code URL. */
  readonly sourceUrl?: string;
  /** When this reference package was created. */
  readonly createdAt: ISODateTime;
  /** When this reference package was last updated. */
  readonly updatedAt: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// FRI-PLAT-904: ECOSYSTEM PROGRAM
// ═══════════════════════════════════════════════════════════════════════

// ─── Creator Onboarding ───

/**
 * Onboarding states.
 */
export const FRIDAY_ONBOARDING_STATES = [
  "not_started",
  "in_progress",
  "completed",
  "blocked",
  "expired",
] as const;

/** Onboarding state union type. */
export type FridayOnboardingState = (typeof FRIDAY_ONBOARDING_STATES)[number];

/**
 * Onboarding step keys.
 */
export const FRIDAY_ONBOARDING_STEP_KEYS = [
  "register",
  "profile_complete",
  "agreement_signed",
  "identity_verified",
  "first_package",
  "active",
] as const;

/** Onboarding step key union type. */
export type FridayOnboardingStepKey = (typeof FRIDAY_ONBOARDING_STEP_KEYS)[number];

/**
 * An onboarding step within a creator onboarding flow.
 */
export interface FridayOnboardingStep {
  /** Unique step record identifier. */
  readonly id: UUID;
  /** Parent onboarding flow ID. */
  readonly onboardingId: UUID;
  /** Step key. */
  readonly stepKey: FridayOnboardingStepKey;
  /** Step order (for sequencing). */
  readonly stepOrder: number;
  /** Current step status. */
  readonly status: FridayOnboardingState;
  /** Step keys that must be completed before this step. */
  readonly prerequisites: readonly FridayOnboardingStepKey[];
  /** Evidence of completion (JSON). */
  readonly evidence?: JsonObject;
  /** Reason for block (if status is 'blocked'). */
  readonly blockerReason?: string;
  /** When this step was started. */
  readonly startedAt?: ISODateTime;
  /** When this step was completed. */
  readonly completedAt?: ISODateTime;
  /** When this step was created. */
  readonly createdAt: ISODateTime;
  /** When this step was last updated. */
  readonly updatedAt: ISODateTime;
}

/**
 * A creator onboarding flow.
 */
export interface FridayCreatorOnboarding {
  /** Unique onboarding record identifier. */
  readonly id: UUID;
  /** Creator (principal) ID. */
  readonly creatorId: string;
  /** Tenant ID. */
  readonly tenantId: string;
  /** Overall onboarding state. */
  readonly state: FridayOnboardingState;
  /** Current step key. */
  readonly currentStep: FridayOnboardingStepKey;
  /** When onboarding was started. */
  readonly startedAt?: ISODateTime;
  /** When onboarding was completed. */
  readonly completedAt?: ISODateTime;
  /** When this onboarding flow expires. */
  readonly expiresAt?: ISODateTime;
  /** When this record was created. */
  readonly createdAt: ISODateTime;
  /** When this record was last updated. */
  readonly updatedAt: ISODateTime;
}

// ─── Certification ───

/**
 * Certification badge levels.
 */
export const FRIDAY_CERTIFICATION_BADGE_LEVELS = [
  "bronze",
  "silver",
  "gold",
] as const;

/** Certification badge level union type. */
export type FridayCertificationBadge =
  (typeof FRIDAY_CERTIFICATION_BADGE_LEVELS)[number];

/**
 * Certification requirement types.
 */
export const FRIDAY_CERTIFICATION_REQUIREMENT_TYPES = [
  "automated",
  "manual",
  "metric",
] as const;

/** Certification requirement type union type. */
export type FridayCertificationRequirementType =
  (typeof FRIDAY_CERTIFICATION_REQUIREMENT_TYPES)[number];

/**
 * A single requirement within a certification rubric category.
 */
export interface FridayCertificationRequirement {
  /** Requirement identifier (unique within category). */
  readonly requirementId: string;
  /** Human-readable requirement name. */
  readonly name: string;
  /** Requirement description. */
  readonly description: string;
  /** How this requirement is evaluated. */
  readonly type: FridayCertificationRequirementType;
  /** Maximum points for this requirement. */
  readonly maxPoints: number;
}

/**
 * A category within a certification rubric.
 */
export interface FridayCertificationCategory {
  /** Category identifier (unique within rubric). */
  readonly categoryId: string;
  /** Category name (e.g. 'Code Quality', 'Security'). */
  readonly name: string;
  /** Weight as a percentage (0–100, all categories sum to 100). */
  readonly weight: number;
  /** Requirements within this category. */
  readonly requirements: readonly FridayCertificationRequirement[];
}

/**
 * Badge threshold definition within a rubric.
 */
export interface FridayCertificationThreshold {
  /** Badge level. */
  readonly badge: FridayCertificationBadge;
  /** Minimum overall score (0–100) required for this badge. */
  readonly minScore: number;
}

/**
 * A certification rubric definition.
 */
export interface FridayCertificationRubric {
  /** Unique rubric record identifier. */
  readonly id: UUID;
  /** Rubric name. */
  readonly name: string;
  /** Rubric version. */
  readonly version: string;
  /** Category definitions with weights and requirements. */
  readonly categories: readonly FridayCertificationCategory[];
  /** Badge thresholds. */
  readonly thresholds: readonly FridayCertificationThreshold[];
  /** Number of days a certification is valid. */
  readonly validityDays: number;
  /** Whether this rubric version is active. */
  readonly isActive: boolean;
  /** When this rubric was created. */
  readonly createdAt: ISODateTime;
  /** When this rubric was last updated. */
  readonly updatedAt: ISODateTime;
}

/**
 * Per-category score within a certification.
 */
export interface FridayCertificationCategoryScore {
  /** Category ID. */
  readonly categoryId: string;
  /** Score achieved (0–100). */
  readonly score: number;
  /** Per-requirement scores. */
  readonly requirementScores: Readonly<Record<string, number>>;
}

/**
 * An issued certification.
 */
export interface FridayCertification {
  /** Unique certification record identifier. */
  readonly id: UUID;
  /** Rubric used for certification. */
  readonly rubricId: UUID;
  /** Certified package name. */
  readonly packageName: string;
  /** Certified package version. */
  readonly packageVersion: string;
  /** Tenant ID. */
  readonly tenantId: string;
  /** Overall weighted score (0–100). */
  readonly overallScore: number;
  /** Per-category scores. */
  readonly categoryScores: readonly FridayCertificationCategoryScore[];
  /** Awarded badge level. */
  readonly badgeLevel: FridayCertificationBadge;
  /** When the certification was issued. */
  readonly issuedAt: ISODateTime;
  /** When the certification expires. */
  readonly expiresAt: ISODateTime;
  /** When the certification was revoked (null if active). */
  readonly revokedAt?: ISODateTime;
  /** Reason for revocation. */
  readonly revocationReason?: string;
  /** Principal or 'system' that issued the certification. */
  readonly certifiedBy: string;
  /** When this record was created. */
  readonly createdAt: ISODateTime;
  /** When this record was last updated. */
  readonly updatedAt: ISODateTime;
}

// ─── Trust Badges ───

/**
 * Trust badge type identifiers.
 */
export const FRIDAY_TRUST_BADGE_TYPES = [
  "verified_creator",
  "certified_package",
  "top_rated",
  "premier_creator",
  "security_audited",
  "official",
] as const;

/** Trust badge type union type. */
export type FridayTrustBadgeType = (typeof FRIDAY_TRUST_BADGE_TYPES)[number];

/**
 * Trust badge subject types.
 */
export const FRIDAY_TRUST_BADGE_SUBJECT_TYPES = [
  "creator",
  "package",
] as const;

/** Trust badge subject type union type. */
export type FridayTrustBadgeSubjectType =
  (typeof FRIDAY_TRUST_BADGE_SUBJECT_TYPES)[number];

/**
 * Trust levels (ordered from lowest to highest).
 */
export const FRIDAY_TRUST_LEVELS = [
  "none",
  "verified",
  "certified",
  "premier",
  "official",
] as const;

/** Trust level union type. */
export type FridayTrustLevel = (typeof FRIDAY_TRUST_LEVELS)[number];

/**
 * A trust badge awarded to a creator or package.
 */
export interface FridayTrustBadge {
  /** Unique badge record identifier. */
  readonly id: UUID;
  /** Badge type. */
  readonly badgeType: FridayTrustBadgeType;
  /** Subject type (creator or package). */
  readonly subjectType: FridayTrustBadgeSubjectType;
  /** Subject ID (creator ID or package name). */
  readonly subjectId: string;
  /** Trust level. */
  readonly trustLevel: FridayTrustLevel;
  /** Criteria that were met to earn this badge. */
  readonly criteria: JsonObject;
  /** When the badge was granted. */
  readonly grantedAt: ISODateTime;
  /** When the badge expires (null for permanent). */
  readonly expiresAt?: ISODateTime;
  /** When the badge was revoked (null if active). */
  readonly revokedAt?: ISODateTime;
  /** Reason for revocation. */
  readonly revocationReason?: string;
  /** When this record was created. */
  readonly createdAt: ISODateTime;
  /** When this record was last updated. */
  readonly updatedAt: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// PERSISTENCE ROW TYPES (SQLite)
// ═══════════════════════════════════════════════════════════════════════

// ─── Product & Pricing Row Types ───

/** SQLite row shape for the `product_tiers` table. */
export interface FridayProductTierRow {
  readonly id: string;
  readonly tier_key: string;
  readonly name: string;
  readonly description: string;
  readonly seat_model: string;
  readonly is_active: number;
  readonly sort_order: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `feature_gates` table. */
export interface FridayFeatureGateRow {
  readonly id: string;
  readonly gate_key: string;
  readonly name: string;
  readonly description: string;
  readonly value_type: string;
  readonly default_value: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `feature_entitlements` table. */
export interface FridayFeatureEntitlementRow {
  readonly id: string;
  readonly gate_id: string;
  readonly tier_id: string;
  readonly value: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `feature_entitlement_overrides` table. */
export interface FridayFeatureEntitlementOverrideRow {
  readonly id: string;
  readonly gate_id: string;
  readonly tenant_id: string;
  readonly value: string;
  readonly reason: string | null;
  readonly granted_by: string;
  readonly expires_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `pricing_models` table. */
export interface FridayPricingModelRow {
  readonly id: string;
  readonly tier_id: string;
  readonly model_type: string;
  readonly base_price: number;
  readonly currency: string;
  readonly billing_interval: string;
  readonly meter_id: string | null;
  readonly is_active: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `usage_meters` table. */
export interface FridayUsageMeterRow {
  readonly id: string;
  readonly meter_key: string;
  readonly name: string;
  readonly description: string;
  readonly unit: string;
  readonly aggregation: string;
  readonly reset_interval: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `usage_quotas` table. */
export interface FridayUsageQuotaRow {
  readonly id: string;
  readonly meter_id: string;
  readonly tier_id: string;
  readonly limit_value: number | null;
  readonly overage_policy: string;
  readonly overage_rate: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `usage_records` table. */
export interface FridayUsageRecordRow {
  readonly id: string;
  readonly meter_id: string;
  readonly tenant_id: string;
  readonly value: number;
  readonly recorded_at: string;
  readonly period_key: string;
  readonly source: string;
  readonly metadata: string | null;
  readonly created_at: string;
}

// ─── Data Governance Row Types ───

/** SQLite row shape for the `retention_policies` table. */
export interface FridayRetentionPolicyRow {
  readonly id: string;
  readonly object_type: string;
  readonly tenant_id: string | null;
  readonly retention_days: number;
  readonly min_days: number;
  readonly max_days: number;
  readonly action: string;
  readonly is_configurable: number;
  readonly storage_region: string | null;
  readonly data_residency_requirement: string | null;
  readonly allowed_regions: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `retention_rules` table. */
export interface FridayRetentionRuleRow {
  readonly id: string;
  readonly policy_id: string;
  readonly name: string;
  readonly condition: string;
  readonly override_days: number | null;
  readonly priority: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `deletion_requests` table. */
export interface FridayDeletionRequestRow {
  readonly id: string;
  readonly object_type: string;
  readonly object_id: string;
  readonly tenant_id: string;
  readonly state: string;
  readonly reason: string;
  readonly requested_by: string;
  readonly parent_request: string | null;
  readonly scheduled_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly error_message: string | null;
  readonly region: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `deletion_tombstones` table. */
export interface FridayDeletionTombstoneRow {
  readonly id: string;
  readonly object_type: string;
  readonly object_id: string;
  readonly tenant_id: string;
  readonly lifecycle_phase: string;
  readonly deletion_request_id: string;
  readonly deleted_by: string;
  readonly soft_deleted_at: string;
  readonly hard_deleted_at: string;
  readonly audit_only_at: string | null;
  readonly created_at: string;
}

/** SQLite row shape for the `audit_exports` table. */
export interface FridayAuditExportRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly format: string;
  readonly scope_json: string;
  readonly schedule: string | null;
  readonly encryption_key: string | null;
  readonly state: string;
  readonly output_path: string | null;
  readonly record_count: number | null;
  readonly file_size_bytes: number | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly error_message: string | null;
  readonly requested_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `compliance_frameworks` table. */
export interface FridayComplianceFrameworkRow {
  readonly id: string;
  readonly framework: string;
  readonly version: string;
  readonly is_active: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `compliance_mappings` table. */
export interface FridayComplianceMappingRow {
  readonly id: string;
  readonly framework_id: string;
  readonly article: string;
  readonly requirement: string;
  readonly capability: string;
  readonly module: string;
  readonly evidence_type: string;
  readonly notes: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

// ─── Developer Platform Row Types ───

/** SQLite row shape for the `package_templates` table. */
export interface FridayPackageTemplateRow {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly version: string;
  readonly registry_id: string | null;
  readonly manifest_json: string;
  readonly variables_json: string;
  readonly files_json: string;
  readonly friday_version_range: string;
  readonly author: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `package_test_suites` table. */
export interface FridayPackageTestSuiteRow {
  readonly id: string;
  readonly package_name: string;
  readonly package_version: string;
  readonly suite_name: string;
  readonly tests_json: string;
  readonly timeout_ms: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `package_test_results` table. */
export interface FridayPackageTestResultRow {
  readonly id: string;
  readonly suite_id: string;
  readonly test_name: string;
  readonly category: string;
  readonly status: string;
  readonly duration_ms: number;
  readonly message: string | null;
  readonly evidence_json: string | null;
  readonly acceptance_verdict_json: string | null;
  readonly executed_at: string;
  readonly created_at: string;
}

/** SQLite row shape for the `reference_packages` table. */
export interface FridayReferencePackageRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly demonstrates: string;
  readonly registry_id: string | null;
  readonly source_url: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

// ─── Ecosystem Row Types ───

/** SQLite row shape for the `creator_onboarding` table. */
export interface FridayCreatorOnboardingRow {
  readonly id: string;
  readonly creator_id: string;
  readonly tenant_id: string;
  readonly state: string;
  readonly current_step: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly expires_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `onboarding_steps` table. */
export interface FridayOnboardingStepRow {
  readonly id: string;
  readonly onboarding_id: string;
  readonly step_key: string;
  readonly step_order: number;
  readonly status: string;
  readonly prerequisites: string;
  readonly evidence_json: string | null;
  readonly blocker_reason: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `certification_rubrics` table. */
export interface FridayCertificationRubricRow {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly categories_json: string;
  readonly thresholds_json: string;
  readonly validity_days: number;
  readonly is_active: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `certifications` table. */
export interface FridayCertificationRow {
  readonly id: string;
  readonly rubric_id: string;
  readonly package_name: string;
  readonly package_version: string;
  readonly tenant_id: string;
  readonly overall_score: number;
  readonly category_scores: string;
  readonly badge_level: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly revoked_at: string | null;
  readonly revocation_reason: string | null;
  readonly certified_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `trust_badges` table. */
export interface FridayTrustBadgeRow {
  readonly id: string;
  readonly badge_type: string;
  readonly subject_type: string;
  readonly subject_id: string;
  readonly trust_level: string;
  readonly criteria_json: string;
  readonly granted_at: string;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
  readonly revocation_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

// ─── Row-to-Entity Mapper Signature ───

/** Generic row-to-entity mapper function type. */
export type FridayCrossProgramRowMapper<TRow, TEntity> = (row: TRow) => TEntity;
