// Phase 14.5E module_28e Slice 6.4 — owner-signed approval token for
// high-risk channel-triggered actions.
//
// The owner-link API (`POST /v1/channels/actions/{actionId}/owner-approve`)
// takes a token that is an HMAC-SHA-256 over a deterministic JSON payload
// containing the channel-action context. The signing key is the existing
// internal runtime secret (typically `FRIDAY_TOKEN_SECRET`); 14.5E does
// not introduce a new user-provided secret. The token is opaque to the
// channel side and is built by the local Assistant / API surface that
// has access to the runtime secret.
//
// The token payload is:
//
//   {
//     "actionId": "<canonical action id>",
//     "channelId": "<channelKind>:<chatId>",
//     "principalId": "<bound principal id>",
//     "riskLevel": "high",
//     "expiresAt": "<iso8601 utc timestamp>"
//   }
//
// The wire format is `${base64url(payloadJson)}.${hexHmac}`. The verifier
// reconstructs the payload, recomputes the HMAC, and accepts only when:
//   - the wire format is well-formed;
//   - every expected field matches the API request context;
//   - the timestamp has not yet expired;
//   - the HMAC is constant-time equal to the recomputed value.
//
// No part of the token is encrypted; it is a signed bearer-style approval
// that the owner-link UX hands the user. The token is single-use at the
// API layer: the route is expected to enforce idempotency by recording
// approvals in the same store the gate consults before execute.

import { createHmac, timingSafeEqual } from "node:crypto";

import { FridayDomainError } from "#errors";

const TOKEN_VERSION = "v1";
const HASH_ALGORITHM = "sha256";

export interface FridayChannelActionApprovalPayload {
  readonly actionId: string;
  readonly channelId: string;
  readonly principalId: string;
  readonly riskLevel: "high";
  readonly expiresAt: string;
}

export interface FridayChannelActionApprovalVerifyInput {
  readonly token: string;
  readonly actionId: string;
  readonly channelId: string;
  readonly principalId: string;
  readonly nowIso: string;
  readonly signingKey: string;
}

export interface FridayChannelActionApprovalSignInput
  extends FridayChannelActionApprovalPayload {
  readonly signingKey: string;
}

export const FRIDAY_CHANNEL_ACTION_APPROVAL_ERROR_CODES = {
  TOKEN_MALFORMED: "CHANNEL_OWNER_APPROVAL_TOKEN_MALFORMED",
  TOKEN_PAYLOAD_INVALID: "CHANNEL_OWNER_APPROVAL_TOKEN_PAYLOAD_INVALID",
  TOKEN_SIGNATURE_INVALID: "CHANNEL_OWNER_APPROVAL_TOKEN_SIGNATURE_INVALID",
  TOKEN_EXPIRED: "CHANNEL_OWNER_APPROVAL_TOKEN_EXPIRED",
  TOKEN_CONTEXT_MISMATCH: "CHANNEL_OWNER_APPROVAL_TOKEN_CONTEXT_MISMATCH",
  SIGNING_KEY_MISSING: "CHANNEL_OWNER_APPROVAL_SIGNING_KEY_MISSING",
} as const;

export function signFridayChannelActionApprovalToken(
  input: FridayChannelActionApprovalSignInput,
): string {
  if (typeof input.signingKey !== "string" || input.signingKey.length === 0) {
    throw new FridayDomainError(
      FRIDAY_CHANNEL_ACTION_APPROVAL_ERROR_CODES.SIGNING_KEY_MISSING,
      "Owner-signed approval requires a non-empty internal runtime signing key.",
      { httpStatus: 500 },
    );
  }
  assertPayload(input);
  const payloadJson = stableStringify({
    v: TOKEN_VERSION,
    actionId: input.actionId,
    channelId: input.channelId,
    principalId: input.principalId,
    riskLevel: input.riskLevel,
    expiresAt: input.expiresAt,
  });
  const encodedPayload = Buffer.from(payloadJson, "utf8").toString("base64url");
  const signature = createHmac(HASH_ALGORITHM, input.signingKey)
    .update(payloadJson, "utf8")
    .digest("hex");
  return `${encodedPayload}.${signature}`;
}

export function verifyFridayChannelActionApprovalToken(
  input: FridayChannelActionApprovalVerifyInput,
): FridayChannelActionApprovalPayload {
  if (typeof input.signingKey !== "string" || input.signingKey.length === 0) {
    throw new FridayDomainError(
      FRIDAY_CHANNEL_ACTION_APPROVAL_ERROR_CODES.SIGNING_KEY_MISSING,
      "Owner-signed approval requires a non-empty internal runtime signing key.",
      { httpStatus: 500 },
    );
  }
  if (typeof input.token !== "string" || !input.token.includes(".")) {
    throw new FridayDomainError(
      FRIDAY_CHANNEL_ACTION_APPROVAL_ERROR_CODES.TOKEN_MALFORMED,
      "Owner approval token must be `<base64url(payload)>.<hexHmac>`.",
      { httpStatus: 400 },
    );
  }
  const separatorIndex = input.token.indexOf(".");
  const encodedPayload = input.token.slice(0, separatorIndex);
  const signatureHex = input.token.slice(separatorIndex + 1);
  if (encodedPayload.length === 0 || signatureHex.length === 0) {
    throw new FridayDomainError(
      FRIDAY_CHANNEL_ACTION_APPROVAL_ERROR_CODES.TOKEN_MALFORMED,
      "Owner approval token is missing the payload or signature segment.",
      { httpStatus: 400 },
    );
  }

  let payloadJson: string;
  try {
    payloadJson = Buffer.from(encodedPayload, "base64url").toString("utf8");
  } catch {
    throw new FridayDomainError(
      FRIDAY_CHANNEL_ACTION_APPROVAL_ERROR_CODES.TOKEN_MALFORMED,
      "Owner approval token payload is not valid base64url.",
      { httpStatus: 400 },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    throw new FridayDomainError(
      FRIDAY_CHANNEL_ACTION_APPROVAL_ERROR_CODES.TOKEN_PAYLOAD_INVALID,
      "Owner approval token payload is not valid JSON.",
      { httpStatus: 400 },
    );
  }

  if (!isPlainObject(parsed)) {
    throw new FridayDomainError(
      FRIDAY_CHANNEL_ACTION_APPROVAL_ERROR_CODES.TOKEN_PAYLOAD_INVALID,
      "Owner approval token payload must be a JSON object.",
      { httpStatus: 400 },
    );
  }

  if ((parsed as { v?: unknown }).v !== TOKEN_VERSION) {
    throw new FridayDomainError(
      FRIDAY_CHANNEL_ACTION_APPROVAL_ERROR_CODES.TOKEN_PAYLOAD_INVALID,
      "Owner approval token version is not supported.",
      { httpStatus: 400 },
    );
  }

  const payload: FridayChannelActionApprovalPayload = {
    actionId: requireString(parsed, "actionId"),
    channelId: requireString(parsed, "channelId"),
    principalId: requireString(parsed, "principalId"),
    riskLevel: requireRiskLevel(parsed),
    expiresAt: requireString(parsed, "expiresAt"),
  };

  const expected = createHmac(HASH_ALGORITHM, input.signingKey)
    .update(payloadJson, "utf8")
    .digest("hex");
  if (!constantTimeEqualHex(expected, signatureHex)) {
    throw new FridayDomainError(
      FRIDAY_CHANNEL_ACTION_APPROVAL_ERROR_CODES.TOKEN_SIGNATURE_INVALID,
      "Owner approval token signature did not match the internal runtime key.",
      { httpStatus: 401 },
    );
  }

  if (payload.actionId !== input.actionId
    || payload.channelId !== input.channelId
    || payload.principalId !== input.principalId) {
    throw new FridayDomainError(
      FRIDAY_CHANNEL_ACTION_APPROVAL_ERROR_CODES.TOKEN_CONTEXT_MISMATCH,
      "Owner approval token does not match the requested action/channel/principal.",
      { httpStatus: 403 },
    );
  }

  const expiresAt = Date.parse(payload.expiresAt);
  const now = Date.parse(input.nowIso);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(now)) {
    throw new FridayDomainError(
      FRIDAY_CHANNEL_ACTION_APPROVAL_ERROR_CODES.TOKEN_PAYLOAD_INVALID,
      "Owner approval token expiresAt or current time is not a valid ISO-8601 timestamp.",
      { httpStatus: 400 },
    );
  }
  if (now >= expiresAt) {
    throw new FridayDomainError(
      FRIDAY_CHANNEL_ACTION_APPROVAL_ERROR_CODES.TOKEN_EXPIRED,
      "Owner approval token expired.",
      { httpStatus: 401 },
    );
  }

  return payload;
}

function assertPayload(input: FridayChannelActionApprovalPayload): void {
  if (input.riskLevel !== "high") {
    throw new FridayDomainError(
      FRIDAY_CHANNEL_ACTION_APPROVAL_ERROR_CODES.TOKEN_PAYLOAD_INVALID,
      "Owner approval token riskLevel must be \"high\".",
      { httpStatus: 400 },
    );
  }
  for (const key of ["actionId", "channelId", "principalId", "expiresAt"] as const) {
    if (typeof input[key] !== "string" || input[key].length === 0) {
      throw new FridayDomainError(
        FRIDAY_CHANNEL_ACTION_APPROVAL_ERROR_CODES.TOKEN_PAYLOAD_INVALID,
        `Owner approval token field "${key}" must be a non-empty string.`,
        { httpStatus: 400 },
      );
    }
  }
}

function requireString(source: unknown, key: string): string {
  const value = (source as Record<string, unknown>)[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new FridayDomainError(
      FRIDAY_CHANNEL_ACTION_APPROVAL_ERROR_CODES.TOKEN_PAYLOAD_INVALID,
      `Owner approval token field "${key}" must be a non-empty string.`,
      { httpStatus: 400 },
    );
  }
  return value;
}

function requireRiskLevel(source: unknown): "high" {
  const value = (source as Record<string, unknown>).riskLevel;
  if (value !== "high") {
    throw new FridayDomainError(
      FRIDAY_CHANNEL_ACTION_APPROVAL_ERROR_CODES.TOKEN_PAYLOAD_INVALID,
      "Owner approval token riskLevel must be \"high\".",
      { httpStatus: 400 },
    );
  }
  return value;
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function stableStringify(value: Record<string, unknown>): string {
  const keys = Object.keys(value).sort();
  const pairs = keys.map((key) => `${JSON.stringify(key)}:${JSON.stringify(value[key])}`);
  return `{${pairs.join(",")}}`;
}
