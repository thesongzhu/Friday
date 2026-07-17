import { describe, it, expect, vi } from "vitest";
import { createFridayAgentMemoryTools } from "#agent";
import type { FridayMemoryService } from "#memory";
import type { FridayMemoryItem, FridayMemorySearchResult } from "#memory";
import { attachFridayAgentToolExecutionContext } from "../../../../src/agent/runtime/friday-agent-tool-execution-context.js";

// ─── Sibling learned-fact egress leak (agent memory_search TOOL — a trust boundary): learned
//     facts are appended to memory_search results AFTER being written verbatim (they bypass
//     the write-time PII guard). Their content crossed the agent trust boundary unredacted, so
//     a full-width / CJK / ASCII card/email leaked to the tool caller. Default here is to
//     REDACT: no functional reason for the agent to receive raw PII from a learned preference
//     fact. These tests invoke the REAL tool `execute` and assert on the serialized result. ───

const NOW = "2026-02-19T00:00:00.000Z";
// toFullwidth("4111111111111111") — Luhn-valid Visa test number in full-width digits.
const FULLWIDTH_CARD = "４１１１１１１１１１１１１１１１";

function signalWithPrincipal(principalId: string): AbortSignal {
  return attachFridayAgentToolExecutionContext(new AbortController().signal, {
    runId: "run-1",
    sessionKey: "agent:run:run-1",
    readOnly: false,
    principalId,
  });
}

function makeSearchResult(overrides?: Partial<FridayMemorySearchResult>): FridayMemorySearchResult {
  const item: FridayMemoryItem = {
    id: "item-1",
    namespace: "agent",
    key: "key-1",
    content: "The weather in Seattle is rainy",
    source: "agent",
    tags: ["weather"],
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    item,
    score: 0.5,
    ftsScore: 0.5,
    semanticScore: 0.5,
    matchedBy: ["fts"],
    snippet: "The weather in Seattle...",
    ...overrides,
  };
}

function mockMemoryService(searchResults: FridayMemorySearchResult[]): FridayMemoryService {
  return {
    search: vi.fn().mockResolvedValue(searchResults),
    store: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(false),
    prune: vi.fn().mockResolvedValue({ deletedCount: 0, deletedIds: [], dryRun: false }),
  } as unknown as FridayMemoryService;
}

describe("FridayAgentMemoryTools memory_search — learned-fact PII egress", () => {
  it("redacts a full-width card in the appended learned-fact content", async () => {
    const [searchTool] = createFridayAgentMemoryTools({
      memoryService: mockMemoryService([]),
      listLearnedFacts: () => [{
        key: "card",
        value: `カード番号は${FULLWIDTH_CARD}です`,
        confidence: 0.9,
        evidenceCount: 3,
        lastConfirmedAt: NOW,
      }],
    });

    const result = await searchTool!.execute({ query: "card" }, signalWithPrincipal("user-1"));
    expect(result.isError).toBeUndefined();

    const parsed = JSON.parse(result.content) as Array<{ content: string; metadata: { source: string } }>;
    const learned = parsed.find((r) => r.metadata.source === "learned_fact")!;
    expect(learned.content).toContain("[CREDIT_CARD]");
    expect(learned.content).not.toContain(FULLWIDTH_CARD);
    // No raw full-width digits anywhere in the serialized tool result.
    expect(result.content).not.toContain(FULLWIDTH_CARD);
  });

  it("redacts a learned fact but leaves an unrelated stored result unchanged (surgical scope)", async () => {
    const [searchTool] = createFridayAgentMemoryTools({
      memoryService: mockMemoryService([makeSearchResult()]),
      listLearnedFacts: () => [{
        key: "card",
        value: `カード番号は${FULLWIDTH_CARD}です`,
        confidence: 0.9,
        evidenceCount: 3,
        lastConfirmedAt: NOW,
      }],
    });

    const result = await searchTool!.execute({ query: "card" }, signalWithPrincipal("user-1"));
    const parsed = JSON.parse(result.content) as Array<{ content: string; metadata: { source: string } }>;

    const stored = parsed.find((r) => r.metadata.source === "agent")!;
    expect(stored.content).toBe("The weather in Seattle is rainy");
    const learned = parsed.find((r) => r.metadata.source === "learned_fact")!;
    expect(learned.content).not.toContain(FULLWIDTH_CARD);
    expect(learned.content).toContain("[CREDIT_CARD]");
  });

  // SEC-EVENT-REDACTION-001 round-15: the agent-tool learned-fact search reuses the SAME canonical
  // output filter, so a SHAPED secret in a learned-fact value (stringified into content) is redacted —
  // including the round-15 Stripe underscore shape (`sk_live_`) that 14e4c4f4's `sk-` shape missed.
  it("redacts a Stripe underscore-format sk_live_ secret in an appended learned-fact value (round-15 shape)", async () => {
    const SK_LIVE = ["sk_live", "0123456789abcdefghijABCDwxyz"].join("_"); // built at runtime (push-protection) // pragma: allowlist secret
    const [searchTool] = createFridayAgentMemoryTools({
      memoryService: mockMemoryService([]),
      listLearnedFacts: () => [{
        key: "creds",
        // BARE sk_live_ in a plain string (no `apiKey:`/`token:` assignment context) — caught ONLY by
        // the round-15 underscore SHAPE, not the generic-assignment pattern. RED on 14e4c4f4.
        value: `deploy used ${SK_LIVE} to auth`,
        confidence: 0.9,
        evidenceCount: 3,
        lastConfirmedAt: NOW,
      }],
    });
    const result = await searchTool!.execute({ query: "creds" }, signalWithPrincipal("user-1"));
    const parsed = JSON.parse(result.content) as Array<{ content: string; metadata: { source: string } }>;
    const learned = parsed.find((r) => r.metadata.source === "learned_fact")!;
    expect(learned.content).toContain("[REDACTED_SECRET]");
    expect(learned.content).not.toContain(SK_LIVE);
    expect(result.content).not.toContain(SK_LIVE);
  });

  it("leaves a learned fact with no PII unchanged (negative control)", async () => {
    const [searchTool] = createFridayAgentMemoryTools({
      memoryService: mockMemoryService([]),
      listLearnedFacts: () => [{
        key: "pref:display_name",
        value: "Captain Friday",
        confidence: 0.8,
        evidenceCount: 1,
        lastConfirmedAt: NOW,
      }],
    });

    const result = await searchTool!.execute(
      { query: "what should you call me" },
      signalWithPrincipal("user-1"),
    );
    const parsed = JSON.parse(result.content) as Array<{ content: string; metadata: { source: string } }>;
    const learned = parsed.find((r) => r.metadata.source === "learned_fact")!;
    expect(learned.content).toBe("Captain Friday");
  });
});
