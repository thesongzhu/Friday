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

  // Stripe-shaped fixtures are BUILT from `<prefix>_<body>` at runtime so no contiguous literal Stripe
  // key (`sk_live_…`) ever appears in SOURCE — GitHub push protection scans source text and does NOT
  // honor the detect-secrets pragma. At runtime these produce the exact shapes the redactor must
  // (`sk_live`/`sk_test`/`rk_live`/`rk_test`/`whsec`) or must NOT (`pk_live`/`pk_test`) catch.
  const stripeShaped = (prefix: string): string => `${prefix}_0123456789abcdefghijABCDwxyz`; // pragma: allowlist secret

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

    // SEC-EVENT-REDACTION-001 (round-15): Stripe-style UNDERSCORE-format secrets the hyphenated `sk-`
    // shape MISSES. RED on 14e4c4f4 (underscore form returned verbatim); GREEN once the underscore
    // pattern is added. `sk_live_`/`sk_test_` (secret) + `rk_live_`/`rk_test_` (restricted) + `whsec_`
    // (webhook signing secret) redact; the PUBLISHABLE `pk_live_`/`pk_test_` keys are NOT secrets and
    // MUST survive byte-identical.
    it("redacts Stripe underscore-format SECRET / RESTRICTED / webhook keys (sk_live_/sk_test_/rk_live_/rk_test_/whsec_)", () => {
      for (const secret of ["sk_live", "sk_test", "rk_live", "rk_test", "whsec"].map(stripeShaped)) {
        expect(redactSecretShapesInString(secret), secret.slice(0, 8)).toBe(M);
        // Also caught as a BARE value embedded in free text.
        expect(redactSecretShapesInString(`key ${secret} used`)).toBe(`key ${M} used`);
      }
    });

    it("does NOT redact Stripe PUBLISHABLE keys (pk_live_/pk_test_ are client-safe, not secrets)", () => {
      for (const publishable of ["pk_live", "pk_test"].map(stripeShaped)) {
        expect(redactSecretShapesInString(publishable), publishable.slice(0, 8)).toBe(publishable);
        expect(redactSecretShapesInString(`pub ${publishable} ok`)).toBe(`pub ${publishable} ok`);
      }
    });

    // SEC-EVENT-REDACTION-001 (round-15): exhaustive real-world provider-format audit. Anthropic
    // `sk-ant-` is covered by the `sk-` shape (the `-` is inside the value class); Google `AIza…` and
    // npm `npm_…` are NEW shapes this round. RED on 14e4c4f4 for AIza/npm_ (returned verbatim); GREEN
    // after. Benign `npm_config_cache` (short, has `_` in the body) must NOT match.
    it("redacts Anthropic sk-ant-, Google AIza…, and npm npm_… (exhaustive provider audit)", () => {
      for (const secret of [
        "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", // pragma: allowlist secret
        "AIzaSyD-abcdefghijklmnopqrstuvwxyz01234", // pragma: allowlist secret
        "npm_abcdefghijklmnopqrstuvwxyz0123456789", // pragma: allowlist secret
      ]) {
        expect(redactSecretShapesInString(secret), secret.slice(0, 8)).toBe(M);
        expect(redactSecretShapesInString(`use ${secret} now`)).toBe(`use ${M} now`);
      }
      // Benign npm_ config identifier is NOT a token (short, `_` inside the body) → untouched.
      expect(redactSecretShapesInString("npm_config_cache is set")).toBe("npm_config_cache is set");
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

    // Round-15: the underscore-format Stripe secret is reported as a whole-value span (so the memory
    // key/value legs that consume this SPAN entry point redact it too); the publishable pk_ key is not.
    it("reports the underscore-format Stripe secret as a span and never the publishable pk_ key", () => {
      const secret = stripeShaped("sk_live");
      const input = `leak ${secret} here`;
      const spans = findSecretShapeSpans(input);
      expect(spans).toHaveLength(1);
      expect(input.slice(spans[0].start, spans[0].end)).toBe(secret);
      expect(findSecretShapeSpans(`pub ${stripeShaped("pk_live")} ok`)).toEqual([]);
    });
  });

  // ─── SEC-EVENT-REDACTION-001 round-16: consolidated provider-shape audit + the `pk-` HYPHEN
  //     over-redaction fix. Each fixture is BUILT from parts (`seg(...)`) so no contiguous literal
  //     credential appears in SOURCE (GitHub push protection); the bodies are obviously-fake sequential
  //     strings. Findings 2 (pk- publishable removed) + 3 (ya29/xapp/glpat/SG/GOCSPX/sq0/dop/gsk/xai). ───
  describe("round-16 consolidated provider audit + pk- hyphen fix", () => {
    const seg = (...p: string[]): string => p.join(""); // pragma: allowlist secret
    const SGPOOL = "ABCdefGHIjkl0123456789abcdefghijkLMNopqrstuvwxyz0123456789"; // pragma: allowlist secret
    // Each ADDED shape as a bare value (Friday itself recognizes each as key material / sensitive).
    const ADDED: Record<string, string> = {
      "Google OAuth ya29.": seg("ya29.", "a0AfB_by-DtestTokenValue0123456789ABCDEFxyz"), // pragma: allowlist secret
      "Slack app-level xapp-": seg("xapp-", "1-A0123ABCD-4567890123-abcdef0123456789abcdef"), // pragma: allowlist secret
      "GitLab glpat-": seg("glpat-", "ABCdef0123456789ghijkLMNop"), // pragma: allowlist secret
      "SendGrid SG.<22>.<43>": seg("SG.", SGPOOL.slice(0, 22), ".", SGPOOL.slice(0, 43)), // pragma: allowlist secret
      "Google client-secret GOCSPX-": seg("GOCSPX-", "abcdefghijklmnop_qrstuvwx"), // pragma: allowlist secret
      "Square sq0atp-": seg("sq0atp-", "0123456789abcdefghijklABCDwxyz"), // pragma: allowlist secret
      "Square sq0csp-": seg("sq0csp-", "0123456789abcdefghijklABCDwxyz"), // pragma: allowlist secret
      "DigitalOcean dop_v1_": seg("dop_v1_", "0123456789abcdef".repeat(4)), // pragma: allowlist secret
      "Groq gsk_": seg("gsk_", "abcdefghijklmnopqrstuvwxyz0123456789ABCDwx"), // pragma: allowlist secret
      "xAI xai-": seg("xai-", "abcdefghijklmnop0123456789"), // pragma: allowlist secret
    };

    it("redacts every ADDED provider shape whole (bare value) AND embedded in free text", () => {
      for (const [name, secret] of Object.entries(ADDED)) {
        expect(redactSecretShapesInString(secret), name).toBe(M);
        expect(redactSecretShapesInString(`use ${secret} now`), name).toBe(`use ${M} now`);
      }
    });

    it("reports each ADDED shape as a whole-value span (so the memory key/value legs + audit redact it too)", () => {
      for (const [name, secret] of Object.entries(ADDED)) {
        const input = `leak ${secret} here`;
        const spans = findSecretShapeSpans(input);
        expect(spans.length, name).toBeGreaterThanOrEqual(1);
        expect(input.slice(spans[0]!.start, spans[0]!.end), name).toBe(secret);
        expect(spans[0]!.replacement, name).toBe(M);
      }
    });

    // FINDING 2 — NO-DEGRADE: the client-safe HYPHEN publishable `pk-` (Stripe/Google) and Friday's own
    // satellite `publicKey: "pk-…"` are NOT secrets. Round-15 wrongly classified bare `pk-<16+>` as a
    // credential → data-loss. RED before the alternation drops `pk`; GREEN after.
    it("does NOT redact publishable pk- HYPHEN keys (client-safe; Friday satellite publicKey)", () => {
      for (const pkVal of [
        seg("pk-", "abcdefghijklmnopqrstuv0123456789"), // pragma: allowlist secret — 32-char body, would have matched round-15
        seg("pk-", "abcdefghijklmnop"), // pragma: allowlist secret — 16-char body
        seg("pk-", "abc123"), // short satellite publicKey form
        "pk-1",
      ]) {
        expect(redactSecretShapesInString(pkVal), pkVal).toBe(pkVal);
        expect(findSecretShapeSpans(pkVal), pkVal).toEqual([]);
      }
      // In context: a satellite record's publicKey survives byte-identical.
      const rec = `{"publicKey":"${seg("pk-", "abcdefghijklmnopqrstuv0123456789")}"}`; // pragma: allowlist secret
      expect(redactSecretShapesInString(rec)).toBe(rec);
    });

    // FINDING 3 — Twilio SK is the API Key SID (an IDENTIFIER / username), NOT the secret. The Twilio
    // secret (Auth Token) is SHAPELESS → caught by its KEY NAME, never by a bare-`SK` shape. Redacting
    // `SK`+32-hex would over-redact a public identifier and false-fire on benign 34-char hex. EXCLUDED.
    it("does NOT redact Twilio API Key SID (SK+32-hex identifier) nor benign 32-hex / UUID near-misses", () => {
      for (const benign of [
        seg("SK", "0123456789abcdef0123456789abcdef"), // Twilio API Key SID (identifier, not secret) // pragma: allowlist secret
        "9f8e7d6c5b4a3928170695f4e3d2c1b0", // bare 32-hex (git blob / md5) // pragma: allowlist secret
        "550e8400-e29b-41d4-a716-446655440000", // a UUID
        "ya29_notatoken", // ya29 near-miss (underscore, not the literal `.`)
        "glpat_docs", // glpat near-miss (underscore, not the hyphen)
        "GOCSPX_notasecret_underscore", // GOCSPX near-miss (underscore, not the hyphen)
        "sq0abc-nothing", // sq0 near-miss (neither atp nor csp)
        "sku-12345", // not sk-<16+>
      ]) {
        expect(redactSecretShapesInString(benign), benign).toBe(benign);
        expect(findSecretShapeSpans(benign), benign).toEqual([]);
      }
    });

    // SENSITIVITY: the ADDED patterns are load-bearing. The pairing "shape → marker" vs "near-miss →
    // verbatim" IS the sensitivity boundary — removing any ADDED pattern makes its shape leak (RED),
    // while the near-misses guarantee the pattern is not an over-redactor.
    it("SENSITIVITY: each ADDED shape produces the marker (no silent pass-through)", () => {
      for (const [name, secret] of Object.entries(ADDED)) {
        expect(redactSecretShapesInString(secret), name).toContain(M);
        expect(redactSecretShapesInString(secret), name).not.toContain(secret);
      }
    });
  });

  // ─── SEC-EVENT-REDACTION-001 round-17: HuggingFace `hf_` user access token. The provider-catalog's
  //     `detectFridayProviderKindFromApiKey` classifies `hf_` as HuggingFace with HIGH confidence (a real
  //     bearer credential, a fully-wired Friday provider), yet the canonical detector MISSED it — round-16
  //     mined the SAME function for `gsk_`/`xai-` but left `hf_` uncovered, so it leaked verbatim on
  //     memory-egress + audit sinks. RED on d2e0e222 (bare `hf_`+34 returned verbatim, 0 spans); GREEN
  //     after `\bhf_[A-Za-z0-9]{34,}\b` is added. Fixtures are BUILT from parts (`seg`) so no contiguous
  //     literal token appears in SOURCE (GitHub push protection); the body is an obviously-fake sequence. ───
  describe("round-17 HuggingFace hf_ token", () => {
    const seg = (...p: string[]): string => p.join(""); // pragma: allowlist secret
    // 34-char base62 body WITH digits — proves the `[A-Za-z0-9]` class (real HF tokens include digits,
    // unlike the letters-only `hf_[a-zA-Z]{34}` secret-scanner rule this pattern is a strict superset of).
    const HF_BODY = "AbCdEfGhIjKlMnOpQrStUvWxYz01234567"; // pragma: allowlist secret — 34 base62 chars
    const HF = seg("hf_", HF_BODY); // pragma: allowlist secret

    it("redacts a bare hf_ token AND embedded in free text (whole value → marker)", () => {
      expect(redactSecretShapesInString(HF)).toBe(M);
      expect(redactSecretShapesInString(`use ${HF} now`)).toBe(`use ${M} now`);
    });

    it("redacts a LONGER fine-grained hf_ token (open-ended {34,} — no boundary leak)", () => {
      // A fine-grained token longer than 34 must not slip the trailing \b and leak (why `{34,}`, not `{34}`).
      const HF_LONG = seg("hf_", HF_BODY, "890abcXYZ"); // pragma: allowlist secret — 43-char body
      expect(redactSecretShapesInString(HF_LONG)).toBe(M);
      expect(redactSecretShapesInString(`k ${HF_LONG} k`)).toBe(`k ${M} k`);
    });

    it("reports the hf_ token as a whole-value span (memory key/value legs + audit consume it)", () => {
      const input = `leak ${HF} here`;
      const spans = findSecretShapeSpans(input);
      expect(spans).toHaveLength(1);
      expect(input.slice(spans[0]!.start, spans[0]!.end)).toBe(HF);
      expect(spans[0]!.replacement).toBe(M);
    });

    // NO-DEGRADE: the body class excludes `_` and requires 34+ contiguous base62 chars, so a benign
    // `hf_`-prefixed snake_case identifier, a short form, and a bare 34-char hash (no prefix) all survive
    // byte-identical with NO span (not an over-redactor). NOTE: a `hf_` GLUED to a preceding word char
    // followed by a real 34+ high-entropy body (`shf_<34>`) is NO LONGER a benign near-miss — it is a
    // leaked-credential evasion the glued-prefix fix (SEC-SECRET-GLUED-PREFIX-001) now catches; that case
    // moved to the glued-prefix describe block below.
    it("does NOT redact benign hf_ near-misses (hf_docs / short / underscore body / bare hash)", () => {
      for (const benign of [
        "hf_docs", // short (4 body chars)
        "hf_", // prefix only
        "hf_config_value_thing", // underscore-separated identifier, no 34-char base62 run
        "AbCdEfGhIjKlMnOpQrStUvWxYz01234567", // pragma: allowlist secret — bare 34-char hash, NO hf_ prefix
      ]) {
        expect(redactSecretShapesInString(benign), benign).toBe(benign);
        expect(findSecretShapeSpans(benign), benign).toEqual([]);
      }
    });

    it("SENSITIVITY: the hf_ shape produces the marker (no silent pass-through)", () => {
      expect(redactSecretShapesInString(HF)).toContain(M);
      expect(redactSecretShapesInString(HF)).not.toContain(HF);
    });
  });

  // ─── SEC-SECRET-GLUED-PREFIX-001: the canonical detector missed a distinctive-prefix credential
  //     GLUED directly after an ASCII word char (`keyhf_<34>`): the leading `\b` on the whole-match
  //     prefix patterns requires a NON-word boundary before the prefix, so `<wordchar>hf_<body>` has no
  //     boundary and survived — reaching the audit-read, realtime on-wire, and memory read-back sinks.
  //     The fix DROPS the leading `\b` on the HIGH-ENTROPY distinctive-prefix whole-match patterns only.
  //     RED on bf6968f9 (glued forms return verbatim, 0 spans); GREEN after. Fixtures are BUILT from
  //     parts (`seg`) so no contiguous literal credential appears in SOURCE (GitHub push protection). ───
  describe("SEC-SECRET-GLUED-PREFIX-001 glued distinctive-prefix credential (leading \\b evasion)", () => {
    const seg = (...p: string[]): string => p.join(""); // pragma: allowlist secret
    const SGPOOL = "ABCdefGHIjkl0123456789abcdefghijkLMNopqrstuvwxyz0123456789"; // pragma: allowlist secret
    const SG_SECRET = seg("SG.", SGPOOL.slice(0, 22), ".", SGPOOL.slice(0, 43)); // pragma: allowlist secret

    // Patterns whose leading `\b` was DROPPED — each is a high-signal literal prefix + LONG high-entropy
    // body (body excludes separators OR the prefix is astronomically distinctive), so allowing a glued
    // prefix cannot over-match a plausible benign identifier. [name, whole-secret].
    const DEBOUNDED: Array<[string, string]> = [
      ["HuggingFace hf_", seg("hf_", "AbCdEfGhIjKlMnOpQrStUvWxYz01234567")], // pragma: allowlist secret — 34 base62
      ["Groq gsk_", seg("gsk_", "abcdefghijklmnopqrstuvwxyz0123456789ABCDwx")], // pragma: allowlist secret — 42 base62
      ["npm npm_", seg("npm_", "abcdefghijklmnopqrstuvwxyz0123456789")], // pragma: allowlist secret — 36 base62
      ["DigitalOcean dop_v1_", seg("dop_v1_", "0123456789abcdef".repeat(4))], // pragma: allowlist secret — 64 hex
      ["Google GOCSPX-", seg("GOCSPX-", "abcdefghijklmnop_qrstuvwx")], // pragma: allowlist secret
      ["GitLab glpat-", seg("glpat-", "ABCdef0123456789ghijkLMNop")], // pragma: allowlist secret
      ["SendGrid SG.<22>.<43>", SG_SECRET], // pragma: allowlist secret
      ["Square sq0atp-", seg("sq0atp-", "0123456789abcdefghijklABCDwxyz")], // pragma: allowlist secret
      ["Square sq0csp-", seg("sq0csp-", "0123456789abcdefghijklABCDwxyz")], // pragma: allowlist secret
      // GitHub classic {ghp,ghr} were SPLIT out of the classic alternation and PLAIN de-`\b`'d
      // (SEC-SECRET-GLUED-PREFIX-001 P1 fix): both have ZERO dict word-endings and are not a benign
      // fragment, so a glued `keyghp_<36>` / `keyghr_<…>` (after ANY word char) is now CAUGHT. The
      // AMBIGUOUS classic members {gho,ghs,ghu,github_pat_} KEEP `\b` — see KEPT.
      // NB: AWS `AKIA` is ALSO de-bounded (P1 canary) but via a CONTEXT-SENSITIVE `(?<![A-Z0-9])`
      // lookbehind — NOT a plain `\b`-drop — because `AKIA` is the suffix of SLOV-AKIA / CZECHOSLOV-AKIA,
      // so it is NOT in this DEBOUNDED set (whose generic assertion is that an UPPERCASE-`X`-glued form
      // also redacts, which must NOT hold for AKIA). AKIA has its own dedicated lookbehind test below.
      ["GitHub classic ghp_ (0 word-endings)", seg("ghp_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")], // pragma: allowlist secret — 36 base62
      ["GitHub classic ghr_ (0 word-endings)", seg("ghr_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")], // pragma: allowlist secret — 36 base62
      ["Slack xoxb-", seg("xoxb-", "EXAMPLENOTAREALSLACKTOKEN")], // pragma: allowlist secret
    ];

    it("RED→GREEN: a glued (word-char-prefixed) credential is redacted, benign prefix char preserved", () => {
      for (const [name, secret] of DEBOUNDED) {
        // Standalone still redacts (no regression on the existing whole-value behavior).
        expect(redactSecretShapesInString(secret), `${name} standalone`).toBe(M);
        // GLUED after a single word char, and after a multi-char word — only the credential is redacted.
        expect(redactSecretShapesInString(seg("X", secret)), `${name} X-glued`).toBe(`X${M}`);
        expect(redactSecretShapesInString(seg("key", secret)), `${name} key-glued`).toBe(`key${M}`);
      }
    });

    it("reports the glued credential as a span that EXCLUDES the benign leading char (byte-preserving)", () => {
      for (const [name, secret] of DEBOUNDED) {
        const input = seg("key", secret);
        const spans = findSecretShapeSpans(input);
        expect(spans.length, name).toBe(1);
        // The span is exactly the credential (prefix+body) — the leading `key` is outside it.
        expect(input.slice(spans[0]!.start, spans[0]!.end), name).toBe(secret);
        expect(spans[0]!.replacement, name).toBe(M);
        // Splicing reproduces the in-place scrubber output (path parity, no off-by-one).
        const spliced = input.slice(0, spans[0]!.start) + spans[0]!.replacement + input.slice(spans[0]!.end);
        expect(spliced, name).toBe(redactSecretShapesInString(input));
        expect(spliced, name).toBe(`key${M}`);
      }
    });

    it("still redacts through the EXISTING delimited paths (whitespace / quote / = / : / leading zero-width)", () => {
      const [, HFV] = DEBOUNDED[0]!; // hf_ secret
      expect(redactSecretShapesInString(`leak ${HFV} here`)).toBe(`leak ${M} here`);
      expect(redactSecretShapesInString(`"${HFV}"`)).toBe(`"${M}"`);
      expect(redactSecretShapesInString(`x=${HFV}`)).toBe(`x=${M}`);
      expect(redactSecretShapesInString(`ref: ${HFV}`)).toBe(`ref: ${M}`);
      expect(redactSecretShapesInString(`​${HFV}`)).toBe(`​${M}`); // leading zero-width
    });

    // KEPT the leading `\b` — the prefix is SHORT / low-signal and glues into a common word, or is itself
    // a common English WORD-FRAGMENT (`AI`/`app`/`-ghs`/"github"), so a glued form would over-redact a
    // benign identifier. Each: standalone STILL redacts, but the glued/word-embedded benign form is
    // UNCHANGED. [name, standalone-secret, glued-BENIGN].
    const KEPT: Array<[string, string, string]> = [
      ["sk- (desk-/risk-/task-)", seg("sk-", "abcdefghijklmnopqrstuv0123456789"), "desk-management-framework-v2extras"], // pragma: allowlist secret
      ["xai- (…xai)", seg("xai-", "abcdefghijklmnop0123456789"), seg("proxai-", "abcdefghijklmnop0123456789")], // pragma: allowlist secret
      ["Stripe sk_live_ (desk_/risk_)", seg("sk", "_live_", "0123456789abcdefABCD"), seg("desk", "_live_", "0123456789abcdefABCD")], // pragma: allowlist secret
      ["github_pat_ (natural phrase)", seg("github_pat_", "11ABCDE0aBcDeFgHiJkL0"), seg("my", "github_pat_", "reference0token0id00")], // pragma: allowlist secret
      // GitHub classic AMBIGUOUS {gho,ghs,ghu} — word-endings (sor-GHO / walkthrou-GHS / Ra-GHU), so a
      // glued form is NOT caught; standalone still is. (ghp/ghr were de-`\b`'d — see DEBOUNDED.)
      ["GitHub classic gho_ (…gho/ghs word-ending)", seg("gho_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"), seg("walkthroughs_", "completedThisWeekX")], // pragma: allowlist secret
      // AWS AMBIGUOUS {ASIA,AGPA,…} — ASIA is an English word + AGPA is ULID-constructible; the body is
      // all-caps/digit (ULID alphabet), so a glued form (a 26-char ULID `012345AGPA…`) is NOT caught;
      // standalone still is. (AKIA was de-`\b`'d — see DEBOUNDED.)
      ["AWS AMBIGUOUS ASIA/AGPA (word/ULID fragment)", seg("ASIA", "JEXAMPLE01234XYZ"), "012345AGPABCDEFGHJKMNPQRST"], // pragma: allowlist secret — glued-benign is a ULID
      ["Slack xapp- (maxapp-)", seg("xapp-", "1-A0123ABCD-4567890123"), "maxapp-config-value-here"], // pragma: allowlist secret
      ["Google AIza (openAIza…)", seg("AIza", "SyDabcdefghijklmnopqrstuvwxyz012345"), seg("open", "AIza", "SyDabcdefghijklmnopqrstuvwxyz012345")], // pragma: allowlist secret
      ["Google ya29. (maya29.field)", seg("ya29.", "a0AfBbyDtestTokenValue0123456789ABCDEF"), "maya29.profile_image_url_field_v2"], // pragma: allowlist secret
    ];

    it("NO-DEGRADE: KEPT-boundary short/low-signal prefixes still redact standalone but NOT when glued into a word", () => {
      for (const [name, standalone, gluedBenign] of KEPT) {
        expect(redactSecretShapesInString(standalone), `${name} standalone`).toBe(M);
        expect(redactSecretShapesInString(gluedBenign), `${name} glued-benign`).toBe(gluedBenign);
        expect(findSecretShapeSpans(gluedBenign), `${name} glued-benign span`).toEqual([]);
      }
    });

    // NO-DEGRADE benign-identifier corpus — MUST be returned byte-identical (zero redaction). These are
    // the ordinary identifiers/blobs the shared detector protects: short/low-entropy bodies after a
    // distinctive prefix, UUIDs, base64 blobs (incl. a `_`/`-`-bearing base64url one), snake_case ids,
    // `AKIA` as a plain word, hex ids, file paths, and hyphen/underscore near-misses.
    const BENIGN_CORPUS = [
      "myhf_variable", // hf_ + short body
      "staging_key",
      seg("gsk_", "count"), // gsk_count (short body)
      "sq0_index", // sq0 not followed by atp-/csp-
      "npm_config", // npm_ + short body with `_`
      "npm_config_cache is set",
      "550e8400-e29b-41d4-a716-446655440000", // a UUID
      "abc123def456ghi789jkl012mno345pqr678stuv", // pragma: allowlist secret — pure lowercase-alnum blob, no prefix reachable
      "aGVsbG8_d29ybGQ-dGhpc19pc19iZW5pZ24", // pragma: allowlist secret — base64url blob w/ `_` and `-`, not a secret shape
      "user_session_reference_identifier_v2", // snake_case id
      "AKIA is the aws access-key id prefix", // AKIA as a plain word (no 16-char body)
      // AWS AKIA NO-DEGRADE: benign all-caps / ULID / base32 ids where an ASIA/AIDA/AGPA fragment is GLUED
      // after a word char — the AKIA branch keeps `\b`, so these are UNCHANGED (they were CORRUPTED while
      // AKIA was de-`\b`'d). (A DELIMITED `"ASIA<16>"` — quote boundary — is caught by BASE too, so it is
      // NOT a benign-unchanged case; only the GLUED forms are the fix's concern.)
      "012345AGPABCDEFGHJKMNPQRST", // pragma: allowlist secret — 26-char Crockford-base32 ULID (AGPA glued after digit `5`)
      "AUSTRALASIAWIDEDEPLOYMENT01", // pragma: allowlist secret — all-caps constant, ASIA glued after `L`
      "EURASIAREGIONCODE0123456789", // pragma: allowlist secret — all-caps, ASIA glued after `R`
      "PROJECTAIDABUILDPIPELINE42X", // pragma: allowlist secret — all-caps, AIDA glued after `T`
      // Negative controls for the KEPT-`\b` AWS members whose fragment is NOT ULID nor a common word but
      // IS inside a common all-caps acronym / place name (criterion (c)) — these MUST survive:
      "AIPACPOLICYCONFERENCE2024ABC", // pragma: allowlist secret — AIPA is a prefix of the all-caps org AIPAC
      "AOTEAROANEWZEALANDGOVT01ABCD", // pragma: allowlist secret — AROA is inside the place name AOTEAROA
      "OPENCANVASRENDERINGCONTEXT2D", // pragma: allowlist secret — ANVA is inside CANVAS (also ULID-constructible)
      // Negative controls for the de-`\b`'d AKIA member: `AKIA` is the SUFFIX of the country names
      // SLOV-AKIA / CZECHOSLOV-AKIA (absent from the dict, so the per-word analysis missed them). The
      // `(?<![A-Z0-9])` context-lookbehind keeps `AKIA<16>` glued mid-all-caps-word / mid-alphanumeric-run
      // UNCHANGED (would corrupt under a plain leading-`\b` drop — `SLOVAKIA…` → `SLOV[REDACTED]`).
      "SLOVAKIAREGIONCODE2024AB", // pragma: allowlist secret — AKIA after `V` (uppercase) → not a credential
      "CZECHOSLOVAKIAREGIONCODE012345", // pragma: allowlist secret — AKIA after `V` → not a credential
      "deployed to SLOVAKIAREGIONCODE2024AB today", // pragma: allowlist secret — free-text SLOVAKIA embedding
      "PROJECT2AKIAXYZ0123456789ABC", // pragma: allowlist secret — AKIA after `2` (digit) → not a credential
      "9f8e7d6c5b4a3928170695f4e3d2c1b0", // pragma: allowlist secret — 32-hex id / git blob
      "/var/log/hf_service/npm_cache/output.log", // file path with hf_/npm_ short segments
      "GOCSPX_notasecret_underscore", // GOCSPX_ (underscore, not the required hyphen)
      "glpat_docs", // glpat_ (underscore, not the hyphen)
      "sq0abc-nothing", // sq0 near-miss (neither atp nor csp)
      // GitHub-classic NO-DEGRADE (round-2): benign snake_case words ENDING in ghs/gho/ghp/ghr/ghu
      // before `_`. The classic branch body is BASE62 (excludes `_`), so the snake_case `_` breaks the
      // body below 16 chars → no match. (These were CORRUPTED by the first-round `[A-Za-z0-9_]` body.)
      "walkthroughs_completed_counter",
      "walkthroughs_completedThisWeek", // CONTIGUOUS 17-base62 run after ghs_ — only the leading `\b` closes this
      "coughs_e3b0c44298fc1c14", // ghs_ + a content-hash suffix (contiguous base62)
      "highs_thresholdValueConfig1",
      "breakthroughs_this_quarter_list",
      "highs_and_lows_threshold_value",
      "coughs_detected_in_recording_v2",
      "laughs_per_minute_counter",
      "troughs_index",
      "sighs_and_weighs_and_doughs", // multiple ghs-ending words
      "metric name walkthroughs_started_and_completed today", // free-text sentence
      // Negative controls for the KEPT-`\b` github members gho/ghu (word-endings sor-GHO / Ra-GHU): a
      // lowercase `<word>_<16+ contiguous base62>` MUST survive (would over-redact if these were de-`\b`'d).
      "sorgho_yieldPerHectare2024xx", // gho_ + 21 contiguous base62 — only the leading `\b` closes this
      "raghu_authTokenReferenceValueV2", // ghu_ + contiguous base62 run
    ];

    it("NO-DEGRADE: the benign-identifier corpus is returned byte-identical (zero over-redaction)", () => {
      for (const benign of BENIGN_CORPUS) {
        expect(redactSecretShapesInString(benign), benign).toBe(benign);
        expect(findSecretShapeSpans(benign), benign).toEqual([]);
      }
    });

    // GitHub-classic sensitivity boundary (SEC-SECRET-GLUED-PREFIX-001 P1 split): the classic alternation
    // is SPLIT by prefix. {ghp,ghr} have ZERO dict word-endings → de-`\b`'d (a glued token is now CAUGHT);
    // {gho,ghs,ghu} are word-endings (sor-GHO / walkthrou-GHS / Ra-GHU) and `github_pat_` contains
    // "github" → KEEP `\b` (a glued token stays an ACCEPTED gap). Benign `<-ghs word>_<contiguous base62
    // run>` is UNCHANGED for the KEPT members even for a contiguous run a base62 body alone did not close;
    // a DELIMITED / standalone / labeled classic token IS still caught for EVERY prefix.
    it("GitHub-classic split: ghp/ghr GLUED redacts (P1); benign `…ghs_<run>` survives; gho/ghs/ghu GLUED is an accepted gap", () => {
      // Benign — the KEPT `\b` blocks the match; UNCHANGED even for a CONTIGUOUS 17+ base62 run.
      expect(redactSecretShapesInString("walkthroughs_completed_counter")).toBe("walkthroughs_completed_counter");
      expect(redactSecretShapesInString("walkthroughs_completedThisWeek")).toBe("walkthroughs_completedThisWeek"); // 17 contiguous base62
      expect(redactSecretShapesInString("coughs_e3b0c44298fc1c14")).toBe("coughs_e3b0c44298fc1c14"); // hash suffix
      expect(redactSecretShapesInString("highs_thresholdValueConfig1")).toBe("highs_thresholdValueConfig1");
      const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"; // 36 base62
      // DE-`\b`'d {ghp,ghr}: DELIMITED still caught AND a GLUED token is now REDACTED (P1 canary), the
      // benign leading char preserved byte-for-byte; the span is exactly the credential.
      for (const p of ["ghp_", "ghr_"]) {
        const TOK = seg(p, B62); // pragma: allowlist secret
        expect(redactSecretShapesInString(TOK), `${p} standalone`).toBe(M);
        expect(redactSecretShapesInString(`token ${TOK} used`), `${p} delimited`).toBe(`token ${M} used`);
        expect(redactSecretShapesInString(seg("key", TOK)), `${p} GLUED`).toBe(`key${M}`); // P1: now caught
        const spans = findSecretShapeSpans(seg("key", TOK));
        expect(spans.length, `${p} glued span`).toBe(1);
        expect(seg("key", TOK).slice(spans[0]!.start, spans[0]!.end), `${p} glued span body`).toBe(TOK);
      }
      // KEPT-`\b` {gho,ghs,ghu}: DELIMITED / standalone still caught, but a GLUED token stays an ACCEPTED
      // gap (these prefixes are benign word-endings, so de-`\b` would over-redact `sorgho_…`/`…ghs_…`).
      for (const p of ["gho_", "ghs_", "ghu_"]) {
        const TOK = seg(p, B62); // pragma: allowlist secret
        expect(redactSecretShapesInString(TOK), `${p} standalone`).toBe(M);
        expect(redactSecretShapesInString(`apikey=${TOK}`), `${p} labeled`).toBe(`apikey=${M}`);
        expect(redactSecretShapesInString(seg("key", TOK)), `${p} GLUED gap`).toBe(seg("key", TOK));
        expect(findSecretShapeSpans(seg("key", TOK)), `${p} glued span`).toEqual([]);
      }
    });

    // AWS sensitivity boundary (SEC-SECRET-GLUED-PREFIX-001 P1 split): the AWS alternation is SPLIT by
    // prefix. `AKIA` (has `I` → not ULID; no common all-caps acronym) is de-bounded via a context-sensitive
    // `(?<![A-Z0-9])` lookbehind — NOT a plain `\b`-drop — because `AKIA` is the suffix of the country
    // names SLOV-AKIA / CZECHOSLOV-AKIA (see the dedicated lookbehind test below); a glued `keyAKIA<16>`
    // is CAUGHT (P1 canary) while a mid-all-caps-word `SLOVAKIA<16>` is NOT. The AMBIGUOUS members
    // {ASIA,AGPA,AIDA,AROA,AIPA,ANPA,ANVA} — word-endings (Eur-ASIA), ULID-constructible (AGPA/ANPA/ANVA),
    // or acronym fragments (AIDA, AIPA→AIPAC, AROA→AOTEAROA) — KEEP `\b`, so a benign all-caps / ULID id
    // where the fragment is GLUED after a word char is UNCHANGED. A DELIMITED / standalone / labeled AWS
    // key IS still caught for EVERY prefix (the common case — AWS keys are ~always delimited in env/config).
    it("AWS split: AKIA GLUED redacts (P1); benign glued ULID/all-caps survives; ASIA/AGPA/AIDA/… GLUED is an accepted gap", () => {
      const B16 = "JEXAMPLE01234XYZ"; // 16 [0-9A-Z]
      // Benign all-caps / ULID with an AMBIGUOUS fragment GLUED after a word char → UNCHANGED (the `\b` blocks it).
      expect(redactSecretShapesInString("012345AGPABCDEFGHJKMNPQRST")).toBe("012345AGPABCDEFGHJKMNPQRST"); // pragma: allowlist secret — benign ULID (AKIA-family scanner false positive)
      expect(redactSecretShapesInString("AUSTRALASIAWIDEDEPLOYMENT01")).toBe("AUSTRALASIAWIDEDEPLOYMENT01"); // pragma: allowlist secret — benign all-caps constant
      expect(redactSecretShapesInString("PROJECTAIDABUILDPIPELINE42X")).toBe("PROJECTAIDABUILDPIPELINE42X"); // pragma: allowlist secret — benign all-caps constant
      // DE-`\b`'d AKIA: DELIMITED still caught AND a GLUED key is now REDACTED (P1 canary); leading char preserved.
      const KEY = seg("AKIA", "IOSFODNN7EXAMPLE"); // pragma: allowlist secret — AKIA + 16 [0-9A-Z]
      expect(redactSecretShapesInString(KEY)).toBe(M);
      expect(redactSecretShapesInString(`token ${KEY} used`)).toBe(`token ${M} used`);
      expect(redactSecretShapesInString(`apikey=${KEY}`)).toBe(`apikey=${M}`);
      expect(redactSecretShapesInString(seg("key", KEY))).toBe(`key${M}`); // P1: glued now caught
      const spans = findSecretShapeSpans(seg("key", KEY));
      expect(spans.length).toBe(1);
      expect(seg("key", KEY).slice(spans[0]!.start, spans[0]!.end)).toBe(KEY);
      // KEPT-`\b` AMBIGUOUS members: DELIMITED / standalone still caught, but a GLUED key stays an ACCEPTED gap.
      for (const p of ["ASIA", "AGPA", "AIDA", "AROA", "AIPA", "ANPA", "ANVA"]) {
        const K = seg(p, B16); // pragma: allowlist secret
        expect(redactSecretShapesInString(K), `${p} standalone`).toBe(M);
        expect(redactSecretShapesInString(`apikey=${K}`), `${p} labeled`).toBe(`apikey=${M}`);
        expect(redactSecretShapesInString(seg("x", K)), `${p} GLUED gap`).toBe(seg("x", K));
        expect(findSecretShapeSpans(seg("x", K)), `${p} glued span`).toEqual([]);
      }
    });

    // AWS AKIA context-lookbehind (SEC-SECRET-GLUED-PREFIX-001 round-5 NO-DEGRADE): `AKIA` is the SUFFIX of
    // the country names SLOV-AKIA / CZECHOSLOV-AKIA (proper nouns absent from /usr/share/dict/words, so the
    // per-word dict analysis missed them). A plain leading-`\b` drop corrupts an ALL-CAPS `SLOVAKIA<16>`
    // region constant (`SLOVAKIA<16>` → `SLOV[REDACTED]`). The `(?<![A-Z0-9])` lookbehind fixes
    // it: `AKIA` matches only when it starts a FRESH token (after lowercase / symbol / space / start), not
    // when embedded after an UPPERCASE letter or DIGIT. RED on 2c83630f (plain de-`\b`); GREEN after.
    it("AWS AKIA lookbehind: SLOVAKIA/CZECHOSLOVAKIA/alphanumeric-embedded survives; lowercase/symbol/space-glued still caught", () => {
      const K = seg("AKIA", "IOSFODNN7EXAMPLE"); // pragma: allowlist secret — AKIA + 16 [0-9A-Z]
      // NEGATIVE: AKIA preceded by an UPPERCASE letter or DIGIT → NOT a credential → UNCHANGED, 0 spans.
      const negatives = [
        "SLOVAKIAREGIONCODE2024AB", // pragma: allowlist secret — AKIA after `V`
        "CZECHOSLOVAKIAREGIONCODE012345", // pragma: allowlist secret — AKIA after `V`
        "deployed to SLOVAKIAREGIONCODE2024AB today", // pragma: allowlist secret — free-text SLOVAKIA embedding
        seg("PROJECT2", K), // AKIA after digit `2`
        seg("XAKIA", "IOSFODNN7EXAMPLE"), // pragma: allowlist secret — AKIA after uppercase `X` (mid-all-caps-word)
      ];
      for (const n of negatives) {
        expect(redactSecretShapesInString(n), n).toBe(n);
        expect(findSecretShapeSpans(n), n).toEqual([]);
      }
      // POSITIVE: AKIA starting a fresh token (lowercase / symbol / space / assignment / string start) → CAUGHT.
      expect(redactSecretShapesInString(seg("key", K))).toBe(`key${M}`); // lowercase glue (P1 canary)
      expect(redactSecretShapesInString(seg("aws", K))).toBe(`aws${M}`); // lowercase glue
      expect(redactSecretShapesInString(`(${K})`)).toBe(`(${M})`); // symbol glue
      expect(redactSecretShapesInString(`region ${K}`)).toBe(`region ${M}`); // whitespace delimited
      expect(redactSecretShapesInString(`aws_key=${K}`)).toBe(`aws_key=${M}`); // assignment
      expect(redactSecretShapesInString(K)).toBe(M); // string start
      // Span still excludes the benign lowercase lead (lookbehind is zero-width).
      const spans = findSecretShapeSpans(seg("key", K));
      expect(spans.length).toBe(1);
      expect(seg("key", K).slice(spans[0]!.start, spans[0]!.end)).toBe(K);
    });
  });
});
