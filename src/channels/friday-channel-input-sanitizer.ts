/**
 * Sanitizes inbound channel message text before it reaches the agent runtime.
 * Strips control characters, zero-width characters, and Unicode
 * bidirectional / directional-format controls, folds line/paragraph
 * separators into whitespace, and normalizes whitespace.
 * Enforces a maximum length to prevent memory/performance issues.
 */

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;

/**
 * Unicode bidirectional / directional-format controls exploited by
 * "trojan-source" concealment and prompt-injection attacks to visually
 * reorder or hide instructions: the embedding/override formatters
 * U+202A-U+202E (LRE/RLE/PDF/LRO/RLO), the directional isolates
 * U+2066-U+2069 (LRI/RLI/FSI/PDI), and the Arabic Letter Mark U+061C.
 * Removed outright (like zero-width characters) so they cannot alter the
 * visual order of or conceal the underlying text.
 */
const BIDI_FORMAT_CONTROLS = /[\u061C\u202A-\u202E\u2066-\u2069]/g;

/**
 * Line/paragraph separators not covered by the C0/DEL control strip:
 * LINE SEPARATOR U+2028, PARAGRAPH SEPARATOR U+2029, and NEL U+0085.
 * Mapped to a space so they fold into the existing whitespace-normalization
 * chain consistently with the other separators.
 */
const LINE_PARA_SEPARATORS = /[\u0085\u2028\u2029]/g;

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
    .replace(BIDI_FORMAT_CONTROLS, "")
    .replace(ZERO_WIDTH, "")
    .replace(LINE_PARA_SEPARATORS, " ")
    .replace(/\s+/g, " ")
    .trim();
}
