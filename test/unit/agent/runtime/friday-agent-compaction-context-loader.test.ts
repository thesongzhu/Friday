import { describe, expect, it, vi } from "vitest";

import type { FridayMemoryItem } from "../../../../src/memory/model/friday-memory.types.js";
import { createFridayCompactionContextLoader } from "../../../../src/agent/runtime/friday-agent-compaction-context-loader.js";

const NOW = "2026-04-16T19:00:00.000Z";

describe("FridayCompactionContextLoader", () => {
  it("returns only compaction blocks for the current session", async () => {
    const items: FridayMemoryItem[] = [
      {
        id: "item-1",
        namespace: "compaction.summary",
        key: "summary:run-1",
        content: "User already validated Discord routing.",
        source: "compaction:session-a:run-1",
        tags: ["compaction", "auto", "session-a"],
        metadata: { compactedAt: NOW },
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "item-2",
        namespace: "compaction.todos",
        key: "todos:run-1",
        content: "Re-run self-healing after config patch.",
        source: "compaction:session-a:run-1",
        tags: ["compaction", "auto", "session-a"],
        metadata: { compactedAt: NOW },
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "item-3",
        namespace: "compaction.summary",
        key: "summary:run-2",
        content: "This belongs to another session.",
        source: "compaction:session-b:run-2",
        tags: ["compaction", "auto", "session-b"],
        metadata: { compactedAt: NOW },
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    const loader = createFridayCompactionContextLoader({
      memoryService: {
        store: vi.fn(),
        search: vi.fn(),
        get: vi.fn(),
        list: vi.fn(async () => items),
        delete: vi.fn(),
        prune: vi.fn(),
      } as never,
    });

    const result = await loader.loadContext({ sessionKey: "session-a" });

    expect(result.blockCount).toBe(1);
    expect(result.fragment).toContain("Discord routing");
    expect(result.fragment).toContain("self-healing");
    expect(result.fragment).not.toContain("another session");
    expect(result.sources).toEqual(["compaction:session-a:run-1"]);
  });

  it("returns an empty fragment when sessionKey is missing", async () => {
    const loader = createFridayCompactionContextLoader({
      memoryService: {
        store: vi.fn(),
        search: vi.fn(),
        get: vi.fn(),
        list: vi.fn(async () => []),
        delete: vi.fn(),
        prune: vi.fn(),
      } as never,
    });

    const result = await loader.loadContext({});

    expect(result.fragment).toBe("");
    expect(result.blockCount).toBe(0);
  });
});
