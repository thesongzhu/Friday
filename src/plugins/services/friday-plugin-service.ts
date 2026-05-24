/**
 * Plugin service — orchestrates registry, loader, resolver, and local trust.
 */

import * as fs from "node:fs";

import { FridayDomainError } from "#errors";
import {
  FRIDAY_CORE_CHANNEL_PLUGIN_IDS,
  FRIDAY_PLUGIN_ERROR_CODES,
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
  FridayPluginEnableOptions,
  FridayPluginInstallInput,
  FridayPluginService,
} from "./friday-plugin-service.types.js";
import { createFridayPluginHealthMonitor } from "./friday-plugin-health-monitor.js";
import { buildPluginLocalPackageBytes } from "./friday-plugin-package-bytes.js";

// ─── Factory ───

export function createFridayPluginService(
  deps: CreateFridayPluginServiceDeps,
): FridayPluginService {
  const {
    registry,
    resolver,
    loader,
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
  const pluginHealthMonitor = createFridayPluginHealthMonitor({
    onAutoDisable: (pluginId, failures) => {
      const now = nowIso();
      registry.setError(
        pluginId,
        "PLUGIN_AUTO_DISABLED",
        `Plugin auto-disabled after ${String(failures)} consecutive enable/load failures`,
        now,
      );
      registry.setStatus(pluginId, "disabled", now);
      registry.setEnabled(pluginId, false, now);
      console.warn(
        `[friday][marker] plugin_auto_disabled pluginId=${pluginId} failures=${String(failures)}`,
      );
    },
  });

  /**
   * Builds synthetic package bytes from a local install directory by reading
   * the manifest file and all declared entrypoint files. This ensures a stable
   * fingerprint that the loader can re-verify on load.
   */
  function buildLocalPackageBytes(installPath: string, manifest: FridayPluginManifest): Buffer {
    return buildPluginLocalPackageBytes(installPath, manifest, readFileAsBuffer);
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

  function assertPluginEnableAllowedByLifecycle(
    entity: FridayPluginEntity,
    options?: FridayPluginEnableOptions,
  ): void {
    if (coreIds.has(entity.id) || entity.source === "bundled") {
      return;
    }
    if (options?.lifecycleBypass === "canary" || options?.lifecycleBypass === "promote") {
      return;
    }
    if (entity.promotionChannel === "active" && entity.compatibilityStatus === "compatible") {
      return;
    }
    throw new FridayDomainError(
      "PLUGIN_LIFECYCLE_PROMOTION_REQUIRED",
      `Plugin "${entity.id}" must complete the external plugin lifecycle before it can be enabled.`,
      {
        httpStatus: 403,
        details: {
          pluginId: entity.id,
          promotionChannel: entity.promotionChannel,
          compatibilityStatus: entity.compatibilityStatus,
        },
      },
    );
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

  function recordLifecycleFailure(
    pluginId: string,
    error: unknown,
    fallbackStatus?: FridayPluginEntity["status"],
  ): void {
    const state = pluginHealthMonitor.recordFailure(pluginId);
    if (!state.autoDisabled) {
      const failureAt = nowIso();
      registry.setError(
        pluginId,
        FRIDAY_PLUGIN_ERROR_CODES.LIFECYCLE_ERROR,
        error instanceof Error ? error.message : String(error),
        failureAt,
      );
      if (fallbackStatus) {
        registry.setStatus(pluginId, fallbackStatus, failureAt);
      }
    }
  }

  return {
    listPlugins(query?: FridayPluginListQuery): FridayPluginEntity[] {
      return registry.list(query).map((entity) => enrichPluginEntity(entity));
    },

    getPlugin(pluginId: string): FridayPluginEntity | null {
      const entity = registry.get(pluginId);
      return entity ? enrichPluginEntity(entity) : null;
    },

    isPluginRuntimeLoaded(pluginId: string): boolean {
      return loader.getLoaded().has(pluginId);
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

      // B1 truth-labeling: even when `manifest.signature` is present
      // (ed25519 keyId+value), the install path below DOES NOT verify it
      // cryptographically. The downstream `evaluateLocalTrustOnInstall` is a
      // user-approval / fingerprint trust-on-install model. The
      // `trustMode = "signed"` literal in this declaration is reserved for a
      // future signature-verifying path; the runtime here always falls into
      // the trust-on-install branch. Advise operators once at install time so
      // they don't interpret a manifest with a signature field as evidence
      // of cryptographic provenance.
      if (manifest.signature) {
        console.info(
          `[friday][plugins] Plugin "${manifest.id}" manifest declares an ed25519 signature (keyId=${JSON.stringify(manifest.signature.keyId)}), but signature verification is proof_pending in this build — installation will fall back to trust-on-install (user-approval + fingerprint). See FridayPluginSignature docstring for the B1 follow-up that adds real verification.`,
        );
      }
      let trustMode: "signed" | "trust_on_install" = "trust_on_install";
      let signatureVerified = false;
      let trustedFingerprint: string | undefined;
      // B1 truth-labeling: these signature-result fields exist in the entity
      // schema for forward-compat with a future signature-verifying path. They
      // stay undefined under the current trust-on-install model — see the
      // advisory log above and FridayPluginSignature docstring.
      let signatureAlgorithm: string | undefined;
      let signatureKeyId: string | undefined;
      let signatureValue: string | undefined;

      if (!packageBytes) {
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

    async enablePlugin(pluginId: string, options?: FridayPluginEnableOptions): Promise<FridayPluginEntity> {
      const entity = requirePlugin(pluginId);
      const policySummary = buildPolicySummary(pluginId, entity.manifest);

      assertPluginEnableAllowedByLifecycle(entity, options);

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

      if (
        entity.status !== "installed"
        && entity.status !== "configured"
        && entity.status !== "disabled"
        && entity.status !== "error"
      ) {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.INVALID_STATUS_TRANSITION,
          `Cannot enable plugin "${pluginId}" from status "${entity.status}"`,
          { httpStatus: 400, details: { pluginId, status: entity.status } },
        );
      }

      // Verify dependencies are met
      const allPlugins = registry.list();
      const resolvedLoadPlan = resolver.resolveLoadOrder(allPlugins, [pluginId]);
      const loadPlan = options?.lifecycleBypass
        ? { ...resolvedLoadPlan, lifecycleBypass: options.lifecycleBypass }
        : resolvedLoadPlan;

      const now = nowIso();
      registry.setStatus(pluginId, "enabled", now);
      registry.setEnabled(pluginId, true, now);

      // Load the plugin via loader to keep runtime state in sync
      try {
        await loader.load(loadPlan);
        pluginHealthMonitor.recordSuccess(pluginId);
      } catch (err) {
        const state = pluginHealthMonitor.recordFailure(pluginId);
        if (!state.autoDisabled) {
          const failureAt = nowIso();
          registry.setStatus(pluginId, "error", failureAt);
          registry.setEnabled(pluginId, false, failureAt);
          registry.setError(
            pluginId,
            "PLUGIN_LOAD_FAILED",
            err instanceof Error ? err.message : String(err),
            failureAt,
          );
        }
        throw err;
      }

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
          try {
            await loader.unload([pluginId]);
            pluginHealthMonitor.recordSuccess(pluginId);
          } catch (err) {
            recordLifecycleFailure(pluginId, err, entity.status);
            throw err;
          }
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
      pluginHealthMonitor.reset(pluginId);

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
          try {
            await loader.unload([pluginId]);
            pluginHealthMonitor.recordSuccess(pluginId);
          } catch (err) {
            recordLifecycleFailure(pluginId, err, entity.status);
            throw err;
          }
        } else {
          registry.setStatus(pluginId, "disabled", nowIso());
        }
      }

      registry.remove(pluginId);
      pluginHealthMonitor.reset(pluginId);
    },
  };
}
