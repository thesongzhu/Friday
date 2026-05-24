import type { FridayHttpMethod, FridayRouteDefinition, FridayRouteHandler } from "../model/friday-api-common.types.js";
import { FridayDomainError } from "#errors";
import { isFridayCanonicalRouteOperationId } from "./friday-http-route-contract.js";

// ─── Route entry (type-erased for registry storage) ───

export interface FridayRouteEntry {
  operationId: string;
  method: FridayHttpMethod;
  path: string;
  auth:
    | { public: true; allowUnauthenticatedMutation?: true }
    | { public: false; anyOfScopes: string[]; anyOfRoles?: string[] };
  rateLimitPolicyId?: string;
  handler: FridayRouteHandler<unknown, unknown, unknown, unknown>;
}

// ─── Route registry ───

export interface FridayHttpRouteRegistry {
  register(route: FridayRouteEntry): void;
  getRoutes(): readonly FridayRouteEntry[];
  findRoute(method: FridayHttpMethod, path: string): FridayRouteEntry | undefined;
  getRouteCount(): number;
}

// ─── Factory ───

export function createFridayHttpRouteRegistry(): FridayHttpRouteRegistry {
  const routes: FridayRouteEntry[] = [];

  return {
    register(route) {
      if (!isFridayCanonicalRouteOperationId(route.operationId)) {
        throw new FridayDomainError(
          "ROUTE_INVALID_OPERATION_ID",
          `Route with operationId '${route.operationId}' must use lowercase dot-separated segments`,
          { httpStatus: 500 },
        );
      }

      // Prevent duplicate operationIds
      const existing = routes.find((r) => r.operationId === route.operationId);
      if (existing) {
        throw new FridayDomainError("ROUTE_DUPLICATE_OPERATION_ID", `Route with operationId '${route.operationId}' is already registered`, { httpStatus: 500 });
      }
      routes.push(route);
    },

    getRoutes() {
      return routes;
    },

    findRoute(method, path) {
      const matches = routes.filter((r) => r.method === method && matchPath(r.path, path));
      if (matches.length === 0) {
        return undefined;
      }

      return matches.reduce((best, candidate) =>
        isRoutePatternMoreSpecific(candidate.path, best.path) ? candidate : best,
      );
    },

    getRouteCount() {
      return routes.length;
    },
  };
}

// ─── Path matching and specificity (supports :param segments) ───

function matchPath(pattern: string, actual: string): boolean {
  const patternParts = pattern.split("/");
  const actualParts = actual.split("/");

  if (patternParts.length !== actualParts.length) return false;

  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) continue;
    if (patternParts[i] !== actualParts[i]) return false;
  }

  return true;
}

function isRoutePatternMoreSpecific(candidatePattern: string, currentPattern: string): boolean {
  const candidateParts = candidatePattern.split("/");
  const currentParts = currentPattern.split("/");

  const maxLength = Math.max(candidateParts.length, currentParts.length);
  for (let index = 0; index < maxLength; index++) {
    const candidateIsParam = isParameterSegment(candidateParts[index]);
    const currentIsParam = isParameterSegment(currentParts[index]);

    if (candidateIsParam === currentIsParam) {
      continue;
    }

    return !candidateIsParam && currentIsParam;
  }

  const candidateStaticCount = countStaticSegments(candidateParts);
  const currentStaticCount = countStaticSegments(currentParts);
  if (candidateStaticCount !== currentStaticCount) {
    return candidateStaticCount > currentStaticCount;
  }

  // Fewer parameter segments = more specific (more segments are literal matches)
  return countParameterSegments(candidateParts) < countParameterSegments(currentParts);
}

function isParameterSegment(segment: string | undefined): boolean {
  return typeof segment === "string" && segment.startsWith(":");
}

function countStaticSegments(parts: readonly string[]): number {
  return parts.filter((part) => part.length > 0 && !isParameterSegment(part)).length;
}

function countParameterSegments(parts: readonly string[]): number {
  return parts.filter((part) => isParameterSegment(part)).length;
}
