import { describe, expect, it } from "vitest";

import { createFridayProviderContextPruner } from "../../../../src/providers/context/friday-provider-context-pruner.js";

describe("FridayProviderContextPruner", () => {
  it("prunes oversized recent tool-result payloads", () => {
    const pruner = createFridayProviderContextPruner();
    const result = pruner.prune([
      {
        messageId: "tool-result-1",
        role: "tool-result",
        content: "X".repeat(20_000),
        createdAt: "2026-02-19T10:00:00.000Z",
      },
    ]);

    expect(result.prunedCount).toBe(1);
    expect(result.messages[0]?.content).toContain("[...pruned");
  });

  it("does not prune a recent large user message just because it is large", () => {
    const pruner = createFridayProviderContextPruner();
    const content = "Y".repeat(20_000);
    const result = pruner.prune([
      {
        messageId: "user-1",
        role: "user",
        content,
        createdAt: "2026-02-19T10:00:00.000Z",
      },
    ]);

    expect(result.prunedCount).toBe(0);
    expect(result.messages[0]?.content).toBe(content);
  });
});
