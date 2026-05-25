/**
 * Shared token-redaction helpers used by the Phase24 trusted inbound listeners
 * (Discord / Telegram / Lark+Feishu). Each listener writes JSON proof artifacts
 * that must never contain raw bot tokens or app secrets. The two primitives:
 *
 *   - scrub(value, token, { tokenLabel, prefixLabel })
 *       Walks every string in `value` (via JSON.parse(JSON.stringify(...))) and
 *       replaces:
 *         - exact `token` occurrences with `tokenLabel`
 *         - the first 12 chars of `token` with `prefixLabel`  (only when the
 *           token is >12 chars; matches the original inline helpers).
 *       Returns a deep-cloned, scrubbed copy. Non-strings pass through.
 *
 *   - containsTokenMaterial(serialized, token)
 *       Returns true if the serialized text still contains the raw token or
 *       its 12-char prefix. Used as a defense-in-depth assertion before any
 *       artifact is written to disk.
 *
 * createScrubber({ token, tokenLabel, prefixLabel }) returns ergonomic
 * pre-bound helpers so each listener can pass its own labels exactly once.
 *
 * Behavior parity: this module is a direct extraction of the duplicated
 * helpers from phase24b-discord-trusted-inbound-listener.mjs and
 * phase24c-telegram-trusted-inbound-listener.mjs. The redaction label is the
 * only thing that becomes a parameter — the 12-char prefix logic, the
 * empty-token short-circuit, and the deep-clone semantics are unchanged.
 */

const DEFAULT_PREFIX_CHARS = 12;

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * Deep-clone `value` and replace any occurrence of `token` (and its 12-char
 * prefix) with redaction labels.
 *
 * @param {unknown} value
 * @param {string} token
 * @param {{ tokenLabel: string, prefixLabel: string }} labels
 * @returns {unknown}
 */
export function scrub(value, token, labels) {
  const tokenLabel = labels?.tokenLabel ?? "[REDACTED_TOKEN]";
  const prefixLabel = labels?.prefixLabel ?? "[REDACTED_TOKEN_PREFIX]";
  const replacer = (_key, current) => {
    if (typeof current !== "string") return current;
    let next = current;
    if (isNonEmptyString(token)) {
      next = next.split(token).join(tokenLabel);
      if (token.length > DEFAULT_PREFIX_CHARS) {
        next = next.split(token.slice(0, DEFAULT_PREFIX_CHARS)).join(prefixLabel);
      }
    }
    return next;
  };
  let serialized;
  try {
    serialized = JSON.stringify(value, replacer);
  } catch {
    // Cycles or non-serializable members would otherwise propagate and leave
    // the caller stringifying the raw error (which may itself carry secrets).
    // Fail closed to a sentinel string instead.
    return "[REDACTED_UNSERIALIZABLE]";
  }
  return JSON.parse(serialized);
}

/**
 * Returns true if `serialized` contains `token` (or its 12-char prefix when
 * the token is longer than 12 chars). Used as a fail-closed assertion before
 * writing any proof artifact to disk.
 *
 * @param {string} serialized
 * @param {string} token
 * @returns {boolean}
 */
export function containsTokenMaterial(serialized, token) {
  if (!isNonEmptyString(token)) return false;
  if (typeof serialized !== "string") return false;
  if (serialized.includes(token)) return true;
  if (token.length > DEFAULT_PREFIX_CHARS && serialized.includes(token.slice(0, DEFAULT_PREFIX_CHARS))) {
    return true;
  }
  return false;
}

/**
 * Build a pair of pre-bound helpers for a given token + label set. Listeners
 * pass their own redaction labels exactly once at construction time:
 *
 *   const { scrub: scrubLocal, containsTokenMaterial: hasTokenLocal } =
 *     createScrubber({
 *       token: config.botToken,
 *       tokenLabel: "[REDACTED_DISCORD_BOT_TOKEN]",
 *       prefixLabel: "[REDACTED_DISCORD_BOT_TOKEN_PREFIX]",
 *     });
 *
 * @param {{ token: string, tokenLabel: string, prefixLabel: string }} options
 */
export function createScrubber({ token, tokenLabel, prefixLabel }) {
  const labels = { tokenLabel, prefixLabel };
  return {
    scrub(value) {
      return scrub(value, token, labels);
    },
    containsTokenMaterial(serialized) {
      return containsTokenMaterial(serialized, token);
    },
  };
}
