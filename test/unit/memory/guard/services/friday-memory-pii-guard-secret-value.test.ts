import { describe, it, expect } from "vitest";
import { createFridayMemoryPiiGuard } from "../../../../../src/memory/guard/services/friday-memory-pii-guard.js";
import {
  findSecretShapeSpans,
  isSensitiveSecretFieldName,
} from "../../../../../src/security/friday-secret-shape-redactor.js";

// ─── SEC-EVENT-REDACTION-001 round-14: the ROOT fix. The shared guard's string-VALUE leg
//     (`redactStringLeaf` inside `redactDeep`, and `scanAndTransform`) composed ONLY the PII
//     detectors — never the shared secret-shape redactor — so a secret string VALUE escaped every
//     `redactDeep`/`scanAndTransform` consumer. It now composes the canonical secret detector
//     (raw ∪ Unicode) WITH PII, secret precedence, exactly as `redactKey` does for a secret KEY.
//     RED on 815f98ad, GREEN after the centralization. ───

const M = "[REDACTED_SECRET]";

// Fake credentials used as string VALUES (never real).
const SK = "sk-abcdefghijklmnopqrstuv0123456789"; // pragma: allowlist secret
const SK_PROJ = "sk-proj-advisorCanary0123456789ABCDEFG"; // pragma: allowlist secret
const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"; // pragma: allowlist secret
const PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIBOwIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----"; // pragma: allowlist secret
const GH_PAT = "github_pat_11ABCDEF0aBcDeFgHiJkL_0123456789abcdefghij"; // pragma: allowlist secret
const BEARER = `Authorization: Bearer ${SK_PROJ}`; // pragma: allowlist secret
const GENERIC = "api_key=genericcredential123abcXYZ"; // pragma: allowlist secret

// Unicode-obfuscated secret VALUES.
const ZW_SK = "sk-​abcdefghijklmnop0123456789"; // U+200B // pragma: allowlist secret
const FW_SK = "ｓｋ－abcdefghijklmnop0123456789abcd"; // full-width sk- // pragma: allowlist secret
const CM_SK = "sk-ábcdefghijklmnop0123456789"; // combining acute // pragma: allowlist secret

describe("FridayMemoryPiiGuard — SECRET-shape string VALUE leg (round-14)", () => {
  const guard = createFridayMemoryPiiGuard("redact");

  describe("scanAndTransform (content/snippet leg)", () => {
    it("redacts each raw secret family in transformedContent; matches stays PII-only", () => {
      for (const secret of [SK, SK_PROJ, JWT, PEM, GH_PAT]) {
        const r = guard.scanAndTransform(`x ${secret} y`);
        expect(r.transformedContent).toContain(M);
        expect(r.transformedContent).not.toContain(secret);
        // Secrets carry NO PII tag — matches/distinctTypes remain empty for a secret-only string.
        expect(r.matches).toHaveLength(0);
        expect(r.distinctTypes).toHaveLength(0);
        expect(r.tagsToAdd).toHaveLength(0);
      }
    });

    it("redacts Unicode-obfuscated secrets (zero-width / full-width / combining)", () => {
      for (const secret of [ZW_SK, FW_SK, CM_SK]) {
        expect(guard.scanAndTransform(secret).transformedContent).toBe(M);
      }
    });

    it("preserves the Bearer / assignment forensic prefix, redacts ONLY the credential", () => {
      expect(guard.scanAndTransform(BEARER).transformedContent).toBe(`Authorization: Bearer ${M}`);
      expect(guard.scanAndTransform(GENERIC).transformedContent).toBe(`api_key=${M}`);
    });
  });

  describe("redactDeep (metadata / learned-fact value leg)", () => {
    it("redacts a secret string VALUE leaf, nested and in arrays; structure + benign siblings preserved", () => {
      const { value } = guard.redactDeep({
        a: SK,
        list: [{ k: JWT }, GENERIC],
        deep: { l2: { pem: PEM, header: BEARER } },
        note: "hello",
      });
      const v = value as {
        a: string;
        list: [{ k: string }, string];
        deep: { l2: { pem: string; header: string } };
        note: string;
      };
      expect(v.a).toBe(M);
      expect(v.list[0].k).toBe(M);
      expect(v.list[1]).toBe(`api_key=${M}`);
      expect(v.deep.l2.pem).toBe(M);
      expect(v.deep.l2.header).toBe(`Authorization: Bearer ${M}`);
      expect(v.note).toBe("hello");
    });

    it("SECRET PRECEDENCE: a secret assignment whose credential is PII-shaped → secret marker (not PII)", () => {
      const { value } = guard.redactDeep({ x: "token=123-45-6789" });
      // Secret runs first and consumes the credential bytes; the PII residual finds nothing.
      expect((value as { x: string }).x).toBe(`token=${M}`);
    });
  });

  describe("SENSITIVITY — the secret composition is load-bearing", () => {
    it("the PII matcher MISSES every secret family; the value leg CATCHES it", () => {
      // (a) Removing the secret composition (PII-only, the pre-round-14 leg) → the PII scan finds
      //     nothing, so transformedContent would equal the input (RED). (b) The value leg redacts it.
      for (const secret of [SK, SK_PROJ, JWT, GH_PAT, GENERIC]) {
        const r = guard.scanAndTransform(secret);
        expect(r.matches, `PII matcher must MISS ${secret.slice(0, 6)}`).toHaveLength(0);
        expect(r.transformedContent, `value leg must CATCH ${secret.slice(0, 6)}`).toContain(M);
        expect(r.transformedContent).not.toBe(secret);
      }
    });
  });

  describe("NO-DEGRADE — strict superset", () => {
    it("benign multilingual / PII-free / structured / typed values are byte-identical", () => {
      const benign = { color: "青", note: "café ok", count: 3, big: 123456789, ok: true, z: null };
      expect(guard.redactDeep(structuredClone(benign)).value).toEqual(benign);
      expect(guard.scanAndTransform("no secrets here 用户名 café").transformedContent).toBe(
        "no secrets here 用户名 café",
      );
    });

    it("PII values redact EXACTLY as before (secret composition did not disturb PII)", () => {
      expect(guard.scanAndTransform("email a@b.com card 4111 1111 1111 1111").transformedContent).toBe(
        "email [EMAIL] card [CREDIT_CARD]",
      );
      const { value } = guard.redactDeep({ ssn: "123-45-6789", note: "ok" });
      expect((value as { ssn: string; note: string }).ssn).toBe("[SSN_US]");
    });

    it("VALUE leg keeps the U+3000 ideographic-space card non-bridge (no over-redaction)", () => {
      // Two full-width 8-digit groups joined ONLY by U+3000 must NOT bridge into a false 16-digit
      // card — the value leg keeps PII on `findMatches` (which does not fold U+3000), so this is
      // preserved even though the secret Unicode pass runs over the NFKD copy.
      const g = "４１１１１１１１　１１１１１１１１"; // 8 + U+3000 + 8 full-width digits
      const r = guard.scanAndTransform(g);
      expect(r.distinctTypes).not.toContain("credit_card");
      expect(r.transformedContent).not.toContain("[CREDIT_CARD]");
      expect(r.transformedContent).toBe(g); // byte-identical
    });

    it("round-12 secret KEY redaction is unaffected (secret key still → marker)", () => {
      const { value } = guard.redactDeep({ [SK]: "v" });
      expect(Object.keys(value as Record<string, unknown>)).toEqual([M]);
      expect((value as Record<string, unknown>)[M]).toBe("v");
    });

    it("tag/block mode does NOT mutate a secret VALUE (redaction is a redact-mode mutation)", () => {
      const tagGuard = createFridayMemoryPiiGuard("tag");
      expect(tagGuard.scanAndTransform(SK).transformedContent).toBe(SK);
      expect((tagGuard.redactDeep({ a: SK }).value as { a: string }).a).toBe(SK);
      expect(tagGuard.scanAndTransform(SK).tagsToAdd).toHaveLength(0); // secrets carry no tag
    });

    it("idempotent — re-running over an already-redacted value is a no-op", () => {
      const once = guard.redactDeep({ a: SK, b: BEARER }).value;
      expect(guard.redactDeep(once).value).toEqual(once);
    });
  });
});

// ─── SEC-EVENT-REDACTION-001 round-15: KEY-NAME NUKE PARITY with the 0600 audit sink. A value under a
//     sensitive-secret KEY NAME (password / apiKey / token / secret / clientSecret / authorization / …)
//     is whole-value-nuked to the marker regardless of shape — EXACTLY as the audit writer's
//     `buildContentSkeleton` does (via the SAME shared predicate `isSensitiveSecretFieldName`). Before
//     round-15, `redactDeep` computed `sensitiveTypeForKey` (numeric-PII typing) but NEVER called
//     `isSensitiveSecretFieldName`, so a SHAPELESS credential under a sensitive key escaped memory
//     egress VERBATIM while the audit sink redacted the same input (the round-14 verification gap).
//     RED on 14e4c4f4 (shapeless value verbatim), GREEN once the object branch wires the key-name nuke. ───
describe("FridayMemoryPiiGuard — KEY-NAME NUKE PARITY with the audit sink (round-15)", () => {
  const guard = createFridayMemoryPiiGuard("redact");

  // Opaque, SHAPELESS credentials — no distinctive substring, catchable ONLY by their key.
  const PLAIN_PW = "hunter2plainword"; // pragma: allowlist secret
  const OPAQUE_TOKEN = "opaquevaluewithnoshape"; // pragma: allowlist secret
  const OPAQUE_SECRET = "justplainopaquesecret"; // pragma: allowlist secret
  const OPAQUE_CLIENT_SECRET = "opaqueclientsecretval"; // pragma: allowlist secret
  const OPAQUE_AUTHZ = "opaqueauthorizationvv"; // pragma: allowlist secret
  // Stripe underscore-format secret used AS A VALUE under a sensitive key (also a shape-fix canary).
  // Built at runtime so no literal `sk_live_…` appears in source (GitHub push protection).
  const SK_LIVE = ["sk_live", "0123456789abcdefghijABCDwxyz"].join("_"); // pragma: allowlist secret

  it("PROOF the values are SHAPELESS — the shape detector MISSES them (so ONLY the key-name nuke catches them)", () => {
    for (const v of [PLAIN_PW, OPAQUE_TOKEN, OPAQUE_SECRET, OPAQUE_CLIENT_SECRET, OPAQUE_AUTHZ]) {
      expect(findSecretShapeSpans(v), `${v} must be shapeless`).toEqual([]);
    }
    // The key names ARE classified sensitive by the shared predicate (SAME set as the audit writer).
    for (const k of ["password", "apiKey", "api_key", "token", "secret", "clientSecret", "authorization"]) {
      expect(isSensitiveSecretFieldName(k), k).toBe(true);
    }
  });

  it("nukes a SHAPELESS credential VALUE under a sensitive KEY NAME to the marker (top / nested / array)", () => {
    const { value } = guard.redactDeep({
      password: PLAIN_PW,
      apiKey: SK_LIVE,
      token: OPAQUE_TOKEN,
      nested: { secret: OPAQUE_SECRET, clientSecret: OPAQUE_CLIENT_SECRET, note: "keep me" },
      list: [{ authorization: OPAQUE_AUTHZ }, { plain: "visible" }],
      note: "public note",
    });
    const v = value as {
      password: string; apiKey: string; token: string;
      nested: { secret: string; clientSecret: string; note: string };
      list: [{ authorization: string }, { plain: string }];
      note: string;
    };
    expect(v.password).toBe(M);
    expect(v.apiKey).toBe(M);
    expect(v.token).toBe(M);
    expect(v.nested.secret).toBe(M);
    expect(v.nested.clientSecret).toBe(M);
    expect(v.list[0].authorization).toBe(M);
    // Benign siblings under NON-sensitive keys are byte-identical (NO-DEGRADE).
    expect(v.nested.note).toBe("keep me");
    expect(v.list[1].plain).toBe("visible");
    expect(v.note).toBe("public note");
    // No credential byte survives anywhere in the tree.
    const json = JSON.stringify(v);
    for (const cred of [PLAIN_PW, OPAQUE_TOKEN, OPAQUE_SECRET, OPAQUE_CLIENT_SECRET, OPAQUE_AUTHZ, SK_LIVE]) {
      expect(json, cred).not.toContain(cred);
    }
  });

  it("nukes the WHOLE value regardless of TYPE (object / array / number under a sensitive key)", () => {
    const { value } = guard.redactDeep({
      credentials: { user: "u", pass: PLAIN_PW }, // whole OBJECT nuked
      secret: [1, 2, 3], // whole ARRAY nuked
      token: 1234567890, // NUMBER nuked (sensitiveTypeForKey never typed `token`, so round-14 leaked it)
    });
    const v = value as Record<string, unknown>;
    expect(v.credentials).toBe(M);
    expect(v.secret).toBe(M);
    expect(v.token).toBe(M);
  });

  describe("SENSITIVITY — the key-name nuke is load-bearing", () => {
    it("a shapeless credential under a sensitive key is redacted ONLY by the key-name nuke (shape+PII miss it)", () => {
      // Remove the key-name nuke (simulated by the pre-round-15 leg = shape+PII value scrubber only):
      // the scanAndTransform value transform (which has NO key context) returns the value VERBATIM,
      // proving the redaction comes from the KEY-NAME nuke in redactDeep, not the value scrubber.
      expect(guard.scanAndTransform(PLAIN_PW).transformedContent).toBe(PLAIN_PW); // no shape/PII → verbatim
      expect((guard.redactDeep({ password: PLAIN_PW }).value as { password: string }).password).toBe(M);
    });
  });

  describe("NO-DEGRADE — strict superset", () => {
    it("a benign value under a NON-sensitive key is byte-identical (incl. publishable pk_ key value)", () => {
      const input = {
        note: PLAIN_PW.length > 0 ? "just a note" : "",
        tokenCount: 42, // near-miss key → not sensitive
        publishableKey: ["pk_live", "0123456789abcdefghijABCDwxyz"].join("_"), // pk_ PUBLISHABLE → preserved // pragma: allowlist secret
        color: "青",
      };
      expect(guard.redactDeep(structuredClone(input)).value).toEqual(input);
    });

    it("tag/block mode NEVER mutates a sensitive-key value (the nuke is a redact-mode mutation, no tag)", () => {
      const tagGuard = createFridayMemoryPiiGuard("tag");
      const input = { password: PLAIN_PW, token: OPAQUE_TOKEN };
      const { value, tagsToAdd } = tagGuard.redactDeep(structuredClone(input));
      expect(value).toEqual(input); // byte-identical
      expect(tagsToAdd).toEqual([]); // secrets carry no guard tag
    });

    it("idempotent — re-running over the nuked result is a no-op", () => {
      const once = guard.redactDeep({ password: PLAIN_PW, apiKey: SK_LIVE }).value;
      expect(guard.redactDeep(once).value).toEqual(once);
    });
  });
});

// ─── SEC-EVENT-REDACTION-001 round-16: the round-16 ADDED provider shapes flow through the SAME value
//     leg (`redactSecretAndPiiValueString` = SEC-uni ∪ SEC-raw ∪ PII), so a NEW shape under a
//     NON-sensitive key is redacted on `redactDeep` in BOTH raw and Unicode-obfuscated form; the
//     publishable `pk-` HYPHEN key (Finding 2) is preserved. RED before the shapes are added / before
//     `pk` is dropped from the alternation. ───
describe("FridayMemoryPiiGuard — round-16 ADDED provider shapes in the VALUE leg (redactDeep)", () => {
  const guard = createFridayMemoryPiiGuard("redact");
  const M16 = "[REDACTED_SECRET]";
  const seg = (...p: string[]): string => p.join(""); // pragma: allowlist secret
  const SGPOOL = "ABCdefGHIjkl0123456789abcdefghijkLMNopqrstuvwxyz0123456789"; // pragma: allowlist secret
  const ADDED: Record<string, string> = {
    ya29: seg("ya29.", "a0AfB_by-DtestTokenValue0123456789ABCDEFxyz"), // pragma: allowlist secret
    xapp: seg("xapp-", "1-A0123ABCD-4567890123-abcdef0123456789abcdef"), // pragma: allowlist secret
    glpat: seg("glpat-", "ABCdef0123456789ghijkLMNop"), // pragma: allowlist secret
    sendgrid: seg("SG.", SGPOOL.slice(0, 22), ".", SGPOOL.slice(0, 43)), // pragma: allowlist secret
    gocspx: seg("GOCSPX-", "abcdefghijklmnop_qrstuvwx"), // pragma: allowlist secret
    square: seg("sq0atp-", "0123456789abcdefghijklABCDwxyz"), // pragma: allowlist secret
    digitalocean: seg("dop_v1_", "0123456789abcdef".repeat(4)), // pragma: allowlist secret
    groq: seg("gsk_", "abcdefghijklmnopqrstuvwxyz0123456789ABCDwx"), // pragma: allowlist secret
    xai: seg("xai-", "abcdefghijklmnop0123456789"), // pragma: allowlist secret
  };

  it("redacts each ADDED shape as a bare VALUE under a NON-sensitive key (structured redactDeep)", () => {
    const input: Record<string, string> = { note: "keep" };
    for (const [k, v] of Object.entries(ADDED)) input[`nonsensitive_${k}`] = v;
    const out = guard.redactDeep(structuredClone(input)).value as Record<string, string>;
    expect(out.note).toBe("keep");
    const json = JSON.stringify(out);
    for (const [k, v] of Object.entries(ADDED)) {
      expect(out[`nonsensitive_${k}`], k).toBe(M16);
      expect(json, k).not.toContain(v);
    }
  });

  it("redacts a Unicode-obfuscated ADDED shape (zero-width / full-width) via the SEC-uni value leg", () => {
    // A zero-width splice after `glpat-` and a full-width `xai-` de-obfuscate to a real shape; the raw
    // scan misses them, so this proves the value leg's SEC-uni pass covers the ADDED shapes too.
    const zwGlpat = seg("glpat-", "​", "ABCdef0123456789ghijkLMNop"); // pragma: allowlist secret
    const fwXai = seg("ｘａｉ－", "abcdefghijklmnop0123456789"); // full-width xai- // pragma: allowlist secret
    const out = guard.redactDeep({ a: zwGlpat, b: fwXai }).value as { a: string; b: string };
    expect(out.a).toBe(M16);
    expect(out.b).toBe(M16);
  });

  it("NO-DEGRADE: a publishable pk- HYPHEN value under a non-sensitive key is byte-identical (Finding 2)", () => {
    const input = {
      publicKey: seg("pk-", "abcdefghijklmnopqrstuv0123456789"), // pragma: allowlist secret — publishable, preserved
      note: "ok",
    };
    expect(guard.redactDeep(structuredClone(input)).value).toEqual(input);
  });
});

