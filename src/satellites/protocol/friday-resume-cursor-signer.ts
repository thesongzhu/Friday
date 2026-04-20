import { createHmac, timingSafeEqual } from "node:crypto";
import { FridayDomainError } from "#errors";
import type { FridayResumeCursorPayload } from "../model/friday-satellite-protocol.types.js";

export interface FridayResumeCursorSigner {
  sign(input: FridayResumeCursorPayload): string;
  verify(cursor: string): FridayResumeCursorPayload;
}

/**
 * Creates an HMAC-based cursor signer for resume protocol.
 * The cursor is `base64(JSON payload).base64(HMAC-SHA256 signature)`.
 */
export function createFridayResumeCursorSigner(secretKey: string): FridayResumeCursorSigner {
  function computeHmac(data: string): string {
    return createHmac("sha256", secretKey).update(data).digest("base64url");
  }

  return {
    sign(input) {
      const payloadJson = JSON.stringify(input);
      const payloadB64 = Buffer.from(payloadJson).toString("base64url");
      const sig = computeHmac(payloadB64);
      return `${payloadB64}.${sig}`;
    },

    verify(cursor) {
      const dotIndex = cursor.indexOf(".");
      if (dotIndex === -1) {
        throw new FridayDomainError("CURSOR_VALIDATION_ERROR", "Invalid cursor format: missing signature separator", { httpStatus: 400 });
      }
      const payloadB64 = cursor.substring(0, dotIndex);
      const sig = cursor.substring(dotIndex + 1);

      const expectedSig = computeHmac(payloadB64);
      const receivedSigBuf = Buffer.from(sig);
      const expectedSigBuf = Buffer.from(expectedSig);
      if (
        receivedSigBuf.length !== expectedSigBuf.length
        || !timingSafeEqual(receivedSigBuf, expectedSigBuf)
      ) {
        throw new FridayDomainError("CURSOR_VALIDATION_ERROR", "Invalid cursor: HMAC verification failed", { httpStatus: 403 });
      }

      const payloadJson = Buffer.from(payloadB64, "base64url").toString("utf-8");
      return JSON.parse(payloadJson) as FridayResumeCursorPayload;
    },
  };
}
