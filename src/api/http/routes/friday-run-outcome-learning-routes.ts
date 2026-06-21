import { FridayDomainError } from "#errors";
import { assertBoundPrincipalForOperation } from "../../../security/friday-owner-session-channel-capability.js";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayRustHubRunOutcomeLearningDecisionRequest,
  FridayRustHubRunOutcomeLearningDecisionResult,
} from "../../mission-spine/friday-rust-hub-agent-run-ws-sealed-client.js";

export interface FridayRunOutcomeLearningRoutesDispatchService {
  decideRunOutcomeLearning(
    request: FridayRustHubRunOutcomeLearningDecisionRequest,
  ): Promise<FridayRustHubRunOutcomeLearningDecisionResult>;
}

export interface FridayRunOutcomeLearningRoutesDeps {
  readonly dispatch?: FridayRunOutcomeLearningRoutesDispatchService | null;
  readonly dispatchDisabledReason?: string | null;
}

export interface FridayRunOutcomeLearningDecideResponse {
  readonly result: FridayRustHubRunOutcomeLearningDecisionResult;
}

const DEFAULT_DISPATCH_DISABLED_MESSAGE =
  "Run-outcome learning confirmation dispatch is unavailable in this runtime; the Rust Hub sealed-WS decision seam has not been wired.";

const SURFACE = "api:/v1/run-outcome-learning/decide";
const VALID_DECISIONS = new Set(["confirm", "reject"]);

function throwInvalidBody(failures: readonly string[]): never {
  throw new FridayDomainError(
    "RUN_OUTCOME_LEARNING_DECISION_REQUEST_INVALID",
    "Run-outcome learning decision request body did not satisfy the dispatch contract.",
    {
      httpStatus: 400,
      details: { surface: SURFACE, failures },
    },
  );
}

function asBody(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function readRequiredString(
  body: Record<string, unknown>,
  field: string,
  failures: string[],
): string | undefined {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    failures.push(`${field}_missing_or_empty`);
    return undefined;
  }
  return value.trim();
}

function readOptionalString(body: Record<string, unknown>, field: string, failures: string[]): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    failures.push(`${field}_not_string`);
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function validateRunOutcomeLearningDecisionBody(
  body: unknown,
): FridayRustHubRunOutcomeLearningDecisionRequest {
  const b = asBody(body);
  const failures: string[] = [];
  const candidateId = readRequiredString(b, "candidateId", failures);
  const decision = readRequiredString(b, "decision", failures);
  const reason = readOptionalString(b, "reason", failures);
  if (decision !== undefined && !VALID_DECISIONS.has(decision)) {
    failures.push("decision_not_confirm_or_reject");
  }
  if (failures.length > 0 || candidateId === undefined || decision === undefined) {
    throwInvalidBody(failures);
  }
  return {
    candidateId,
    decision: decision as "confirm" | "reject",
    ...(reason !== undefined ? { reason } : {}),
  };
}

export function createFridayRunOutcomeLearningRoutes(
  deps: FridayRunOutcomeLearningRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  const dispatch = deps.dispatch ?? null;

  function dispatchDisabledMessage(): string {
    return deps.dispatchDisabledReason && deps.dispatchDisabledReason.trim().length > 0
      ? deps.dispatchDisabledReason
      : DEFAULT_DISPATCH_DISABLED_MESSAGE;
  }

  function throwDispatchDisabled(): never {
    throw new FridayDomainError(
      "RUN_OUTCOME_LEARNING_DISPATCH_UNAVAILABLE",
      dispatchDisabledMessage(),
      {
        httpStatus: 503,
        details: { surface: SURFACE, dispatch: "rust_hub_unavailable", proofReady: false },
      },
    );
  }

  return [
    {
      operationId: "run.outcome.learning.decide.apply",
      method: "POST",
      path: "/v1/run-outcome-learning/decide",
      auth: { public: true },
      async handler(ctx): Promise<FridayRunOutcomeLearningDecideResponse> {
        if (!dispatch) {
          throwDispatchDisabled();
        }
        assertBoundPrincipalForOperation(ctx.principal ?? null, "run.outcome.learning.decide.apply", "api");
        const request = validateRunOutcomeLearningDecisionBody(ctx.body);
        const result = await dispatch.decideRunOutcomeLearning(request);
        return { result };
      },
    },
  ];
}
