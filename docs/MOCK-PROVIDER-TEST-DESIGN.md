# Mock Provider Test Design — CX (gpt-5.3-codex)
> Date: 2026-02-20

**Design Scope**
Assumption: this is based on the interfaces and file paths in your prompt (the source tree wasn’t present in this workspace snapshot), so names are implementation-ready but may need small wiring adjustments to your existing test harness types.

**Goals**
1. Remove all real LLM dependency from default E2E.
2. Cover all provider kinds and all provider APIs deterministically.
3. Preserve one optional live suite gated by `E2E_LIVE=1`.
4. Keep mocks fast, deterministic, and assertion-friendly.

---

**Target File Layout**
- `test/_mocks/mock-llm-providers.ts`
- `test/e2e/mock/_helpers/create-mock-hub-env.ts`
- `test/e2e/mock/_helpers/install-mock-providers.ts`
- `test/e2e/mock/_helpers/provider-matrix.ts`
- `test/e2e/mock/_helpers/mock-fetch-router.ts`
- `test/e2e/mock/friday-mock-journeys.e2e.test.ts`
- `test/e2e/mock/friday-mock-provider-errors.e2e.test.ts`
- `test/e2e/live/friday-live-journeys.e2e.test.ts`

---

**1. Mock Provider Factory (`test/_mocks/mock-llm-providers.ts`)**

Use one protocol-aware mock fetch per API, plus a small router to dispatch by URL.

```ts
export type MockLlmReply =
  | { type: "text"; text: string; status?: number; latencyMs?: number }
  | { type: "tool_use"; toolName: string; toolInput: unknown; toolCallId?: string; textAfterTool?: string; latencyMs?: number }
  | { type: "http_error"; status: number; body?: unknown; headers?: HeadersInit; latencyMs?: number }
  | { type: "network_error"; message: string; code?: string; latencyMs?: number }
  | { type: "timeout"; message?: string; code?: "ETIMEDOUT" | "ECONNRESET"; latencyMs?: number };

export type MockFetchCall = {
  api: FridayProviderApi;
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyRaw?: string;
  bodyJson?: unknown;
  atIso: string;
};

export interface MockFetch extends typeof fetch {
  calls: MockFetchCall[];
  enqueue: (...replies: MockLlmReply[]) => void;
  setDefault: (reply: MockLlmReply) => void;
  reset: () => void;
}

export function createMockFetch(api: FridayProviderApi, opts?: {
  initialReplies?: MockLlmReply[];
  defaultReply?: MockLlmReply;
}): MockFetch;
```

Deterministic behavior:
- FIFO queue of replies (`enqueue`).
- If queue empty, use `defaultReply`.
- `calls` records every request for assertions.
- No random IDs. Use deterministic IDs like `mock_msg_1`, `mock_call_1`.

SSE helper (shared):
```ts
function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(line));
        controller.close();
      }
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}
```

Provider format examples:

`anthropic-messages` (SSE):
```ts
[
  `event: content_block_start\n`,
  `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
  `event: content_block_delta\n`,
  `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from mock"}}\n\n`,
  `event: content_block_stop\n`,
  `data: {"type":"content_block_stop","index":0}\n\n`,
  `event: message_delta\n`,
  `data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":4}}\n\n`,
  `event: message_stop\n`,
  `data: {"type":"message_stop"}\n\n`
]
```

`openai-completions` (SSE):
```ts
[
  `data: {"id":"chatcmpl_mock_1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello from mock"},"finish_reason":null}]}\n\n`,
  `data: {"id":"chatcmpl_mock_1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
  `data: [DONE]\n\n`
]
```

`openai-responses` (SSE):
```ts
[
  `data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_mock_1","type":"message","role":"assistant","content":[]}}\n\n`,
  `data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_mock_1","content_index":0,"delta":"Hello from mock"}\n\n`,
  `data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_mock_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello from mock"}]}}\n\n`,
  `data: {"type":"response.completed","response":{"id":"resp_mock_1","status":"completed"}}\n\n`
]
```

`google-generative-ai` (JSON):
```ts
{
  "candidates": [
    {
      "content": { "role": "model", "parts": [{ "text": "Hello from mock" }] },
      "finishReason": "STOP"
    }
  ],
  "usageMetadata": { "promptTokenCount": 5, "candidatesTokenCount": 4, "totalTokenCount": 9 }
}
```

`ollama` (JSON):
```ts
{
  "model": "mock-ollama",
  "created_at": "2026-02-20T00:00:00.000Z",
  "message": { "role": "assistant", "content": "Hello from mock" },
  "done": true
}
```

Tool-use examples:
- Anthropic: `content_block_start` with `type:"tool_use"` and `content_block_delta.delta.type:"input_json_delta"`.
- OpenAI completions: `choices[0].delta.tool_calls`.
- OpenAI responses: `response.output_item.added` / `done` with item `type:"function_call"`.
- Google: `parts:[{ functionCall: { name, args } }]`.
- Ollama: `message.tool_calls:[{ function:{ name, arguments } }]`.

Error simulation:
- `http_error`: return `Response` with provider-native error body.
- `network_error`: `throw Object.assign(new Error(msg), { code })`.
- `timeout`: throw `Error("ETIMEDOUT: mock timeout")` or `AbortError`.

---

**2. Mock Provider E2E Helpers (`test/e2e/mock/_helpers/`)**

`install-mock-providers.ts`:
```ts
export type InstalledMockProvider = {
  kind: FridayProviderKind;
  api: FridayProviderApi;
  providerId: string;
  routeId: string;
  baseUrl: string;
};

export async function installMockProviders(hubEnv: HubEnv): Promise<Record<FridayProviderKind, InstalledMockProvider>>;
```

Registration map:
- `openai` -> `openai-responses` -> base URL `https://mock.openai.local/v1`
- `anthropic` -> `anthropic-messages` -> `https://mock.anthropic.local/v1`
- `google` -> `google-generative-ai` -> `https://mock.google.local/v1beta`
- `ollama` -> `ollama` -> `https://mock.ollama.local`
- `openai-compatible` -> `openai-completions` -> `https://mock.compat.local/v1`

`create-mock-hub-env.ts`:
```ts
export type MockHubEnv = HubEnv & {
  providerMap: Record<FridayProviderKind, InstalledMockProvider>;
  mockFetchByApi: Record<FridayProviderApi, MockFetch>;
  restoreFetch: () => void;
};

export async function createMockHubEnv(): Promise<MockHubEnv>;
```

Behavior:
1. Build one `MockFetch` per API.
2. Create URL router fetch that dispatches to the right `MockFetch` by host/path.
3. Patch `globalThis.fetch` for the env lifetime.
4. Call `installMockProviders`.
5. Return env with cleanup restoring original fetch.

`provider-matrix.ts`:
```ts
export const PROVIDER_MATRIX: ReadonlyArray<{
  kind: FridayProviderKind;
  api: FridayProviderApi;
}> = [ ...five entries... ];
```

---

**3. Refactored E2E Test Structure**

`test/e2e/mock/friday-mock-journeys.e2e.test.ts`
- Runs by default in CI.
- Reuses current 10 journey scenarios.
- Uses `describe.each(PROVIDER_MATRIX)` to run each scenario against each provider kind.
- For each test:
1. `const env = await createMockHubEnv()`
2. enqueue deterministic text/tool response on that provider’s mock
3. run journey
4. assert final output and `mockFetch.calls`

`test/e2e/mock/friday-mock-provider-errors.e2e.test.ts`
- Parameterized per provider kind.
- Cases: 4xx, 5xx, timeout, failover.

`test/e2e/live/friday-live-journeys.e2e.test.ts`
- Optional suite only:
```ts
const describeLive = process.env.E2E_LIVE === "1" ? describe : describe.skip;
```
- Keep small smoke coverage only (not full matrix).
- Existing `test/e2e/real` can be migrated here, then retired.

---

**4. Provider-Specific Test Cases**

Use one shared test generator with explicit matrix entries for all 5 kinds:

1. `openai` (`openai-responses`)
2. `anthropic` (`anthropic-messages`)
3. `google` (`google-generative-ai`)
4. `ollama` (`ollama`)
5. `openai-compatible` (`openai-completions`)

For each provider:
1. Basic text completion:
- enqueue `{ type: "text", text: "mock hello" }`
- assert assistant output contains `mock hello`
- assert one network call recorded

2. Tool call round-trip:
- first reply `{ type: "tool_use", toolName: "get_weather", toolInput: { city: "SF" } }`
- simulate tool execution in harness
- second reply `{ type: "text", text: "Weather is 68F" }`
- assert emitted unified events include `tool_use` then `message_end`

3. Error handling:
- 4xx non-transient: ensure surfaced error and no retry loop
- 5xx transient: ensure retry/fallback is attempted
- timeout/transient (`ETIMEDOUT`/`AbortError`): ensure fallback path engaged

4. Failover:
- provider A returns `429`
- provider B returns successful text
- assert final success from B
- assert A was called once and then cooled down/skipped on immediate repeat request

---

**5. Integration Points**

Agent LLM client (`createFridayAgentLlmClient`):
- Inject `fetchImpl` directly in tests.
- This is the preferred path for stream parser validation.

Provider inference client:
- Integration tests: patch `globalThis.fetch` via mock router because `providerService.runWithFallback()` eventually calls fetch.
- Unit tests: stub `providerService.runWithFallback` directly to isolate generator logic from transport.

Mocking level guidance:
1. `fetch` level for protocol correctness and end-to-end parser behavior.
2. `runWithFallback` level for business logic unit tests.
3. fallback module unit tests for cooldown/transient classification correctness.

---

**CI Behavior**
- Default CI command: `vitest test/e2e/mock --run`
- Live command: `E2E_LIVE=1 vitest test/e2e/live --run`
- No external services required for default CI.
- Expected runtime: all mock E2E tests deterministic, each test under 1 second.

---

**Rollout Plan**
1. Add `mock-llm-providers.ts` and helper env wiring.
2. Port one representative journey to mock matrix.
3. Port remaining journeys.
4. Add error/failover matrix tests.
5. Move old real tests to `test/e2e/live` and gate with `E2E_LIVE=1`.
6. Switch CI to mock suite only.

This design gives Friday full provider-kind coverage, API-shape fidelity, and reliable CI without real inference dependencies.