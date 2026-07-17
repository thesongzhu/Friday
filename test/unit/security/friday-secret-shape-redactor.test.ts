import { describe, it, expect } from "vitest";
import {
  FRIDAY_DEFAULT_SECRET_MARKER,
  findSecretShapeSpans,
  isSensitiveSecretFieldName,
  redactSecretShapesInString,
} from "../../../src/security/friday-secret-shape-redactor.js";

// SEC-EVENT-REDACTION-001: the reusable secret-shape scrubber the at-rest audit redactor layers over
// the shared PII guard. Locks the full baseline coverage a redactor must have (SEC-EVENT-REDACTION-001
// rejects copied / incomplete lists) and the benign no-degrade property.
describe("friday-secret-shape-redactor", () => {
  const M = FRIDAY_DEFAULT_SECRET_MARKER;

  describe("isSensitiveSecretFieldName", () => {
    it("matches credential field names across case / separator variants", () => {
      for (const key of [
        "password", "passphrase", "secret", "clientSecret", "secretKey",
        "token", "accessToken", "access_token", "refreshToken", "sessionToken",
        "apiKey", "api_key", "API-KEY", "apiSecret", "privateKey", "authorization", "cookie",
        "credential", "credentials",
      ]) {
        expect(isSensitiveSecretFieldName(key)).toBe(true);
      }
    });

    it("does NOT match benign / forensic field names (no over-redaction)", () => {
      for (const key of [
        "id", "requestId", "correlationId", "sessionKey", "chatId", "authHeader",
        "note", "attempt", "runId", "messageId", "tokenCount", "keychainVersion",
      ]) {
        expect(isSensitiveSecretFieldName(key)).toBe(false);
      }
    });
  });

  describe("redactSecretShapesInString", () => {
    it("redacts each supported credential shape", () => {
      // pragma: allowlist secret
      const cases: Array<[string, (out: string) => void]> = [
        ["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", (o) => expect(o).toBe(M)], // pragma: allowlist secret
        ["github_pat_11ABCDE0aBcDeFgHiJkL_0123456789abcdefghijklmnopqrstuvWXYZ", (o) => expect(o).toBe(M)], // pragma: allowlist secret
        ["sk-abcdefghijklmnopqrstuv0123456789", (o) => expect(o).toBe(M)], // pragma: allowlist secret
        ["sk-proj-abcdefghijklmnopqrstuv0123456789", (o) => expect(o).toBe(M)], // pragma: allowlist secret
        ["AKIAIOSFODNN7EXAMPLE", (o) => expect(o).toBe(M)], // pragma: allowlist secret
        ["xoxb-EXAMPLENOTAREALSLACKTOKEN", (o) => expect(o).toBe(M)], // pragma: allowlist secret
        [
          "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c", // pragma: allowlist secret
          (o) => expect(o).toBe(M),
        ],
        [`Bearer abcdefghijklmnopqrstuvwx`, (o) => expect(o).toBe(`Bearer ${M}`)], // pragma: allowlist secret
        [`Authorization: Bearer abcdefghijklmnopqrstuvwx`, (o) => expect(o).toBe(`Authorization: Bearer ${M}`)], // pragma: allowlist secret
      ];
      for (const [input, assertOut] of cases) {
        assertOut(redactSecretShapesInString(input));
      }
    });

    it("redacts generic key=value / key: value credential assignments, keeping the label", () => {
      // pragma: allowlist secret
      expect(redactSecretShapesInString("api_key=genericcredential123abc")).toBe(`api_key=${M}`);
      expect(redactSecretShapesInString('config token: "supersecretvalue00"')).toBe(`config token: "${M}"`);
      expect(redactSecretShapesInString("startup: password=hunter2plaintext done")).toBe(
        `startup: password=${M} done`,
      );
    });

    it("redacts a PEM private-key block", () => {
      const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOwIBAAJBAKj34\n-----END RSA PRIVATE KEY-----"; // pragma: allowlist secret
      expect(redactSecretShapesInString(pem)).toBe(M);
    });

    it("honors a custom marker", () => {
      expect(redactSecretShapesInString("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "[X]")).toBe("[X]"); // pragma: allowlist secret
    });

    it("leaves benign text and forensic identifiers byte-identical (no over-redaction)", () => {
      for (const benign of [
        "delivery ok",
        "run-42",
        "wamid.HBgLABC123",
        "2015550123", // phone-shaped id is NOT a secret shape — untouched here
        "channel:signal:route-in",
        "9f8e7d6c5b4a3928170695f4e3d2c1b0", // pragma: allowlist secret
        "sku-12345", // not sk-<16+>
      ]) {
        expect(redactSecretShapesInString(benign)).toBe(benign);
      }
    });

    it("is idempotent (re-running over an already-redacted string is a no-op)", () => {
      const once = redactSecretShapesInString("token=supersecretvalue00 and sk-abcdefghijklmnopqrstuv0123456789"); // pragma: allowlist secret
      expect(redactSecretShapesInString(once)).toBe(once);
    });
  });

  // PRIV-UNICODE-REDACTION-001: the SPAN entry point consulted by the Unicode-normalizer
  // de-obfuscation layer. Spans + replacement must reconstruct exactly what the in-place scrubber
  // produces, so a match found on the normalized detection copy maps back and redacts the original.
  describe("findSecretShapeSpans", () => {
    it("reports a whole-value shape as a single span whose replacement is the marker", () => {
      const input = "leak: sk-abcdefghijklmnopqrstuv0123456789 here"; // pragma: allowlist secret
      const spans = findSecretShapeSpans(input);
      expect(spans).toHaveLength(1);
      const [s] = spans;
      expect(input.slice(s.start, s.end)).toBe("sk-abcdefghijklmnopqrstuv0123456789"); // pragma: allowlist secret
      expect(s.replacement).toBe(M);
      // Splicing the span reproduces the in-place scrubber output exactly.
      const spliced = input.slice(0, s.start) + s.replacement + input.slice(s.end);
      expect(spliced).toBe(redactSecretShapesInString(input));
    });

    it("keeps the scheme / label prefix in the replacement for Bearer and generic-assignment shapes", () => {
      const bearer = findSecretShapeSpans("Bearer abcdefghijklmnopqrstuvwx"); // pragma: allowlist secret
      expect(bearer[0].replacement).toBe(`Bearer ${M}`);
      const assign = findSecretShapeSpans("api_key=genericcredential123abc"); // pragma: allowlist secret
      expect(assign[0].replacement).toBe(`api_key=${M}`);
    });

    it("returns no spans for benign text (no over-redaction)", () => {
      for (const benign of ["delivery ok", "run-42", "channel:signal:route-in", "2015550123"]) {
        expect(findSecretShapeSpans(benign)).toEqual([]);
      }
    });
  });
});
