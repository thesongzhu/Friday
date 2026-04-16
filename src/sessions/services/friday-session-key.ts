import { FridayDomainError } from "#errors";

import {
  FRIDAY_SESSION_DEFAULT_ACCOUNT_ID,
  FRIDAY_SESSION_ERROR_CODES,
  FRIDAY_SESSION_KEY_SEGMENT_MAX_LENGTH,
  FRIDAY_SESSION_KEY_SEGMENT_REGEX,
  FRIDAY_SESSION_SUBAGENT_PREFIX,
} from "../friday-session.constants.js";
import type { FridaySessionKeyParts } from "../model/friday-session.types.js";

// ─── Segment normalization ───

function normalizeSegment(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function validateSegment(segment: string, label: string): void {
  if (!segment) {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
      `Session key segment '${label}' must not be empty`,
      { httpStatus: 400 },
    );
  }
  if (segment.length > FRIDAY_SESSION_KEY_SEGMENT_MAX_LENGTH) {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
      `Session key segment '${label}' exceeds max length of ${FRIDAY_SESSION_KEY_SEGMENT_MAX_LENGTH}`,
      { httpStatus: 400 },
    );
  }
  if (!FRIDAY_SESSION_KEY_SEGMENT_REGEX.test(segment)) {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
      `Session key segment '${label}' contains invalid characters: '${segment}'`,
      { httpStatus: 400 },
    );
  }
}

// ─── Key building ───

/** Build a canonical conversation session key: `<channel>:<accountId>:<chatId>`. */
export function buildFridaySessionKey(
  channel: string,
  chatId: string,
  accountId?: string,
): string {
  const c = normalizeSegment(channel);
  const a = normalizeSegment(accountId ?? FRIDAY_SESSION_DEFAULT_ACCOUNT_ID);
  const ch = normalizeSegment(chatId);

  validateSegment(c, "channel");
  validateSegment(a, "accountId");
  validateSegment(ch, "chatId");

  return `${c}:${a}:${ch}`;
}

/**
 * Build a canonical DM session key.
 * For DM chats, the chatId is collapsed to the userId,
 * so the same user on the same channel always maps to the same session.
 */
export function buildFridayDmSessionKey(
  channel: string,
  userId: string,
  accountId?: string,
): string {
  const normalizedUserId = normalizeSegment(userId);
  validateSegment(normalizedUserId, "userId");
  return buildFridaySessionKey(channel, normalizedUserId, accountId);
}

/** Build a subagent session key: `subagent:<parentKey>:<taskId>`. */
export function buildFridaySubagentSessionKey(
  parentKey: string,
  taskId: string,
): string {
  const normalizedTaskId = normalizeSegment(taskId);
  validateSegment(normalizedTaskId, "taskId");

  // Recursively validate the parent key
  parseFridaySessionKey(parentKey);

  return `${FRIDAY_SESSION_SUBAGENT_PREFIX}:${parentKey}:${normalizedTaskId}`;
}

// ─── Key parsing ───

const FRIDAY_SESSION_MAX_SUBAGENT_DEPTH = 10;

/** Parse a canonical session key into its constituent parts. */
export function parseFridaySessionKey(key: string, _depth = 0): FridaySessionKeyParts {
  if (_depth > FRIDAY_SESSION_MAX_SUBAGENT_DEPTH) {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
      `Session key exceeds maximum subagent nesting depth of ${FRIDAY_SESSION_MAX_SUBAGENT_DEPTH}`,
      { httpStatus: 400 },
    );
  }
  if (!key) {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
      "Session key must not be empty",
      { httpStatus: 400 },
    );
  }

  // Subagent key: `subagent:<parentKey>:<taskId>`
  if (key.startsWith(`${FRIDAY_SESSION_SUBAGENT_PREFIX}:`)) {
    const rest = key.slice(FRIDAY_SESSION_SUBAGENT_PREFIX.length + 1);
    // The taskId is the last segment; the parentKey is everything before it.
    // parentKey itself could be a subagent key (recursive), so we find the last `:`.
    const lastColon = rest.lastIndexOf(":");
    if (lastColon <= 0) {
      throw new FridayDomainError(
        FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
        `Subagent session key missing parentKey or taskId: '${key}'`,
        { httpStatus: 400 },
      );
    }

    const parentKey = rest.slice(0, lastColon);
    const taskId = rest.slice(lastColon + 1);

    validateSegment(taskId, "taskId");
    // Recursively validate the parent key
    const parentParts = parseFridaySessionKey(parentKey, _depth + 1);

    return {
      kind: "subagent",
      parentKey,
      taskId,
      channel: parentParts.channel,
      accountId: parentParts.accountId,
      chatId: parentParts.chatId,
      canonicalKey: key,
    };
  }

  // Legacy channel-scoped conversation key: `channel:<channelKind>:<chatSlot>`
  // `chatSlot` may already include encoded thread information.
  const legacyChannelSegments = key.split(":");
  if (legacyChannelSegments.length === 3 && legacyChannelSegments[0] === "channel") {
    const [, channelKind, chatSlot] = legacyChannelSegments;
    validateSegment(channelKind, "channel");
    validateSegment(chatSlot, "chatId");

    return {
      kind: "conversation",
      channel: channelKind,
      accountId: FRIDAY_SESSION_DEFAULT_ACCOUNT_ID,
      chatId: chatSlot,
      canonicalKey: key,
    };
  }

  // Legacy system-scoped key: `system:<chatSlot>`
  // Older internal surfaces (for example heartbeat) used a two-segment form.
  // Normalize them to the canonical 3-segment conversation shape.
  if (legacyChannelSegments.length === 2 && legacyChannelSegments[0] === "system") {
    const [, chatSlot] = legacyChannelSegments;
    validateSegment(chatSlot, "chatId");

    return {
      kind: "conversation",
      channel: "system",
      accountId: FRIDAY_SESSION_DEFAULT_ACCOUNT_ID,
      chatId: chatSlot,
      canonicalKey: `system:${FRIDAY_SESSION_DEFAULT_ACCOUNT_ID}:${chatSlot}`,
    };
  }

  // Conversation key: `<channel>:<accountId>:<chatId>`
  const segments = key.split(":");
  if (segments.length !== 3) {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
      `Session key must have exactly 3 segments (channel:accountId:chatId), got ${segments.length}: '${key}'`,
      { httpStatus: 400 },
    );
  }

  const [channel, accountId, chatId] = segments;
  validateSegment(channel, "channel");
  validateSegment(accountId, "accountId");
  validateSegment(chatId, "chatId");

  return {
    kind: "conversation",
    channel,
    accountId,
    chatId,
    canonicalKey: key,
  };
}

/** Validate a session key without returning parsed parts. Throws on invalid. */
export function validateFridaySessionKey(key: string): void {
  parseFridaySessionKey(key);
}

/**
 * Canonicalize a raw session key to its normalized form.
 * Applies lowercase + segment normalization to each segment.
 * Returns the canonicalized key string. Throws on structurally invalid keys.
 */
export function canonicalizeFridaySessionKey(rawKey: string, _depth = 0): string {
  if (_depth > FRIDAY_SESSION_MAX_SUBAGENT_DEPTH) {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
      `Session key exceeds maximum subagent nesting depth of ${FRIDAY_SESSION_MAX_SUBAGENT_DEPTH}`,
      { httpStatus: 400 },
    );
  }
  if (!rawKey) {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
      "Session key must not be empty",
      { httpStatus: 400 },
    );
  }

  // Subagent key: `subagent:<parentKey>:<taskId>`
  if (rawKey.startsWith(`${FRIDAY_SESSION_SUBAGENT_PREFIX}:`)) {
    const rest = rawKey.slice(FRIDAY_SESSION_SUBAGENT_PREFIX.length + 1);
    const lastColon = rest.lastIndexOf(":");
    if (lastColon <= 0) {
      throw new FridayDomainError(
        FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
        `Subagent session key missing parentKey or taskId: '${rawKey}'`,
        { httpStatus: 400 },
      );
    }

    const parentKey = rest.slice(0, lastColon);
    const taskId = rest.slice(lastColon + 1);
    const normalizedParent = canonicalizeFridaySessionKey(parentKey, _depth + 1);
    const normalizedTaskId = normalizeSegment(taskId);
    validateSegment(normalizedTaskId, "taskId");

    return `${FRIDAY_SESSION_SUBAGENT_PREFIX}:${normalizedParent}:${normalizedTaskId}`;
  }

  // Legacy channel-scoped conversation key. We keep the persisted key shape for
  // backward compatibility, but normalize the channel kind and slot contents so
  // session services can derive the correct `channel` column.
  if (rawKey.startsWith("channel:")) {
    const segments = rawKey.split(":");
    if (segments.length === 3) {
      const [, channelKind, chatSlot] = segments;
      const normalizedKind = normalizeSegment(channelKind);
      const normalizedSlot = normalizeSegment(chatSlot);
      validateSegment(normalizedKind, "channel");
      validateSegment(normalizedSlot, "chatId");
      return `channel:${normalizedKind}:${normalizedSlot}`;
    }

    if (segments.length === 5 && segments[3] === "thread") {
      const [, channelKind, chatId, , threadId] = segments;
      const normalizedKind = normalizeSegment(channelKind);
      const normalizedSlot = normalizeSegment(`${chatId}--thread--${threadId}`);
      validateSegment(normalizedKind, "channel");
      validateSegment(normalizedSlot, "chatId");
      return `channel:${normalizedKind}:${normalizedSlot}`;
    }

    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
      `Legacy channel session key must be 'channel:<kind>:<chat>' or 'channel:<kind>:<chat>:thread:<threadId>': '${rawKey}'`,
      { httpStatus: 400 },
    );
  }

  if (rawKey.startsWith("system:")) {
    const segments = rawKey.split(":");
    if (segments.length === 2) {
      const [, chatSlot] = segments;
      const normalizedSlot = normalizeSegment(chatSlot);
      validateSegment(normalizedSlot, "chatId");
      return `system:${FRIDAY_SESSION_DEFAULT_ACCOUNT_ID}:${normalizedSlot}`;
    }
  }

  // Conversation key: `<channel>:<accountId>:<chatId>`
  const segments = rawKey.split(":");
  if (segments.length !== 3) {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
      `Session key must have exactly 3 segments (channel:accountId:chatId), got ${segments.length}: '${rawKey}'`,
      { httpStatus: 400 },
    );
  }

  const [channel, accountId, chatId] = segments;
  const c = normalizeSegment(channel);
  const a = normalizeSegment(accountId);
  const ch = normalizeSegment(chatId);

  validateSegment(c, "channel");
  validateSegment(a, "accountId");
  validateSegment(ch, "chatId");

  return `${c}:${a}:${ch}`;
}

/**
 * Normalize a raw session key input.
 * Handles DM collapse when chatKind is "dm" and userId is provided.
 */
export function normalizeFridaySessionKey(input: {
  channel: string;
  chatId: string;
  userId?: string;
  accountId?: string;
  chatKind?: string;
}): string {
  // DM collapse: use userId as chatId for DM chats
  if (input.chatKind === "dm" && input.userId) {
    return buildFridayDmSessionKey(input.channel, input.userId, input.accountId);
  }

  return buildFridaySessionKey(input.channel, input.chatId, input.accountId);
}
