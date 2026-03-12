import { describe, it, expect } from "vitest";
import {
  normalizeFridaySessionSendPolicy,
  resolveFridaySessionSendPolicy,
  isFridaySessionSendAllowed,
  FRIDAY_SESSION_DEFAULT_SEND_POLICY,
  FRIDAY_SESSION_VALID_SEND_POLICIES,
} from "#sessions";

describe("FridaySessionSendPolicy", () => {
  // ─── normalizeFridaySessionSendPolicy ───

  describe("normalizeFridaySessionSendPolicy", () => {
    it("normalizes 'allow'", () => {
      expect(normalizeFridaySessionSendPolicy("allow")).toBe("allow");
    });

    it("normalizes 'block'", () => {
      expect(normalizeFridaySessionSendPolicy("block")).toBe("block");
    });

    it("normalizes 'queue'", () => {
      expect(normalizeFridaySessionSendPolicy("queue")).toBe("queue");
    });

    it("normalizes uppercase values", () => {
      expect(normalizeFridaySessionSendPolicy("ALLOW")).toBe("allow");
      expect(normalizeFridaySessionSendPolicy("Block")).toBe("block");
    });

    it("trims whitespace", () => {
      expect(normalizeFridaySessionSendPolicy("  allow  ")).toBe("allow");
    });

    it("returns undefined for null", () => {
      expect(normalizeFridaySessionSendPolicy(null)).toBeUndefined();
    });

    it("returns undefined for undefined", () => {
      expect(normalizeFridaySessionSendPolicy(undefined)).toBeUndefined();
    });

    it("returns undefined for invalid values", () => {
      expect(normalizeFridaySessionSendPolicy("invalid")).toBeUndefined();
      expect(normalizeFridaySessionSendPolicy("")).toBeUndefined();
    });
  });

  // ─── resolveFridaySessionSendPolicy ───

  describe("resolveFridaySessionSendPolicy", () => {
    it("returns session policy when set", () => {
      expect(resolveFridaySessionSendPolicy({ sessionPolicy: "block" })).toBe("block");
    });

    it("returns rule policy when session policy is not set", () => {
      expect(resolveFridaySessionSendPolicy({ rulePolicy: "queue" })).toBe("queue");
    });

    it("prefers session policy over rule policy", () => {
      expect(resolveFridaySessionSendPolicy({
        sessionPolicy: "block",
        rulePolicy: "allow",
      })).toBe("block");
    });

    it("returns default when neither is set", () => {
      expect(resolveFridaySessionSendPolicy({})).toBe("allow");
    });

    it("returns default for undefined session policy", () => {
      expect(resolveFridaySessionSendPolicy({ sessionPolicy: undefined })).toBe("allow");
    });
  });

  // ─── isFridaySessionSendAllowed ───

  describe("isFridaySessionSendAllowed", () => {
    it("allows 'allow' policy", () => {
      expect(isFridaySessionSendAllowed("allow")).toBe(true);
    });

    it("blocks 'block' policy", () => {
      expect(isFridaySessionSendAllowed("block")).toBe(false);
    });

    it("blocks 'queue' policy", () => {
      expect(isFridaySessionSendAllowed("queue")).toBe(false);
    });
  });

  // ─── Constants ───

  describe("constants", () => {
    it("default send policy is 'allow'", () => {
      expect(FRIDAY_SESSION_DEFAULT_SEND_POLICY).toBe("allow");
    });

    it("valid policies include allow, block, queue", () => {
      expect(FRIDAY_SESSION_VALID_SEND_POLICIES.has("allow")).toBe(true);
      expect(FRIDAY_SESSION_VALID_SEND_POLICIES.has("block")).toBe(true);
      expect(FRIDAY_SESSION_VALID_SEND_POLICIES.has("queue")).toBe(true);
      expect(FRIDAY_SESSION_VALID_SEND_POLICIES.size).toBe(3);
    });
  });
});
