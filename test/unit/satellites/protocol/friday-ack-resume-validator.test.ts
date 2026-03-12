import { describe, it, expect } from "vitest";
import { createFridayResumeCursorSigner } from "#satellites";
import { createFridayAckResumeValidator } from "#satellites";
import type { FridayWsResumeFrame } from "#hub";

describe("FridayAckResumeValidator", () => {
  const secret = "test-validator-secret";
  const signer = createFridayResumeCursorSigner(secret);
  const validator = createFridayAckResumeValidator(signer);

  function makeResumeFrame(overrides: Partial<FridayWsResumeFrame> = {}): FridayWsResumeFrame {
    const cursor = signer.sign({
      seq: 10,
      streamId: "stream-001",
      epoch: 5,
      issuedAt: "2025-01-15T10:00:00.000Z",
    });
    return {
      type: "resume",
      lastAckedSeq: 10,
      streamId: "stream-001",
      epoch: 5,
      cursor,
      subscriptions: ["events"],
      emittedAt: "2025-01-15T10:05:00.000Z",
      ...overrides,
    };
  }

  it("accepts valid resume frame", () => {
    const frame = makeResumeFrame();
    const result = validator.validateResume(frame, 5);
    expect(result).toEqual({ ok: true, effectiveSeq: 10 });
  });

  it("rejects tampered cursor", () => {
    const frame = makeResumeFrame({ cursor: "tampered.cursor" });
    const result = validator.validateResume(frame, 5);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("AUTH_UNAUTHORIZED");
    }
  });

  it("rejects stale epoch in cursor", () => {
    // Cursor signed with epoch 5, but current epoch is 6
    const frame = makeResumeFrame();
    const result = validator.validateResume(frame, 6);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("STREAM_EPOCH_STALE");
    }
  });

  it("rejects epoch mismatch between frame and cursor", () => {
    // Frame says epoch 6 but cursor was signed with epoch 5
    const frame = makeResumeFrame({ epoch: 6 });
    const result = validator.validateResume(frame, 6);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("STREAM_EPOCH_STALE");
    }
  });

  it("rejects stream ID mismatch between frame and cursor", () => {
    const frame = makeResumeFrame({ streamId: "different-stream" });
    const result = validator.validateResume(frame, 5);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("AUTH_UNAUTHORIZED");
    }
  });

  it("rejects seq mismatch between frame and cursor", () => {
    const frame = makeResumeFrame({ lastAckedSeq: 999 });
    const result = validator.validateResume(frame, 5);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("STREAM_CURSOR_OUT_OF_RANGE");
    }
  });
});
