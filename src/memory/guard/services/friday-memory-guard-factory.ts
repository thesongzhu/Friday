import type { FridayAuthPrincipal } from "#api";

import type {
  CreateFridayMemoryGuardServiceFactoryDeps,
  FridayMemoryGuardContext,
  FridayMemoryGuardService,
  FridayMemoryGuardServiceFactory,
} from "../model/friday-memory-guard.types.js";

import { createFridayMemoryGuardService } from "./friday-memory-guard-service.js";
import { createFridayMemoryRateLimiter } from "./friday-memory-rate-limiter.js";
import { createFridayMemoryPiiGuard } from "./friday-memory-pii-guard.js";
import { createFridayMemoryOutputFilter } from "./friday-memory-output-filter.js";
import { createFridayMemoryGuardQuotaRepository } from "../persistence/friday-memory-guard-quota-repository.js";

function defaultResolveContext(principal: FridayAuthPrincipal | null): FridayMemoryGuardContext {
  if (!principal) {
    // Anonymous / unauthenticated — treat as system-level for internal calls
    return {
      subject: {
        hubId: "default",
        accessLevel: "system",
      },
      principalId: "anonymous",
    };
  }

  // If the principal is a service or workflow-runner, treat as system
  if (principal.principalType === "service" || principal.principalType === "workflow-runner") {
    return {
      subject: {
        hubId: "default",
        accessLevel: "system",
      },
      principalId: principal.principalId,
    };
  }

  // For user/satellite principals — tenant access
  return {
    subject: {
      hubId: "default",
      userId: principal.userId ?? principal.principalId,
      accessLevel: "tenant",
    },
    principalId: principal.principalId,
  };
}

export function createFridayMemoryGuardServiceFactory(
  deps: CreateFridayMemoryGuardServiceFactoryDeps,
): FridayMemoryGuardServiceFactory {
  // Shared components (singletons across all request-scoped guards)
  const rateLimiter = createFridayMemoryRateLimiter();
  const quotaRepo = createFridayMemoryGuardQuotaRepository();
  const piiGuard = createFridayMemoryPiiGuard();
  const outputFilter = createFridayMemoryOutputFilter();

  const resolveContext = deps.resolveContextFromPrincipal ?? defaultResolveContext;

  return {
    forPrincipal(principal: FridayAuthPrincipal | null): FridayMemoryGuardService {
      const context = resolveContext(principal);
      return createFridayMemoryGuardService({
        core: deps.core,
        db: deps.db,
        nowIso: deps.nowIso,
        nowMs: deps.nowMs,
        context,
        rateLimiter,
        quotaRepo,
        piiGuard,
        outputFilter,
      });
    },

    forContext(context: FridayMemoryGuardContext): FridayMemoryGuardService {
      return createFridayMemoryGuardService({
        core: deps.core,
        db: deps.db,
        nowIso: deps.nowIso,
        nowMs: deps.nowMs,
        context,
        rateLimiter,
        quotaRepo,
        piiGuard,
        outputFilter,
      });
    },
  };
}
