import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "#state";
import { createFridayPluginRegistryService, createFridayPluginRepository } from "#plugins";
import { createFridayProviderProfileRepository } from "#providers";
import { createFridaySkillRepository } from "#skills";
import { createFridayWorkflowRepository } from "#workflows";

import { createFridayAutonomySubjectInventoryService } from "../../../src/autonomy/services/friday-autonomy-subject-inventory-service.js";
import { createFridayAutonomySubjectUpgradeStateRepository } from "../../../src/autonomy/persistence/friday-autonomy-subject-upgrade-state-repository.js";
import { createTestDb } from "../satellites/_helpers/create-test-db.helper.js";

describe("FridayAutonomySubjectInventoryService", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("lists persisted and runtime-only autonomy subjects with normalized upgrade metadata", () => {
    const skillRepo = createFridaySkillRepository();
    const workflowRepo = createFridayWorkflowRepository({ db });
    const providerRepo = createFridayProviderProfileRepository();
    const pluginRepo = createFridayPluginRepository();
    const subjectUpgradeStateRepo = createFridayAutonomySubjectUpgradeStateRepository();
    const pluginRegistry = createFridayPluginRegistryService({ sqlite: db, pluginRepository: pluginRepo });

    db.withWriteTransaction((conn) => {
      skillRepo.upsertSkillFromCatalog(conn, {
        id: "skill-1",
        name: "Skill One",
        source: "local",
        origin: "managed",
        latestVersion: "1.0.0",
        status: "installed",
        nowIso: "2026-04-17T21:00:00.000Z",
      });
      skillRepo.setUpgradeMetadata(conn, "skill-1", {
        compatibilityStatus: "adaptation_required",
        promotionChannel: "shadow",
        shadowVersionId: "skill-1-shadow",
      }, "2026-04-17T21:00:00.000Z");

      workflowRepo.insertWorkflow(
        conn,
        "wf-1",
        { slug: "wf-one", name: "Workflow One" },
        "etag-1",
        "2026-04-17T21:00:00.000Z",
      );
      workflowRepo.setUpgradeMetadata(conn, "wf-1", {
        compatibilityStatus: "compatible",
        promotionChannel: "active",
      }, "2026-04-17T21:00:00.000Z");

      providerRepo.insert(conn, {
        id: "prov-1",
        kind: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        enabled: true,
        defaultModel: "claude-sonnet-4-20250514",
        config: {
          api: "anthropic-messages",
          authMode: "api-key",
          keySource: { kind: "env-ref", envVar: "FRIDAY_ANTHROPIC_API_KEY" },
          supportedModels: ["claude-sonnet-4-20250514"],
        },
        createdAt: "2026-04-17T21:00:00.000Z",
        updatedAt: "2026-04-17T21:00:00.000Z",
      });

      pluginRegistry.upsert({
        id: "plugin-1",
        name: "Plugin One",
        description: "Upgrade-aware plugin",
        version: "1.2.3",
        source: "local",
        status: "enabled",
        enabled: true,
        trustMode: "trust_on_install",
        installPath: "/plugins/plugin-1",
        kinds: ["integration"],
        manifest: {
          schemaVersion: "1.0",
          id: "plugin-1",
          version: "1.2.3",
          name: "Plugin One",
          description: "Upgrade-aware plugin",
          kinds: ["integration"],
          entrypoints: { integration: "./dist/index.js" },
          permissions: { grants: [], promptOn: [] },
          compatibility: { minHubVersion: "1.0.0", apiVersion: "1" },
        },
        compatibilityStatus: "blocked",
        promotionChannel: "none",
        nowIso: "2026-04-17T21:00:00.000Z",
      });

      subjectUpgradeStateRepo.setUpgradeMetadata(conn, "mcp_server", "mcp-1", {
        compatibilityStatus: "compatible",
        promotionChannel: "active",
        shadowVersionId: "mcp-1@shadow",
      }, "2026-04-17T21:05:00.000Z");

      subjectUpgradeStateRepo.setUpgradeMetadata(conn, "channel_adapter", "webchat", {
        compatibilityStatus: "compatible",
        promotionChannel: "canary",
      }, "2026-04-17T21:06:00.000Z");
    });

    const service = createFridayAutonomySubjectInventoryService({
      sqlite: db,
      skillRepo,
      workflowRepo,
      providerProfileRepo: providerRepo,
      pluginRegistry,
      subjectUpgradeStateRepo,
      mcpAdapter: {
        listServers: () => [{ id: "mcp-1", transport: "stdio", command: "npx", args: ["-y", "server"] }],
        listServerStates: () => [{ serverId: "mcp-1", transport: "stdio", state: "loaded", lazyDiscovery: false, toolCount: 2, resourceCount: 1 }],
      },
      channelRegistry: {
        listViews: () => [{
          kind: "webchat",
          running: true,
          status: "connected",
          health: { state: "connected", restartCount: 0, credentialStatus: "unknown" },
          diagnostics: { authMode: "none" },
          allowlist: { hasAllowedUsers: false, allowedUsersCount: 0, hasAllowedChats: false, allowedChatsCount: 0 },
        }],
      },
    });

    const subjects = service.list();
    expect(subjects.map((subject) => `${subject.kind}:${subject.id}`)).toEqual([
      "channel_adapter:webchat",
      "mcp_server:mcp-1",
      "plugin:plugin-1",
      "provider_profile:prov-1",
      "skill:skill-1",
      "workflow:wf-1",
    ]);

    const skill = subjects.find((subject) => subject.kind === "skill")!;
    expect(skill.compatibilityStatus).toBe("adaptation_required");
    expect(skill.promotionChannel).toBe("shadow");

    const workflow = subjects.find((subject) => subject.kind === "workflow")!;
    expect(workflow.promotionChannel).toBe("active");

    const mcp = subjects.find((subject) => subject.kind === "mcp_server")!;
    expect(mcp.status).toBe("loaded");
    expect(mcp.promotionChannel).toBe("active");
    expect(mcp.compatibilityStatus).toBe("compatible");

    const channel = subjects.find((subject) => subject.kind === "channel_adapter")!;
    expect(channel.status).toBe("connected");
    expect(channel.promotionChannel).toBe("canary");
    expect(channel.details?.authMode).toBe("none");
  });
});
