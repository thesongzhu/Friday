/**
 * Plugin service — orchestrates registry, loader, resolver, marketplace, signatures.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { FridayDomainError } from "#errors";
import { safeDirName } from "#utilities";
import {
  FRIDAY_CORE_CHANNEL_PLUGIN_IDS,
  FRIDAY_PLUGIN_ERROR_CODES,
  FRIDAY_PLUGIN_MANIFEST_FILENAME,
  FRIDAY_PLUGIN_SDK_PREVIEW_VERSION,
  FRIDAY_PLUGIN_VALID_SDK_PREVIEW_CAPABILITIES,
} from "../model/friday-plugin.types.js";
import type {
  FridayPluginCapabilitySummary,
  FridayPluginEntity,
  FridayPluginListQuery,
  FridayPluginManifest,
  FridayPluginPolicySummary,
  FridayPluginPublisherProgram,
  FridayPluginSdkPreviewCapability,
} from "../model/friday-plugin.types.js";
import type {
  CreateFridayPluginServiceDeps,
  FridayPluginInstallInput,
  FridayPluginService,
} from "./friday-plugin-service.types.js";
import type {
  FridayMarketplacePluginDetail,
  FridayMarketplaceSearchQuery,
  FridayMarketplaceSearchResult,
} from "./friday-plugin-marketplace-client.js";

// ─── Factory ───

export function createFridayPluginService(
  deps: CreateFridayPluginServiceDeps,
): FridayPluginService {
  const {
    registry,
    resolver,
    loader,
    marketplace,
    signatureVerifier,
    previewPolicy,
    nowIso,
  } = deps;

  const readFileAsBuffer = deps.readFileAsBuffer ?? ((filePath: string): Buffer =>
    fs.readFileSync(filePath)
  );

  const coreIds = new Set<string>(FRIDAY_CORE_CHANNEL_PLUGIN_IDS);
  const supportedCapabilities = new Set<FridayPluginSdkPreviewCapability>(
    previewPolicy?.supportedCapabilities ?? FRIDAY_PLUGIN_VALID_SDK_PREVIEW_CAPABILITIES,
  );
  const firstPartyIdPrefixes = previewPolicy?.firstPartyIdPrefixes ?? ["friday."];
  const allowlistedPluginIds = new Set(previewPolicy?.allowlistedPluginIds ?? []);
  const allowlistedPublisherIds = new Set(previewPolicy?.allowlistedPublisherIds ?? []);
  const supportedSdkVersion = previewPolicy?.sdkVersion ?? FRIDAY_PLUGIN_SDK_PREVIEW_VERSION;

  /**
   * Builds synthetic package bytes from a local install directory by reading
   * the manifest file and all declared entrypoint files. This ensures a stable
   * fingerprint that the loader can re-verify on load.
   */
  function buildLocalPackageBytes(installPath: string, manifest: FridayPluginManifest): Buffer {
    const manifestPath = path.join(installPath, FRIDAY_PLUGIN_MANIFEST_FILENAME);
    const parts: Buffer[] = [readFileAsBuffer(manifestPath)];

    // Append entrypoint file contents in deterministic (sorted) order
    const entrypointKeys = Object.keys(manifest.entrypoints).sort();
    for (const kind of entrypointKeys) {
      const relative = manifest.entrypoints[kind as keyof typeof manifest.entrypoints];
      if (relative) {
        const fullPath = path.resolve(installPath, relative);
        parts.push(readFileAsBuffer(fullPath));
      }
    }

    return Buffer.concat(parts);
  }

  function requirePlugin(pluginId: string): FridayPluginEntity {
    const entity = registry.get(pluginId);
    if (!entity) {
      throw new FridayDomainError(
        FRIDAY_PLUGIN_ERROR_CODES.NOT_FOUND,
        `Plugin "${pluginId}" not found`,
        { httpStatus: 404, details: { pluginId } },
      );
    }
    return entity;
  }

  function assertNotCorePlugin(pluginId: string): void {
    if (coreIds.has(pluginId)) {
      throw new FridayDomainError(
        FRIDAY_PLUGIN_ERROR_CODES.CORE_PLUGIN_PROTECTED,
        `Cannot modify core plugin "${pluginId}"`,
        { httpStatus: 403, details: { pluginId } },
      );
    }
  }

  function classifyPublisherProgram(
    pluginId: string,
    manifest: FridayPluginManifest,
  ): FridayPluginPublisherProgram {
    if (firstPartyIdPrefixes.some((prefix) => pluginId.startsWith(prefix))) {
      return "first_party";
    }
    if (
      allowlistedPluginIds.has(pluginId)
      || (manifest.previewSdk?.publisherId !== undefined && allowlistedPublisherIds.has(manifest.previewSdk.publisherId))
    ) {
      return "allowlisted_partner";
    }
    return "untrusted";
  }

  function buildCapabilitySummary(manifest: FridayPluginManifest): FridayPluginCapabilitySummary {
    const requestedCapabilities = manifest.previewSdk?.capabilities ?? [];
    const supportedList = requestedCapabilities.filter((capability) => supportedCapabilities.has(capability));
    const unsupportedList = requestedCapabilities.filter((capability) => !supportedCapabilities.has(capability));

    return {
      previewEnabled: manifest.previewSdk !== undefined,
      sdkVersion: manifest.previewSdk?.sdkVersion ?? null,
      requestedCapabilities,
      supportedCapabilities: supportedList,
      unsupportedCapabilities: unsupportedList,
    };
  }

  function buildPolicySummary(
    pluginId: string,
    manifest: FridayPluginManifest,
  ): FridayPluginPolicySummary {
    const capabilitySummary = buildCapabilitySummary(manifest);
    const publisherProgram = classifyPublisherProgram(pluginId, manifest);
    const reasons: string[] = [];

    if (manifest.previewSdk?.sdkVersion && manifest.previewSdk.sdkVersion !== supportedSdkVersion) {
      reasons.push(
        `Preview SDK version "${manifest.previewSdk.sdkVersion}" is not supported by this hub. Expected "${supportedSdkVersion}".`,
      );
    }

    if (capabilitySummary.unsupportedCapabilities.length > 0) {
      reasons.push(
        `Unsupported preview capabilities: ${capabilitySummary.unsupportedCapabilities.join(", ")}`,
      );
    }

    if (manifest.previewSdk !== undefined && publisherProgram === "untrusted") {
      reasons.push("Preview SDK plugins are limited to first-party and allowlisted partner publishers.");
    }

    const allowed = reasons.length === 0;

    return {
      publisherProgram,
      installAllowed: allowed,
      enableAllowed: allowed,
      reasons,
    };
  }

  function assertPreviewPolicy(pluginId: string, manifest: FridayPluginManifest): void {
    if (manifest.previewSdk === undefined) {
      return;
    }
    const policySummary = buildPolicySummary(pluginId, manifest);
    if (!policySummary.installAllowed) {
      throw new FridayDomainError(
        FRIDAY_PLUGIN_ERROR_CODES.PREVIEW_POLICY_BLOCKED,
        `Preview SDK policy blocked plugin "${pluginId}"`,
        { httpStatus: 403, details: { pluginId, policySummary } },
      );
    }
  }

  function enrichPluginEntity(entity: FridayPluginEntity): FridayPluginEntity {
    return {
      ...entity,
      capabilitySummary: buildCapabilitySummary(entity.manifest),
      policySummary: buildPolicySummary(entity.id, entity.manifest),
    };
  }

  return {
    listPlugins(query?: FridayPluginListQuery): FridayPluginEntity[] {
      return registry.list(query).map((entity) => enrichPluginEntity(entity));
    },

    getPlugin(pluginId: string): FridayPluginEntity | null {
      const entity = registry.get(pluginId);
      return entity ? enrichPluginEntity(entity) : null;
    },

    listPluginVersions(pluginId: string) {
      const entity = requirePlugin(pluginId);
      // Return the currently installed version as the only known version
      return [
        {
          version: entity.version,
          installedAt: entity.installedAt,
          status: entity.status,
        },
      ];
    },

    installPlugin(input: FridayPluginInstallInput): FridayPluginEntity {
      const { manifest, installPath, source, packageBytes, userApproved } = input;

      assertPreviewPolicy(manifest.id, manifest);

      // Check not already installed
      const existing = registry.get(manifest.id);
      if (existing && existing.status !== "uninstalled") {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.ALREADY_INSTALLED,
          `Plugin "${manifest.id}" is already installed`,
          { httpStatus: 409, details: { pluginId: manifest.id } },
        );
      }

      // Determine trust mode and verify
      let trustMode: "signed" | "trust_on_install" = "trust_on_install";
      let signatureVerified = false;
      let trustedFingerprint: string | undefined;
      let signatureAlgorithm: string | undefined;
      let signatureKeyId: string | undefined;
      let signatureValue: string | undefined;

      if (source === "marketplace") {
        // Marketplace requires signature
        if (!manifest.signature) {
          throw new FridayDomainError(
            FRIDAY_PLUGIN_ERROR_CODES.SIGNATURE_REQUIRED,
            `Marketplace plugin "${manifest.id}" must have a signature`,
            { httpStatus: 400, details: { pluginId: manifest.id } },
          );
        }
        if (!packageBytes) {
          throw new FridayDomainError(
            FRIDAY_PLUGIN_ERROR_CODES.SIGNATURE_REQUIRED,
            `Marketplace plugin "${manifest.id}" requires packageBytes for signature verification`,
            { httpStatus: 400, details: { pluginId: manifest.id } },
          );
        }

        // Compute checksum and verify Ed25519 signature
        const expectedChecksum = signatureVerifier.computeChecksum(packageBytes);
        const verifyResult = signatureVerifier.verifyMarketplacePackage({
          pluginId: manifest.id,
          version: manifest.version,
          packageBytes,
          expectedChecksum,
          signature: manifest.signature,
          publicKeyPem: manifest.signature.keyId, // resolved by verifier
        });

        trustMode = "signed";
        signatureAlgorithm = manifest.signature.algorithm;
        signatureKeyId = manifest.signature.keyId;
        signatureValue = manifest.signature.value;
        signatureVerified = verifyResult.verified;
      } else if (source === "local") {
        // Local install: trust-on-install always enforced
        if (!packageBytes) {
          // No package bytes — read manifest + entrypoints from disk to compute fingerprint
          if (!userApproved) {
            throw new FridayDomainError(
              FRIDAY_PLUGIN_ERROR_CODES.SIGNATURE_REQUIRED,
              `Local plugin "${manifest.id}" requires user approval for trust-on-install`,
              { httpStatus: 403, details: { pluginId: manifest.id } },
            );
          }
          const localBytes = buildLocalPackageBytes(installPath, manifest);
          const result = signatureVerifier.evaluateLocalTrustOnInstall({
            pluginId: manifest.id,
            version: manifest.version,
            packageBytes: localBytes,
            userApproved: true,
          });
          trustedFingerprint = result.fingerprint;
          signatureVerified = result.verified;
        } else {
          const result = signatureVerifier.evaluateLocalTrustOnInstall({
            pluginId: manifest.id,
            version: manifest.version,
            packageBytes,
            userApproved: userApproved ?? false,
          });
          trustedFingerprint = result.fingerprint;
          signatureVerified = result.verified;
        }
      }

      // Register in database
      const now = nowIso();
      const entity = registry.upsert({
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        source,
        status: "installed",
        enabled: false,
        trustMode,
        installPath,
        kinds: manifest.kinds,
        manifest,
        signatureAlgorithm,
        signatureKeyId,
        signatureValue,
        signatureVerified,
        trustedFingerprintSha256: trustedFingerprint,
        nowIso: now,
      });

      return enrichPluginEntity(entity);
    },

    async enablePlugin(pluginId: string): Promise<FridayPluginEntity> {
      const entity = requirePlugin(pluginId);
      const policySummary = buildPolicySummary(pluginId, entity.manifest);

      if (!policySummary.enableAllowed) {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.PREVIEW_POLICY_BLOCKED,
          `Preview SDK policy blocked enablement for plugin "${pluginId}"`,
          { httpStatus: 403, details: { pluginId, policySummary } },
        );
      }

      if (entity.status === "enabled" || entity.status === "running") {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.ALREADY_ENABLED,
          `Plugin "${pluginId}" is already enabled`,
          { httpStatus: 409, details: { pluginId, status: entity.status } },
        );
      }

      if (entity.status !== "installed" && entity.status !== "configured" && entity.status !== "disabled") {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.INVALID_STATUS_TRANSITION,
          `Cannot enable plugin "${pluginId}" from status "${entity.status}"`,
          { httpStatus: 400, details: { pluginId, status: entity.status } },
        );
      }

      // Verify dependencies are met
      const allPlugins = registry.list();
      const loadPlan = resolver.resolveLoadOrder(allPlugins, [pluginId]);

      const now = nowIso();
      registry.setStatus(pluginId, "enabled", now);
      registry.setEnabled(pluginId, true, now);

      // Load the plugin via loader to keep runtime state in sync
      await loader.load(loadPlan);

      return enrichPluginEntity(requirePlugin(pluginId));
    },

    async disablePlugin(pluginId: string): Promise<FridayPluginEntity> {
      // Core plugins CAN be disabled (design: "non-uninstallable, but can be enabled/disabled")
      const entity = requirePlugin(pluginId);

      if (entity.status === "disabled") {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.ALREADY_DISABLED,
          `Plugin "${pluginId}" is already disabled`,
          { httpStatus: 409, details: { pluginId } },
        );
      }

      if (entity.status !== "enabled" && entity.status !== "running" && entity.status !== "error") {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.INVALID_STATUS_TRANSITION,
          `Cannot disable plugin "${pluginId}" from status "${entity.status}"`,
          { httpStatus: 400, details: { pluginId, status: entity.status } },
        );
      }

      // Unload from runtime if currently running
      if (entity.status === "running") {
        const loadedPlugins = loader.getLoaded();
        if (loadedPlugins.has(pluginId)) {
          await loader.unload([pluginId]);
        }
      }

      // Only update registry if loader.unload didn't already transition to disabled
      const current = requirePlugin(pluginId);
      if (current.status !== "disabled") {
        const now = nowIso();
        registry.setStatus(pluginId, "disabled", now);
        registry.setEnabled(pluginId, false, now);
      } else {
        registry.setEnabled(pluginId, false, nowIso());
      }

      return enrichPluginEntity(requirePlugin(pluginId));
    },

    async uninstallPlugin(pluginId: string, force?: boolean): Promise<void> {
      assertNotCorePlugin(pluginId);
      const entity = requirePlugin(pluginId);

      // Check reverse dependencies unless force
      if (!force) {
        const allPlugins = registry.list();
        const dependents = allPlugins.filter((p) => {
          const deps = p.manifest.dependencies ?? {};
          return Object.keys(deps).includes(pluginId);
        });

        if (dependents.length > 0) {
          throw new FridayDomainError(
            FRIDAY_PLUGIN_ERROR_CODES.UNINSTALL_BLOCKED,
            `Cannot uninstall "${pluginId}": required by ${dependents.map((d) => d.id).join(", ")}`,
            { httpStatus: 409, details: { pluginId, dependentIds: dependents.map((d) => d.id) } },
          );
        }
      }

      // If running, unload via loader first
      if (entity.status === "running") {
        const loadedPlugins = loader.getLoaded();
        if (loadedPlugins.has(pluginId)) {
          await loader.unload([pluginId]);
        } else {
          registry.setStatus(pluginId, "disabled", nowIso());
        }
      }

      registry.remove(pluginId);
    },

    async searchMarketplace(query: FridayMarketplaceSearchQuery): Promise<FridayMarketplaceSearchResult> {
      if (!marketplace) {
        // Degrade gracefully when marketplace is not configured.
        // This keeps marketplace discovery UI/API paths functional in local mode.
        return { items: [], total: 0 };
      }
      const result = await marketplace.search(query);
      return {
        ...result,
        items: result.items.map((item) => {
          const manifest = item.previewSdk
            ? {
                schemaVersion: "1.0" as const,
                id: item.id,
                version: item.version,
                name: item.name,
                description: item.description,
                kinds: [],
                entrypoints: {},
                permissions: { grants: [], promptOn: [] },
                compatibility: { minHubVersion: "0.0.0", apiVersion: "1" as const },
                previewSdk: item.previewSdk,
              }
            : undefined;

          return {
            ...item,
            capabilitySummary: manifest
              ? buildCapabilitySummary(manifest)
              : item.capabilitySummary,
            policySummary: manifest
              ? buildPolicySummary(item.id, manifest)
              : item.policySummary,
          };
        }),
      };
    },

    async listMarketplacePluginVersions(pluginId: string) {
      if (!marketplace) {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.DISCOVERY_FAILED,
          "Marketplace client is not configured",
          { httpStatus: 503 },
        );
      }
      const versions = await marketplace.listVersions(pluginId);
      return versions.map((v) => ({
        version: v.version,
        releasedAt: v.releasedAt,
        checksum: v.checksum,
      }));
    },

    async getMarketplacePlugin(pluginId: string): Promise<FridayMarketplacePluginDetail> {
      if (!marketplace) {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.DISCOVERY_FAILED,
          "Marketplace client is not configured",
          { httpStatus: 503 },
        );
      }
      const detail = await marketplace.getPluginDetail(pluginId);
      return {
        ...detail,
        capabilitySummary: buildCapabilitySummary(detail.manifest),
        policySummary: buildPolicySummary(detail.id, detail.manifest),
      };
    },

    async installFromMarketplace(pluginId: string): Promise<FridayPluginEntity> {
      if (!marketplace) {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.DISCOVERY_FAILED,
          "Marketplace client is not configured",
          { httpStatus: 503 },
        );
      }

      // Download from marketplace
      const downloadResult = await marketplace.downloadPackage(pluginId);
      const { packageBytes, checksum, manifest } = downloadResult;

      // Signature is required for marketplace
      if (!manifest.signature) {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.SIGNATURE_REQUIRED,
          `Marketplace plugin "${pluginId}" must have a signature`,
          { httpStatus: 400, details: { pluginId } },
        );
      }

      // Verify checksum matches
      const actualChecksum = signatureVerifier.computeChecksum(packageBytes);
      if (actualChecksum !== checksum) {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.SIGNATURE_INVALID,
          `Checksum mismatch for marketplace plugin "${pluginId}"`,
          { httpStatus: 400, details: { pluginId, expected: checksum, actual: actualChecksum } },
        );
      }

      // Install with marketplace source
      const installPath = `/plugins/marketplace/${safeDirName(manifest.id)}`;

      return this.installPlugin({
        manifest,
        installPath,
        source: "marketplace",
        packageBytes,
      });
    },
  };
}
