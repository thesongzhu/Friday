import { FridayDomainError } from "#errors";
import type {
  FridayStudioArtifactResponse,
  FridayStudioExportResponse,
  FridayStudioImportRequest,
  FridayStudioImportResponse,
  FridayStudioProductsResponse,
  FridayStudioRunRequest,
  FridayStudioRunResponse,
} from "../../model/friday-api-studio.types.js";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { FridayStudioService } from "../../../studio/friday-studio-service.js";

export interface FridayStudioRoutesDeps {
  service: FridayStudioService;
}

function requireObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FridayDomainError("VALIDATION_ERROR", message, { httpStatus: 400 });
  }
  return value as Record<string, unknown>;
}

function requireStringParam(params: unknown, field: string): string {
  const obj = requireObject(params, "Route params are required");
  const value = obj[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new FridayDomainError("VALIDATION_ERROR", `${field} is required`, { httpStatus: 400 });
  }
  return value.trim();
}

function readRunRequest(body: unknown): FridayStudioRunRequest {
  const obj = requireObject(body, "Studio run request body is required");
  if (typeof obj.productId !== "string" || obj.productId.trim().length === 0) {
    throw new FridayDomainError("VALIDATION_ERROR", "productId is required", { httpStatus: 400 });
  }
  const inputs = obj.inputs === undefined ? undefined : requireObject(obj.inputs, "inputs must be an object");
  return {
    productId: obj.productId as FridayStudioRunRequest["productId"],
    inputs,
    locale: obj.locale === "zh" || obj.locale === "en" ? obj.locale : undefined,
    deliveryTarget: typeof obj.deliveryTarget === "object" && obj.deliveryTarget !== null && !Array.isArray(obj.deliveryTarget)
      ? obj.deliveryTarget as FridayStudioRunRequest["deliveryTarget"]
      : undefined,
  };
}

function readImportRequest(body: unknown): FridayStudioImportRequest {
  const obj = requireObject(body, "Studio import request body is required");
  if (obj.kind !== "directory" && obj.kind !== "zip") {
    throw new FridayDomainError("VALIDATION_ERROR", "kind must be directory or zip", { httpStatus: 400 });
  }
  return obj as unknown as FridayStudioImportRequest;
}

export function createFridayStudioRoutes(
  deps: FridayStudioRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "studio.products.list",
      method: "GET",
      path: "/v1/studio/products",
      auth: { public: true },
      async handler(): Promise<FridayStudioProductsResponse> {
        return { products: deps.service.listProducts() };
      },
    },
    {
      operationId: "studio.runs.create",
      method: "POST",
      path: "/v1/studio/runs",
      auth: { public: true },
      rateLimitPolicyId: "agent.run",
      async handler(ctx): Promise<FridayStudioRunResponse> {
        return { run: await deps.service.runProduct(readRunRequest(ctx.body)) };
      },
    },
    {
      operationId: "studio.runs.get",
      method: "GET",
      path: "/v1/studio/runs/:runId",
      auth: { public: true },
      async handler(ctx): Promise<FridayStudioRunResponse> {
        return { run: deps.service.getRun(requireStringParam(ctx.params, "runId")) };
      },
    },
    {
      operationId: "studio.artifacts.get",
      method: "GET",
      path: "/v1/studio/runs/:runId/artifacts/:artifactId",
      auth: { public: true },
      async handler(ctx): Promise<FridayStudioArtifactResponse> {
        return deps.service.getArtifact(
          requireStringParam(ctx.params, "runId"),
          requireStringParam(ctx.params, "artifactId"),
        );
      },
    },
    {
      operationId: "studio.runs.export",
      method: "GET",
      path: "/v1/studio/runs/:runId/export",
      auth: { public: true },
      async handler(ctx): Promise<FridayStudioExportResponse> {
        return deps.service.exportRun(requireStringParam(ctx.params, "runId"));
      },
    },
    {
      operationId: "studio.imports.create",
      method: "POST",
      path: "/v1/studio/imports",
      auth: { public: true },
      async handler(ctx): Promise<FridayStudioImportResponse> {
        return deps.service.importLocalPack(readImportRequest(ctx.body));
      },
    },
  ];
}
