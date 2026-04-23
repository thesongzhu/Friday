import * as crypto from "node:crypto";

import type {
  FridayRealtimeClientFrame,
  FridayRealtimeEncryptedFrameEnvelope,
  FridayRealtimeServerFrame,
} from "../model/friday-api-realtime.types.js";

type FridayRealtimeFrameDirection = "client" | "server";

export interface FridayRealtimeFrameCrypto {
  keyId: string;
  encryptClientFrame(frame: FridayRealtimeClientFrame): FridayRealtimeEncryptedFrameEnvelope;
  decryptClientFrame(envelope: FridayRealtimeEncryptedFrameEnvelope): FridayRealtimeClientFrame;
  encryptServerFrame(frame: FridayRealtimeServerFrame): FridayRealtimeEncryptedFrameEnvelope;
  decryptServerFrame(envelope: FridayRealtimeEncryptedFrameEnvelope): FridayRealtimeServerFrame;
}

export interface CreateFridayRealtimeFrameCryptoOptions {
  secret: string;
  keyId?: string;
  randomBytes?: (size: number) => Buffer;
}

const ENVELOPE_VERSION = 1;
const ALGORITHM = "A256GCM";

export function isFridayRealtimeEncryptedFrameEnvelope(
  value: unknown,
): value is FridayRealtimeEncryptedFrameEnvelope {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { type?: unknown }).type === "encrypted"
    && (value as { envelopeVersion?: unknown }).envelopeVersion === ENVELOPE_VERSION
    && (value as { alg?: unknown }).alg === ALGORITHM
    && typeof (value as { keyId?: unknown }).keyId === "string"
    && typeof (value as { nonce?: unknown }).nonce === "string"
    && typeof (value as { ciphertext?: unknown }).ciphertext === "string"
    && typeof (value as { tag?: unknown }).tag === "string",
  );
}

function deriveKey(secret: string): Buffer {
  if (secret.trim().length === 0) {
    throw new Error("Realtime frame crypto secret is required");
  }
  return crypto.createHash("sha256").update(secret).digest();
}

function aadFor(direction: FridayRealtimeFrameDirection, keyId: string): Buffer {
  return Buffer.from(`friday-realtime:${direction}:${keyId}:v${String(ENVELOPE_VERSION)}`, "utf8");
}

export function createFridayRealtimeFrameCrypto(
  options: CreateFridayRealtimeFrameCryptoOptions,
): FridayRealtimeFrameCrypto {
  const keyId = options.keyId ?? "realtime-frame:v1";
  const key = deriveKey(options.secret);
  const randomBytes = options.randomBytes ?? crypto.randomBytes;

  function encryptFrame(
    frame: FridayRealtimeClientFrame | FridayRealtimeServerFrame,
    direction: FridayRealtimeFrameDirection,
  ): FridayRealtimeEncryptedFrameEnvelope {
    const nonce = randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aadFor(direction, keyId));
    const plaintext = Buffer.from(JSON.stringify(frame), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      type: "encrypted",
      envelopeVersion: ENVELOPE_VERSION,
      alg: ALGORITHM,
      keyId,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  }

  function decryptFrame<TFrame>(
    envelope: FridayRealtimeEncryptedFrameEnvelope,
    direction: FridayRealtimeFrameDirection,
  ): TFrame {
    if (!isFridayRealtimeEncryptedFrameEnvelope(envelope)) {
      throw new Error("Invalid realtime encrypted frame envelope");
    }
    if (envelope.keyId !== keyId) {
      throw new Error("Realtime encrypted frame keyId mismatch");
    }
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.nonce, "base64"),
    );
    decipher.setAAD(aadFor(direction, keyId));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext) as TFrame;
  }

  return {
    keyId,
    encryptClientFrame: (frame) => encryptFrame(frame, "client"),
    decryptClientFrame: (envelope) => decryptFrame<FridayRealtimeClientFrame>(envelope, "client"),
    encryptServerFrame: (frame) => encryptFrame(frame, "server"),
    decryptServerFrame: (envelope) => decryptFrame<FridayRealtimeServerFrame>(envelope, "server"),
  };
}
