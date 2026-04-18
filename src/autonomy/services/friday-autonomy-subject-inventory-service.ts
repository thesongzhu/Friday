import {
  defaultFridayAutonomyUpgradeFields,
  type FridayAutonomyCanaryStats,
  type FridayAutonomyCompatibilityStatus,
  type FridayAutonomyUpgradeFields,
  type FridayAutonomyPromotionChannel,
} from "../model/friday-autonomy-upgrade.types.js";
import type { FridayAutonomySubjectRecord } from "../model/friday-autonomy-subject.types.js";
import type { FridaySqliteLayer } from "#state";
import type { FridaySkillRepository } from "../../skills/persistence/friday-skill-repository.js";
import type { FridayWorkflowRepository } from "../../workflows/persistence/friday-workflow-repository.js";
import type { FridayProviderProfileRepository } from "../../providers/persistence/friday-provider-profile-repository.js";
import type { FridayPluginRegistryService } from "../../plugins/services/friday-plugin-registry-service.js";
import type { FridayMcpAdapter } from "../../agent/mcp/friday-mcp-adapter.types.js";
import type { FridayChannelRegistry } from "../../channels/friday-channel-registry.js";
import type { FridayAutonomySubjectUpgradeStateRepository } from "../persistence/friday-autonomy-subject-upgrade-state-repository.js";

export interface FridayAutonomySubjectInventoryService {
  list(): FridayAutonomySubjectRecord[];
}

export interface CreateFridayAutonomySubjectInventoryServiceDeps {
  sqlite: FridaySqliteLayer;
  skillRepo: FridaySkillRepository;
  workflowRepo: FridayWorkflowRepository;
  providerProfileRepo: FridayProviderProfileRepository;
  pluginRegistry: Pick<FridayPluginRegistryService, "list">;
  subjectUpgradeStateRepo?: FridayAutonomySubjectUpgradeStateRepository;
  mcpAdapter?: Pick<FridayMcpAdapter, "listServers" | "listServerStates">;
  channelRegistry?: Pick<FridayChannelRegistry, "listViews">;
}

type FridayAutonomyUpgradeLikeInput = {
  lastVerifiedAt?: string | null;
  lastVerifiedRuntimeVersion?: string | null;
  lastVerifiedProviderModel?: string | null;
  compatibilityStatus?: FridayAutonomyCompatibilityStatus;
  promotionChannel?: FridayAutonomyPromotionChannel;
  shadowVersionId?: string | null;
  canaryStats?: FridayAutonomyCanaryStats | null;
};

function withUpgradeDefaults(
  input: FridayAutonomyUpgradeLikeInput | undefined,
): FridayAutonomyUpgradeFields {
  const defaults = defaultFridayAutonomyUpgradeFields();
  return {
    lastVerifiedAt: input?.lastVerifiedAt ?? undefined,
    lastVerifiedRuntimeVersion: input?.lastVerifiedRuntimeVersion ?? undefined,
    lastVerifiedProviderModel: input?.lastVerifiedProviderModel ?? undefined,
    compatibilityStatus: input?.compatibilityStatus ?? defaults.compatibilityStatus,
    promotionChannel: input?.promotionChannel ?? defaults.promotionChannel,
    shadowVersionId: input?.shadowVersionId ?? undefined,
    canaryStats: input?.canaryStats ?? undefined,
  };
}

export function createFridayAutonomySubjectInventoryService(
  deps: CreateFridayAutonomySubjectInventoryServiceDeps,
): FridayAutonomySubjectInventoryService {
  const {
    sqlite,
    skillRepo,
    workflowRepo,
    providerProfileRepo,
    pluginRegistry,
    subjectUpgradeStateRepo,
    mcpAdapter,
    channelRegistry,
  } = deps;

  return {
    list() {
      const subjects: FridayAutonomySubjectRecord[] = [];
      const subjectUpgradeStateByKey = subjectUpgradeStateRepo
        ? sqlite.withReadConnection((db) =>
            new Map(
              subjectUpgradeStateRepo
                .list(db)
                .map((state) => [`${state.subjectKind}:${state.subjectId}`, state] as const),
            ))
        : new Map<string, ReturnType<FridayAutonomySubjectUpgradeStateRepository["list"]>[number]>();

      sqlite.withReadConnection((db) => {
        for (const skill of skillRepo.listAll(db)) {
          subjects.push({
            kind: "skill",
            id: skill.id,
            displayName: skill.name,
            status: skill.status,
            activeVersion: skill.installedVersion ?? skill.latestVersion,
            details: {
              source: skill.source,
              origin: skill.origin,
              runtimeApiVersion: skill.currentManifest?.runtime.apiVersion,
              minHubVersion: skill.currentManifest?.runtime.minHubVersion,
              entrypoint: skill.currentManifest?.runtime.entrypoint,
            },
            ...withUpgradeDefaults(skill),
          });
        }

        for (const workflow of workflowRepo.listWorkflows(db, { limit: 1000 })) {
          subjects.push({
            kind: "workflow",
            id: workflow.id,
            displayName: workflow.name,
            status: workflow.isArchived ? "archived" : workflow.publishedVersionNumber ? "published" : "draft",
            activeVersion: workflow.publishedVersionNumber?.toString() ?? workflow.latestVersionNumber.toString(),
            details: {
              slug: workflow.slug,
              latestVersionNumber: workflow.latestVersionNumber,
              publishedVersionNumber: workflow.publishedVersionNumber,
            },
            ...withUpgradeDefaults(workflow),
          });
        }

        for (const profile of providerProfileRepo.list(db)) {
          subjects.push({
            kind: "provider_profile",
            id: profile.id,
            displayName: profile.name,
            status: profile.enabled ? "enabled" : "disabled",
            activeVersion: profile.defaultModel,
            details: {
              providerKind: profile.kind,
              baseUrl: profile.baseUrl,
              api: profile.config.api,
              authMode: profile.config.authMode,
              keySourceKind: profile.config.keySource.kind,
              validationStatus: profile.config.validation?.status ?? "never",
              supportedModels: profile.config.supportedModels,
            },
            ...withUpgradeDefaults(profile),
          });
        }
      });

      for (const plugin of pluginRegistry.list()) {
        subjects.push({
          kind: "plugin",
          id: plugin.id,
          displayName: plugin.name,
          status: plugin.status,
          activeVersion: plugin.version,
          details: {
            source: plugin.source,
            enabled: plugin.enabled,
            kinds: plugin.kinds,
            minHubVersion: plugin.manifest.compatibility.minHubVersion,
            apiVersion: plugin.manifest.compatibility.apiVersion,
            requiredCapabilities: plugin.manifest.requiredCapabilities ?? [],
          },
          ...withUpgradeDefaults(plugin),
        });
      }

      if (mcpAdapter) {
        const stateById = new Map(mcpAdapter.listServerStates().map((state) => [state.serverId, state]));
        for (const server of mcpAdapter.listServers()) {
          const state = stateById.get(server.id);
          const upgradeState = subjectUpgradeStateByKey.get(`mcp_server:${server.id}`);
          subjects.push({
            kind: "mcp_server",
            id: server.id,
            displayName: server.id,
            status: state?.state ?? "configured",
            activeVersion: undefined,
            details: {
              transport: state?.transport ?? server.transport ?? (server.url ? "http" : "stdio"),
              toolCount: state?.toolCount,
              resourceCount: state?.resourceCount,
            },
            ...withUpgradeDefaults(upgradeState),
          });
        }
      }

      if (channelRegistry) {
        for (const channel of channelRegistry.listViews()) {
          const upgradeState = subjectUpgradeStateByKey.get(`channel_adapter:${channel.kind}`);
          subjects.push({
            kind: "channel_adapter",
            id: channel.kind,
            displayName: channel.kind,
            status: channel.status,
            details: {
              running: channel.running,
              credentialStatus: channel.health.credentialStatus,
              restartCount: channel.health.restartCount,
              authMode: typeof channel.diagnostics?.authMode === "string" ? channel.diagnostics.authMode : undefined,
            },
            ...withUpgradeDefaults(upgradeState),
          });
        }
      }

      return subjects.sort((a, b) => {
        const kindCompare = a.kind.localeCompare(b.kind);
        return kindCompare !== 0 ? kindCompare : a.id.localeCompare(b.id);
      });
    },
  };
}
