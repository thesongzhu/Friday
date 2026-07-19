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

// ─── SEC-EVENT-REDACTION-001 round-16 — FINDING 1: the TAG-drop decision is now Unicode-secret-aware.
//     Before round-16 `dropSensitiveTags` ran the secret detector over the RAW tag ONLY, so a secret
//     hidden behind a zero-width splice (`s<U+200B>k-…`), a full-width form (`ｓｋ－…`), or a combining
//     mark (`sk-á…`) SURVIVED `filterItem.tags` / `filterSearchResult` VERBATIM (a real egress leak).
//     Round-16 composes the SAME raw ∪ Unicode-de-obfuscated secret detection the value leg uses, so
//     such a TAG is DROPPED; a benign tag stays byte-identical (tags are filtered, never rewritten).
//     RED on 473053f1 (raw-only tag drop), GREEN after `isSecretShapedTag`. ───
describe("FridayMemoryOutputFilter — FINDING 1: Unicode-obfuscated secret TAG drop (round-16)", () => {
  const filter = createFridayMemoryOutputFilter();
  const seg = (...p: string[]): string => p.join(""); // pragma: allowlist secret
  // Unicode-obfuscated secret tags (de-obfuscate to `sk-…`); raw detection MISSES these.
  const OBFUSCATED_SECRET_TAGS = [ZW_SK, FW_SK, CM_SK];
  // round-16 ADDED shapes as tags (built from parts; raw shapes).
  const ADDED_SECRET_TAGS = [
    seg("ya29.", "a0AfB_by-DtestTokenValue0123456789ABCDEFxyz"), // pragma: allowlist secret
    seg("xapp-", "1-A0123ABCD-4567890123-abcdef0123456789abcdef"), // pragma: allowlist secret
    seg("glpat-", "ABCdef0123456789ghijkLMNop"), // pragma: allowlist secret
    seg("gsk_", "abcdefghijklmnopqrstuvwxyz0123456789ABCDwx"), // pragma: allowlist secret
  ];
  const BENIGN_TAGS = ["ok", "fine", "café", "用户名", "run-42", seg("pk-", "abcdefghijklmnopqrstuv0123456789")]; // pragma: allowlist secret — last is a publishable pk-, must survive

  it("DROPS Unicode-obfuscated secret tags (zero-width / full-width / combining) from filterItem.tags", () => {
    const out = filter.filterItem(
      makeItem({ tags: ["ok", ...OBFUSCATED_SECRET_TAGS, "fine"] }),
    );
    for (const t of OBFUSCATED_SECRET_TAGS) expect(out.tags, t).not.toContain(t);
    // The benign tags survive byte-identical (filtered, never rewritten).
    expect(out.tags).toEqual(["ok", "fine"]);
  });

  it("DROPS Unicode-obfuscated secret tags from filterSearchResult (nested item)", () => {
    const result = makeResult(makeItem({ tags: ["keep", ...OBFUSCATED_SECRET_TAGS] }), "snippet");
    const out = filter.filterSearchResult(result);
    for (const t of OBFUSCATED_SECRET_TAGS) expect(out.item.tags, t).not.toContain(t);
    expect(out.item.tags).toEqual(["keep"]);
  });

  it("DROPS round-16 ADDED provider shapes carried as tags", () => {
    const out = filter.filterItem(makeItem({ tags: ["alpha", ...ADDED_SECRET_TAGS, "omega"] }));
    for (const t of ADDED_SECRET_TAGS) expect(out.tags, t).not.toContain(t);
    expect(out.tags).toEqual(["alpha", "omega"]);
    expect(JSON.stringify(out.tags)).not.toContain("glpat-");
  });

  it("NO-DEGRADE: benign tags (incl. multilingual + publishable pk-) are preserved byte-identical", () => {
    const out = filter.filterItem(makeItem({ tags: [...BENIGN_TAGS] }));
    expect(out.tags).toEqual(BENIGN_TAGS);
  });

  it("SENSITIVITY: each obfuscated tag would leak under the pre-round-16 raw-only check", () => {
    // The raw-only predicate the prior code used (findSecretShapeSpans over the RAW tag) MISSES every
    // obfuscated tag — so without the Unicode leg they would NOT be dropped (RED). The filter DOES drop
    // them (GREEN), proving the Unicode leg is load-bearing.
    for (const t of OBFUSCATED_SECRET_TAGS) {
      const kept = filter.filterItem(makeItem({ tags: [t] })).tags;
      expect(kept, t).toEqual([]); // dropped by the round-16 Unicode-aware predicate
    }
  });
});

// ─── SEC-EVENT-REDACTION-001 round-17: the HuggingFace `hf_` shape on the memory OUTPUT FILTER. The
//     provider-catalog classifies `hf_` as HuggingFace HIGH-confidence, yet the canonical detector missed
//     it, so it leaked through `filterItem.content` (scanAndTransform string leg) and survived as a
//     `filterItem.tags` value. RED on d2e0e222 (verbatim in content, kept as a tag); GREEN after the
//     `hf_` pattern is added. Built from parts so no contiguous literal token appears in SOURCE. ───
describe("FridayMemoryOutputFilter — round-17 HuggingFace hf_ shape (content + tag drop)", () => {
  const filter = createFridayMemoryOutputFilter();
  const HF_BODY = "AbCdEfGhIjKlMnOpQrStUvWxYz01234567"; // pragma: allowlist secret — 34 base62 chars
  const HF = ["hf", HF_BODY].join("_"); // pragma: allowlist secret

  it("redacts an hf_ token in item.content (scanAndTransform leg), surrounding text preserved", () => {
    const out = filter.filterItem(makeItem({ content: `auth used ${HF} today` }));
    expect(out.content).toContain(M);
    expect(out.content).not.toContain(HF);
    expect(out.content).toContain("auth used");
  });

  it("redacts an hf_ token carried in item.metadata VALUES (redactDeep leg) under a non-sensitive key", () => {
    const out = filter.filterItem(makeItem({ metadata: { tokenPreview: HF, note: "keep" } }));
    const md = out.metadata as { tokenPreview: string; note: string };
    expect(md.tokenPreview).toBe(M);
    expect(md.note).toBe("keep");
    expect(JSON.stringify(md)).not.toContain(HF);
  });

  it("DROPS an hf_-shaped tag, preserving benign tags byte-identical", () => {
    const out = filter.filterItem(makeItem({ tags: ["ok", HF, "fine"] }));
    expect(out.tags).not.toContain(HF);
    expect(JSON.stringify(out.tags)).not.toContain(HF_BODY);
    expect(out.tags).toEqual(["ok", "fine"]);
  });

  it("NO-DEGRADE: benign hf_ near-misses survive (short / underscore body are not tokens)", () => {
    const out = filter.filterItem(makeItem({ tags: ["hf_docs", "hf_config_value_thing"], content: "hf_docs reference" }));
    expect(out.tags).toEqual(["hf_docs", "hf_config_value_thing"]);
    expect(out.content).toBe("hf_docs reference");
  });
});

// ─── SEC-SECRET-GLUED-PREFIX-001: a distinctive-prefix credential GLUED directly to a preceding ASCII
//     word char (`keyhf_<34>`) had no word boundary before the prefix, so the canonical detector's
//     leading `\b` skipped it and it survived memory read-back to agents through EVERY output-filter leg
//     (content scanAndTransform / metadata redactDeep / tag drop). RED on bf6968f9 (glued token verbatim
//     in content + metadata, kept as a tag); GREEN after the leading `\b` is dropped on the high-entropy
//     distinctive-prefix patterns. Built from parts so no contiguous literal token appears in SOURCE. ───
describe("FridayMemoryOutputFilter — SEC-SECRET-GLUED-PREFIX-001 glued distinctive-prefix credential", () => {
  const filter = createFridayMemoryOutputFilter();
  const seg = (...p: string[]): string => p.join(""); // pragma: allowlist secret
  const HF_BODY = "AbCdEfGhIjKlMnOpQrStUvWxYz01234567"; // pragma: allowlist secret — 34 base62
  const HF = seg("hf_", HF_BODY); // pragma: allowlist secret
  const GLUED = seg("key", HF); // pragma: allowlist secret — hf_ glued after the word `key`

  it("redacts a GLUED hf_ token in item.content (scanAndTransform leg), leaving the benign leading `key`", () => {
    const out = filter.filterItem(makeItem({ content: seg("auth used ", GLUED, " today") }));
    expect(out.content).toContain(M);
    expect(out.content).not.toContain(HF);
    expect(out.content).not.toContain(HF_BODY);
    // Only the credential subspan is masked — the glued `key` and surrounding text survive.
    expect(out.content).toBe(`auth used key${M} today`);
  });

  it("redacts a GLUED hf_ token carried in item.metadata VALUES (redactDeep leg) under a non-sensitive key", () => {
    const out = filter.filterItem(makeItem({ metadata: { tokenPreview: GLUED, note: "keep" } }));
    const md = out.metadata as { tokenPreview: string; note: string };
    expect(md.tokenPreview).toBe(`key${M}`);
    expect(md.note).toBe("keep");
    expect(JSON.stringify(md)).not.toContain(HF_BODY);
  });

  it("DROPS a GLUED hf_-shaped tag, preserving benign tags byte-identical", () => {
    const out = filter.filterItem(makeItem({ tags: ["ok", GLUED, "fine"] }));
    expect(JSON.stringify(out.tags)).not.toContain(HF_BODY);
    expect(out.tags).toEqual(["ok", "fine"]);
  });

  it("NO-DEGRADE: a word-embedded near-miss with a SHORT body is not a token (survives)", () => {
    // `keyhf_` + a short body has no 34-char high-entropy run, so it is NOT a credential — untouched.
    const out = filter.filterItem(makeItem({ tags: [seg("key", "hf_docs")], content: seg("ref key", "hf_docs") }));
    expect(out.tags).toEqual([seg("key", "hf_docs")]);
    expect(out.content).toBe(seg("ref key", "hf_docs"));
  });

  // SEC-SECRET-GLUED-PREFIX-001 P1: GitHub classic `ghp_`/`ghr_` and AWS `AKIA` were SPLIT out of their
  // alternations and de-`\b`'d (they are provably NOT benign word/ULID/acronym fragments), so a real
  // credential GLUED after a word char is now caught in every output-filter leg. RED on 7021926c (glued
  // token survives content + metadata + kept as a tag); GREEN after.
  it("redacts GLUED ghp_/ghr_/AKIA credentials in content / metadata / tags (P1 split), benign lead preserved", () => {
    const GHP = seg("ghp_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"); // pragma: allowlist secret — 36 base62
    const AKIA = seg("AKIA", "IOSFODNN7EXAMPLE"); // pragma: allowlist secret — AKIA + 16 [0-9A-Z]
    for (const [glueWord, body] of [["key", GHP], ["aws", AKIA]] as const) {
      const glued = seg(glueWord, body);
      // content leg — only the credential subspan is masked, the glued benign word survives.
      const c = filter.filterItem(makeItem({ content: seg("token ", glued, " now") }));
      expect(c.content).toBe(`token ${glueWord}${M} now`);
      expect(c.content).not.toContain(body);
      // metadata value leg under a non-sensitive key.
      const m = filter.filterItem(makeItem({ metadata: { ref: glued, note: "keep" } }));
      expect((m.metadata as { ref: string; note: string }).ref).toBe(`${glueWord}${M}`);
      expect((m.metadata as { note: string }).note).toBe("keep");
      // tag leg — the glued-credential tag is dropped, benign tags preserved.
      const t = filter.filterItem(makeItem({ tags: ["ok", glued, "fine"] }));
      expect(JSON.stringify(t.tags)).not.toContain(body);
      expect(t.tags).toEqual(["ok", "fine"]);
    }
  });

  // NO-DEGRADE (round-2): benign snake_case words ending in `ghs`/etc before `_` MUST survive through
  // EVERY output-filter leg — the github-classic base62 body breaks at the `_`. The first-round
  // `[A-Za-z0-9_]` body corrupted these (`walkthroughs_completed_counter` → `walkthrou[REDACTED_SECRET]`).
  it("NO-DEGRADE: benign `…ghs_<snake_case>` identifiers survive content / metadata / tags byte-identical", () => {
    const benign = ["walkthroughs_completed_counter", "walkthroughs_completedThisWeek", "coughs_e3b0c44298fc1c14", "breakthroughs_this_quarter_list", "laughs_per_minute_counter",
      // AWS AKIA word-fragment: benign ULID / all-caps id with ASIA/AGPA glued after a word char.
      "012345AGPABCDEFGHJKMNPQRST", "AUSTRALASIAWIDEDEPLOYMENT01", // pragma: allowlist secret — benign ULID/all-caps (AKIA-family scanner false positives)
      // AKIA is the SUFFIX of SLOV-AKIA / CZECHOSLOV-AKIA — the `(?<![A-Z0-9])` lookbehind keeps these all-caps
      // country region constants UNCHANGED (a plain `\b`-drop corrupts `SLOVAKIA<16>` → `SLOV[REDACTED_SECRET]`).
      "SLOVAKIAREGIONCODE2024AB", "CZECHOSLOVAKIAREGIONCODE012345"]; // pragma: allowlist secret — AKIA after uppercase `V`
    const out = filter.filterItem(makeItem({
      content: "metric name walkthroughs_started_and_completed today",
      metadata: { walk: benign[0], breakt: benign[1], note: "keep" },
      tags: [...benign],
    }));
    expect(out.content).toBe("metric name walkthroughs_started_and_completed today");
    const md = out.metadata as { walk: string; breakt: string; note: string };
    expect(md.walk).toBe(benign[0]);
    expect(md.breakt).toBe(benign[1]);
    expect(md.note).toBe("keep");
    expect(out.tags).toEqual(benign); // no tag dropped, none rewritten
  });
});
