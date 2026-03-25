/**
 * Plugin service types — high-level orchestrator for plugin lifecycle.
 */

import type { FridaySqliteLayer } from "#state";
import type {
  FridayPluginEntity,
  FridayPluginListQuery,
  FridayPluginManifest,
  FridayPluginSdkPreviewCapability,
} from "../model/friday-plugin.types.js";
import type { FridayPluginRegistryService } from "./friday-plugin-registry-service.js";
import type { FridayPluginDependencyResolver } from "./friday-plugin-dependency-resolver.js";
import type { FridayPluginLoader } from "./friday-plugin-loader.js";
import type {
  FridayMarketplacePluginDetail,
  FridayMarketplaceSearchQuery,
  FridayMarketplaceSearchResult,
  FridayPluginMarketplaceClient,
} from "./friday-plugin-marketplace-client.js";
import type { FridayPluginSignatureVerifier } from "../security/friday-plugin-signature-verifier.js";

// ─── Version Info ───

export interface FridayPluginVersionInfo {
  version: string;
  installedAt: string;
  status: string;
}

export interface FridayMarketplacePluginVersionInfo {
  version: string;
  releasedAt: string;
  checksum: string;
}

// ─── Service Interface ───

export interface FridayPluginService {
  /** List installed plugins. */
  listPlugins(query?: FridayPluginListQuery): FridayPluginEntity[];
  /** Get a plugin by ID. */
  getPlugin(pluginId: string): FridayPluginEntity | null;
  /** List versions for a local/installed plugin. */
  listPluginVersions(pluginId: string): FridayPluginVersionInfo[];
  /** Install a local plugin from a manifest and path. */
  installPlugin(input: FridayPluginInstallInput): FridayPluginEntity;
  /** Enable an installed plugin. */
  enablePlugin(pluginId: string): Promise<FridayPluginEntity>;
  /** Disable an enabled/running plugin. */
  disablePlugin(pluginId: string): Promise<FridayPluginEntity>;
  /** Uninstall a plugin. */
  uninstallPlugin(pluginId: string, force?: boolean): Promise<void>;
  /** Search the marketplace. */
  searchMarketplace(query: FridayMarketplaceSearchQuery): Promise<FridayMarketplaceSearchResult>;
  /** Get marketplace plugin detail. */
  getMarketplacePlugin(pluginId: string): Promise<FridayMarketplacePluginDetail>;
  /** List versions for a marketplace plugin. */
  listMarketplacePluginVersions(pluginId: string): Promise<FridayMarketplacePluginVersionInfo[]>;
  /** Install a plugin from the marketplace. */
  installFromMarketplace(pluginId: string): Promise<FridayPluginEntity>;
}

export interface FridayPluginInstallInput {
  manifest: FridayPluginManifest;
  installPath: string;
  source: "local" | "marketplace";
  packageBytes?: Buffer;
  userApproved?: boolean;
}

export interface FridayPluginPreviewPolicyConfig {
  sdkVersion?: string;
  supportedCapabilities?: FridayPluginSdkPreviewCapability[];
  firstPartyIdPrefixes?: string[];
  allowlistedPluginIds?: string[];
  allowlistedPublisherIds?: string[];
}

// ─── Deps ───

export interface CreateFridayPluginServiceDeps {
  sqlite: FridaySqliteLayer;
  registry: FridayPluginRegistryService;
  resolver: FridayPluginDependencyResolver;
  loader: FridayPluginLoader;
  marketplace?: FridayPluginMarketplaceClient;
  signatureVerifier: FridayPluginSignatureVerifier;
  previewPolicy?: FridayPluginPreviewPolicyConfig;
  nowIso: () => string;
  idGenerator: () => string;
  /** Read a file from disk as a Buffer. Used to compute fingerprints for local installs. */
  readFileAsBuffer?: (filePath: string) => Buffer;
}
