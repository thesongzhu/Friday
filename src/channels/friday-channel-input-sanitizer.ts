/**
 * Sanitizes inbound channel message text before it reaches the agent runtime.
 * Strips control characters, zero-width characters, and normalizes whitespace.
 * Enforces a maximum length to prevent memory/performance issues.
 */

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;

/** Maximum channel input length in characters (100 KB of UTF-16). */
export const FRIDAY_MAX_CHANNEL_INPUT_LENGTH = 50_000;

export function sanitizeChannelInput(input: string): string {
  // Truncate before expensive regex processing to bound CPU cost
  const bounded = input.length > FRIDAY_MAX_CHANNEL_INPUT_LENGTH
    ? input.slice(0, FRIDAY_MAX_CHANNEL_INPUT_LENGTH)
    : input;
  return bounded
    .normalize("NFC")
    .replace(CONTROL_CHARS, " ")
    .replace(ZERO_WIDTH, "")
    .replace(/\s+/g, " ")
    .trim();
}
