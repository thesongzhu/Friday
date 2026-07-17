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

    // PRIV-UNICODE-REDACTION-001 round-9: a sensitive credential KEY hidden behind a Unicode
    // obfuscation (zero-width / combining mark / full-width / mathematical-alphanumeric / precomposed
    // accent) must still classify as sensitive, because a shapeless credential VALUE is catchable
    // ONLY by its KEY. Before round-9 the classifier normalized ASCII hyphen/underscore/whitespace +
    // lowercase ONLY, so an obfuscated KEY escaped classification. RED on 47c70192; GREEN once the
    // classifier canonicalizes the KEY through the shared `buildUnicodeDetectionCopy` primitive (the
    // SAME de-obfuscation used for values) BEFORE the existing ASCII normalization.
    it("matches sensitive field names hidden behind Unicode obfuscation (zero-width / combining / full-width / math-alnum / precomposed)", () => {
      for (const key of [
        "api​Key", // ZWSP → apikey
        "tóken", // combining acute over `o` → token
        "ｓｅｃｒｅｔ", // full-width `ｓｅｃｒｅｔ` → secret
        "\u{1D429}\u{1D41A}\u{1D42C}\u{1D42C}\u{1D430}\u{1D428}\u{1D42B}\u{1D41D}", // math-bold `𝐩𝐚𝐬𝐬𝐰𝐨𝐫𝐝` → password
        "pásswörd", // precomposed á / ö → password
        "acce‍ssToken", // ZWJ inside accessToken → accesstoken
        "clientｓecret", // mixed full-width `ｓ` in clientSecret → clientsecret
      ]) {
        expect(isSensitiveSecretFieldName(key)).toBe(true);
      }
    });

    // NO-DEGRADE: a benign multilingual key, or a near-miss that must NOT be mistaken for
    // token/secret/key/password, stays NON-sensitive — the canonicalization only feeds the SAME
    // exact-match set, it never broadens matching.
    it("does NOT over-classify benign multilingual / near-miss keys after Unicode canonicalization", () => {
      for (const key of [
        "用户名", // CJK `用户名` (username)
        "اسم", // Arabic `اسم` (name)
        "café", // accented `café` → cafe (not in set)
        "🔑icon", // 🔑icon — folds to `🔑icon`, not a credential token
        "ｔｏｋｅｎｓ", // full-width `ｔｏｋｅｎｓ` → tokens (plural ≠ token)
        "ｋｅｙ", // full-width `ｋｅｙ` → key (bare `key` intentionally NOT in the set)
        "ｐａｓｓｗｏｒｄＨｉｎｔ", // full-width `ｐａｓｓｗｏｒｄＨｉｎｔ` → passwordhint (compound ≠ password)
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

  // PRIV-UNICODE-REDACTION-001 (round-13): the SPAN entry point consulted by the Unicode-normalizer
  // de-obfuscation layer, and the CANONICAL prefix-preserving credential-subspan detector #1618 will
  // consume. Each match is reported as its sensitive CREDENTIAL [start,end) subspan + the MARKER (never
  // a replacement reconstructed from a — possibly normalized — prefix capture). For a whole-value shape
  // the subspan IS the whole match; for a PREFIX-BEARING shape the subspan is ONLY the credential AFTER
  // the preserved scheme/label + separator, so splicing the marker there in an ORIGINAL string leaves
  // the (possibly Unicode-obfuscated) prefix bytes byte-identical. Splicing reproduces the in-place
  // scrubber output exactly, so the two paths stay byte-consistent.
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

    // Round-13: the span for a prefix-bearing shape covers ONLY the credential — the benign scheme /
    // label + separator is NOT part of the span — and the replacement is the bare marker. This is what
    // preserves the ORIGINAL prefix bytes when the span is mapped back from a normalized detection copy.
    it("reports ONLY the credential subspan (not the prefix) for Bearer and generic-assignment shapes", () => {
      const bearerInput = "Bearer abcdefghijklmnopqrstuvwx"; // pragma: allowlist secret
      const bearer = findSecretShapeSpans(bearerInput);
      expect(bearer).toHaveLength(1);
      // Span excludes the "Bearer " scheme prefix — it is exactly the credential token.
      expect(bearerInput.slice(bearer[0].start, bearer[0].end)).toBe("abcdefghijklmnopqrstuvwx"); // pragma: allowlist secret
      expect(bearer[0].replacement).toBe(M);
      // Splicing the marker at the subspan preserves the "Bearer " prefix and matches the scrubber.
      const bearerSpliced =
        bearerInput.slice(0, bearer[0].start) + bearer[0].replacement + bearerInput.slice(bearer[0].end);
      expect(bearerSpliced).toBe(`Bearer ${M}`);
      expect(bearerSpliced).toBe(redactSecretShapesInString(bearerInput));

      // `Authorization: Bearer …` matches BOTH the Authorization-Bearer AND the bare-Bearer pattern,
      // so two OVERLAPPING credential spans are reported (redactUnicodeObfuscated merges them); EVERY
      // reported span is exactly the credential and excludes the header/scheme prefix.
      const authInput = "Authorization: Bearer abcdefghijklmnopqrstuvwx"; // pragma: allowlist secret
      const auth = findSecretShapeSpans(authInput);
      expect(auth.length).toBeGreaterThanOrEqual(1);
      for (const s of auth) {
        expect(authInput.slice(s.start, s.end)).toBe("abcdefghijklmnopqrstuvwx"); // pragma: allowlist secret
        expect(s.replacement).toBe(M);
        expect(authInput.slice(0, s.start) + M + authInput.slice(s.end)).toBe(
          `Authorization: Bearer ${M}`,
        );
      }

      const assignInput = "api_key=genericcredential123abc"; // pragma: allowlist secret
      const assign = findSecretShapeSpans(assignInput);
      expect(assign).toHaveLength(1);
      // Span excludes the "api_key=" label + separator — it is exactly the credential value.
      expect(assignInput.slice(assign[0].start, assign[0].end)).toBe("genericcredential123abc"); // pragma: allowlist secret
      expect(assign[0].replacement).toBe(M);
      const assignSpliced =
        assignInput.slice(0, assign[0].start) + assign[0].replacement + assignInput.slice(assign[0].end);
      expect(assignSpliced).toBe(`api_key=${M}`);
      expect(assignSpliced).toBe(redactSecretShapesInString(assignInput));

      // A quoted assignment: the surrounding quotes are benign and must be OUTSIDE the credential span.
      const quotedInput = 'config token: "supersecretvalue00"'; // pragma: allowlist secret
      const quoted = findSecretShapeSpans(quotedInput);
      expect(quoted).toHaveLength(1);
      expect(quotedInput.slice(quoted[0].start, quoted[0].end)).toBe("supersecretvalue00"); // pragma: allowlist secret
      expect(
        quotedInput.slice(0, quoted[0].start) + M + quotedInput.slice(quoted[0].end),
      ).toBe(`config token: "${M}"`);
    });

    it("returns no spans for benign text (no over-redaction)", () => {
      for (const benign of ["delivery ok", "run-42", "channel:signal:route-in", "2015550123"]) {
        expect(findSecretShapeSpans(benign)).toEqual([]);
      }
    });
  });
});
