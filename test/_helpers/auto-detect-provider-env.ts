const AUTO_DETECT_PROVIDER_ENV_VARS = [
  "FRIDAY_ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "OLLAMA_BASE_URL",
] as const;

export type FridayAutoDetectProviderEnvSnapshot = Map<string, string | undefined>;

export function clearAutoDetectProviderEnv(): FridayAutoDetectProviderEnvSnapshot {
  const snapshot: FridayAutoDetectProviderEnvSnapshot = new Map(
    AUTO_DETECT_PROVIDER_ENV_VARS.map((key) => [key, process.env[key]]),
  );
  for (const key of AUTO_DETECT_PROVIDER_ENV_VARS) {
    delete process.env[key];
  }
  return snapshot;
}

export function restoreAutoDetectProviderEnv(
  snapshot: FridayAutoDetectProviderEnvSnapshot,
): void {
  for (const [key, value] of snapshot) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
