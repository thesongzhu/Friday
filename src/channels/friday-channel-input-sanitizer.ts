/**
 * Sanitizes inbound channel message text before it reaches the agent runtime.
 * Strips control characters, zero-width characters, and normalizes whitespace.
 */

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;

export function sanitizeChannelInput(input: string): string {
  return input
    .replace(CONTROL_CHARS, " ")
    .replace(ZERO_WIDTH, "")
    .replace(/\s+/g, " ")
    .trim();
}
