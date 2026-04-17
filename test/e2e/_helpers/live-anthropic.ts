export const LIVE_ANTHROPIC_MODEL = "claude-sonnet-4-20250514";

export function resolveLiveAnthropicApiKeyEnvRef(): string | null {
  const fridayApiKey = process.env.FRIDAY_ANTHROPIC_API_KEY?.trim();
  if (fridayApiKey) {
    return "$FRIDAY_ANTHROPIC_API_KEY";
  }
  const legacyApiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (legacyApiKey) {
    return "$ANTHROPIC_API_KEY";
  }
  return null;
}

export function hasLiveAnthropicApiKey(): boolean {
  return resolveLiveAnthropicApiKeyEnvRef() !== null;
}

export function liveAnthropicCredentialMessage(): string {
  return "FRIDAY_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY alias) env var is required";
}
