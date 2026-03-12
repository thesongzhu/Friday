import { describe, it, expect } from "vitest";
import { createFridayWorkflowConflictRoutes } from "#api";
import type { FridayWorkflowConflictRoutesDeps } from "#api";
import type {
  FridayWorkflowConflictEntity,
  FridayWorkflowDraftEntity,
} from "#api";

/** Handlers are never invoked; stubs only satisfy the type signature. */
const stubConflict = {} as unknown as FridayWorkflowConflictEntity;
const stubDraft = {} as unknown as FridayWorkflowDraftEntity;

describe("FridayWorkflowConflictRoutes", () => {
  const stubDeps: FridayWorkflowConflictRoutesDeps = {
    listConflicts: () => ({ items: [] }),
    resolveConflict: () => ({ conflict: stubConflict, draft: stubDraft }),
  };

  const routes = createFridayWorkflowConflictRoutes(stubDeps);

  it("registers 2 conflict routes", () => {
    expect(routes).toHaveLength(2);
  });

  it("GET /v1/workflows/:workflowId/conflicts requires workflow.read", () => {
    const route = routes.find((r) => r.operationId === "conflicts.list");
    expect(route).toBeDefined();
    expect(route!.method).toBe("GET");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["workflow.read"] });
  });

  it("POST /v1/workflows/:workflowId/conflicts/:conflictId/resolve requires workflow.conflict.resolve", () => {
    const route = routes.find((r) => r.operationId === "conflicts.resolve");
    expect(route).toBeDefined();
    expect(route!.method).toBe("POST");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["workflow.conflict.resolve"] });
    expect(route!.rateLimitPolicyId).toBe("workflow.resolve_conflict");
  });
});
