import type { FridayWsResumeFrame } from "#hub";
import type { FridayResumeValidationResult } from "../model/friday-satellite-protocol.types.js";
import type { FridayResumeCursorSigner } from "./friday-resume-cursor-signer.js";

export interface FridayAckResumeValidator {
  validateResume(frame: FridayWsResumeFrame, currentEpoch: number): FridayResumeValidationResult;
}

export function createFridayAckResumeValidator(
  cursorSigner: FridayResumeCursorSigner,
): FridayAckResumeValidator {
  return {
    validateResume(frame, currentEpoch) {
      // 1. Verify cursor HMAC
      let cursorPayload;
      try {
        cursorPayload = cursorSigner.verify(frame.cursor);
      } catch (err) {
        console.warn("[friday][ack-resume-validator] cursor HMAC verification failed:", err instanceof Error ? err.message : String(err));
        return {
          ok: false,
          code: "AUTH_UNAUTHORIZED",
          message: "Resume cursor HMAC verification failed",
        };
      }

      // 2. Check epoch matches current
      if (cursorPayload.epoch !== currentEpoch || frame.epoch !== currentEpoch) {
        return {
          ok: false,
          code: "STREAM_EPOCH_STALE",
          message: `Epoch mismatch: cursor=${cursorPayload.epoch}, frame=${frame.epoch}, current=${currentEpoch}`,
        };
      }

      // 3. Check stream ID matches
      if (cursorPayload.streamId !== frame.streamId) {
        return {
          ok: false,
          code: "AUTH_UNAUTHORIZED",
          message: "Stream ID in cursor does not match frame stream ID",
        };
      }

      // 4. Check seq consistency
      if (cursorPayload.seq !== frame.lastAckedSeq) {
        return {
          ok: false,
          code: "STREAM_CURSOR_OUT_OF_RANGE",
          message: `Cursor seq ${cursorPayload.seq} does not match frame lastAckedSeq ${frame.lastAckedSeq}`,
        };
      }

      return {
        ok: true,
        effectiveSeq: frame.lastAckedSeq,
      };
    },
  };
}
