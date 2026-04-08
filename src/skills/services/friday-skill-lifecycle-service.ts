import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";
import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import { safeDirName } from "#utilities";
import type { FridaySelfHealingApiService } from "#learning";
import { loadFridaySkillPackage } from "../manifest/friday-skill-package-loader.js";
import { safeParseFridaySkillManifestV2 } from "../manifest/friday-skill-manifest.schema.js";
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import type {
  FridayMarketplaceSourceEntity,
  FridaySignatureVerificationResult,
  FridaySkillCatalogItem,
  FridaySkillCatalogQuery,
  FridaySkillEligibility,
  FridaySkillEntity,
  FridaySkillFailureEvidenceSummary,
  FridaySkillInstallationEntity,
  FridaySkillInstallPlanSummary,
  FridaySkillInstallRequest,
  FridaySkillInstallResult,
  FridaySkillPermissionPreview,
  FridaySkillRequirementPreview,
  FridaySkillVerificationStatus,
  FridaySkillVersionEntity,
  FridayTrustScoreBreakdown,
  JsonValue,
} from "../model/friday-skill-marketplace.types.js";
import type { SkillOrigin } from "../model/friday-skill-source.types.js";
import type { FridayMarketplaceCacheRepository } from "../persistence/friday-marketplace-cache-repository.js";
import type { FridayMarketplaceSourceRepository } from "../persistence/friday-marketplace-source-repository.js";
import type { FridaySkillInstallationRepository } from "../persistence/friday-skill-installation-repository.js";
import type { FridaySkillRepository } from "../persistence/friday-skill-repository.js";
import type { FridaySkillVersionRepository } from "../persistence/friday-skill-version-repository.js";
import type { FridayRegisteredSkill, FridaySkillRegistry } from "../registry/friday-skill-registry.types.js";
import type { FridayMarketplaceDiscoveryService, FridaySkillCatalogResult } from "./friday-marketplace-discovery-service.js";
import type { FridaySkillInstallationService } from "./friday-skill-installation-service.js";
import type { FridaySkillPackageInstaller } from "./friday-skill-package-installer.js";
import type { FridaySkillSignatureVerifier } from "./friday-skill-signature-verifier.js";
import type { FridaySkillTrustScoringService } from "./friday-skill-trust-scoring-service.js";
import { validateFridaySkillPackage } from "../validation/friday-skill-validation-pipeline.js";
import { mapFridaySkillOriginToTrustTier } from "../trust/friday-skill-trust-enforcer.js";

export interface FridaySkillVerificationEvidence {
  skillId: string;
  verifiedAt: string;
  ok: boolean;
  preflight: FridaySkillPreflightSummary;
  manifestVerdict: {
    ok: boolean;
    issues: Array<{
      code: string;
      severity: "error" | "warning";
      message: string;
      path?: string;
    }>;
  };
  packageIntegrity: {
    available: boolean;
    ok: boolean;
    expectedChecksum?: string;
    actualChecksum?: string;
    archivePath?: string;
  };
  dependencyCheck: {
    ok: boolean;
    checkedBins: string[];
    missingBins: string[];
  };
  runtimeDryRun: {
    attempted: boolean;
    ok: boolean;
    executable: boolean;
    reason: string;
  };
  trustSummary: {
    verdict: "trusted" | "warning" | "blocked" | "local";
    policy?: string;
    score?: number;
    signatureValid?: boolean;
    reasons: string[];
  };
}

export type FridaySkillPreflightCheckLevel =
  | "pass"
  | "blocking"
  | "warning"
  | "advisory";

export interface FridaySkillPreflightCheck {
  id:
    | "manifest"
    | "integrity"
    | "dependencies"
    | "requirements"
    | "permissions"
    | "runtime"
    | "trust";
  label: string;
  level: FridaySkillPreflightCheckLevel;
  summary: string;
  details: string[];
}

export interface FridaySkillPreflightSummary {
  verdict: "ready" | "needs_review" | "blocked";
  counts: {
    blocking: number;
    warning: number;
    advisory: number;
  };
  checks: FridaySkillPreflightCheck[];
}

export type FridaySkillOriginType =
  | "generated"
  | "stabilized"
  | "cli-backed"
  | "mcp-backed";

export type FridaySkillMaturity = "draft" | "verified" | "stable";

export interface FridaySkillLifecycleSummary {
  skillId: string;
  name: string;
  description?: string;
  source: string;
  origin: string;
  status: string;
  starter: boolean;
  category?: string;
  tags: string[];
  publisher?: string;
  latestVersion?: string;
  installedVersion?: string;
  updateAvailable: boolean;
  sourceId?: string;
  managed: boolean;
  registryLoaded: boolean;
  currentManifest?: SkillManifestV2;
  originType: FridaySkillOriginType;
  maturity: FridaySkillMaturity;
  verificationStatus: FridaySkillVerificationStatus;
  requirementPreview: FridaySkillRequirementPreview;
  permissionPreview: FridaySkillPermissionPreview;
  eligibility: FridaySkillEligibility;
  installPlan: FridaySkillInstallPlanSummary;
  latestFailure?: FridaySkillFailureEvidenceSummary;
}

export interface FridaySkillLifecycleDetail extends FridaySkillLifecycleSummary {
  sourceDetails?: FridayMarketplaceSourceEntity;
  versions: FridaySkillVersionEntity[];
  installations: FridaySkillInstallationEntity[];
  catalogEntry?: FridaySkillCatalogItem;
  verification?: FridaySkillVerificationEvidence;
}

export interface FridaySkillCatalogViewItem extends FridaySkillCatalogItem {
  installed: boolean;
  installedVersion?: string;
  updateAvailable: boolean;
  sourceDetails?: FridayMarketplaceSourceEntity;
  originType: FridaySkillOriginType;
  maturity: FridaySkillMaturity;
  verificationStatus: FridaySkillVerificationStatus;
  requirementPreview: FridaySkillRequirementPreview;
  permissionPreview: FridaySkillPermissionPreview;
  eligibility: FridaySkillEligibility;
  installPlan: FridaySkillInstallPlanSummary;
  latestFailure?: FridaySkillFailureEvidenceSummary;
}

export interface FridaySkillInstallOutcome {
  skill: FridaySkillLifecycleDetail;
  installation: FridaySkillInstallResult;
  evidence: FridaySkillVerificationEvidence;
}

export interface FridaySkillUpdateOutcome extends FridaySkillInstallOutcome {
  updated: boolean;
  previousVersion?: string;
}

export interface FridaySkillDeleteOutcome {
  deleted: true;
  skillId: string;
}

export interface FridayManifestValidationOutcome {
  ok: boolean;
  issues: Array<{
    code: string;
    severity: "error" | "warning";
    message: string;
    path?: string;
  }>;
}

export interface FridaySkillLifecycleService {
  listSkills(): FridaySkillLifecycleSummary[];
  listCatalog(query: FridaySkillCatalogQuery): FridaySkillCatalogResult & { items: FridaySkillCatalogViewItem[] };
  getSkill(skillId: string): FridaySkillLifecycleDetail | null;
  install(input: FridaySkillInstallRequest & { userId: string }): Promise<FridaySkillInstallOutcome>;
  update(input: FridaySkillInstallRequest & { userId: string }): Promise<FridaySkillUpdateOutcome>;
  deleteSkill(input: { skillId: string; deletedBy: string }): Promise<FridaySkillDeleteOutcome>;
  verifySkill(input: { skillId: string; userId: string }): Promise<FridaySkillVerificationEvidence>;
  validateManifest(manifest: unknown): FridayManifestValidationOutcome;
}

export interface CreateFridaySkillLifecycleServiceDeps {
  db: FridaySqliteLayer;
  nowIso: () => string;
  managedSkillsDir: string;
  hubVersion: string;
  supportedApiVersions: string[];
  registry: FridaySkillRegistry;
  discovery: FridayMarketplaceDiscoveryService;
  installations: FridaySkillInstallationService;
  packageInstaller: FridaySkillPackageInstaller;
  signatureVerifier: FridaySkillSignatureVerifier;
  trustScoring: FridaySkillTrustScoringService;
  skillRepo: FridaySkillRepository;
  versionRepo: FridaySkillVersionRepository;
  installationRepo: FridaySkillInstallationRepository;
  sourceRepo: FridayMarketplaceSourceRepository;
  cacheRepo: FridayMarketplaceCacheRepository;
  selfHealing?: FridaySelfHealingApiService;
}

function compareVersions(nextVersion: string | undefined, currentVersion: string | undefined): boolean {
  if (!nextVersion || !currentVersion) {
    return false;
  }
  if (semver.valid(nextVersion) && semver.valid(currentVersion)) {
    return semver.gt(nextVersion, currentVersion);
  }
  return nextVersion !== currentVersion;
}

function findExactCatalogItem(items: FridaySkillCatalogItem[], skillId: string, version?: string): FridaySkillCatalogItem | null {
  if (version) {
    const exact = items.find((item) => item.skillId === skillId && item.version === version);
    if (exact) {
      return exact;
    }
  }
  return items.find((item) => item.skillId === skillId) ?? null;
}

function probeBin(command: string): boolean {
  if (command.trim().length === 0) {
    return true;
  }
  const probe = process.platform === "win32"
    ? spawnSync("where", [command], { encoding: "utf-8" })
    : spawnSync("which", [command], { encoding: "utf-8" });
  return probe.status === 0;
}

function permissionToken(input: { resource: string; action: string }): string {
  return `${input.resource}.${input.action}`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function buildFirstUsePrompts(manifest?: SkillManifestV2): string[] {
  return uniqueStrings([
    ...(manifest?.triggers.phrases ?? []),
    ...(manifest?.triggers.intents ?? []),
  ]).slice(0, 3);
}

function deriveSkillOriginType(manifest?: SkillManifestV2): FridaySkillOriginType {
  const tags = manifest?.tags ?? [];
  const tagSet = new Set(tags.map((tag) => tag.toLowerCase()));
  if (tagSet.has("mcp") || tagSet.has("mcp-backed") || tagSet.has("starter.mcp")) {
    return "mcp-backed";
  }
  if (
    manifest?.runtime.kind === "shell"
    || manifest?.runtime.kind === "python"
    || tagSet.has("cli")
    || tagSet.has("cli-backed")
  ) {
    return "cli-backed";
  }
  if (tagSet.has("stable") || tagSet.has("stabilized") || tagSet.has("skill.stabilized")) {
    return "stabilized";
  }
  return "generated";
}

function deriveSkillMaturity(input: {
  manifest?: SkillManifestV2;
  verificationStatus: FridaySkillVerificationStatus;
  installedVersion?: string;
  registryLoaded: boolean;
  status: string;
  starter: boolean;
  originType: FridaySkillOriginType;
}): FridaySkillMaturity {
  const tags = new Set((input.manifest?.tags ?? []).map((tag) => tag.toLowerCase()));
  if (tags.has("draft") || tags.has("generated.draft")) {
    return "draft";
  }

  const verified = input.verificationStatus === "trusted"
    || input.verificationStatus === "local";
  const stableByLifecycle = input.starter
    || input.registryLoaded
    || input.status === "installed"
    || input.originType === "stabilized";

  if (verified && stableByLifecycle) {
    return "stable";
  }
  if (verified || Boolean(input.installedVersion)) {
    return "verified";
  }
  return "draft";
}

function buildRequirementPreview(manifest?: SkillManifestV2): FridaySkillRequirementPreview {
  const bins = manifest?.requirements.bins ?? [];
  const env = manifest?.requirements.env ?? [];
  const config = manifest?.requirements.config ?? [];
  const supportedOs = manifest?.requirements.os ?? [];
  const requiredCapabilities = manifest?.executionTargets.requiredCapabilities ?? [];
  const currentOs = process.platform as "darwin" | "linux" | "win32";

  return {
    bins,
    env,
    config,
    supportedOs,
    requiredCapabilities,
    missingBins: bins.filter((bin) => !probeBin(bin)),
    missingEnv: env.filter((key) => {
      const value = process.env[key];
      return typeof value !== "string" || value.trim().length === 0;
    }),
    unresolvedConfig: [...config],
    unsupportedOs: supportedOs.length > 0 && !supportedOs.includes(currentOs),
  };
}

function buildPermissionPreview(manifest?: SkillManifestV2): FridaySkillPermissionPreview {
  const grants = (manifest?.permissions.grants ?? []).map((grant) => ({
    id: grant.id,
    token: permissionToken({ resource: grant.resource, action: grant.action }),
    resource: grant.resource,
    action: grant.action,
    required: grant.required,
    reason: grant.reason,
    selectors: grant.selectors as Record<string, JsonValue | undefined> | undefined,
  }));

  return {
    required: uniqueStrings(grants.filter((grant) => grant.required).map((grant) => grant.token)),
    optional: uniqueStrings(grants.filter((grant) => !grant.required).map((grant) => grant.token)),
    promptOn: uniqueStrings(manifest?.permissions.promptOn ?? []),
    grants,
  };
}

function buildSkillPreflightSummary(input: {
  manifestVerdict: FridaySkillVerificationEvidence["manifestVerdict"];
  packageIntegrity: FridaySkillVerificationEvidence["packageIntegrity"];
  dependencyCheck: FridaySkillVerificationEvidence["dependencyCheck"];
  runtimeDryRun: FridaySkillVerificationEvidence["runtimeDryRun"];
  trustSummary: FridaySkillVerificationEvidence["trustSummary"];
  requirementPreview: FridaySkillRequirementPreview;
  permissionPreview: FridaySkillPermissionPreview;
}): FridaySkillPreflightSummary {
  const checks: FridaySkillPreflightCheck[] = [];

  const manifestErrors = input.manifestVerdict.issues
    .filter((issue) => issue.severity === "error")
    .map((issue) => issue.message);
  const manifestWarnings = input.manifestVerdict.issues
    .filter((issue) => issue.severity === "warning")
    .map((issue) => issue.message);
  checks.push({
    id: "manifest",
    label: "Manifest",
    level: manifestErrors.length > 0 ? "blocking" : manifestWarnings.length > 0 ? "warning" : "pass",
    summary: manifestErrors.length > 0
      ? `Manifest validation found ${String(manifestErrors.length)} blocking issue(s).`
      : manifestWarnings.length > 0
        ? `Manifest validation found ${String(manifestWarnings.length)} warning(s).`
        : "Manifest schema and lifecycle checks passed.",
    details: [...manifestErrors, ...manifestWarnings],
  });

  checks.push({
    id: "integrity",
    label: "Integrity",
    level: !input.packageIntegrity.available
      ? "advisory"
      : input.packageIntegrity.ok
        ? "pass"
        : "blocking",
    summary: !input.packageIntegrity.available
      ? "Package checksum is unavailable until a packaged archive is present."
      : input.packageIntegrity.ok
        ? "Package checksum matches the archived package."
        : "Package checksum does not match the archived package.",
    details: [
      ...(input.packageIntegrity.expectedChecksum
        ? [`Expected checksum: ${input.packageIntegrity.expectedChecksum}`]
        : []),
      ...(input.packageIntegrity.actualChecksum
        ? [`Actual checksum: ${input.packageIntegrity.actualChecksum}`]
        : []),
      ...(input.packageIntegrity.archivePath
        ? [`Archive path: ${input.packageIntegrity.archivePath}`]
        : []),
    ],
  });

  checks.push({
    id: "dependencies",
    label: "Dependencies",
    level: input.dependencyCheck.missingBins.length > 0
      ? "blocking"
      : input.dependencyCheck.checkedBins.length > 0
        ? "pass"
        : "advisory",
    summary: input.dependencyCheck.missingBins.length > 0
      ? `Missing required binaries: ${input.dependencyCheck.missingBins.join(", ")}`
      : input.dependencyCheck.checkedBins.length > 0
        ? "All declared external binaries are available."
        : "No external binaries are declared by this skill.",
    details: input.dependencyCheck.checkedBins.length > 0
      ? [`Checked binaries: ${input.dependencyCheck.checkedBins.join(", ")}`]
      : [],
  });

  const requirementIssues: string[] = [];
  if (input.requirementPreview.unsupportedOs) {
    requirementIssues.push("Current OS is not supported.");
  }
  if (input.requirementPreview.missingEnv.length > 0) {
    requirementIssues.push(`Missing environment variables: ${input.requirementPreview.missingEnv.join(", ")}`);
  }
  if (input.requirementPreview.unresolvedConfig.length > 0) {
    requirementIssues.push(`Requires config values: ${input.requirementPreview.unresolvedConfig.join(", ")}`);
  }
  if (input.requirementPreview.requiredCapabilities.length > 0) {
    requirementIssues.push(`Requires capabilities: ${input.requirementPreview.requiredCapabilities.join(", ")}`);
  }
  checks.push({
    id: "requirements",
    label: "Runtime Requirements",
    level: input.requirementPreview.unsupportedOs
      ? "blocking"
      : requirementIssues.length > 0
        ? "warning"
        : "pass",
    summary: input.requirementPreview.unsupportedOs
      ? "Runtime requirements block this skill on the current machine."
      : requirementIssues.length > 0
        ? "Runtime requirements need operator configuration before wider use."
        : "Runtime requirements are satisfied.",
    details: requirementIssues,
  });

  const permissionIssues: string[] = [];
  if (input.permissionPreview.required.length > 0) {
    permissionIssues.push(`Required grants: ${input.permissionPreview.required.join(", ")}`);
  }
  if (input.permissionPreview.promptOn.length > 0) {
    permissionIssues.push(`Runtime prompts: ${input.permissionPreview.promptOn.join(", ")}`);
  }
  checks.push({
    id: "permissions",
    label: "Permissions",
    level: permissionIssues.length > 0 ? "warning" : "pass",
    summary: permissionIssues.length > 0
      ? "Operator review is required for permissions before broader rollout."
      : "No extra operator permission review is required right now.",
    details: permissionIssues,
  });

  checks.push({
    id: "runtime",
    label: "Runtime Dry-Run",
    level: !input.runtimeDryRun.attempted
      ? "advisory"
      : input.runtimeDryRun.ok
        ? "pass"
        : "blocking",
    summary: input.runtimeDryRun.reason,
    details: [
      `Attempted: ${String(input.runtimeDryRun.attempted)}`,
      `Executable: ${String(input.runtimeDryRun.executable)}`,
    ],
  });

  checks.push({
    id: "trust",
    label: "Trust",
    level: input.trustSummary.verdict === "blocked"
      ? "blocking"
      : input.trustSummary.verdict === "warning"
        ? "warning"
        : "pass",
    summary: input.trustSummary.verdict === "blocked"
      ? "Trust policy blocks this skill in its current state."
      : input.trustSummary.verdict === "warning"
        ? "Trust policy requires operator review before wider rollout."
        : input.trustSummary.verdict === "local"
          ? "Bundled or workspace-managed skill bypasses marketplace trust checks."
          : "Trust policy checks passed.",
    details: input.trustSummary.reasons,
  });

  const counts = checks.reduce(
    (acc, check) => {
      if (check.level === "blocking") acc.blocking += 1;
      if (check.level === "warning") acc.warning += 1;
      if (check.level === "advisory") acc.advisory += 1;
      return acc;
    },
    { blocking: 0, warning: 0, advisory: 0 },
  );

  return {
    verdict: counts.blocking > 0
      ? "blocked"
      : counts.warning > 0
        ? "needs_review"
        : "ready",
    counts,
    checks,
  };
}

function buildVerificationStatus(input: {
  registered: FridayRegisteredSkill | null;
  source: FridayMarketplaceSourceEntity | undefined;
  catalogEntry: FridaySkillCatalogItem | null;
}): FridaySkillVerificationStatus {
  if (input.registered) {
    return "local";
  }

  if (input.source && input.catalogEntry) {
    if (!input.catalogEntry.signatureValid && input.source.trustPolicy === "strict") {
      return "blocked";
    }
    if (input.catalogEntry.signatureValid && input.catalogEntry.trustScore >= 85) {
      return "trusted";
    }
    return "warning";
  }

  return "unverified";
}

function buildEligibility(input: {
  requirements: FridaySkillRequirementPreview;
  permissions: FridaySkillPermissionPreview;
  verificationStatus: FridaySkillVerificationStatus;
}): FridaySkillEligibility {
  const reasons: string[] = [];

  if (input.requirements.unsupportedOs) {
    reasons.push("Current OS is not supported by this skill.");
  }
  if (input.requirements.missingBins.length > 0) {
    reasons.push(`Missing required binaries: ${input.requirements.missingBins.join(", ")}`);
  }
  if (input.requirements.missingEnv.length > 0) {
    reasons.push(`Missing environment variables: ${input.requirements.missingEnv.join(", ")}`);
  }
  if (input.requirements.unresolvedConfig.length > 0) {
    reasons.push(`Requires config values: ${input.requirements.unresolvedConfig.join(", ")}`);
  }
  if (input.requirements.requiredCapabilities.length > 0) {
    reasons.push(`Requires capabilities: ${input.requirements.requiredCapabilities.join(", ")}`);
  }
  if (input.permissions.required.length > 0) {
    reasons.push(`Requires operator-granted permissions: ${input.permissions.required.join(", ")}`);
  }
  if (input.permissions.promptOn.length > 0) {
    reasons.push(`Will prompt at runtime for: ${input.permissions.promptOn.join(", ")}`);
  }
  if (input.verificationStatus === "warning") {
    reasons.push("Source trust metadata requires operator review.");
  }
  if (input.verificationStatus === "blocked") {
    reasons.push("Source trust policy blocks installation in the current state.");
  }

  const blocked = input.requirements.unsupportedOs
    || input.requirements.missingBins.length > 0
    || input.verificationStatus === "blocked";
  const reviewRequired = input.requirements.missingEnv.length > 0
    || input.requirements.unresolvedConfig.length > 0
    || input.requirements.requiredCapabilities.length > 0
    || input.permissions.required.length > 0
    || input.permissions.promptOn.length > 0
    || input.verificationStatus === "warning";

  return {
    verdict: blocked ? "blocked" : reviewRequired ? "needs_configuration" : "eligible",
    installable: !blocked,
    reviewRequired,
    reasons,
  };
}

function buildRecommendedNextAction(input: {
  installed: boolean;
  updateAvailable: boolean;
  eligibility: FridaySkillEligibility;
  verificationStatus: FridaySkillVerificationStatus;
}): string {
  if (input.eligibility.verdict === "blocked") {
    return "Resolve the blocked reasons before installing or enabling this skill.";
  }
  if (input.eligibility.verdict === "needs_configuration") {
    return "Review requirements and permissions, then retry install with the missing grants or config in place.";
  }
  if (!input.installed) {
    return "Install this skill, then run one of the suggested first-use prompts from chat or assistant.";
  }
  if (input.updateAvailable) {
    return "Update this skill to the latest verified version before relying on it for repeated runs.";
  }
  if (input.verificationStatus === "warning" || input.verificationStatus === "unverified") {
    return "Run verification and review trust evidence before wider rollout.";
  }
  return "Use this skill from chat, packs, or assistant and keep it pinned if it becomes part of your primary flow.";
}

function buildImplementationStatus(input: {
  registryLoaded: boolean;
  installedVersion?: string;
  maturity: FridaySkillMaturity;
}): "bundled" | "installed" | "catalog-only" | "generated-draft" {
  if (input.registryLoaded) {
    return "bundled";
  }
  if (input.installedVersion) {
    return "installed";
  }
  if (input.maturity === "draft") {
    return "generated-draft";
  }
  return "catalog-only";
}

function buildInstallPlan(input: {
  sourceId?: string;
  source?: FridayMarketplaceSourceEntity;
  installedVersion?: string;
  targetVersion?: string;
  requirements: FridaySkillRequirementPreview;
  permissions: FridaySkillPermissionPreview;
  verificationStatus: FridaySkillVerificationStatus;
}): FridaySkillInstallPlanSummary {
  return {
    strategy: input.installedVersion ? "update" : "install",
    targetVersion: input.targetVersion,
    sourceId: input.sourceId,
    sourceTrustPolicy: input.source?.trustPolicy,
    targetCount: 1,
    verificationStatus: input.verificationStatus,
    eligibility: buildEligibility({
      requirements: input.requirements,
      permissions: input.permissions,
      verificationStatus: input.verificationStatus,
    }),
    requirements: input.requirements,
    permissions: input.permissions,
  };
}

function buildLatestFailure(installations: FridaySkillInstallationEntity[]): FridaySkillFailureEvidenceSummary | undefined {
  const failed = installations.find((installation) =>
    installation.status === "failed"
    && typeof installation.lastError === "string"
    && installation.lastError.trim().length > 0
  );
  if (!failed || !failed.lastError) {
    return undefined;
  }
  return {
    installationId: failed.id,
    version: failed.version,
    message: failed.lastError,
    failedAt: failed.updatedAt,
    satelliteId: failed.satelliteId,
  };
}

function registryToSummary(skill: FridayRegisteredSkill): FridaySkillLifecycleSummary {
  const requirementPreview = buildRequirementPreview(skill.manifest);
  const permissionPreview = buildPermissionPreview(skill.manifest);
  const verificationStatus: FridaySkillVerificationStatus = "local";
  const originType = deriveSkillOriginType(skill.manifest);
  const maturity = deriveSkillMaturity({
    manifest: skill.manifest,
    verificationStatus,
    installedVersion: skill.manifest.version,
    registryLoaded: true,
    status: skill.status,
    starter: (skill.manifest.tags ?? []).includes("starter"),
    originType,
  });
  const installPlan = buildInstallPlan({
    installedVersion: skill.manifest.version,
    targetVersion: skill.manifest.version,
    requirements: requirementPreview,
    permissions: permissionPreview,
    verificationStatus,
  });

  return {
    skillId: skill.manifest.id,
    name: skill.manifest.name,
    description: skill.manifest.description,
    source: skill.source,
    origin: skill.origin,
    status: skill.status,
    starter: (skill.manifest.tags ?? []).includes("starter"),
    category: skill.manifest.category,
    tags: skill.manifest.tags ?? [],
    publisher: skill.manifest.author?.name,
    latestVersion: skill.manifest.version,
    installedVersion: skill.manifest.version,
    updateAvailable: false,
    managed: skill.origin === "managed",
    registryLoaded: true,
    currentManifest: skill.manifest,
    originType,
    maturity,
    verificationStatus,
    requirementPreview,
    permissionPreview,
    eligibility: installPlan.eligibility,
    installPlan,
  };
}

function persistedToSummary(skill: FridaySkillEntity, catalogEntry: FridaySkillCatalogItem | null): FridaySkillLifecycleSummary {
  const manifest = skill.currentManifest ?? catalogEntry?.manifest;
  const originType = deriveSkillOriginType(manifest);
  const maturity = deriveSkillMaturity({
    manifest,
    verificationStatus: "unverified",
    installedVersion: skill.installedVersion,
    registryLoaded: false,
    status: skill.status,
    starter: (skill.currentManifest?.tags ?? catalogEntry?.manifest.tags ?? []).includes("starter"),
    originType,
  });
  return {
    skillId: skill.id,
    name: skill.name,
    description: skill.currentManifest?.description ?? catalogEntry?.manifest.description,
    source: skill.source,
    origin: skill.origin,
    status: skill.status,
    starter: (skill.currentManifest?.tags ?? catalogEntry?.manifest.tags ?? []).includes("starter"),
    category: skill.currentManifest?.category ?? catalogEntry?.manifest.category,
    tags: skill.currentManifest?.tags ?? catalogEntry?.manifest.tags ?? [],
    publisher: skill.publisher ?? catalogEntry?.publisher,
    latestVersion: skill.latestVersion ?? catalogEntry?.version,
    installedVersion: skill.installedVersion,
    updateAvailable: compareVersions(skill.latestVersion ?? catalogEntry?.version, skill.installedVersion),
    sourceId: catalogEntry?.sourceId,
    managed: skill.origin === "managed",
    registryLoaded: false,
    currentManifest: skill.currentManifest,
    originType,
    maturity,
    verificationStatus: "unverified",
    requirementPreview: buildRequirementPreview(skill.currentManifest ?? catalogEntry?.manifest),
    permissionPreview: buildPermissionPreview(skill.currentManifest ?? catalogEntry?.manifest),
    eligibility: {
      verdict: "eligible",
      installable: true,
      reviewRequired: false,
      reasons: [],
    },
    installPlan: {
      strategy: skill.installedVersion ? "update" : "install",
      targetVersion: skill.latestVersion ?? catalogEntry?.version,
      sourceId: catalogEntry?.sourceId,
      sourceTrustPolicy: undefined,
      targetCount: 1,
      verificationStatus: "unverified",
      eligibility: {
        verdict: "eligible",
        installable: true,
        reviewRequired: false,
        reasons: [],
      },
      requirements: buildRequirementPreview(skill.currentManifest ?? catalogEntry?.manifest),
      permissions: buildPermissionPreview(skill.currentManifest ?? catalogEntry?.manifest),
    },
  };
}

function enrichSummary(input: {
  summary: FridaySkillLifecycleSummary;
  manifest?: SkillManifestV2;
  source?: FridayMarketplaceSourceEntity;
  catalogEntry: FridaySkillCatalogItem | null;
  installations: FridaySkillInstallationEntity[];
  registered: FridayRegisteredSkill | null;
}): FridaySkillLifecycleSummary {
  const manifest = input.manifest;
  const requirementPreview = buildRequirementPreview(manifest);
  const permissionPreview = buildPermissionPreview(manifest);
  const verificationStatus = buildVerificationStatus({
    registered: input.registered,
    source: input.source,
    catalogEntry: input.catalogEntry,
  });
  const originType = deriveSkillOriginType(manifest ?? input.summary.currentManifest);
  const installPlan = buildInstallPlan({
    sourceId: input.summary.sourceId ?? input.catalogEntry?.sourceId,
    source: input.source,
    installedVersion: input.summary.installedVersion,
    targetVersion: input.summary.latestVersion ?? input.catalogEntry?.version,
    requirements: requirementPreview,
    permissions: permissionPreview,
    verificationStatus,
  });

  return {
    ...input.summary,
    originType,
    maturity: deriveSkillMaturity({
      manifest: manifest ?? input.summary.currentManifest,
      verificationStatus,
      installedVersion: input.summary.installedVersion,
      registryLoaded: input.summary.registryLoaded,
      status: input.summary.status,
      starter: input.summary.starter,
      originType,
    }),
    verificationStatus,
    requirementPreview,
    permissionPreview,
    eligibility: installPlan.eligibility,
    installPlan,
    latestFailure: buildLatestFailure(input.installations),
  };
}

export function createFridaySkillLifecycleService(
  deps: CreateFridaySkillLifecycleServiceDeps,
): FridaySkillLifecycleService {
  function getCatalogCandidates(skillId: string): FridaySkillCatalogItem[] {
    return deps.db.withReadConnection((db) =>
      deps.cacheRepo.listCatalog(db, {
        q: skillId,
        limit: 100,
        includeStale: true,
      }),
    ).filter((item) => item.skillId === skillId).map((item) => {
      const manifest = item.manifestJson as unknown as SkillManifestV2;
      return {
        sourceId: item.sourceId,
        skillId: item.skillId,
        skillName: manifest.name ?? item.skillId,
        publisher: manifest.author?.name,
        version: item.version,
        category: manifest.category,
        releasedAt: item.indexedAt,
        signatureValid: item.signatureValid,
        trustScore: item.trustScore,
        starter: (manifest.tags ?? []).includes("starter"),
        manifest,
      };
    });
  }

  function getPersistedSkill(skillId: string): FridaySkillEntity | null {
    return deps.db.withReadConnection((db) =>
      deps.skillRepo.getSkillById(db, skillId),
    );
  }

  function getVersions(skillId: string): FridaySkillVersionEntity[] {
    return deps.db.withReadConnection((db) =>
      deps.versionRepo.listVersions(db, skillId, 20),
    );
  }

  function getInstallations(skillId: string): FridaySkillInstallationEntity[] {
    return deps.db.withReadConnection((db) =>
      deps.installationRepo.listBySkill(db, skillId),
    );
  }

  function getSource(sourceId?: string): FridayMarketplaceSourceEntity | undefined {
    if (!sourceId) {
      return undefined;
    }
    return deps.db.withReadConnection((db) =>
      deps.sourceRepo.getSourceById(db, sourceId),
    ) ?? undefined;
  }

  function buildSummary(skillId: string): FridaySkillLifecycleSummary | null {
    const registered = deps.registry.get(skillId);
    const persisted = getPersistedSkill(skillId);
    const catalogEntry = findExactCatalogItem(
      getCatalogCandidates(skillId),
      skillId,
      persisted?.latestVersion ?? persisted?.installedVersion ?? registered?.manifest.version,
    );
    const source = getSource(catalogEntry?.sourceId);
    const installations = getInstallations(skillId);

    if (registered) {
      const summary = registryToSummary(registered);
      if (persisted) {
        summary.latestVersion = persisted.latestVersion ?? summary.latestVersion;
        summary.installedVersion = persisted.installedVersion ?? summary.installedVersion;
        summary.status = persisted.status ?? summary.status;
        summary.sourceId = catalogEntry?.sourceId;
        summary.updateAvailable = compareVersions(
          persisted.latestVersion ?? catalogEntry?.version,
          persisted.installedVersion ?? summary.installedVersion,
        );
      }
      return enrichSummary({
        summary,
        manifest: persisted?.currentManifest ?? registered.manifest ?? catalogEntry?.manifest,
        source,
        catalogEntry,
        installations,
        registered,
      });
    }

    if (persisted) {
      return enrichSummary({
        summary: persistedToSummary(persisted, catalogEntry),
        manifest: persisted.currentManifest ?? catalogEntry?.manifest,
        source,
        catalogEntry,
        installations,
        registered: null,
      });
    }

    if (catalogEntry) {
      const summary: FridaySkillLifecycleSummary = {
        skillId: catalogEntry.skillId,
        name: catalogEntry.skillName,
        description: catalogEntry.manifest.description,
        source: "marketplace",
        origin: "managed",
        status: "not_installed",
        starter: (catalogEntry.manifest.tags ?? []).includes("starter"),
        category: catalogEntry.category,
        tags: catalogEntry.manifest.tags ?? [],
        publisher: catalogEntry.publisher,
        latestVersion: catalogEntry.version,
        updateAvailable: false,
        sourceId: catalogEntry.sourceId,
        managed: true,
        registryLoaded: false,
        currentManifest: catalogEntry.manifest,
        originType: deriveSkillOriginType(catalogEntry.manifest),
        maturity: "draft",
        verificationStatus: "unverified",
        requirementPreview: buildRequirementPreview(catalogEntry.manifest),
        permissionPreview: buildPermissionPreview(catalogEntry.manifest),
        eligibility: {
          verdict: "eligible",
          installable: true,
          reviewRequired: false,
          reasons: [],
        },
        installPlan: {
          strategy: "install",
          targetVersion: catalogEntry.version,
          sourceId: catalogEntry.sourceId,
          sourceTrustPolicy: undefined,
          targetCount: 1,
          verificationStatus: "unverified",
          eligibility: {
            verdict: "eligible",
            installable: true,
            reviewRequired: false,
            reasons: [],
          },
          requirements: buildRequirementPreview(catalogEntry.manifest),
          permissions: buildPermissionPreview(catalogEntry.manifest),
        },
      };
      return enrichSummary({
        summary,
        manifest: catalogEntry.manifest,
        source,
        catalogEntry,
        installations,
        registered: null,
      });
    }

    return null;
  }

  function buildCatalogViewItem(
    item: FridaySkillCatalogItem,
    summary: FridaySkillLifecycleSummary | null = buildSummary(item.skillId),
  ): FridaySkillCatalogViewItem {
    const requirementPreview = summary?.requirementPreview ?? buildRequirementPreview(item.manifest);
    const permissionPreview = summary?.permissionPreview ?? buildPermissionPreview(item.manifest);
    const sourceDetails = getSource(item.sourceId);
    const verificationStatus = summary?.verificationStatus ?? buildVerificationStatus({
      registered: null,
      source: sourceDetails,
      catalogEntry: item,
    });
    const installPlan = summary?.installPlan ?? buildInstallPlan({
      sourceId: item.sourceId,
      source: sourceDetails,
      installedVersion: summary?.installedVersion,
      targetVersion: item.version,
      requirements: requirementPreview,
      permissions: permissionPreview,
      verificationStatus,
    });
    const installed = Boolean(summary?.installedVersion || summary?.registryLoaded);
    const updateAvailable = compareVersions(item.version, summary?.installedVersion);
    const maturity = summary?.maturity ?? "draft";
    const eligibility = summary?.eligibility ?? installPlan.eligibility;
    const implementationStatus = buildImplementationStatus({
      registryLoaded: Boolean(summary?.registryLoaded),
      installedVersion: summary?.installedVersion,
      maturity,
    });

    return {
      ...item,
      installed,
      installedVersion: summary?.installedVersion,
      updateAvailable,
      sourceDetails,
      originType: summary?.originType ?? deriveSkillOriginType(item.manifest),
      maturity,
      verificationStatus,
      requirementPreview,
      permissionPreview,
      eligibility,
      installPlan,
      latestFailure: summary?.latestFailure,
      trustTier: item.trustTier ?? mapFridaySkillOriginToTrustTier((summary?.origin ?? "managed") as SkillOrigin),
      implementationStatus: item.implementationStatus ?? implementationStatus,
      blockedReasons: item.blockedReasons ?? (eligibility.verdict === "eligible" ? [] : eligibility.reasons),
      shadowedBy: item.shadowedBy ?? (updateAvailable ? [`${item.skillId}@${item.version}`] : []),
      recommendedNextAction: item.recommendedNextAction ?? buildRecommendedNextAction({
        installed,
        updateAvailable,
        eligibility,
        verificationStatus,
      }),
      firstUsePrompts: item.firstUsePrompts ?? buildFirstUsePrompts(item.manifest),
    };
  }

  async function refreshRegistry(): Promise<void> {
    await deps.registry.refresh();
  }

  function buildManifestIssues(manifest: SkillManifestV2 | undefined, registered: FridayRegisteredSkill | null) {
    if (!manifest) {
      return {
        ok: false,
        issues: [
          {
            code: "MANIFEST_MISSING",
            severity: "error" as const,
            message: "No skill manifest was found for this skill.",
          },
        ],
      };
    }

    const parsed = safeParseFridaySkillManifestV2(manifest);
    const issues: Array<{
      code: string;
      severity: "error" | "warning";
      message: string;
      path?: string;
    }> = parsed.success
      ? []
      : parsed.error.issues.map((issue) => ({
        code: "MANIFEST_SCHEMA_INVALID",
        severity: "error" as const,
        message: `${issue.path.join(".")}: ${issue.message}`,
        path: issue.path.join("."),
      }));

    if (registered) {
      issues.push(
        ...registered.validation.issues.map((issue) => ({
          code: issue.code,
          severity: issue.severity,
          message: issue.message,
          path: issue.path,
        })),
      );
    }

    return {
      ok: issues.every((issue) => issue.severity !== "error"),
      issues,
    };
  }

  function buildPackageIntegrity(skillId: string, version: string | undefined, versionEntity: FridaySkillVersionEntity | null) {
    if (!version || !versionEntity) {
      return {
        available: false,
        ok: false,
      };
    }

    const archivePath = join(
      deps.managedSkillsDir,
      safeDirName(skillId),
      safeDirName(version),
      "package.tgz",
    );

    if (!existsSync(archivePath)) {
      return {
        available: false,
        ok: false,
        archivePath,
        expectedChecksum: versionEntity.checksum,
      };
    }

    const actualChecksum = deps.signatureVerifier.computeChecksum(readFileSync(archivePath));
    return {
      available: true,
      ok: actualChecksum === versionEntity.checksum,
      expectedChecksum: versionEntity.checksum,
      actualChecksum,
      archivePath,
    };
  }

  function buildTrustSummary(input: {
    source: FridayMarketplaceSourceEntity | undefined;
    catalogEntry: FridaySkillCatalogItem | null;
    verification: FridaySignatureVerificationResult | null;
    score: FridayTrustScoreBreakdown | null;
    registered: FridayRegisteredSkill | null;
  }): FridaySkillVerificationEvidence["trustSummary"] {
    if (input.registered) {
      return {
        verdict: "local",
        reasons: [
          `Registry trust tier: ${input.registered.trust.trustTier}`,
          `Execution mode: ${input.registered.trust.executionMode}`,
        ],
      };
    }

    if (input.source && input.catalogEntry) {
      const verdict = input.catalogEntry.signatureValid
        ? input.catalogEntry.trustScore >= 85
          ? "trusted"
          : "warning"
        : input.source.trustPolicy === "strict"
          ? "blocked"
          : "warning";
      return {
        verdict,
        policy: input.source.trustPolicy,
        score: input.catalogEntry.trustScore,
        signatureValid: input.catalogEntry.signatureValid,
        reasons: input.score?.reasons ?? [],
      };
    }

    if (input.verification) {
      return {
        verdict: input.verification.signatureValid ? "trusted" : "warning",
        signatureValid: input.verification.signatureValid,
        reasons: input.verification.checks,
      };
    }

    return {
      verdict: "warning",
      reasons: ["No trust metadata available for this skill."],
    };
  }

  async function reportSkillFailure(input: {
    userId: string;
    skillId: string;
    stage: "install" | "update" | "delete" | "verify";
    message: string;
  }): Promise<void> {
    if (!deps.selfHealing) {
      return;
    }
    deps.selfHealing.reportStructuredFailure({
      userId: input.userId,
      category: "workflow",
      severity: "medium",
      message: `skill_lifecycle:${input.stage}:${input.skillId}:${input.message}`,
      context: {
        source: "skills_lifecycle",
        skillId: input.skillId,
        stage: input.stage,
      },
      correlationId: `${input.stage}:${input.skillId}`,
    });
  }

  return {
    listSkills() {
      const summaries = new Map<string, FridaySkillLifecycleSummary>();
      for (const registered of deps.registry.list()) {
        const summary = buildSummary(registered.manifest.id) ?? registryToSummary(registered);
        summaries.set(registered.manifest.id, summary);
      }
      const persisted = deps.db.withReadConnection((db) =>
        deps.skillRepo.listAll(db),
      );
      for (const skill of persisted) {
        const next = buildSummary(skill.id);
        if (next) {
          summaries.set(skill.id, next);
        }
      }
      return [...summaries.values()].sort((left, right) => left.name.localeCompare(right.name));
    },

    listCatalog(query) {
      const result = deps.discovery.search(query);
      const items = result.items.map((item) => buildCatalogViewItem(item));
      return {
        ...result,
        items,
      };
    },

    getSkill(skillId) {
      const summary = buildSummary(skillId);
      if (!summary) {
        return null;
      }
      const catalogItems = getCatalogCandidates(skillId);
      const catalogEntry = findExactCatalogItem(
        catalogItems,
        skillId,
        summary.latestVersion ?? summary.installedVersion,
      );
      return {
        ...summary,
        sourceDetails: getSource(summary.sourceId ?? catalogEntry?.sourceId),
        versions: getVersions(skillId),
        installations: getInstallations(skillId),
        catalogEntry: catalogEntry ? buildCatalogViewItem(catalogEntry, summary) : undefined,
      };
    },

    async install(input) {
      try {
        const installation = await deps.installations.install(input);
        await refreshRegistry();
        const skill = this.getSkill(input.skillId);
        if (!skill) {
          throw new FridayDomainError("SKILL_NOT_FOUND", `Skill "${input.skillId}" not found after install`, {
            httpStatus: 404,
          });
        }
        const evidence = await this.verifySkill({
          skillId: input.skillId,
          userId: input.userId,
        });
        return { skill, installation, evidence };
      } catch (error) {
        await reportSkillFailure({
          userId: input.userId,
          skillId: input.skillId,
          stage: "install",
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },

    async update(input) {
      const before = this.getSkill(input.skillId);
      if (!before) {
        throw new FridayDomainError("SKILL_NOT_FOUND", `Skill "${input.skillId}" not found`, {
          httpStatus: 404,
        });
      }
      const previousVersion = before.installedVersion;
      try {
        const installation = await deps.installations.install(input);
        if (previousVersion && previousVersion !== installation.resolvedVersion) {
          deps.packageInstaller.remove(input.skillId, previousVersion);
        }
        await refreshRegistry();
        const skill = this.getSkill(input.skillId);
        if (!skill) {
          throw new FridayDomainError("SKILL_NOT_FOUND", `Skill "${input.skillId}" not found after update`, {
            httpStatus: 404,
          });
        }
        const evidence = await this.verifySkill({
          skillId: input.skillId,
          userId: input.userId,
        });
        return {
          skill,
          installation,
          evidence,
          updated: previousVersion !== installation.resolvedVersion,
          previousVersion,
        };
      } catch (error) {
        await reportSkillFailure({
          userId: input.userId,
          skillId: input.skillId,
          stage: "update",
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },

    async deleteSkill(input) {
      const persisted = getPersistedSkill(input.skillId);
      const registered = deps.registry.get(input.skillId);
      if (!persisted && !registered) {
        throw new FridayDomainError("SKILL_NOT_FOUND", `Skill "${input.skillId}" not found`, {
          httpStatus: 404,
        });
      }

      try {
        if (persisted?.installedVersion) {
          deps.packageInstaller.remove(input.skillId, persisted.installedVersion);
        }
        if (registered?.origin === "managed" && existsSync(registered.skillDir)) {
          rmSync(registered.skillDir, { recursive: true, force: true });
        }
        deps.db.withWriteTransaction((db) => {
          if (persisted) {
            deps.skillRepo.markDeleted(db, input.skillId, input.deletedBy, deps.nowIso());
          }
        });
        await refreshRegistry();
        return {
          deleted: true,
          skillId: input.skillId,
        };
      } catch (error) {
        await reportSkillFailure({
          userId: input.deletedBy,
          skillId: input.skillId,
          stage: "delete",
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },

    async verifySkill(input) {
      const detail = this.getSkill(input.skillId);
      if (!detail) {
        throw new FridayDomainError("SKILL_NOT_FOUND", `Skill "${input.skillId}" not found`, {
          httpStatus: 404,
        });
      }

      const registered = deps.registry.get(input.skillId);
      const manifest = detail.currentManifest ?? registered?.manifest ?? detail.catalogEntry?.manifest;
      const version = detail.installedVersion ?? detail.latestVersion;
      const versionEntity = version
        ? deps.db.withReadConnection((db) => deps.versionRepo.getVersion(db, input.skillId, version))
        : null;
      const packageIntegrity = buildPackageIntegrity(input.skillId, detail.installedVersion, versionEntity);
      const manifestVerdict = buildManifestIssues(manifest, registered);
      const checkedBins = manifest?.requirements.bins ?? [];
      const missingBins = checkedBins.filter((bin) => !probeBin(bin));
      const dependencyCheck = {
        ok: missingBins.length === 0,
        checkedBins,
        missingBins,
      };

      let runtimeDryRun: FridaySkillVerificationEvidence["runtimeDryRun"];
      if (registered) {
        runtimeDryRun = {
          attempted: true,
          ok: registered.validation.ok,
          executable: registered.validation.ok,
          reason: registered.validation.ok
            ? "Registry loaded the skill and validation passed."
            : registered.validation.issues[0]?.message ?? "Registry validation failed.",
        };
      } else if (detail.installedVersion) {
        const skillDir = join(
          deps.managedSkillsDir,
          safeDirName(input.skillId),
          safeDirName(detail.installedVersion),
        );
        if (existsSync(join(skillDir, "skill.manifest.json"))) {
          const loaded = loadFridaySkillPackage({
            skillDir,
            workspaceDir: skillDir,
          });
          if (loaded.ok) {
            const validation = validateFridaySkillPackage({
              loaded: loaded.value,
              workspaceDir: skillDir,
              hubVersion: deps.hubVersion,
              supportedApiVersions: deps.supportedApiVersions,
            });
            runtimeDryRun = {
              attempted: true,
              ok: validation.ok,
              executable: validation.ok,
              reason: validation.ok
                ? "Installed skill package passed dry-run validation."
                : validation.issues[0]?.message ?? "Installed skill package failed dry-run validation.",
            };
          } else {
            runtimeDryRun = {
              attempted: true,
              ok: false,
              executable: false,
              reason: loaded.error.message,
            };
          }
        } else {
          runtimeDryRun = {
            attempted: true,
            ok: false,
            executable: false,
            reason: "Installed package does not expose an unpacked skill manifest.",
          };
        }
      } else {
        runtimeDryRun = {
          attempted: false,
          ok: false,
          executable: false,
          reason: "Skill is not installed, so runtime dry-run is unavailable.",
        };
      }

      const sourceDetails = detail.sourceDetails ?? getSource(detail.sourceId);
      const catalogEntry = detail.catalogEntry ?? findExactCatalogItem(getCatalogCandidates(input.skillId), input.skillId, version);
      const verificationResult = versionEntity
        ? ({
          integrityValid: packageIntegrity.ok,
          signatureValid: catalogEntry?.signatureValid ?? false,
          checks: packageIntegrity.available
            ? [packageIntegrity.ok ? "integrity:pass" : "integrity:fail"]
            : ["integrity:unavailable"],
        } satisfies FridaySignatureVerificationResult)
        : null;
      const trustBreakdown = sourceDetails && catalogEntry && verificationResult
        ? deps.trustScoring.computeScore({
          verification: verificationResult,
          trustPolicy: sourceDetails.trustPolicy,
          hasPinnedKeys: sourceDetails.pinnedKeyIds.length > 0,
          keyPinningPassed: verificationResult.checks.includes("key-pinning:pass"),
          publisherInstallCount: detail.installations.filter((installation) => installation.status === "installed").length,
          indexedAt: catalogEntry.releasedAt ?? deps.nowIso(),
          nowIso: deps.nowIso(),
          cacheTtlHours: 6,
        })
        : null;
      const trustSummary = buildTrustSummary({
        source: sourceDetails,
        catalogEntry,
        verification: verificationResult,
        score: trustBreakdown,
        registered,
      });

      const ok = manifestVerdict.ok
        && dependencyCheck.ok
        && (!packageIntegrity.available || packageIntegrity.ok)
        && runtimeDryRun.ok
        && trustSummary.verdict !== "blocked";
      const preflight = buildSkillPreflightSummary({
        manifestVerdict,
        packageIntegrity,
        dependencyCheck,
        runtimeDryRun,
        trustSummary,
        requirementPreview: detail.requirementPreview,
        permissionPreview: detail.permissionPreview,
      });

      const evidence: FridaySkillVerificationEvidence = {
        skillId: input.skillId,
        verifiedAt: deps.nowIso(),
        ok,
        preflight,
        manifestVerdict,
        packageIntegrity,
        dependencyCheck,
        runtimeDryRun,
        trustSummary,
      };

      if (!ok) {
        await reportSkillFailure({
          userId: input.userId,
          skillId: input.skillId,
          stage: "verify",
          message: runtimeDryRun.reason,
        });
      }

      return evidence;
    },

    validateManifest(manifest) {
      const parsed = safeParseFridaySkillManifestV2(manifest);
      if (parsed.success) {
        return { ok: true, issues: [] };
      }
      return {
        ok: false,
        issues: parsed.error.issues.map((issue) => ({
          code: "MANIFEST_SCHEMA_INVALID",
          severity: "error" as const,
          message: `${issue.path.join(".")}: ${issue.message}`,
          path: issue.path.join("."),
        })),
      };
    },
  };
}
