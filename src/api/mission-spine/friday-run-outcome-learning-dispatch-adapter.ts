import { FridayDomainError } from "#errors";

import type { FridayRunOutcomeLearningRoutesDispatchService } from "../http/routes/friday-run-outcome-learning-routes.js";
import {
  createFridayRustHubAgentRunSealedClient,
  type CreateFridayRustHubAgentRunSealedClientOptions,
  type FridayRustHubAgentRunSealedClient,
  type FridayRustHubRunOutcomeLearningDecisionRequest,
  type FridayRustHubRunOutcomeLearningDecisionResult,
} from "./friday-rust-hub-agent-run-ws-sealed-client.js";
import type { FridayRustAgentRunWsClientX25519SecretResolver } from "./friday-rust-hub-agent-run-ws-client-x25519-secret.js";

export type CreateRunOutcomeLearningSealedClientFn = (
  options: CreateFridayRustHubAgentRunSealedClientOptions,
) => FridayRustHubAgentRunSealedClient;

export interface CreateFridayRunOutcomeLearningDispatchAdapterOptions {
  readonly host?: string;
  readonly port: number;
  readonly timeoutMs?: number;
  readonly secretResolver: FridayRustAgentRunWsClientX25519SecretResolver;
  readonly createClient?: CreateRunOutcomeLearningSealedClientFn;
}

function unavailable(message: string): FridayDomainError {
  return new FridayDomainError("RUN_OUTCOME_LEARNING_DISPATCH_RUST_UNAVAILABLE", message, {
    httpStatus: 503,
    details: {
      surface: "service:run_outcome_learning_dispatch_adapter",
      bridge: "rust_wired",
      proofOnly: true,
      proofReady: false,
    },
  });
}

export function createFridayRunOutcomeLearningDispatchAdapter(
  options: CreateFridayRunOutcomeLearningDispatchAdapterOptions,
): FridayRunOutcomeLearningRoutesDispatchService {
  const { host, port, timeoutMs } = options;
  const createClient = options.createClient ?? createFridayRustHubAgentRunSealedClient;
  const secretResolver = options.secretResolver;

  function buildClient(): FridayRustHubAgentRunSealedClient {
    const clientSecret = secretResolver();
    if (!clientSecret) {
      throw unavailable("Run-outcome learning dispatch could not resolve the sealed-WS client secret.");
    }
    try {
      return createClient({
        ...(host !== undefined ? { host } : {}),
        port,
        clientSecret,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
    } catch {
      throw unavailable("Run-outcome learning dispatch could not construct the sealed-WS client.");
    }
  }

  return {
    async decideRunOutcomeLearning(
      request: FridayRustHubRunOutcomeLearningDecisionRequest,
    ): Promise<FridayRustHubRunOutcomeLearningDecisionResult> {
      const client = buildClient();
      try {
        return await client.decideRunOutcomeLearning(request);
      } catch (error) {
        throw error instanceof FridayDomainError
          ? error
          : unavailable("Run-outcome learning decision dispatch failed.");
      }
    },
  };
}

export function readRunOutcomeLearningRustWsPort(raw: string | undefined): number {
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
