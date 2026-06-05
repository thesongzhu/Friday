import { describe, expect, it } from "vitest";
import { createMockHubEnv } from "../e2e/mock/_helpers/mock-env.js";

interface AgentRunEnvelope {
  ok: boolean;
  data?: {
    status: "completed" | "failed" | "cancelled";
    response?: string;
    responseText?: string;
  };
  error?: {
    code: string;
    message: string;
  };
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function withTemporaryEnv<T>(
  key: string,
  value: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

describe("Agent dependency-missing resilience", () => {
  it("fail-closes retired TS agent run start and avoids runaway provider retries", async () =>
    withTemporaryEnv("FRIDAY_DESKTOP_ENABLED", undefined, async () => {
      const startedAt = Date.now();
      const env = await createMockHubEnv({ providerKinds: ["anthropic"] });
      try {
        const provider = env.providers.anthropic;
        expect(provider).toBeDefined();
        const mock = env.mockFor("anthropic");
        mock.enqueue({
          type: "tool_use",
          toolName: "desktop",
          toolInput: { action: "session_info" },
        });
        mock.enqueue({
          type: "text",
          text: "Desktop runtime is not enabled. Set FRIDAY_DESKTOP_ENABLED=true and restart Friday.",
        });

        const response = await fetch(`${env.baseUrl}/v1/agent/runs`, {
          method: "POST",
          headers: authHeaders(env.accessToken),
          body: JSON.stringify({
            task: "Check desktop session info",
            providerId: provider!.providerId,
            model: provider!.model,
            timeoutMs: 30_000,
          }),
        });
        const body = (await response.json()) as AgentRunEnvelope;
        expect(response.status).toBe(503);
        expect(body.ok).toBe(false);
        expect(body.error?.code).toBe("TS_RUNTIME_AGENT_RUNS_RETIRED");
        expect(mock.calls.length).toBe(0);
        expect(Date.now() - startedAt).toBeLessThan(15_000);
      } finally {
        await env.cleanup();
      }
    }), 20_000);
});
