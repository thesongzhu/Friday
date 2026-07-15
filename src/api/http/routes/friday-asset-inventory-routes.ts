import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { FridayAutonomySubjectRecord } from "../../../autonomy/model/friday-autonomy-subject.types.js";
import type { FridayAgentAutomationRecord } from "../../../agent/services/friday-agent-automation-service.types.js";
import { createFridayMemoryOutputFilter } from "#memory";

export interface FridayAssetInventoryRoutesDeps {
  subjectInventory: { list(): FridayAutonomySubjectRecord[] };
  listLearnedFacts?: (input: { userId: string }) => Array<{
    key: string;
    value: unknown;
    confidence: number;
    evidenceCount: number;
    lastConfirmedAt: string;
  }>;
  deleteLearnedFact?: (input: { userId: string; key: string }) => boolean;
  listAutomations?: () => FridayAgentAutomationRecord[];
}

export type FridayAssetInventoryCategory = "runtime" | "knowledge" | "automation";

export interface FridayAssetInventoryItem {
  category: FridayAssetInventoryCategory;
  kind: string;
  id: string;
  displayName: string;
  status: string;
  details: Record<string, unknown>;
  controls: {
    canDelete?: boolean;
    canDisable?: boolean;
    viewUrl?: string;
  };
}

const SUBJECT_DETAILS_ALLOWLIST: Record<string, readonly string[]> = {
  skill: ["source", "origin", "entrypoint"],
  workflow: ["slug", "latestVersionNumber", "publishedVersionNumber"],
  provider_profile: ["providerKind", "validationStatus", "supportedModels"],
  plugin: ["source", "enabled", "kinds"],
  mcp_server: ["transport", "toolCount", "resourceCount"],
  channel_adapter: ["running", "credentialStatus", "restartCount"],
};

const SUBJECT_VIEW_URL: Record<string, string> = {
  skill: "/skills",
  workflow: "/workflows",
  provider_profile: "/settings",
  plugin: "/plugins",
  mcp_server: "/mcp",
  channel_adapter: "/channels",
};

function projectSubjectDetails(
  kind: string,
  details: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!details) return {};
  const allowed = SUBJECT_DETAILS_ALLOWLIST[kind];
  if (!allowed) return {};
  const projected: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in details) {
      projected[key] = details[key];
    }
  }
  return projected;
}

function confidenceToStatus(confidence: number): string {
  if (confidence >= 0.7) return "high_confidence";
  if (confidence >= 0.4) return "medium_confidence";
  return "low_confidence";
}

export function createFridayAssetInventoryRoutes(
  deps: FridayAssetInventoryRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  // Learned facts bypass the write-time PII guard (written verbatim), so their free-form
  // `value` is routed through the SAME production PII output filter (#1607) as a final egress
  // transform here — no raw PII (full-width / CJK / ASCII) leaks into the asset inventory.
  const outputFilter = createFridayMemoryOutputFilter();
  return [
    {
      operationId: "assets.inventory.list",
      method: "GET",
      path: "/v1/assets/inventory",
      auth: { public: true },
      async handler(ctx) {
        const userId = (ctx.principal as { userId?: string } | null)?.userId;
        const items: FridayAssetInventoryItem[] = [];
        const categories: FridayAssetInventoryCategory[] = ["runtime"];

        for (const subject of deps.subjectInventory.list()) {
          items.push({
            category: "runtime",
            kind: subject.kind,
            id: subject.id,
            displayName: subject.displayName,
            status: subject.status,
            details: projectSubjectDetails(subject.kind, subject.details),
            controls: {
              viewUrl: SUBJECT_VIEW_URL[subject.kind],
            },
          });
        }

        if (userId && deps.listLearnedFacts) {
          categories.push("knowledge");
          for (const fact of deps.listLearnedFacts({ userId })) {
            items.push({
              category: "knowledge",
              kind: "learned_fact",
              id: fact.key,
              displayName: fact.key,
              status: confidenceToStatus(fact.confidence),
              details: {
                value: outputFilter.redactLearnedFactValue(fact.value),
                confidence: fact.confidence,
                evidenceCount: fact.evidenceCount,
                lastConfirmedAt: fact.lastConfirmedAt,
              },
              controls: {
                canDelete: !!deps.deleteLearnedFact,
              },
            });
          }
        }

        if (userId && deps.listAutomations) {
          categories.push("automation");
          for (const automation of deps.listAutomations()) {
            items.push({
              category: "automation",
              kind: "automation",
              id: automation.id,
              displayName: automation.name || automation.taskTemplate,
              status: automation.enabled ? "enabled" : "disabled",
              details: {
                reuseCount: automation.reuseCount,
                runCount: automation.runCount,
                lastRunAt: automation.lastRunAt,
                promotionState: automation.promotionState,
                estimatedTimeSavedMinutes: automation.estimatedTimeSavedMinutes,
              },
              controls: {
                canDelete: true,
                canDisable: true,
                viewUrl: "/automations",
              },
            });
          }
        }

        return { items, categories };
      },
    },
  ];
}
