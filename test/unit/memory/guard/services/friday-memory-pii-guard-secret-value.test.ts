import { describe, it, expect } from "vitest";
import { createFridayMemoryPiiGuard } from "../../../../../src/memory/guard/services/friday-memory-pii-guard.js";

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
