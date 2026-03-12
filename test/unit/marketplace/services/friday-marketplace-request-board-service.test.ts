import { describe, expect, it, vi } from "vitest";

import { FridayDomainError } from "#errors";
import { FridayMarketplaceRequestBoardService } from "../../../../src/marketplace/services/friday-marketplace-request-board-service.js";
import type {
  MarketplaceActorContext,
  FridayMarketplaceRequestPost,
  FridayMarketplaceRequestResponse,
} from "../../../../src/marketplace/model/friday-marketplace.types.js";

const REQUESTER_ACTOR: MarketplaceActorContext = {
  tenantId: "tenant-requester",
  principalId: "requester-1",
};

const CREATOR_ACTOR: MarketplaceActorContext = {
  tenantId: "tenant-creator",
  principalId: "creator-1",
};

const INTRUDER_ACTOR: MarketplaceActorContext = {
  tenantId: "tenant-intruder",
  principalId: "intruder-1",
};

function createService() {
  const requests = new Map<string, FridayMarketplaceRequestPost>();
  const responses = new Map<string, FridayMarketplaceRequestResponse[]>();
  let sequence = 0;
  const now = vi.fn(() => `2026-03-09T00:00:0${Math.min(sequence, 9)}.000Z`);

  const deps = {
    commerce: {
      getPublisherByPrincipal: vi.fn(async (tenantId: string, principalId: string) =>
        principalId === "creator-1"
          ? {
              id: "pub-1",
              tenantId,
              principalId,
            }
          : null,
      ),
      getRequest: vi.fn(async (requestId: string) => requests.get(requestId) ?? null),
      listRequestResponses: vi.fn(async (requestId: string) => responses.get(requestId) ?? []),
      listRequests: vi.fn(async () => [...requests.values()]),
      saveRequest: vi.fn(async (request: FridayMarketplaceRequestPost) => {
        requests.set(request.id, request);
      }),
      saveRequestResponse: vi.fn(async (response: FridayMarketplaceRequestResponse) => {
        const current = responses.get(response.requestId) ?? [];
        responses.set(response.requestId, [...current, response]);
      }),
    },
    generateId: vi.fn(() => {
      sequence += 1;
      return `id-${sequence}`;
    }),
    now,
  };

  return {
    deps,
    requests,
    responses,
    service: new FridayMarketplaceRequestBoardService(deps),
  };
}

describe("FridayMarketplaceRequestBoardService", () => {
  it("creates an open marketplace request", async () => {
    const { service, requests } = createService();

    const bundle = await service.createRequest(
      {
        assetKind: "skill",
        title: " Need a backup skill ",
        goal: " Backup files ",
        desiredOutcome: " A reusable backup skill ",
        constraints: ["local files only"],
        budgetSupportIntent: "tip later",
        privacy: "private",
        publishability: "allow_publication",
        riskNotes: "no destructive actions",
      },
      REQUESTER_ACTOR,
    );

    expect(bundle.request).toMatchObject({
      id: "id-1",
      assetKind: "skill",
      title: "Need a backup skill",
      goal: "Backup files",
      desiredOutcome: "A reusable backup skill",
      status: "open",
      requesterTenantId: "tenant-requester",
      requesterPrincipalId: "requester-1",
    });
    expect(bundle.responses).toEqual([]);
    expect(requests.get("id-1")).toEqual(bundle.request);
  });

  it("creates a response, infers creator id, and moves open requests into discussion", async () => {
    const { service, requests } = createService();
    await service.createRequest(
      {
        assetKind: "workflow",
        title: "Need workflow",
        goal: "Automate deploys",
        desiredOutcome: "A deploy workflow",
        constraints: [],
        privacy: "public",
        publishability: "allow_publication",
      },
      REQUESTER_ACTOR,
    );

    const bundle = await service.createResponse(
      "id-1",
      {
        message: " I can build this ",
        proposal: "deliver in 2 days",
      },
      CREATOR_ACTOR,
    );

    expect(bundle.responses).toHaveLength(1);
    expect(bundle.responses[0]).toMatchObject({
      id: "id-2",
      responderTenantId: "tenant-creator",
      responderPrincipalId: "creator-1",
      responderCreatorId: "publisher:pub-1",
      message: "I can build this",
    });
    expect(requests.get("id-1")).toMatchObject({ status: "in_discussion" });
  });

  it("hides private requests from non-owners and rejects their responses", async () => {
    const { service } = createService();
    await service.createRequest(
      {
        assetKind: "workflow",
        title: "Need workflow",
        goal: "Automate deploys",
        desiredOutcome: "A deploy workflow",
        constraints: [],
        privacy: "private",
        publishability: "private_only",
      },
      REQUESTER_ACTOR,
    );

    await expect(service.getRequest("id-1", INTRUDER_ACTOR)).resolves.toBeNull();
    await expect(service.listRequests(INTRUDER_ACTOR)).resolves.toEqual([]);
    await expect(
      service.createResponse("id-1", { message: "I can do it" }, INTRUDER_ACTOR),
    ).rejects.toMatchObject<Partial<FridayDomainError>>({
      code: "MARKETPLACE_REQUEST_NOT_FOUND",
    });
  });

  it("allows only the requester to accept a response", async () => {
    const { service } = createService();
    await service.createRequest(
      {
        assetKind: "agent",
        title: "Need agent",
        goal: "Handle triage",
        desiredOutcome: "A triage agent",
        constraints: [],
        privacy: "private",
        publishability: "private_only",
      },
      REQUESTER_ACTOR,
    );
    await service.createResponse("id-1", { message: "I can do it" }, REQUESTER_ACTOR);

    await expect(service.acceptResponse("id-1", "id-2", INTRUDER_ACTOR)).rejects.toMatchObject<
      Partial<FridayDomainError>
    >({
      code: "MARKETPLACE_REQUEST_NOT_FOUND",
    });

    const bundle = await service.acceptResponse("id-1", "id-2", REQUESTER_ACTOR);
    expect(bundle.request).toMatchObject({
      status: "accepted",
      acceptedResponseId: "id-2",
    });
  });

  it("requires both tenant and principal to own a public request mutation", async () => {
    const { service } = createService();
    await service.createRequest(
      {
        assetKind: "agent",
        title: "Need agent",
        goal: "Handle triage",
        desiredOutcome: "A triage agent",
        constraints: [],
        privacy: "public",
        publishability: "private_only",
      },
      REQUESTER_ACTOR,
    );

    await expect(
      service.closeRequest("id-1", {
        tenantId: "tenant-other",
        principalId: "requester-1",
      }),
    ).rejects.toMatchObject<Partial<FridayDomainError>>({
      code: "MARKETPLACE_REQUEST_FORBIDDEN",
    });
  });

  it("allows only the requester to close a request", async () => {
    const { service } = createService();
    await service.createRequest(
      {
        assetKind: "skill",
        title: "Need skill",
        goal: "Handle reports",
        desiredOutcome: "A reporting skill",
        constraints: [],
        privacy: "public",
        publishability: "allow_publication",
      },
      REQUESTER_ACTOR,
    );

    await expect(service.closeRequest("id-1", INTRUDER_ACTOR)).rejects.toMatchObject<
      Partial<FridayDomainError>
    >({
      code: "MARKETPLACE_REQUEST_FORBIDDEN",
    });

    const bundle = await service.closeRequest("id-1", REQUESTER_ACTOR);
    expect(bundle.request).toMatchObject({
      status: "closed",
    });
    expect(bundle.request.closedAt).toBeTruthy();
  });
});
