/**
 * Core plugin system types, constants, and interfaces.
 */

// ─── Constants ───

export const FRIDAY_PLUGIN_MANIFEST_FILENAME = "friday.plugin.json" as const;

export const FRIDAY_CORE_CHANNEL_PLUGIN_IDS = [
  "friday.channel.discord",
  "friday.channel.telegram",
] as const;

export const FRIDAY_PLUGIN_SOURCE_PRECEDENCE: readonly FridayPluginSource[] = [
  "marketplace",
  "local",
  "bundled",
];

export const FRIDAY_PLUGIN_ERROR_CODES = {
  MANIFEST_NOT_FOUND: "PLUGIN_MANIFEST_NOT_FOUND",
  MANIFEST_INVALID: "PLUGIN_MANIFEST_INVALID",
  MANIFEST_PARSE_ERROR: "PLUGIN_MANIFEST_PARSE_ERROR",
  NOT_FOUND: "PLUGIN_NOT_FOUND",
  ALREADY_INSTALLED: "PLUGIN_ALREADY_INSTALLED",
  ALREADY_ENABLED: "PLUGIN_ALREADY_ENABLED",
  ALREADY_DISABLED: "PLUGIN_ALREADY_DISABLED",
  NOT_INSTALLED: "PLUGIN_NOT_INSTALLED",
  NOT_ENABLED: "PLUGIN_NOT_ENABLED",
  NOT_DISABLED: "PLUGIN_NOT_DISABLED",
  INVALID_STATUS_TRANSITION: "PLUGIN_INVALID_STATUS_TRANSITION",
  DEPENDENCY_MISSING: "PLUGIN_DEPENDENCY_MISSING",
  DEPENDENCY_VERSION_MISMATCH: "PLUGIN_DEPENDENCY_VERSION_MISMATCH",
  DEPENDENCY_CYCLE: "PLUGIN_DEPENDENCY_CYCLE",
  LOAD_FAILED: "PLUGIN_LOAD_FAILED",
  ENTRYPOINT_MISSING: "PLUGIN_ENTRYPOINT_MISSING",
  ENTRYPOINT_INVALID: "PLUGIN_ENTRYPOINT_INVALID",
  LIFECYCLE_ERROR: "PLUGIN_LIFECYCLE_ERROR",
  UNINSTALL_BLOCKED: "PLUGIN_UNINSTALL_BLOCKED",
  CORE_PLUGIN_PROTECTED: "PLUGIN_CORE_PLUGIN_PROTECTED",
  SIGNATURE_REQUIRED: "PLUGIN_SIGNATURE_REQUIRED",
  SIGNATURE_INVALID: "PLUGIN_SIGNATURE_INVALID",
  TRUST_FINGERPRINT_MISMATCH: "PLUGIN_TRUST_FINGERPRINT_MISMATCH",
  DISCOVERY_FAILED: "PLUGIN_DISCOVERY_FAILED",
  PREVIEW_POLICY_BLOCKED: "PLUGIN_PREVIEW_POLICY_BLOCKED",
} as const;

export const FRIDAY_PLUGIN_VALID_STATUSES: readonly FridayPluginStatus[] = [
  "not_installed",
  "installed",
  "configured",
  "enabled",
  "running",
  "disabled",
  "error",
  "uninstalled",
];

export const FRIDAY_PLUGIN_VALID_KINDS: readonly FridayPluginKind[] = [
  "channel",
  "provider",
  "skill",
  "storage",
  "integration",
];

export const FRIDAY_PLUGIN_VALID_SOURCES: readonly FridayPluginSource[] = [
  "bundled",
  "local",
  "marketplace",
];

export const FRIDAY_PLUGIN_VALID_TRUST_MODES: readonly FridayPluginTrustMode[] = [
  "signed",
  "trust_on_install",
];

export const FRIDAY_PLUGIN_SDK_PREVIEW_VERSION = "2026-03-preview" as const;

export const FRIDAY_PLUGIN_VALID_SDK_PREVIEW_CAPABILITIES: readonly FridayPluginSdkPreviewCapability[] = [
  "registerTool",
  "registerChannel",
  "registerProvider",
  "registerSkillPack",
  "registerRoutes",
  "registerHooks",
];

// ─── Core Types ───

export type FridayPluginKind =
  | "channel"
  | "provider"
  | "skill"
  | "storage"
  | "integration";

export type FridayPluginSource = "bundled" | "local" | "marketplace";

export type FridayPluginStatus =
  | "not_installed"
  | "installed"
  | "configured"
  | "enabled"
  | "running"
  | "disabled"
  | "error"
  | "uninstalled";

export type FridayPluginTrustMode = "signed" | "trust_on_install";

export type FridayPluginSdkPreviewCapability =
  | "registerTool"
  | "registerChannel"
  | "registerProvider"
  | "registerSkillPack"
  | "registerRoutes"
  | "registerHooks";

export type FridayPluginPublisherProgram =
  | "first_party"
  | "allowlisted_partner"
  | "untrusted";

// ─── Permission Types ───

export type FridayPluginPermissionResource =
  | "filesystem"
  | "network"
  | "channel"
  | "tool"
  | "memory"
  | "device"
  | "shell"
  | "provider"
  | "storage"
  | "hook";

export type FridayPluginPermissionAction =
  | "read"
  | "write"
  | "connect"
  | "send"
  | "receive"
  | "execute"
  | "register";

export interface FridayPluginPermissionGrantSelectors {
  pathPrefixes?: string[];
  hostAllowlist?: string[];
  channelIds?: string[];
  toolAllowlist?: string[];
  memoryNamespaces?: string[];
  providerKinds?: string[];
  hookNames?: string[];
}

export interface FridayPluginPermissionGrant {
  id: string;
  resource: FridayPluginPermissionResource;
  action: FridayPluginPermissionAction;
  required: boolean;
  reason: string;
  selectors?: FridayPluginPermissionGrantSelectors;
}

export type FridayPluginPromptOnAction =
  | "filesystem.write"
  | "network.connect"
  | "shell.execute"
  | "channel.send"
  | "provider.execute";

export interface FridayPluginPermissionPolicy {
  grants: FridayPluginPermissionGrant[];
  promptOn: FridayPluginPromptOnAction[];
}

// ─── Signature Types ───

export interface FridayPluginSignature {
  algorithm: "ed25519";
  keyId: string;
  value: string;
}

export interface FridayPluginSdkPreviewManifest {
  sdkVersion: string;
  capabilities: FridayPluginSdkPreviewCapability[];
  publisherId?: string;
}

export interface FridayPluginCapabilitySummary {
  previewEnabled: boolean;
  sdkVersion: string | null;
  requestedCapabilities: FridayPluginSdkPreviewCapability[];
  supportedCapabilities: FridayPluginSdkPreviewCapability[];
  unsupportedCapabilities: FridayPluginSdkPreviewCapability[];
}

export interface FridayPluginPolicySummary {
  publisherProgram: FridayPluginPublisherProgram;
  installAllowed: boolean;
  enableAllowed: boolean;
  reasons: string[];
}

// ─── Manifest ───

/** Host capabilities that a plugin may require (Initiative G.1). */
export type FridayPluginRequiredCapability =
  | "filesystem"
  | "network"
  | "shell"
  | "memory"
  | "channel"
  | "browser"
  | "desktop"
  | "provider"
  | "mcp";

export interface FridayPluginManifest {
  schemaVersion: "1.0";
  id: string;
  version: string;
  name: string;
  description: string;
  kinds: FridayPluginKind[];
  entrypoints: Partial<Record<FridayPluginKind, string>>;
  dependencies?: Record<string, string>;
  permissions: FridayPluginPermissionPolicy;
  compatibility: {
    minHubVersion: string;
    apiVersion: "1";
  };
  signature?: FridayPluginSignature;
  previewSdk?: FridayPluginSdkPreviewManifest;
  /**
   * Host capabilities this plugin requires (Initiative G.1).
   * Install/enable will fail if the host does not support all listed capabilities.
   */
  requiredCapabilities?: FridayPluginRequiredCapability[];
}

// ─── Persistence Entity ───

export interface FridayPluginEntity {
  id: string;
  name: string;
  description: string;
  version: string;
  source: FridayPluginSource;
  status: FridayPluginStatus;
  enabled: boolean;
  trustMode: FridayPluginTrustMode;
  installPath: string;
  kinds: FridayPluginKind[];
  manifest: FridayPluginManifest;
  config: Record<string, unknown>;
  signatureAlgorithm: string | null;
  signatureKeyId: string | null;
  signatureValue: string | null;
  signatureVerified: boolean;
  trustedFingerprintSha256: string | null;
  lastVerifiedAt: string | null;
  installedAt: string;
  updatedAt: string;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  capabilitySummary?: FridayPluginCapabilitySummary;
  policySummary?: FridayPluginPolicySummary;
}

export interface FridayPluginDependencyEntity {
  pluginId: string;
  dependencyPluginId: string;
  semverRange: string;
  optional: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── Repository Input/Query Types ───

export interface FridayUpsertPluginInput {
  id: string;
  name: string;
  description: string;
  version: string;
  source: FridayPluginSource;
  status: FridayPluginStatus;
  enabled: boolean;
  trustMode: FridayPluginTrustMode;
  installPath: string;
  kinds: FridayPluginKind[];
  manifest: FridayPluginManifest;
  config?: Record<string, unknown>;
  signatureAlgorithm?: string;
  signatureKeyId?: string;
  signatureValue?: string;
  signatureVerified?: boolean;
  trustedFingerprintSha256?: string;
  lastVerifiedAt?: string;
  nowIso: string;
}

export interface FridayPluginListQuery {
  source?: FridayPluginSource;
  status?: FridayPluginStatus;
  kind?: FridayPluginKind;
  enabled?: boolean;
}

export interface FridayUpsertPluginDependencyInput {
  pluginId: string;
  dependencyPluginId: string;
  semverRange: string;
  optional: boolean;
  nowIso: string;
}

// ─── Discovery Types ───

export interface FridayDiscoveredPluginCandidate {
  id: string;
  version: string;
  source: FridayPluginSource;
  manifest: FridayPluginManifest;
  installPath: string;
}

// ─── Dependency Resolution Types ───

export interface FridayPluginInstallPlanInput {
  pluginId: string;
  installDependencies?: boolean;
}

export interface FridayPluginInstallPlanItem {
  pluginId: string;
  version: string;
  source: FridayPluginSource;
  reason: "requested" | "dependency";
}

export interface FridayPluginInstallPlan {
  items: FridayPluginInstallPlanItem[];
  warnings: string[];
}

export interface FridayPluginLoadPlan {
  order: string[];
  warnings: string[];
}

// ─── Loaded Plugin Types ───

export interface FridayPluginEntrypointModule {
  activate?(context: FridayPluginActivationContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}

export interface FridayPluginActivationContext {
  pluginId: string;
  config: Record<string, unknown>;
}

export interface FridayLoadedPlugin {
  id: string;
  manifest: FridayPluginManifest;
  modules: Map<FridayPluginKind, FridayPluginEntrypointModule>;
}

// ─── Registered Plugin ───

export interface FridayRegisteredPlugin {
  id: string;
  version: string;
  source: FridayPluginSource;
  manifest: FridayPluginManifest;
  entity: FridayPluginEntity;
}
