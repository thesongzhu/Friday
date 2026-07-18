import { describe, it, expect, vi } from "vitest";
import { createFridayAgentMemoryTools } from "#agent";
import type { FridayMemoryService } from "#memory";
import type { FridayMemoryItem, FridayMemorySearchResult } from "#memory";
import { attachFridayAgentToolExecutionContext } from "../../../../src/agent/runtime/friday-agent-tool-execution-context.js";

// ─── SEC-AGENT-MEMORY-SEARCH-RAW-EGRESS-001 ────────────────────────────────────────────────
// The memory_search tool egresses across a TRUST BOUNDARY to the agent/model. The sibling
// `forContext` (guarded) and learned-fact legs route their results through the canonical
// output filter, but the DIRECT `memoryService.search` / `.list` legs returned RAW persisted
// rows. A LEGACY row written before the write-time guard existed therefore leaked its raw
// content/tags to the agent. This lane routes the deduped direct+guarded results through the
// SAME production output filter at the SERIALIZATION boundary only (after all scoring/dedup, so
// ranking/order/limit are byte-for-byte unchanged). These tests invoke the REAL tool `execute`
// and assert on the SERIALIZED result — RED on the pre-fix tree (raw sensitive value in the
// output), GREEN after the route fix.
//
// PII SCOPE: the canonical filter redacts the PII classes it recognizes — email / US phone /
// US SSN / Luhn credit card — and drops PII-valued tags, bringing the direct legs to PARITY
// with the already-filtered sibling legs.
//
// CREDENTIAL SCOPE (gained via the #1619 rebase — NO extra product code in this lane): after
// this branch was rebased onto main carrying SEC-EVENT-REDACTION-001 (#1619), the canonical
// memory output filter ALSO redacts credential SHAPES (hf_ / sk- / Bearer / gsk_ / glpat- /
// AWS …) to `[REDACTED_SECRET]` in content/snippet + metadata, and DROPS a secret-shaped tag
// (raw AND Unicode-obfuscated), on EVERY leg. So the SAME serialization-boundary route fix now
// also redacts a legacy row that stored a credential VALUE — for free. The credential tests
// below prove it: RED = the credential leaks verbatim through the raw direct leg when the route
// fix is stashed; GREEN = `[REDACTED_SECRET]` (content) / dropped (tag) with the fix, across
// BOTH the search and list legs, RAW and one zero-width-obfuscated form.
// ───────────────────────────────────────────────────────────────────────────────────────────

const NOW = "2026-02-19T00:00:00.000Z";

// Sensitive values assembled from PARTS so the source file never contains a contiguous
// secret/PII literal token.
const EMAIL = "leak" + "@" + "evil" + ".com";
const PHONE = "415" + "-" + "555" + "-" + "2671";
const SSN = "123" + "-" + "45" + "-" + "6789";
const CARD = "4111" + " " + "1111" + " " + "1111" + " " + "1111";

// Credential VALUES assembled from PARTS (no contiguous secret literal). Each is a REAL
// recognized shape in the canonical secret-shape detector (#1619): HuggingFace `hf_` + 34+
// base62, OpenAI-style `sk-` + 16+, and a bare `Bearer <token>` (scheme preserved, token
// redacted). Redacted → `[REDACTED_SECRET]` in content; a secret-shaped TAG is dropped.
const HF_PREFIX = "hf" + "_";
const HF_KEY = HF_PREFIX + "abcdefGHIJKL" + "1234567890" + "mnopqrSTUVWX" + "9999YZ"; // body 40 ≥ 34
const SK_KEY = "sk" + "-" + "T3BlbmProjExample" + "KeyABCDEFGH" + "1234567890"; // body 38 ≥ 16
const BEARER_BODY = "eyJhbGciOiJI" + "UzI1NiJ9" + "TOKEN12345"; // ≥ 8 from [A-Za-z0-9._~+/=-]
const BEARER = "Bearer" + " " + BEARER_BODY;

// Zero-width (U+200B) splice INSIDE the hf_ body: the raw stored bytes are obfuscated, but the
// filter's Unicode detection copy folds the ZWSP away and still recognizes the credential.
const ZWSP = "​";
const HF_KEY_ZW = HF_PREFIX + "abcdefGHIJKL" + ZWSP + "1234567890mnopqrSTUVWX9999YZ";
// A distinctive body run that appears CONTIGUOUS in the LEAKED raw output (the ZWSP is spliced
// AFTER it) but must be gone once the credential is redacted — a RED/GREEN discriminator that
// does not depend on the ZWSP position surviving JSON serialization.
const HF_ZW_LEAK_PROBE = HF_PREFIX + "abcdefGHIJKL";

// Benign NEAR-MISS credential-shaped tokens that must NEVER be redacted (preserved verbatim):
// `hf_docs` (body far too short), `sk-tiny` (body < 16), and a publishable `pk-…` key
// (deliberately NOT a secret in the canonical detector — redacting it would be data loss).
const HF_NEAR_MISS = HF_PREFIX + "docs";
const SK_NEAR_MISS = "sk" + "-" + "tiny";
const PK_PUBLISHABLE = "pk" + "-" + "live" + "ABCDEFGH1234567890XYZ";

interface MappedResult {
  content: string;
  score: number;
  metadata: { id: string; namespace: string; tags: string[]; source: string; createdAt: string };
}

function signalWithPrincipal(principalId: string, sessionKey = "agent:run:run-1"): AbortSignal {
  return attachFridayAgentToolExecutionContext(new AbortController().signal, {
    runId: "run-1",
    sessionKey,
    readOnly: false,
    principalId,
  });
}

function makeItem(overrides: Partial<FridayMemoryItem>): FridayMemoryItem {
  return {
    id: "item-1",
    namespace: "agent",
    key: "key-1",
    content: "benign",
    source: "agent",
    tags: [],
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeResult(item: FridayMemoryItem, score: number): FridayMemorySearchResult {
  return {
    item,
    score,
    ftsScore: score,
    semanticScore: score,
    matchedBy: ["fts"],
    snippet: item.content.slice(0, 200),
  };
}

function mockMemoryService(input: {
  search?: FridayMemorySearchResult[];
  list?: FridayMemoryItem[];
}): FridayMemoryService {
  return {
    search: vi.fn().mockResolvedValue(input.search ?? []),
    store: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue(input.list ?? []),
    delete: vi.fn().mockResolvedValue(false),
    prune: vi.fn().mockResolvedValue({ deletedCount: 0, deletedIds: [], dryRun: false }),
  } as unknown as FridayMemoryService;
}

function parse(content: string): MappedResult[] {
  return JSON.parse(content) as MappedResult[];
}

describe("memory_search — direct search/list leg raw egress redaction", () => {
  it("redacts recognized PII in content and drops PII tags on the DIRECT search leg", async () => {
    const legacy = makeItem({
      id: "legacy-1",
      content: `contact ${EMAIL} phone ${PHONE} ssn ${SSN} card ${CARD}`,
      tags: ["weather", SSN, EMAIL],
    });
    const [searchTool] = createFridayAgentMemoryTools({
      memoryService: mockMemoryService({ search: [makeResult(legacy, 0.9)] }),
    });

    const result = await searchTool!.execute({ query: "contact" }, signalWithPrincipal("user-1"));
    expect(result.isError).toBeUndefined();
    const parsed = parse(result.content);
    const stored = parsed.find((r) => r.metadata.id === "legacy-1")!;

    // Content: each recognized PII class replaced by its canonical marker.
    expect(stored.content).toContain("[EMAIL]");
    expect(stored.content).toContain("[PHONE_US]");
    expect(stored.content).toContain("[SSN_US]");
    expect(stored.content).toContain("[CREDIT_CARD]");
    // No raw PII anywhere in the serialized tool output.
    expect(result.content).not.toContain(EMAIL);
    expect(result.content).not.toContain(PHONE);
    expect(result.content).not.toContain(SSN);
    expect(result.content).not.toContain(CARD);
    // PII-valued tags dropped; the benign tag survives byte-identically.
    expect(stored.metadata.tags).toEqual(["weather"]);
  });

  it("redacts recognized PII from the session lexical-fallback LIST leg", async () => {
    const legacy = makeItem({
      id: "legacy-list-1",
      content: `profile email ${EMAIL} card ${CARD}`,
      tags: ["profile", EMAIL],
    });
    const [searchTool] = createFridayAgentMemoryTools({
      // search returns nothing → the row can only reach the agent via the LIST-backed
      // session lexical fallback (buildSessionLexicalCandidates → memoryService.list).
      memoryService: mockMemoryService({ search: [], list: [legacy] }),
      resolveSessionMemoryNamespace: async () => "sess-abc",
    });

    const result = await searchTool!.execute(
      { query: "profile" },
      signalWithPrincipal("user-1", "sess-123"),
    );
    expect(result.isError).toBeUndefined();
    const parsed = parse(result.content);
    const stored = parsed.find((r) => r.metadata.id === "legacy-list-1");
    // The list-leg row MUST reach the agent (proves this leg egresses) AND be redacted.
    expect(stored, "list-leg row should be present in tool output").toBeDefined();
    expect(stored!.content).toContain("[EMAIL]");
    expect(stored!.content).toContain("[CREDIT_CARD]");
    expect(result.content).not.toContain(EMAIL);
    expect(result.content).not.toContain(CARD);
    expect(stored!.metadata.tags).toEqual(["profile"]);
  });

  it("preserves benign content byte-for-byte, ranking order, and the result limit (no-degrade)", async () => {
    const top = makeItem({ id: "top", content: "alpha status green" });
    const mid = makeItem({ id: "mid", content: `contact ${EMAIL}` });
    const low = makeItem({ id: "low", content: "gamma status blue" });
    const [searchTool] = createFridayAgentMemoryTools({
      memoryService: mockMemoryService({
        // Distinct scores → deterministic order; distinct content → no dedup collision.
        search: [makeResult(top, 0.9), makeResult(mid, 0.5), makeResult(low, 0.1)],
      }),
    });

    const result = await searchTool!.execute(
      { query: "status", limit: 2 },
      new AbortController().signal,
    );
    const parsed = parse(result.content);

    // Limit respected: only the two highest-scored rows survive slice(0, limit).
    expect(parsed).toHaveLength(2);
    // Ranking order preserved (highest score first): top (0.9) before mid (0.5); low dropped.
    expect(parsed[0]!.metadata.id).toBe("top");
    expect(parsed[1]!.metadata.id).toBe("mid");
    // Benign content is byte-identical (the egress filter is a no-op on non-PII content).
    expect(parsed[0]!.content).toBe("alpha status green");
    // The PII row that survived the limit is still redacted.
    expect(parsed[1]!.content).toContain("[EMAIL]");
    expect(result.content).not.toContain(EMAIL);
  });
});

describe("memory_search — direct search/list leg raw CREDENTIAL egress redaction (#1619 rebase)", () => {
  it("redacts hf_/sk-/Bearer credentials in content and drops a secret tag on the DIRECT search leg", async () => {
    const legacy = makeItem({
      id: "legacy-secret-1",
      content: `token ${HF_KEY} key ${SK_KEY} auth ${BEARER}`,
      tags: ["weather", HF_KEY, SK_KEY],
    });
    const [searchTool] = createFridayAgentMemoryTools({
      memoryService: mockMemoryService({ search: [makeResult(legacy, 0.9)] }),
    });

    const result = await searchTool!.execute({ query: "token" }, signalWithPrincipal("user-1"));
    expect(result.isError).toBeUndefined();
    const parsed = parse(result.content);
    const stored = parsed.find((r) => r.metadata.id === "legacy-secret-1")!;

    // Each credential shape replaced by the canonical secret marker; the Bearer SCHEME survives.
    expect(stored.content).toContain("[REDACTED_SECRET]");
    expect(stored.content).toContain("Bearer [REDACTED_SECRET]");
    // No raw credential VALUE anywhere in the serialized tool output.
    expect(result.content).not.toContain(HF_KEY);
    expect(result.content).not.toContain(SK_KEY);
    expect(result.content).not.toContain(BEARER_BODY);
    // Secret-shaped tags dropped; the benign tag survives byte-identically.
    expect(stored.metadata.tags).toEqual(["weather"]);
  });

  it("redacts a zero-width-obfuscated hf_ credential in content on the DIRECT search leg", async () => {
    const legacy = makeItem({
      id: "legacy-secret-zw",
      content: `stashed ${HF_KEY_ZW} end`,
      tags: ["ok", HF_KEY_ZW],
    });
    const [searchTool] = createFridayAgentMemoryTools({
      memoryService: mockMemoryService({ search: [makeResult(legacy, 0.9)] }),
    });

    const result = await searchTool!.execute({ query: "stashed" }, signalWithPrincipal("user-1"));
    expect(result.isError).toBeUndefined();
    const parsed = parse(result.content);
    const stored = parsed.find((r) => r.metadata.id === "legacy-secret-zw")!;

    // The Unicode-obfuscated credential is de-obfuscated and redacted, NOT leaked.
    expect(stored.content).toContain("[REDACTED_SECRET]");
    // The contiguous body run that leaks pre-fix is gone (survives neither raw nor de-obfuscated).
    expect(result.content).not.toContain(HF_ZW_LEAK_PROBE);
    // Zero-width-obfuscated secret tag is dropped too (Unicode-aware tag drop).
    expect(stored.metadata.tags).toEqual(["ok"]);
  });

  it("redacts a raw hf_ credential from the session lexical-fallback LIST leg", async () => {
    const legacy = makeItem({
      id: "legacy-secret-list",
      content: `profile creds ${HF_KEY} done`,
      tags: ["profile", HF_KEY],
    });
    const [searchTool] = createFridayAgentMemoryTools({
      // search returns nothing → the row can only reach the agent via the LIST-backed
      // session lexical fallback (buildSessionLexicalCandidates → memoryService.list).
      memoryService: mockMemoryService({ search: [], list: [legacy] }),
      resolveSessionMemoryNamespace: async () => "sess-abc",
    });

    const result = await searchTool!.execute(
      { query: "profile" },
      signalWithPrincipal("user-1", "sess-123"),
    );
    expect(result.isError).toBeUndefined();
    const parsed = parse(result.content);
    const stored = parsed.find((r) => r.metadata.id === "legacy-secret-list");
    // The list-leg row MUST reach the agent (proves this leg egresses) AND be redacted.
    expect(stored, "list-leg row should be present in tool output").toBeDefined();
    expect(stored!.content).toContain("[REDACTED_SECRET]");
    expect(result.content).not.toContain(HF_KEY);
    expect(stored!.metadata.tags).toEqual(["profile"]);
  });

  it("redacts a zero-width-obfuscated hf_ credential from the LIST leg", async () => {
    const legacy = makeItem({
      id: "legacy-secret-list-zw",
      content: `profile stashed ${HF_KEY_ZW} done`,
      tags: ["profile", HF_KEY_ZW],
    });
    const [searchTool] = createFridayAgentMemoryTools({
      memoryService: mockMemoryService({ search: [], list: [legacy] }),
      resolveSessionMemoryNamespace: async () => "sess-abc",
    });

    const result = await searchTool!.execute(
      { query: "profile" },
      signalWithPrincipal("user-1", "sess-123"),
    );
    expect(result.isError).toBeUndefined();
    const parsed = parse(result.content);
    const stored = parsed.find((r) => r.metadata.id === "legacy-secret-list-zw");
    expect(stored, "list-leg row should be present in tool output").toBeDefined();
    expect(stored!.content).toContain("[REDACTED_SECRET]");
    expect(result.content).not.toContain(HF_ZW_LEAK_PROBE);
    expect(stored!.metadata.tags).toEqual(["profile"]);
  });

  it("preserves benign near-miss credential-shaped tokens byte-for-byte (no over-redaction)", async () => {
    const benign = makeItem({
      id: "benign-nearmiss",
      // Short/underscore/publishable near-misses must NOT match any secret shape.
      content: `docs ${HF_NEAR_MISS} sample ${SK_NEAR_MISS} public ${PK_PUBLISHABLE}`,
      tags: [HF_NEAR_MISS, SK_NEAR_MISS, PK_PUBLISHABLE],
    });
    const [searchTool] = createFridayAgentMemoryTools({
      memoryService: mockMemoryService({ search: [makeResult(benign, 0.9)] }),
    });

    const result = await searchTool!.execute({ query: "docs" }, signalWithPrincipal("user-1"));
    expect(result.isError).toBeUndefined();
    const parsed = parse(result.content);
    const stored = parsed.find((r) => r.metadata.id === "benign-nearmiss")!;

    // Content is byte-identical — the near-misses are NOT redacted.
    expect(stored.content).toBe(
      `docs ${HF_NEAR_MISS} sample ${SK_NEAR_MISS} public ${PK_PUBLISHABLE}`,
    );
    expect(stored.content).not.toContain("[REDACTED_SECRET]");
    // Benign near-miss tags are all preserved (none dropped as secret-shaped).
    expect(stored.metadata.tags).toEqual([HF_NEAR_MISS, SK_NEAR_MISS, PK_PUBLISHABLE]);
  });

  it("preserves ranking order and the result limit with a credential row (no-degrade)", async () => {
    const top = makeItem({ id: "c-top", content: "alpha status green" });
    const mid = makeItem({ id: "c-mid", content: `secret ${HF_KEY}` });
    const low = makeItem({ id: "c-low", content: "gamma status blue" });
    const [searchTool] = createFridayAgentMemoryTools({
      memoryService: mockMemoryService({
        search: [makeResult(top, 0.9), makeResult(mid, 0.5), makeResult(low, 0.1)],
      }),
    });

    const result = await searchTool!.execute(
      { query: "status", limit: 2 },
      new AbortController().signal,
    );
    const parsed = parse(result.content);

    // Limit + ranking unchanged: the credential redaction runs at the serialization boundary,
    // AFTER scoring/slice, so the SAME two highest-scored rows survive in the SAME order.
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.metadata.id).toBe("c-top");
    expect(parsed[1]!.metadata.id).toBe("c-mid");
    expect(parsed[0]!.content).toBe("alpha status green");
    // The credential row that survived the limit is still redacted.
    expect(parsed[1]!.content).toContain("[REDACTED_SECRET]");
    expect(result.content).not.toContain(HF_KEY);
  });
});
