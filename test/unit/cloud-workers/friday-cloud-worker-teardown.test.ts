import { describe, expect, it } from "vitest";
import {
  createFridayCloudWorkerCatalogService,
  createFridayCloudWorkerTeardownService,
} from "#cloud-workers";

function makeService() {
  const catalog = createFridayCloudWorkerCatalogService();
  return createFridayCloudWorkerTeardownService({
    catalog,
    nowIso: () => "2026-05-17T20:00:00.000Z",
  });
}

describe("Phase 17A — cloud worker teardown receipt (fixture)", () => {
  it("issues a fixture receipt with proofTier 'fixture' and liveTeardownStatus 'blocked_by_env'", () => {
    const receipt = makeService().issueReceipt({
      providerId: "aliyun-ecs",
      ownerRunId: "owner-run-1",
      resourceTag: "friday-test-worker-001",
      satelliteId: "sat-cloud-1",
    });
    expect(receipt.proofTier).toBe("fixture");
    expect(receipt.liveTeardownStatus).toBe("blocked_by_env");
    expect(receipt.satelliteId).toBe("sat-cloud-1");
    expect(receipt.receiptIssuedAt).toBe("2026-05-17T20:00:00.000Z");
  });

  it("tailors manual cleanup steps to the provider", () => {
    const aliyun = makeService().issueReceipt({
      providerId: "aliyun-ecs",
      ownerRunId: "r",
      resourceTag: "t",
    });
    const tencent = makeService().issueReceipt({
      providerId: "tencent-cvm",
      ownerRunId: "r",
      resourceTag: "t",
    });
    const volcengine = makeService().issueReceipt({
      providerId: "volcengine-ecs",
      ownerRunId: "r",
      resourceTag: "t",
    });
    expect(aliyun.manualCleanupSteps.join(" ")).toMatch(/ECS/);
    expect(tencent.manualCleanupSteps.join(" ")).toMatch(/CVM/);
    expect(volcengine.manualCleanupSteps.join(" ")).toMatch(/Volcengine/);
  });

  it("always includes a DNS-record cleanup step", () => {
    const receipt = makeService().issueReceipt({
      providerId: "tencent-cvm",
      ownerRunId: "r",
      resourceTag: "t",
    });
    const text = receipt.manualCleanupSteps.join(" ");
    expect(text).toMatch(/DNS|subdomain|record/i);
  });

  it("rejects unknown providers", () => {
    expect(() =>
      makeService().issueReceipt({
        providerId: "aws-ec2" as never,
        ownerRunId: "r",
        resourceTag: "t",
      }),
    ).toThrow();
  });

  it("emits a deterministic receiptId for the same input tuple", () => {
    const a = makeService().issueReceipt({
      providerId: "volcengine-ecs",
      ownerRunId: "r",
      resourceTag: "t",
      satelliteId: "sat-1",
    });
    const b = makeService().issueReceipt({
      providerId: "volcengine-ecs",
      ownerRunId: "r",
      resourceTag: "t",
      satelliteId: "sat-1",
    });
    expect(a.receiptId).toBe(b.receiptId);
    expect(a.receiptId).toHaveLength(16);
  });
});
