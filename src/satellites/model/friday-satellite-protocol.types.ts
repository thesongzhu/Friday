/**
 * Protocol types for satellite ACK/resume that extend
 * the base WS frame types in friday-hub-gateway-ingress.types.ts.
 *
 * The core FridayWsAckFrame, FridayWsResumeFrame, and FridayWsEventFrame
 * already exist in the hub service types — we DO NOT redefine them here.
 * This file contains only protocol-layer abstractions for cursor signing
 * and ack/resume validation.
 */

export interface FridayResumeCursorPayload {
  seq: number;
  streamId: string;
  epoch: number;
  issuedAt: string;
}

export type FridayResumeValidationResult =
  | { ok: true; effectiveSeq: number }
  | {
      ok: false;
      code: "AUTH_UNAUTHORIZED" | "STREAM_EPOCH_STALE" | "STREAM_CURSOR_OUT_OF_RANGE";
      message: string;
    };

export interface FridayStreamCheckpoint {
  satelliteId: string;
  streamId: string;
  seq: number;
  updatedAt: string;
}
