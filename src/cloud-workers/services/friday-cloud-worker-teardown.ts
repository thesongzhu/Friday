import { createHash } from "node:crypto";

import type {
  FridayCloudWorkerTeardownReceipt,
  FridayCloudWorkerTeardownReceiptInput,
} from "../model/friday-cloud-worker.types.js";
import type { FridayCloudWorkerCatalogService } from "./friday-cloud-worker-catalog.js";

export interface FridayCloudWorkerTeardownDeps {
  readonly catalog: FridayCloudWorkerCatalogService;
  readonly nowIso: () => string;
}

function manualCleanupStepsFor(provider: { providerId: string }): ReadonlyArray<string> {
  switch (provider.providerId) {
    case "aliyun-ecs":
      return [
        "Release the ECS instance and confirm its security group is removed.",
        "Delete attached cloud disks marked with the Friday test tag.",
        "Delete the DNSPod dedicated-subdomain record for this owner run.",
        "Confirm budget/TTL counters are decremented on the protected workflow run.",
      ];
    case "tencent-cvm":
      return [
        "Release the CVM instance and confirm its security group is removed.",
        "Delete CBS disks marked with the Friday test tag.",
        "Delete the DNSPod or Cloudflare dedicated-subdomain record for this owner run.",
        "Confirm budget/TTL counters are decremented on the protected workflow run.",
      ];
    case "volcengine-ecs":
      return [
        "Release the Volcengine ECS instance and confirm its security group is removed.",
        "Delete attached cloud disks marked with the Friday test tag.",
        "Delete the Cloudflare dedicated-subdomain record for this owner run.",
        "Confirm budget/TTL counters are decremented on the protected workflow run.",
      ];
    default:
      return [
        "Provider is not in the Phase 17 catalog; manual cleanup is the operator's responsibility.",
      ];
  }
}

export function createFridayCloudWorkerTeardownService(
  deps: FridayCloudWorkerTeardownDeps,
) {
  return {
    issueReceipt(
      input: FridayCloudWorkerTeardownReceiptInput,
    ): FridayCloudWorkerTeardownReceipt {
      const provider = deps.catalog.getProvider(input.providerId);
      if (!provider) {
        throw new Error(
          `Unknown Friday cloud worker provider: ${input.providerId}`,
        );
      }

      const receiptId = createHash("sha256")
        .update(`${input.providerId}|${input.ownerRunId}|${input.resourceTag}|${input.satelliteId ?? "none"}`)
        .digest("hex")
        .slice(0, 16);

      return {
        providerId: input.providerId,
        receiptId,
        ownerRunId: input.ownerRunId,
        resourceTag: input.resourceTag,
        satelliteId: input.satelliteId ?? null,
        proofTier: "fixture",
        liveTeardownStatus: "blocked_by_env",
        orphanCheckSteps: [
          "Confirm the cloud-vm satellite no longer reports heartbeats in this hub.",
          "Confirm no other Friday test resources share the same owner run id.",
          "Confirm the dedicated DNS subdomain no longer resolves.",
        ],
        manualCleanupSteps: manualCleanupStepsFor(provider),
        receiptIssuedAt: deps.nowIso(),
      };
    },
  };
}

export type FridayCloudWorkerTeardownService = ReturnType<
  typeof createFridayCloudWorkerTeardownService
>;
