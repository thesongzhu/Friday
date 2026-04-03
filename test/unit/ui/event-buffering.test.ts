import { describe, expect, it } from "vitest";

import { appendBoundedItems, rememberSeenSequence } from "../../../ui/src/hooks/use-agent-run-events";
import { appendSystemEventWindow } from "../../../ui/src/hooks/use-system-events";

describe("event buffering helpers", () => {
  it("caps system event history and ignores duplicates", () => {
    const first = { id: "one", seq: 1 } as never;
    const second = { id: "two", seq: 2 } as never;
    const third = { id: "three", seq: 3 } as never;

    const deduped = appendSystemEventWindow([first], first, 2);
    expect(deduped).toEqual([first]);

    const bounded = appendSystemEventWindow(
      appendSystemEventWindow([first], second, 2),
      third,
      2,
    );
    expect(bounded).toEqual([second, third]);
  });

  it("caps generic stream buffers", () => {
    expect(appendBoundedItems([1, 2], 3, 2)).toEqual([2, 3]);
    expect(appendBoundedItems(["a"], "b", 3)).toEqual(["a", "b"]);
  });

  it("remembers only a bounded sequence window", () => {
    const seen = new Set<number>();
    const order: number[] = [];

    expect(rememberSeenSequence(1, seen, order, 2)).toBe(true);
    expect(rememberSeenSequence(2, seen, order, 2)).toBe(true);
    expect(rememberSeenSequence(2, seen, order, 2)).toBe(false);
    expect(rememberSeenSequence(3, seen, order, 2)).toBe(true);
    expect(seen.has(1)).toBe(false);
    expect(seen.has(2)).toBe(true);
    expect(seen.has(3)).toBe(true);
  });
});
