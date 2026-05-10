import {
  cleanupRealHubEnv,
  createRealHubEnv,
  createRealHubEnvFromStateDir,
  DEEPSEEK_API_KEY_ENV,
  DEEPSEEK_BASE_URL,
  FAST_MODEL,
  OLLAMA_BASE_URL,
  OPENAI_API_KEY_ENV,
  OPENAI_BASE_URL,
  shutdownRealHubEnv,
  type FridayLiveProviderKind,
  type RealHubEnv,
} from "./real-env.js";
import {
  createAnthropicProvider,
  createDeepSeekProvider,
  createOllamaProvider,
  createOpenAiProvider,
  ensureAnthropicProviders,
  ensureDeepSeekProviders,
  ensureOllamaProviders,
  ensureOpenAiProviders,
} from "./api.js";
import { liveAnthropicCredentialMessage } from "../../_helpers/live-anthropic.js";

/**
 * Deep-proof env helper: exactly-one selected live provider lane.
 *
 * Replaces the prior Anthropic-only contract. Tests that opt into
 * createFridayDeepProofHubEnv() get a single-provider deterministic
 * environment: exactly one of FRIDAY_E2E_LIVE_ANTHROPIC / DEEPSEEK / OPENAI /
 * OLLAMA must be set, and the matching credential must be present (Ollama
 * relies on a reachable base URL instead of a key). Other provider keys are
 * sanitized at hub boot via real-env's withSanitizedProviderEnv.
 *
 * Evidence captured by a deep-proof run is lane-specific. A DeepSeek run
 * proves DeepSeek; it does not prove Anthropic. Surfaces consuming the
 * helper should label evidence by the active provider.
 */

const ANTHROPIC_BASE_URL_DEFAULT = "https://api.anthropic.com";

export type FridayDeepProofProviderKind = FridayLiveProviderKind;

export type FridayDeepProofProviderAuthLane = "api_key" | "bearer_token" | "none";

export interface FridayDeepProofEnvStatus {
  gated: boolean;
  selectedProvider: FridayDeepProofProviderKind | null;
  providerAuthLane: FridayDeepProofProviderAuthLane | null;
  credentialEnvRef: string | null;
  usesLegacyLane: boolean;
  blockers: string[];
}

function readFlag(value: string | undefined): boolean {
  return value === "1";
}

function readNonEmptyString(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function resolveAnthropicCredentialEnvRef(env: NodeJS.ProcessEnv): string | null {
  if (readNonEmptyString(env.FRIDAY_ANTHROPIC_API_KEY)) { // pragma: allowlist secret
    return "$FRIDAY_ANTHROPIC_API_KEY";
  }
  if (readNonEmptyString(env.ANTHROPIC_API_KEY)) { // pragma: allowlist secret
    return "$ANTHROPIC_API_KEY";
  }
  return null;
}

function resolveDeepSeekCredentialEnvRef(env: NodeJS.ProcessEnv): string | null {
  if (readNonEmptyString(env.FRIDAY_DEEPSEEK_API_KEY)) { // pragma: allowlist secret
    return "$FRIDAY_DEEPSEEK_API_KEY";
  }
  if (readNonEmptyString(env.DEEPSEEK_API_KEY)) { // pragma: allowlist secret
    return "$DEEPSEEK_API_KEY";
  }
  return null;
}

function resolveOpenAiCredentialEnvRef(env: NodeJS.ProcessEnv): string | null {
  if (readNonEmptyString(env.OPENAI_API_KEY)) { // pragma: allowlist secret
    return "$OPENAI_API_KEY";
  }
  return null;
}

export function getFridayDeepProofEnvStatus(
  env: NodeJS.ProcessEnv = process.env,
): FridayDeepProofEnvStatus {
  const lanes: ReadonlyArray<{ kind: FridayDeepProofProviderKind; flag: boolean }> = [
    { kind: "anthropic", flag: readFlag(env.FRIDAY_E2E_LIVE_ANTHROPIC) },
    { kind: "deepseek", flag: readFlag(env.FRIDAY_E2E_LIVE_DEEPSEEK) },
    { kind: "openai", flag: readFlag(env.FRIDAY_E2E_LIVE_OPENAI) },
    { kind: "ollama", flag: readFlag(env.FRIDAY_E2E_LIVE_OLLAMA) },
  ];
  const enabled = lanes.filter((lane) => lane.flag);
  const legacyLane = readFlag(env.E2E_LIVE);
  const blockers: string[] = [];

  let selectedProvider: FridayDeepProofProviderKind | null = null;
  if (enabled.length === 0) {
    blockers.push("no_provider_lane");
  } else if (enabled.length > 1) {
    blockers.push("multiple_provider_lanes");
  } else {
    selectedProvider = enabled[0]!.kind;
  }

  if (legacyLane) {
    blockers.push("legacy_live_lane_enabled");
  }

  let credentialEnvRef: string | null = null;
  let providerAuthLane: FridayDeepProofProviderAuthLane | null = null;
  switch (selectedProvider) {
    case "anthropic": {
      credentialEnvRef = resolveAnthropicCredentialEnvRef(env);
      providerAuthLane = "api_key";
      if (!credentialEnvRef) {
        blockers.push("missing_key:anthropic");
      }
      break;
    }
    case "deepseek": {
      credentialEnvRef = resolveDeepSeekCredentialEnvRef(env);
      providerAuthLane = "bearer_token";
      if (!credentialEnvRef) {
        blockers.push("missing_key:deepseek");
      }
      break;
    }
    case "openai": {
      credentialEnvRef = resolveOpenAiCredentialEnvRef(env);
      providerAuthLane = "api_key";
      if (!credentialEnvRef) {
        blockers.push("missing_key:openai");
      }
      break;
    }
    case "ollama": {
      providerAuthLane = "none";
      // Ollama key-less; base URL reachability is checked at hub boot.
      break;
    }
    case null:
      break;
  }

  return {
    gated: blockers.length === 0,
    selectedProvider,
    providerAuthLane,
    credentialEnvRef,
    usesLegacyLane: legacyLane,
    blockers,
  };
}

export interface FridayDeepProofLaneSelection {
  selectedProvider: FridayDeepProofProviderKind;
  credentialEnvRef: string | null;
  providerAuthLane: FridayDeepProofProviderAuthLane;
}

export function assertFridayDeepProofSingleProviderLane(
  env: NodeJS.ProcessEnv = process.env,
): FridayDeepProofLaneSelection {
  const status = getFridayDeepProofEnvStatus(env);
  if (!status.gated || !status.selectedProvider || !status.providerAuthLane) {
    const parts: string[] = [];
    if (status.blockers.includes("no_provider_lane")) {
      parts.push(
        "set exactly one of FRIDAY_E2E_LIVE_ANTHROPIC=1 / FRIDAY_E2E_LIVE_DEEPSEEK=1 / FRIDAY_E2E_LIVE_OPENAI=1 / FRIDAY_E2E_LIVE_OLLAMA=1",
      );
    }
    if (status.blockers.includes("multiple_provider_lanes")) {
      parts.push(
        "exactly one provider lane is required; multiple FRIDAY_E2E_LIVE_* flags are set",
      );
    }
    if (status.blockers.includes("legacy_live_lane_enabled")) {
      parts.push("unset E2E_LIVE for deep proof runs");
    }
    if (status.blockers.includes("missing_key:anthropic")) {
      parts.push(liveAnthropicCredentialMessage());
    }
    if (status.blockers.includes("missing_key:deepseek")) {
      parts.push(
        "set FRIDAY_DEEPSEEK_API_KEY or DEEPSEEK_API_KEY for the DeepSeek deep-proof lane",
      );
    }
    if (status.blockers.includes("missing_key:openai")) {
      parts.push("set OPENAI_API_KEY for the OpenAI deep-proof lane");
    }
    throw new Error(
      `[Deep Proof] Single-provider lane required: ${parts.join("; ")}`,
    );
  }
  return {
    selectedProvider: status.selectedProvider,
    credentialEnvRef: status.credentialEnvRef,
    providerAuthLane: status.providerAuthLane,
  };
}

const INITIAL_DEEP_PROOF_STATUS = getFridayDeepProofEnvStatus();

export const FRIDAY_DEEP_PROOF_GATED = INITIAL_DEEP_PROOF_STATUS.gated;

/**
 * Provider key env ref for the active deep-proof lane (e.g.
 * "$FRIDAY_DEEPSEEK_API_KEY"). Null when the gate is closed or when the
 * selected provider is keyless (Ollama).
 */
export const FRIDAY_DEEP_PROOF_PROVIDER_KEY_ENV_REF =
  INITIAL_DEEP_PROOF_STATUS.credentialEnvRef;

export function selectFridayDeepProofProviderKind(): FridayDeepProofProviderKind | null {
  return INITIAL_DEEP_PROOF_STATUS.selectedProvider;
}

function providerLabel(kind: FridayDeepProofProviderKind | null): string {
  switch (kind) {
    case "anthropic":
      return "Anthropic";
    case "deepseek":
      return "DeepSeek";
    case "openai":
      return "OpenAI";
    case "ollama":
      return "Ollama";
    case null:
    default:
      return "no-deep-proof-provider-selected";
  }
}

/**
 * Human-readable label of the active deep-proof provider, used in describe
 * blocks and diagnostic messages. Reflects the lane this run actually
 * proves; do not generalize to other providers.
 */
export const FRIDAY_DEEP_PROOF_PROVIDER_LABEL = providerLabel(
  INITIAL_DEEP_PROOF_STATUS.selectedProvider,
);

/**
 * Default fast model for the active deep-proof lane. Pulls from real-env's
 * FAST_MODEL which is provider-keyed and overridable via E2E_FAST_MODEL.
 */
export function selectFridayDeepProofModel(): string {
  return FAST_MODEL;
}

export const FRIDAY_DEEP_PROOF_MODEL = FAST_MODEL;

export async function createFridayDeepProofHubEnv(opts?: {
  uiStaticDir?: string;
  hubConfig?: Record<string, unknown>;
}): Promise<RealHubEnv> {
  assertFridayDeepProofSingleProviderLane();
  const env = await createRealHubEnv(opts);
  if (!env.hub || !env.httpServer || !env.stateDir) {
    await cleanupRealHubEnv(env);
    throw new Error("[Deep Proof] Local runtime with hub/httpServer/stateDir is required");
  }
  return env;
}

export async function createFridayDeepProofHubEnvFromStateDir(
  stateDir: string,
  opts?: { uiStaticDir?: string; hubConfig?: Record<string, unknown> },
): Promise<RealHubEnv> {
  assertFridayDeepProofSingleProviderLane();
  return createRealHubEnvFromStateDir(stateDir, opts);
}

export interface FridayDeepProofProviderCreationOptions {
  name: string;
  models?: ReadonlyArray<string>;
  defaultModel?: string;
}

export interface FridayDeepProofProviderCreationResult {
  providerId: string;
  providerKind: FridayDeepProofProviderKind;
  model: string;
}

/**
 * Create a single provider on the hub matching the active deep-proof lane.
 * Returns providerId, the active providerKind, and the model used. Tests
 * should use the returned `model` for downstream `model:` parameters
 * (executeGoal, providerModel:, lastVerifiedProviderModel asserts) so the
 * fixture stays consistent with what was actually registered.
 */
export async function createFridayDeepProofProvider(
  env: RealHubEnv,
  opts: FridayDeepProofProviderCreationOptions,
): Promise<FridayDeepProofProviderCreationResult> {
  const lane = assertFridayDeepProofSingleProviderLane();
  const model = opts.defaultModel ?? FAST_MODEL;
  const models = opts.models ?? [model];

  let providerId: string;
  switch (lane.selectedProvider) {
    case "anthropic": {
      if (!lane.credentialEnvRef) {
        throw new Error(liveAnthropicCredentialMessage());
      }
      providerId = await createAnthropicProvider(env.baseUrl, env.accessToken, {
        name: opts.name,
        anthropicBaseUrl: process.env.E2E_ANTHROPIC_BASE_URL ?? ANTHROPIC_BASE_URL_DEFAULT,
        models: [...models],
        defaultModel: model,
        apiKeyEnvRef: lane.credentialEnvRef,
      });
      break;
    }
    case "deepseek": {
      if (!lane.credentialEnvRef) {
        throw new Error(
          "[Deep Proof] DeepSeek key env ref unresolved despite gate pass",
        );
      }
      providerId = await createDeepSeekProvider(env.baseUrl, env.accessToken, {
        name: opts.name,
        deepSeekBaseUrl: DEEPSEEK_BASE_URL,
        models: [...models],
        defaultModel: model,
        apiKeyEnvRef: lane.credentialEnvRef,
      });
      break;
    }
    case "openai": {
      if (!lane.credentialEnvRef) {
        throw new Error(
          "[Deep Proof] OpenAI key env ref unresolved despite gate pass",
        );
      }
      providerId = await createOpenAiProvider(env.baseUrl, env.accessToken, {
        name: opts.name,
        openAiBaseUrl: OPENAI_BASE_URL,
        models: [...models],
        defaultModel: model,
        apiKeyEnvRef: lane.credentialEnvRef,
      });
      break;
    }
    case "ollama": {
      providerId = await createOllamaProvider(env.baseUrl, env.accessToken, {
        name: opts.name,
        ollamaBaseUrl: OLLAMA_BASE_URL,
        models: [...models],
        defaultModel: model,
      });
      break;
    }
  }

  return { providerId, providerKind: lane.selectedProvider, model };
}

/**
 * Create a fast + code provider pair on the hub for the active deep-proof
 * lane and set routing accordingly. Mirrors api.ts ensure*Providers shape.
 * Returns provider IDs, the active providerKind, and the model strings used.
 */
export interface FridayDeepProofProviderPairOptions {
  fastModel?: string;
  codeModel?: string;
  apiKeyEnvRef?: string;
  namePrefix?: string;
}

export interface FridayDeepProofProviderPairResult {
  fastProviderId: string;
  codeProviderId: string;
  providerKind: FridayDeepProofProviderKind;
  fastModel: string;
  codeModel: string;
}

export async function ensureFridayDeepProofProviders(
  env: RealHubEnv,
  opts: FridayDeepProofProviderPairOptions = {},
): Promise<FridayDeepProofProviderPairResult> {
  const lane = assertFridayDeepProofSingleProviderLane();
  const fastModel = opts.fastModel ?? FAST_MODEL;
  const codeModel = opts.codeModel ?? FAST_MODEL;

  switch (lane.selectedProvider) {
    case "anthropic": {
      const credentialEnvRef = opts.apiKeyEnvRef ?? lane.credentialEnvRef;
      if (!credentialEnvRef) {
        throw new Error(liveAnthropicCredentialMessage());
      }
      const providers = await ensureAnthropicProviders(
        env.baseUrl,
        env.accessToken,
        process.env.E2E_ANTHROPIC_BASE_URL ?? ANTHROPIC_BASE_URL_DEFAULT,
        fastModel,
        codeModel,
        credentialEnvRef,
        { namePrefix: opts.namePrefix },
      );
      return {
        ...providers,
        providerKind: "anthropic",
        fastModel,
        codeModel,
      };
    }
    case "deepseek": {
      const credentialEnvRef = opts.apiKeyEnvRef ?? lane.credentialEnvRef ?? `$${DEEPSEEK_API_KEY_ENV}`;
      const providers = await ensureDeepSeekProviders(
        env.baseUrl,
        env.accessToken,
        DEEPSEEK_BASE_URL,
        fastModel,
        codeModel,
        credentialEnvRef,
        { namePrefix: opts.namePrefix },
      );
      return {
        ...providers,
        providerKind: "deepseek",
        fastModel,
        codeModel,
      };
    }
    case "openai": {
      const credentialEnvRef = opts.apiKeyEnvRef ?? lane.credentialEnvRef ?? `$${OPENAI_API_KEY_ENV}`;
      const providers = await ensureOpenAiProviders(
        env.baseUrl,
        env.accessToken,
        OPENAI_BASE_URL,
        fastModel,
        codeModel,
        credentialEnvRef,
        { namePrefix: opts.namePrefix },
      );
      return {
        ...providers,
        providerKind: "openai",
        fastModel,
        codeModel,
      };
    }
    case "ollama": {
      const providers = await ensureOllamaProviders(
        env.baseUrl,
        env.accessToken,
        OLLAMA_BASE_URL,
        fastModel,
        codeModel,
        { namePrefix: opts.namePrefix },
      );
      return {
        ...providers,
        providerKind: "ollama",
        fastModel,
        codeModel,
      };
    }
  }
}

export {
  cleanupRealHubEnv as cleanupFridayDeepProofHubEnv,
  shutdownRealHubEnv as shutdownFridayDeepProofHubEnv,
};
