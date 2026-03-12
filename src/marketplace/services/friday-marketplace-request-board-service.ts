import { FridayDomainError } from "#errors";
import type {
  FridayMarketplaceRequestAssetKind,
  FridayMarketplaceRequestPost,
  FridayMarketplaceRequestPrivacyMode,
  FridayMarketplaceRequestPublishability,
  FridayMarketplaceRequestResponse,
  FridayMarketplaceRequestStatus,
  MarketplaceActorContext,
} from "../model/friday-marketplace.types.js";
import type { FridayMarketplaceCommercePersistence } from "../persistence/friday-marketplace-commerce-persistence.js";

export interface FridayMarketplaceRequestBoardServiceDeps {
  commerce: Pick<
    FridayMarketplaceCommercePersistence,
    | "getPublisherByPrincipal"
    | "getRequest"
    | "listRequestResponses"
    | "listRequests"
    | "saveRequest"
    | "saveRequestResponse"
  >;
  generateId: () => string;
  now: () => string;
}

export interface FridayCreateMarketplaceRequestInput {
  assetKind: FridayMarketplaceRequestAssetKind;
  title: string;
  goal: string;
  desiredOutcome: string;
  constraints: string[];
  budgetSupportIntent?: string | null;
  privacy: FridayMarketplaceRequestPrivacyMode;
  publishability: FridayMarketplaceRequestPublishability;
  riskNotes?: string | null;
}

export interface FridayCreateMarketplaceRequestResponseInput {
  message: string;
  proposal?: string | null;
  deliverableAssetId?: string | null;
}

export interface FridayMarketplaceRequestBundle {
  request: FridayMarketplaceRequestPost;
  responses: FridayMarketplaceRequestResponse[];
}

export class FridayMarketplaceRequestBoardService {
  public constructor(private readonly deps: FridayMarketplaceRequestBoardServiceDeps) {}

  public async listRequests(
    actor: MarketplaceActorContext,
    filters?: {
    assetKind?: FridayMarketplaceRequestAssetKind;
    status?: FridayMarketplaceRequestStatus;
    privacy?: FridayMarketplaceRequestPrivacyMode;
  },
  ): Promise<FridayMarketplaceRequestPost[]> {
    const requests = await this.deps.commerce.listRequests(filters);
    return requests.filter((request) => this.canActorViewRequest(request, actor));
  }

  public async getRequest(
    requestId: string,
    actor: MarketplaceActorContext,
  ): Promise<FridayMarketplaceRequestBundle | null> {
    const request = await this.deps.commerce.getRequest(requestId);
    if (request === null || !this.canActorViewRequest(request, actor)) {
      return null;
    }
    const responses = await this.deps.commerce.listRequestResponses(requestId);
    return { request, responses };
  }

  public async createRequest(
    input: FridayCreateMarketplaceRequestInput,
    actor: MarketplaceActorContext,
  ): Promise<FridayMarketplaceRequestBundle> {
    const now = this.deps.now();
    const request: FridayMarketplaceRequestPost = {
      id: this.deps.generateId(),
      assetKind: input.assetKind,
      requesterTenantId: actor.tenantId,
      requesterPrincipalId: actor.principalId,
      title: input.title.trim(),
      goal: input.goal.trim(),
      desiredOutcome: input.desiredOutcome.trim(),
      constraints: [...input.constraints],
      budgetSupportIntent: input.budgetSupportIntent ?? null,
      privacy: input.privacy,
      publishability: input.publishability,
      riskNotes: input.riskNotes ?? null,
      status: "open",
      acceptedResponseId: null,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    await this.deps.commerce.saveRequest(request);
    return { request, responses: [] };
  }

  public async createResponse(
    requestId: string,
    input: FridayCreateMarketplaceRequestResponseInput,
    actor: MarketplaceActorContext,
  ): Promise<FridayMarketplaceRequestBundle> {
    const request = await this.requireVisibleRequest(requestId, actor);
    if (request.status === "closed") {
      throw new FridayDomainError(
        "MARKETPLACE_REQUEST_CLOSED",
        "Closed requests cannot receive new responses",
        { httpStatus: 409, details: { requestId } },
      );
    }

    const publisher = await this.deps.commerce.getPublisherByPrincipal(actor.tenantId, actor.principalId);
    const response: FridayMarketplaceRequestResponse = {
      id: this.deps.generateId(),
      requestId,
      responderTenantId: actor.tenantId,
      responderPrincipalId: actor.principalId,
      responderCreatorId: publisher ? `publisher:${publisher.id}` : null,
      message: input.message.trim(),
      proposal: input.proposal ?? null,
      deliverableAssetId: input.deliverableAssetId ?? null,
      createdAt: this.deps.now(),
    };
    await this.deps.commerce.saveRequestResponse(response);
    if (request.status === "open") {
      await this.deps.commerce.saveRequest({
        ...request,
        status: "in_discussion",
        updatedAt: this.deps.now(),
      });
    }
    return (await this.getRequest(requestId, actor))!;
  }

  public async acceptResponse(
    requestId: string,
    responseId: string,
    actor: MarketplaceActorContext,
  ): Promise<FridayMarketplaceRequestBundle> {
    const request = await this.requireOwnedRequest(requestId, actor);
    const responses = await this.deps.commerce.listRequestResponses(requestId);
    const response = responses.find((entry) => entry.id === responseId) ?? null;
    if (response === null) {
      throw new FridayDomainError(
        "MARKETPLACE_REQUEST_RESPONSE_NOT_FOUND",
        `Marketplace request response "${responseId}" not found`,
        { httpStatus: 404, details: { requestId, responseId } },
      );
    }
    await this.deps.commerce.saveRequest({
      ...request,
      status: "accepted",
      acceptedResponseId: response.id,
      updatedAt: this.deps.now(),
    });
    return (await this.getRequest(requestId, actor))!;
  }

  public async closeRequest(
    requestId: string,
    actor: MarketplaceActorContext,
  ): Promise<FridayMarketplaceRequestBundle> {
    const request = await this.requireOwnedRequest(requestId, actor);
    const now = this.deps.now();
    await this.deps.commerce.saveRequest({
      ...request,
      status: "closed",
      updatedAt: now,
      closedAt: now,
    });
    return (await this.getRequest(requestId, actor))!;
  }

  private canActorViewRequest(
    request: FridayMarketplaceRequestPost,
    actor: MarketplaceActorContext,
  ): boolean {
    if (request.privacy === "public") {
      return true;
    }
    return this.isRequestOwner(request, actor);
  }

  private isRequestOwner(
    request: FridayMarketplaceRequestPost,
    actor: MarketplaceActorContext,
  ): boolean {
    return request.requesterTenantId === actor.tenantId
      && request.requesterPrincipalId === actor.principalId;
  }

  private async requireVisibleRequest(
    requestId: string,
    actor: MarketplaceActorContext,
  ): Promise<FridayMarketplaceRequestPost> {
    const request = await this.deps.commerce.getRequest(requestId);
    if (request === null) {
      throw new FridayDomainError(
        "MARKETPLACE_REQUEST_NOT_FOUND",
        `Marketplace request "${requestId}" not found`,
        { httpStatus: 404, details: { requestId } },
      );
    }
    if (!this.canActorViewRequest(request, actor)) {
      throw new FridayDomainError(
        "MARKETPLACE_REQUEST_NOT_FOUND",
        `Marketplace request "${requestId}" not found`,
        { httpStatus: 404, details: { requestId } },
      );
    }
    return request;
  }

  private async requireOwnedRequest(
    requestId: string,
    actor: MarketplaceActorContext,
  ): Promise<FridayMarketplaceRequestPost> {
    const request = await this.requireVisibleRequest(requestId, actor);
    if (!this.isRequestOwner(request, actor)) {
      throw new FridayDomainError(
        "MARKETPLACE_REQUEST_FORBIDDEN",
        "Only the requester can modify this marketplace request",
        {
          httpStatus: 403,
          details: { requestId, tenantId: actor.tenantId, principalId: actor.principalId },
        },
      );
    }
    return request;
  }
}
