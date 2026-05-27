import { describe, expect, it, vi } from "vitest";

import {
  FRIDAY_AGENT_RUN_DEFAULT_TIMEOUT_MS,
  FRIDAY_AGENT_RUN_RECEIPT_GRACE_MS,
  FridayClient,
  agentRunRequestTimeoutMs,
} from "../../../validation/real-world/lib/client.mjs";

describe("real-world validation client", () => {
  it("keeps the requested agent runtime timeout but gives HTTP receipt delivery grace", async () => {
    const client = new FridayClient({
      baseUrl: "http://127.0.0.1:3141",
      accessToken: "test-token",
    });
    const request = vi.fn().mockResolvedValue({
      ok: true,
      json: { ok: true, data: { runId: "run-1" } },
      text: JSON.stringify({ ok: true, data: { runId: "run-1" } }),
    });
    client.request = request;

    await client.startAgentRun({
      task: "read README.md",
      timeoutMs: 180_000,
    });

    expect(request).toHaveBeenCalledWith(
      "POST",
      "/v1/agent/runs",
      expect.objectContaining({
        body: expect.objectContaining({
          timeoutMs: 180_000,
        }),
        timeoutMs: 180_000 + FRIDAY_AGENT_RUN_RECEIPT_GRACE_MS,
      }),
    );
  });

  it("waits past the server default agent timeout when no body timeout is supplied", async () => {
    expect(agentRunRequestTimeoutMs(undefined)).toBe(
      FRIDAY_AGENT_RUN_DEFAULT_TIMEOUT_MS + FRIDAY_AGENT_RUN_RECEIPT_GRACE_MS,
    );
  });
});
