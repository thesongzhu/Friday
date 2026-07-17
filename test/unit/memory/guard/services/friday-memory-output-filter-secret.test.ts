import { describe, it, expect } from "vitest";
import { createFridayMemoryOutputFilter } from "#memory";
import type { FridayMemoryItem, FridayMemorySearchResult } from "../../../../../src/memory/model/friday-memory.types.js";

// ─── SEC-EVENT-REDACTION-001 round-14: SECRET-shape string VALUES in the memory OUTPUT FILTER.
//     Before round-14 the shared guard's string-VALUE leg (redactStringLeaf / scanAndTransform) ran
//     ONLY the PII detectors, never the shared secret-shape redactor — so every output-filter path
//     (redactLearnedFactValue / filterItem content|snippet|metadata|tags / filterSearchResult)
//     returned a secret string value VERBATIM. These tests drive the REAL filter and assert the
//     secret is [REDACTED_SECRET]. RED on 815f98ad (value leg is PII-only), GREEN after the leg
//     composes the canonical secret detector with PII (raw ∪ Unicode). ───

const M = "[REDACTED_SECRET]";

// Fake credentials used as string VALUES (never real). Each shape the shared secret redactor covers.
const SK = "sk-abcdefghijklmnopqrstuv0123456789"; // pragma: allowlist secret
const SK_PROJ = "sk-proj-advisorCanary0123456789ABCDEFG"; // pragma: allowlist secret
const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"; // pragma: allowlist secret
const PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIBOwIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----"; // pragma: allowlist secret
const GH_PAT = "github_pat_11ABCDEF0aBcDeFgHiJkL_0123456789abcdefghij"; // pragma: allowlist secret
// The Advisor's exact canary: a nested Authorization header value.
const BEARER = `Authorization: Bearer ${SK_PROJ}`; // pragma: allowlist secret
const GENERIC = "api_key=genericcredential123abcXYZ"; // pragma: allowlist secret

// Unicode-obfuscated secret VALUES (de-obfuscate → same shape).
const ZW_SK = "sk-​abcdefghijklmnop0123456789"; // U+200B after sk- // pragma: allowlist secret
const FW_SK = "ｓｋ－abcdefghijklmnop0123456789abcd"; // full-width sk- // pragma: allowlist secret
const CM_SK = "sk-ábcdefghijklmnop0123456789"; // combining acute on 1st value char // pragma: allowlist secret

const ALL_SECRETS = [SK, SK_PROJ, JWT, PEM, GH_PAT, SK_PROJ, GENERIC, ZW_SK, FW_SK, CM_SK]; // canary bodies
const SECRET_CREDENTIALS = [
  "sk-abcdefghijklmnopqrstuv0123456789", // pragma: allowlist secret
  "sk-proj-advisorCanary0123456789ABCDEFG", // pragma: allowlist secret
  "genericcredential123abcXYZ", // pragma: allowlist secret
  "github_pat_11ABCDEF0aBcDeFgHiJkL", // pragma: allowlist secret
];

function makeItem(overrides: Partial<FridayMemoryItem> = {}): FridayMemoryItem {
  return {
    id: "m-1",
    namespace: "default",
    key: "k-1",
    content: "content",
    source: "test",
    tags: [],
    metadata: {},
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    ...overrides,
  };
}

function makeResult(item: FridayMemoryItem, snippet: string): FridayMemorySearchResult {
  return { item, score: 1, ftsScore: 1, semanticScore: 0, matchedBy: ["fts"], snippet };
}

describe("FridayMemoryOutputFilter — SECRET-shape value egress (round-14)", () => {
  const filter = createFridayMemoryOutputFilter();

  describe("redactLearnedFactValue", () => {
    it("redacts every raw secret family in a plain string value", () => {
      for (const secret of [SK, SK_PROJ, JWT, PEM, GH_PAT]) {
        const out = filter.redactLearnedFactValue(secret) as string;
        expect(out).toContain(M);
        expect(out).not.toContain(secret);
      }
    });

    it("redacts the Advisor canary (nested Authorization: Bearer sk-proj-…) and PRESERVES the scheme prefix", () => {
      const value = { auth: { header: BEARER }, note: "ok" };
      const out = filter.redactLearnedFactValue(value) as { auth: { header: string }; note: string };
      // Prefix bytes preserved, credential gone.
      expect(out.auth.header).toBe(`Authorization: Bearer ${M}`);
      expect(out.note).toBe("ok");
      expect(JSON.stringify(out)).not.toContain(SK_PROJ);
      expect(JSON.stringify(out)).toContain("Authorization: Bearer"); // forensic prefix kept
    });

    it("redacts a generic api_key= assignment, keeping the label and dropping the credential", () => {
      const out = filter.redactLearnedFactValue(`startup: ${GENERIC} rejected`) as string;
      expect(out).toBe(`startup: api_key=${M} rejected`);
      expect(out).not.toContain("genericcredential123abcXYZ"); // pragma: allowlist secret
    });

    it("redacts Unicode-obfuscated secret values (zero-width / full-width / combining)", () => {
      for (const secret of [ZW_SK, FW_SK, CM_SK]) {
        const out = filter.redactLearnedFactValue(secret) as string;
        expect(out).toBe(M);
      }
    });

    it("redacts secrets NESTED deep in objects and arrays, structure preserved", () => {
      const value = { list: [{ k: SK }, { k: JWT }], deep: { l2: { pem: PEM } } };
      const out = filter.redactLearnedFactValue(value) as {
        list: Array<{ k: string }>;
        deep: { l2: { pem: string } };
      };
      expect(out.list[0]!.k).toBe(M);
      expect(out.list[1]!.k).toBe(M);
      expect(out.deep.l2.pem).toBe(M);
      const json = JSON.stringify(out);
      for (const cred of SECRET_CREDENTIALS) expect(json).not.toContain(cred);
    });
  });

  describe("filterItem — content / snippet-less item / metadata / tags", () => {
    it("redacts a secret in item.content (scanAndTransform path)", () => {
      const out = filter.filterItem(makeItem({ content: `deploy used ${GH_PAT} to auth` }));
      expect(out.content).toContain(M);
      expect(out.content).not.toContain(GH_PAT);
      expect(out.content).toContain("deploy used");
    });

    it("redacts a secret carried in item.metadata VALUES (redactDeep path)", () => {
      const out = filter.filterItem(makeItem({ metadata: { token: SK, note: "keep", header: BEARER } }));
      const md = out.metadata as { token: string; note: string; header: string };
      expect(md.token).toBe(M);
      expect(md.header).toBe(`Authorization: Bearer ${M}`);
      expect(md.note).toBe("keep");
      const json = JSON.stringify(md);
      expect(json).not.toContain("sk-abcdefghijklmnopqrstuv0123456789"); // pragma: allowlist secret
      expect(json).not.toContain(SK_PROJ);
    });

    it("drops a tag whose content is a secret shape (mirrors PII-tag drop)", () => {
      const out = filter.filterItem(makeItem({ tags: ["ok", GENERIC, "fine"] }));
      // A "[REDACTED_SECRET]"-marker is not a valid tag; the secret-bearing tag is dropped.
      expect(out.tags).not.toContain(GENERIC);
      expect(JSON.stringify(out.tags)).not.toContain("genericcredential123abcXYZ"); // pragma: allowlist secret
      expect(out.tags).toContain("ok");
      expect(out.tags).toContain("fine");
    });
  });

  describe("filterSearchResult — snippet + nested item", () => {
    it("redacts a secret in the result snippet AND the nested item.content", () => {
      const result = makeResult(makeItem({ content: `key ${SK}` }), `bearer ${SK_PROJ} leaked`);
      const out = filter.filterSearchResult(result);
      expect(out.snippet).toContain(M);
      expect(out.snippet).not.toContain(SK_PROJ);
      expect(out.item.content).toContain(M);
      expect(out.item.content).not.toContain("sk-abcdefghijklmnopqrstuv0123456789"); // pragma: allowlist secret
    });
  });

  describe("NO-DEGRADE + sensitivity", () => {
    it("leaves benign multilingual / PII-free / structured values byte-identical", () => {
      expect(filter.redactLearnedFactValue("blue")).toBe("blue");
      const obj = { color: "青", note: "café ok", count: 3, ok: true, nothing: null };
      expect(filter.redactLearnedFactValue(structuredClone(obj))).toEqual(obj);
      // Idempotent: a second pass over an already-redacted secret value is a no-op.
      const once = filter.redactLearnedFactValue({ k: SK });
      expect(filter.redactLearnedFactValue(once)).toEqual(once);
    });

    it("still redacts PII values exactly as before (secret composition did not disturb PII)", () => {
      const out = filter.redactLearnedFactValue({ email: "alice@example.com", card: "4111 1111 1111 1111" }) as {
        email: string;
        card: string;
      };
      expect(out.email).toBe("[EMAIL]");
      expect(out.card).toBe("[CREDIT_CARD]");
    });

    it("SENSITIVITY: the secret marker is actually present for every family (no silent pass-through)", () => {
      for (const secret of ALL_SECRETS) {
        const out = JSON.stringify(filter.redactLearnedFactValue(secret));
        expect(out).toContain(M);
      }
    });
  });
});
