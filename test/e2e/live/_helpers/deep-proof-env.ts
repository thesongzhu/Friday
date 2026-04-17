import {
  ANTHROPIC_API_KEY_ENV_REF,
  cleanupRealHubEnv,
  createRealHubEnv,
  createRealHubEnvFromStateDir,
  type RealHubEnv,
} from "./real-env.js";
import { liveAnthropicCredentialMessage } from "../../_helpers/live-anthropic.js";

export interface FridayDeepProofEnvStatus {
  gated: boolean;
  providerAuthLane: "api_key";
  credentialEnvRef: string | null;
  usesLegacyLane: boolean;
  usesSupplementalLane: boolean;
  blockers: string[];
}

function readFlag(value: string | undefined): boolean {
  return value === "1";
}

export function getFridayDeepProofEnvStatus(
  env: NodeJS.ProcessEnv = process.env,
): FridayDeepProofEnvStatus {
  const anthropicGate = readFlag(env.FRIDAY_E2E_LIVE_ANTHROPIC);
  const legacyLane = readFlag(env.E2E_LIVE);
  const supplementalLane = readFlag(env.FRIDAY_E2E_LIVE_OPENAI) || readFlag(env.FRIDAY_E2E_LIVE_OLLAMA);
  const credentialEnvRef =
    typeof env.FRIDAY_ANTHROPIC_API_KEY === "string" && env.FRIDAY_ANTHROPIC_API_KEY.trim().length > 0
      ? "$FRIDAY_ANTHROPIC_API_KEY"
      : typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.trim().length > 0
        ? "$ANTHROPIC_API_KEY"
        : null;

  const blockers: string[] = [];
  if (!anthropicGate) {
    blockers.push("missing_anthropic_gate");
  }
  if (!credentialEnvRef) {
    blockers.push("missing_anthropic_api_key");
  }
  if (legacyLane) {
    blockers.push("legacy_live_lane_enabled");
  }
  if (supplementalLane) {
    blockers.push("supplemental_provider_lane_enabled");
  }

  return {
    gated: blockers.length === 0,
    providerAuthLane: "api_key",
    credentialEnvRef,
    usesLegacyLane: legacyLane,
    usesSupplementalLane: supplementalLane,
    blockers,
  };
}

export function assertFridayDeepProofAnthropicLane(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const status = getFridayDeepProofEnvStatus(env);
  if (!status.gated || !status.credentialEnvRef) {
    const parts: string[] = [];
    if (status.blockers.includes("missing_anthropic_gate")) {
      parts.push("set FRIDAY_E2E_LIVE_ANTHROPIC=1");
    }
    if (status.blockers.includes("missing_anthropic_api_key")) {
      parts.push(liveAnthropicCredentialMessage());
    }
    if (status.blockers.includes("legacy_live_lane_enabled")) {
      parts.push("unset E2E_LIVE for deep proof runs");
    }
    if (status.blockers.includes("supplemental_provider_lane_enabled")) {
      parts.push("unset FRIDAY_E2E_LIVE_OPENAI and FRIDAY_E2E_LIVE_OLLAMA for deep proof runs");
    }
    throw new Error(`[Deep Proof] Anthropic-only lane required: ${parts.join("; ")}`);
  }
  return status.credentialEnvRef;
}

export const FRIDAY_DEEP_PROOF_GATED = getFridayDeepProofEnvStatus().gated;

export async function createFridayDeepProofHubEnv(opts?: {
  uiStaticDir?: string;
}): Promise<RealHubEnv> {
  assertFridayDeepProofAnthropicLane();
  const env = await createRealHubEnv(opts);
  if (!env.hub || !env.httpServer || !env.stateDir) {
    await cleanupRealHubEnv(env);
    throw new Error("[Deep Proof] Local runtime with hub/httpServer/stateDir is required");
  }
  return env;
}

export async function createFridayDeepProofHubEnvFromStateDir(
  stateDir: string,
  opts?: { uiStaticDir?: string },
): Promise<RealHubEnv> {
  assertFridayDeepProofAnthropicLane();
  return createRealHubEnvFromStateDir(stateDir, opts);
}

export {
  cleanupRealHubEnv as cleanupFridayDeepProofHubEnv,
  ANTHROPIC_API_KEY_ENV_REF as FRIDAY_DEEP_PROOF_ANTHROPIC_API_KEY_ENV_REF,
};
