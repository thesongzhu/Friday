import { describe, expect, it, vi } from "vitest";

import type { FridayHttpContext } from "#api";
import {
  createFridayMarketplaceRequestRoutes,
  type FridayMarketplaceRequestRoutesDeps,
} from "#api";

function makeCtx(
  overrides: Partial<
    FridayHttpContext<Record<string, string>, Record<string, string>, unknown>
  > = {},
): FridayHttpContext<Record<string, string>, Record<string, string>, unknown> {
  return {
    requestId: "req-marketplace-request-1",
    receivedAt: "2026-03-09T00:00:00.000Z",
    params: {},
    query: {},
    body: null,
    headers: {},
    principal: null,
    ...overrides,
  };
}

function makeDeps(): FridayMarketplaceRequestRoutesDeps {
  return {
    service: {
      listRequests: vi.fn(async () => [
        {
          id: "request-1",
          assetKind: "skill",
          requesterTenantId: "tenant-1",
          requesterPrincipalId: "tenant-1",
          title: "Need a skill",
          goal: "Automate backup",
          desiredOutcome: "Backup skill",
          constraints: [],
          budgetSupportIntent: null,
          privacy: "private",
          publishability: "allow_publication",
          riskNotes: null,
          status: "open",
          acceptedResponseId: null,
          createdAt: "2026-03-09T00:00:00.000Z",
          updatedAt: "2026-03-09T00:00:00.000Z",
          closedAt: null,
        },
      ]),
      createRequest: vi.fn(async () => ({
        request: {
          id: "request-1",
          assetKind: "skill",
          requesterTenantId: "tenant-1",
          requesterPrincipalId: "tenant-1",
          title: "Need a skill",
          goal: "Automate backup",
          desiredOutcome: "Backup skill",
          constraints: [],
          budgetSupportIntent: null,
          privacy: "private",
          publishability: "allow_publication",
          riskNotes: null,
          status: "open",
          acceptedResponseId: null,
          createdAt: "2026-03-09T00:00:00.000Z",
          updatedAt: "2026-03-09T00:00:00.000Z",
          closedAt: null,
        },
        responses: [],
      })),
      getRequest: vi.fn(async (requestId: string) =>
        requestId === "request-1"
          ? {
              request: {
                id: requestId,
                assetKind: "skill",
                requesterTenantId: "tenant-1",
                requesterPrincipalId: "tenant-1",
                title: "Need a skill",
                goal: "Automate backup",
                desiredOutcome: "Backup skill",
                constraints: [],
                budgetSupportIntent: null,
                privacy: "private",
                publishability: "allow_publication",
                riskNotes: null,
                status: "open",
                acceptedResponseId: null,
                createdAt: "2026-03-09T00:00:00.000Z",
                updatedAt: "2026-03-09T00:00:00.000Z",
                closedAt: null,
              },
              responses: [],
            }
          : null,
      ),
      createResponse: vi.fn(async () => ({
        request: {
          id: "request-1",
          assetKind: "skill",
          requesterTenantId: "tenant-1",
          requesterPrincipalId: "tenant-1",
          title: "Need a skill",
          goal: "Automate backup",
          desiredOutcome: "Backup skill",
          constraints: [],
          budgetSupportIntent: null,
          privacy: "private",
          publishability: "allow_publication",
          riskNotes: null,
          status: "in_discussion",
          acceptedResponseId: null,
          createdAt: "2026-03-09T00:00:00.000Z",
          updatedAt: "2026-03-09T00:00:01.000Z",
          closedAt: null,
        },
        responses: [
          {
            id: "response-1",
            requestId: "request-1",
            responderTenantId: "tenant-2",
            responderPrincipalId: "tenant-2",
            responderCreatorId: "publisher:pub-1",
            message: "I can help",
            proposal: null,
            deliverableAssetId: null,
            createdAt: "2026-03-09T00:00:01.000Z",
          },
        ],
      })),
      acceptResponse: vi.fn(async () => ({ accepted: true })),
      closeRequest: vi.fn(async () => ({ closed: true })),
    } as unknown as FridayMarketplaceRequestRoutesDeps["service"],
  };
}

describe("FridayMarketplaceRequestRoutes", () => {
  it("registers request board routes", () => {
    const routes = createFridayMarketplaceRequestRoutes(makeDeps());
    expect(routes.map((route) => route.operationId)).toEqual([
      "marketplace.requests.list",
      "marketplace.requests.create",
      "marketplace.requests.get",
      "marketplace.requests.responses.create",
      "marketplace.requests.accept",
      "marketplace.requests.close",
    ]);
  });

  it("lists requests", async () => {
    const deps = makeDeps();
    const route = createFridayMarketplaceRequestRoutes(deps).find(
      (entry) => entry.operationId === "marketplace.requests.list",
    )!;

    const result = await route.handler(
      makeCtx({
        principal: { principalId: "principal-1", tenantId: "tenant-1" } as never,
        query: { assetKind: "skill", status: "open", privacy: "private" },
      }),
    );

    expect(deps.service.listRequests).toHaveBeenCalledWith(
      { tenantId: "tenant-1", principalId: "principal-1" },
      {
        assetKind: "skill",
        status: "open",
        privacy: "private",
      },
    );
    expect(result).toEqual({
      items: [expect.objectContaining({ id: "request-1" })],
    });
  });

  it("requires authentication to list requests", async () => {
    const route = createFridayMarketplaceRequestRoutes(makeDeps()).find(
      (entry) => entry.operationId === "marketplace.requests.list",
    )!;

    await expect(route.handler(makeCtx())).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("requires authentication to create a request", async () => {
    const route = createFridayMarketplaceRequestRoutes(makeDeps()).find(
      (entry) => entry.operationId === "marketplace.requests.create",
    )!;

    await expect(
      route.handler(
        makeCtx({
          body: {
            assetKind: "skill",
            title: "Need a skill",
            goal: "Automate backup",
            desiredOutcome: "Backup skill",
            privacy: "private",
            publishability: "allow_publication",
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("creates a request", async () => {
    const deps = makeDeps();
    const route = createFridayMarketplaceRequestRoutes(deps).find(
      (entry) => entry.operationId === "marketplace.requests.create",
    )!;

    const result = await route.handler(
      makeCtx({
        principal: { principalId: "principal-1", tenantId: "tenant-1" } as never,
        body: {
          assetKind: "skill",
          title: " Need a skill ",
          goal: " Automate backup ",
          desiredOutcome: " Backup skill ",
          privacy: "private",
          publishability: "allow_publication",
          constraints: [" local only "],
        },
      }),
    );

    expect(deps.service.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Need a skill",
        goal: "Automate backup",
        desiredOutcome: "Backup skill",
        constraints: ["local only"],
      }),
      { tenantId: "tenant-1", principalId: "principal-1" },
    );
    expect(result).toEqual(expect.objectContaining({
      request: expect.objectContaining({ id: "request-1" }),
    }));
  });

  it("returns not found when a request is missing", async () => {
    const route = createFridayMarketplaceRequestRoutes(makeDeps()).find(
      (entry) => entry.operationId === "marketplace.requests.get",
    )!;

    await expect(
      route.handler(makeCtx({
        params: { requestId: "missing" },
        principal: { principalId: "principal-1", tenantId: "tenant-1" } as never,
      })),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_REQUEST_NOT_FOUND",
    });
  });

  it("creates a response and validates response id on accept", async () => {
    const deps = makeDeps();
    const respondRoute = createFridayMarketplaceRequestRoutes(deps).find(
      (entry) => entry.operationId === "marketplace.requests.responses.create",
    )!;
    const acceptRoute = createFridayMarketplaceRequestRoutes(deps).find(
      (entry) => entry.operationId === "marketplace.requests.accept",
    )!;

    await respondRoute.handler(
      makeCtx({
        params: { requestId: "request-1" },
        principal: { principalId: "creator-1", tenantId: "tenant-2" } as never,
        body: { message: " I can help " },
      }),
    );

    expect(deps.service.createResponse).toHaveBeenCalledWith(
      "request-1",
      expect.objectContaining({ message: "I can help" }),
      { tenantId: "tenant-2", principalId: "creator-1" },
    );

    await expect(
      acceptRoute.handler(
        makeCtx({
          params: { requestId: "request-1" },
          principal: { principalId: "requester-1", tenantId: "tenant-1" } as never,
          body: {},
        }),
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("accepts and closes a request", async () => {
    const deps = makeDeps();
    const acceptRoute = createFridayMarketplaceRequestRoutes(deps).find(
      (entry) => entry.operationId === "marketplace.requests.accept",
    )!;
    const closeRoute = createFridayMarketplaceRequestRoutes(deps).find(
      (entry) => entry.operationId === "marketplace.requests.close",
    )!;

    await acceptRoute.handler(
      makeCtx({
        params: { requestId: "request-1" },
        principal: { principalId: "requester-1", tenantId: "tenant-1" } as never,
        body: { responseId: "response-1" },
      }),
    );
    expect(deps.service.acceptResponse).toHaveBeenCalledWith(
      "request-1",
      "response-1",
      { tenantId: "tenant-1", principalId: "requester-1" },
    );

    await closeRoute.handler(
      makeCtx({
        params: { requestId: "request-1" },
        principal: { principalId: "requester-1", tenantId: "tenant-1" } as never,
      }),
    );
    expect(deps.service.closeRequest).toHaveBeenCalledWith(
      "request-1",
      { tenantId: "tenant-1", principalId: "requester-1" },
    );
  });
});
