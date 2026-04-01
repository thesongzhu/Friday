import { describe, expect, it, vi, beforeEach } from "vitest";

const { runFridayCliBackendTextCompletionMock } = vi.hoisted(() => ({
  runFridayCliBackendTextCompletionMock: vi.fn(),
}));

vi.mock("#providers", async () => {
  const actual = await vi.importActual<typeof import("#providers")>("#providers");
  return {
    ...actual,
    runFridayCliBackendTextCompletion: runFridayCliBackendTextCompletionMock,
  };
});

import { createFridayAgentLlmClient } from "#agent";

describe("FridayAgentLlmClient CLI backend", () => {
  beforeEach(() => {
    runFridayCliBackendTextCompletionMock.mockReset();
  });

  it("treats CLI backends as text-only and does not hard-fail when tools are present", async () => {
    runFridayCliBackendTextCompletionMock.mockResolvedValue("CLI_OK");

    const client = createFridayAgentLlmClient({
      backendKind: "cli",
      cliConfig: { backendId: "codex-cli" },
    });

    const events = [];
    for await (const event of client.stream({
      model: "gpt-5.4",
      systemPrompt: "You are Friday.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: [{
        name: "read",
        description: "Read a file",
        parameters: { properties: { path: { type: "string" } } },
        async execute() { return { content: "" }; },
      }],
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(runFridayCliBackendTextCompletionMock).toHaveBeenCalledOnce();
    expect(runFridayCliBackendTextCompletionMock.mock.calls[0]?.[0]).toMatchObject({
      model: "gpt-5.4",
      conversation: "USER: Say hi",
    });
    expect(runFridayCliBackendTextCompletionMock.mock.calls[0]?.[0]?.systemPrompt).toContain(
      "Friday tools are unavailable in this backend.",
    );
    expect(events).toEqual([
      { type: "text_delta", text: "CLI_OK" },
      {
        type: "message_end",
        stopReason: "end_turn",
        inputTokens: 0,
        outputTokens: 0,
      },
    ]);
  });
});
