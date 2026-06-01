import { describe, expect, it } from "vitest";
import {
  MIN_PASSPHRASE_LENGTH,
  evaluatePassphraseGate,
} from "@/lib/auth/first-run-passphrase";

describe("evaluatePassphraseGate (first-run local passphrase)", () => {
  it("blocks submit on an empty form (no accidental empty bootstrap)", () => {
    const s = evaluatePassphraseGate("", "");
    expect(s.canSubmit).toBe(false);
    expect(s.tooShort).toBe(false); // empty is not flagged as 'too short' (no error noise yet)
    expect(s.mismatch).toBe(false);
  });

  it("flags a too-short passphrase and blocks submit", () => {
    const short = "a".repeat(MIN_PASSPHRASE_LENGTH - 1);
    const s = evaluatePassphraseGate(short, short);
    expect(s.tooShort).toBe(true);
    expect(s.canSubmit).toBe(false);
  });

  it("flags a confirm mismatch and blocks submit", () => {
    const s = evaluatePassphraseGate("correct horse battery staple", "different value entirely");
    expect(s.mismatch).toBe(true);
    expect(s.canSubmit).toBe(false);
  });

  it("allows submit only when long enough AND matching", () => {
    const value = "correct horse battery staple";
    const s = evaluatePassphraseGate(value, value);
    expect(s.tooShort).toBe(false);
    expect(s.mismatch).toBe(false);
    expect(s.canSubmit).toBe(true);
  });

  it("treats exactly the minimum length as acceptable", () => {
    const value = "x".repeat(MIN_PASSPHRASE_LENGTH);
    const s = evaluatePassphraseGate(value, value);
    expect(s.canSubmit).toBe(true);
  });

  it("does not submit when long enough but confirm is still empty", () => {
    const s = evaluatePassphraseGate("correct horse battery staple", "");
    expect(s.canSubmit).toBe(false);
  });
});
