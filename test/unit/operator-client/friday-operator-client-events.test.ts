import { describe, expect, it, vi } from "vitest";

import { openFridaySystemEventStream } from "@friday-operator-client";

describe("openFridaySystemEventStream", () => {
  it("refreshes auth once and surfaces a terminal 401 instead of recursing", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const refreshSession = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();

    await expect(openFridaySystemEventStream({
      fetchFn,
      getAccessToken: () => "token-1",
      refreshSession,
      onError,
      onEvent: vi.fn(),
    })).rejects.toThrow("HTTP 401");

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("HTTP 401");
  });
});
