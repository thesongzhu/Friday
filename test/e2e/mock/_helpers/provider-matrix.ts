/**
 * Provider matrix for parameterized mock E2E tests.
 */

import type {
  FridayProviderApi,
  FridayProviderKind,
  FridayProviderAuthMode,
} from "../../../../src/providers/model/friday-provider.types.js";

// ─── Matrix entry ───

export interface ProviderMatrixEntry {
  kind: FridayProviderKind;
  api: FridayProviderApi;
  authMode: FridayProviderAuthMode;
  baseUrl: string;
  model: string;
}

// ─── Provider matrix constant ───

export const PROVIDER_MATRIX: ReadonlyArray<ProviderMatrixEntry> = [
  {
    kind: "anthropic",
    api: "anthropic-messages",
    authMode: "api-key",
    baseUrl: "https://mock.anthropic.local",
    model: "mock-claude",
  },
  {
    kind: "openai",
    api: "openai-responses",
    authMode: "api-key",
    baseUrl: "https://mock.openai.local",
    model: "mock-gpt",
  },
  {
    kind: "openai-compatible",
    api: "openai-completions",
    authMode: "api-key",
    baseUrl: "https://mock.compat.local",
    model: "mock-compat",
  },
  {
    kind: "google",
    api: "google-generative-ai",
    authMode: "api-key",
    baseUrl: "https://mock.google.local",
    model: "mock-gemini",
  },
  {
    kind: "ollama",
    api: "ollama",
    authMode: "none",
    baseUrl: "https://mock.ollama.local",
    model: "mock-llama",
  },
] as const;

/**
 * Streaming-capable providers (those the agent LLM client can parse).
 * Excludes google-generative-ai which uses non-streaming JSON.
 */
export const STREAMING_PROVIDER_MATRIX = PROVIDER_MATRIX.filter(
  (p) => p.api !== "google-generative-ai",
);
