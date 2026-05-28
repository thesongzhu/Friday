import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FRIDAY_MCP_ADAPTER_ERROR_CODES,
  createFridayMcpAdapter,
} from "#agent";

interface RpcRequest {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

const PUBLIC_HTTP_MCP_TEST_URL = "https://93.184.216.34/rpc";

function buildRpcResult(request: RpcRequest): Record<string, unknown> {
  const method = request.method;
  const params = request.params ?? {};

  switch (method) {
    case "initialize":
      return {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "test-mcp", version: "1.0.0" },
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false },
          prompts: { listChanged: false },
        },
      };
    case "tools/list":
      return {
        tools: [
          {
            name: "echo",
            description: "Echo text",
            inputSchema: {
              type: "object",
              properties: {
                text: { type: "string" },
              },
            },
          },
        ],
      };
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      if (name === "explode") {
        throw {
          code: -32001,
          message: "boom",
        };
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const text = typeof args.text === "string" ? args.text : "";
      return {
        content: [
          {
            type: "text",
            text: `echo:${text}`,
          },
        ],
      };
    }
    case "resources/list":
      return {
        resources: [
          {
            uri: "friday://status",
            name: "status",
            mimeType: "application/json",
          },
        ],
      };
    case "resources/read": {
      const uri = typeof params.uri === "string" ? params.uri : "friday://unknown";
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify({ ok: true }),
          },
        ],
      };
    }
    case "prompts/list":
      return {
        prompts: [
          {
            name: "hello",
            description: "Greeting prompt",
          },
        ],
      };
    case "prompts/get": {
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const name = typeof args.name === "string" ? args.name : "world";
      return {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Hello ${name}`,
              },
            ],
          },
        ],
      };
    }
    default:
      return {};
  }
}

function buildStdioServerScript(): string {
  return [
    "let buffer = Buffer.alloc(0);",
    "const SEP = Buffer.from('\\r\\n\\r\\n', 'utf8');",
    "function writeMessage(payload) {",
    "  const body = Buffer.from(JSON.stringify(payload), 'utf8');",
    "  const header = Buffer.from(`Content-Length: ${String(body.length)}\\r\\n\\r\\n`, 'utf8');",
    "  process.stdout.write(Buffer.concat([header, body]));",
    "}",
    "function handleMessage(message) {",
    "  const method = message.method;",
    "  const id = message.id;",
    "  const params = message.params || {};",
    "  if (method === 'exit') { process.exit(0); return; }",
    "  if (id === undefined) { return; }",
    "  try {",
    "    let result = {};",
    "    switch (method) {",
    "      case 'initialize':",
    "        result = { protocolVersion: '2024-11-05', serverInfo: { name: 'test-mcp', version: '1.0.0' }, capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } } };",
    "        break;",
    "      case 'tools/list':",
    "        result = { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] };",
    "        break;",
    "      case 'tools/call':",
    "        if (params.name === 'explode') { throw { code: -32001, message: 'boom' }; }",
    "        result = { content: [{ type: 'text', text: `echo:${typeof params.arguments?.text === 'string' ? params.arguments.text : ''}` }] };",
    "        break;",
    "      case 'resources/list':",
    "        result = { resources: [{ uri: 'friday://status', name: 'status', mimeType: 'application/json' }] };",
    "        break;",
    "      case 'resources/read':",
    "        result = { contents: [{ uri: typeof params.uri === 'string' ? params.uri : 'friday://unknown', mimeType: 'application/json', text: JSON.stringify({ ok: true }) }] };",
    "        break;",
    "      case 'prompts/list':",
    "        result = { prompts: [{ name: 'hello', description: 'Greeting prompt' }] };",
    "        break;",
    "      case 'prompts/get':",
    "        result = { messages: [{ role: 'user', content: [{ type: 'text', text: `Hello ${typeof params.arguments?.name === 'string' ? params.arguments.name : 'world'}` }] }] };",
    "        break;",
    "      default:",
    "        result = {};",
    "        break;",
    "    }",
    "    writeMessage({ jsonrpc: '2.0', id, result });",
    "  } catch (error) {",
    "    const code = typeof error?.code === 'number' ? error.code : -32000;",
    "    const message = typeof error?.message === 'string' ? error.message : String(error);",
    "    writeMessage({ jsonrpc: '2.0', id, error: { code, message } });",
    "  }",
    "}",
    "process.stdin.on('data', (chunk) => {",
    "  buffer = Buffer.concat([buffer, Buffer.from(chunk)]);",
    "  while (true) {",
    "    const headerEnd = buffer.indexOf(SEP);",
    "    if (headerEnd < 0) break;",
    "    const headerText = buffer.subarray(0, headerEnd).toString('utf8');",
    "    const match = headerText.match(/Content-Length:\\s*(\\d+)/i);",
    "    if (!match) { buffer = Buffer.alloc(0); break; }",
    "    const contentLength = Number.parseInt(match[1], 10);",
    "    const bodyStart = headerEnd + SEP.length;",
    "    const frameEnd = bodyStart + contentLength;",
    "    if (buffer.length < frameEnd) break;",
    "    const body = buffer.subarray(bodyStart, frameEnd).toString('utf8');",
    "    buffer = buffer.subarray(frameEnd);",
    "    try { handleMessage(JSON.parse(body)); } catch {}",
    "  }",
    "});",
  ].join("\n");
}

function createHttpFetchMock() {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const rawBody = typeof init?.body === "string" ? init.body : "{}";
    const request = JSON.parse(rawBody) as RpcRequest;

    if (!request.id) {
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    try {
      const result = buildRpcResult(request);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    } catch (error) {
      const code = typeof (error as { code?: unknown }).code === "number"
        ? (error as { code: number }).code
        : -32000;
      const message = error instanceof Error
        ? error.message
        : typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : String(error);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code, message } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MCP transport parity contract", () => {
  it("returns equivalent tool/resource/prompt payloads for stdio and http transports", async () => {
    const stdioAdapter = createFridayMcpAdapter({
      servers: [
        {
          id: "stdio",
          transport: "stdio",
          command: process.execPath,
          args: ["-e", buildStdioServerScript()],
          // Opt in so transport parity is exercised; the adapter fails closed
          // per surface without an allowlist or explicit opt-in.
          policy: { allowAllTools: true, allowAllResources: true, allowAllPrompts: true },
        },
      ],
    });

    const fetchMock = createHttpFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const httpAdapter = createFridayMcpAdapter({
      servers: [
        {
          id: "http",
          transport: "http",
          url: PUBLIC_HTTP_MCP_TEST_URL,
          policy: { allowAllTools: true, allowAllResources: true, allowAllPrompts: true },
        },
      ],
    });

    const [stdioTools, httpTools] = await Promise.all([
      stdioAdapter.listTools({ serverId: "stdio" }),
      httpAdapter.listTools({ serverId: "http" }),
    ]);
    expect(stdioTools[0]?.name).toBe(httpTools[0]?.name);

    const [stdioResources, httpResources] = await Promise.all([
      stdioAdapter.listResources({ serverId: "stdio" }),
      httpAdapter.listResources({ serverId: "http" }),
    ]);
    expect(stdioResources[0]?.uri).toBe(httpResources[0]?.uri);

    const [stdioPrompts, httpPrompts] = await Promise.all([
      stdioAdapter.listPrompts({ serverId: "stdio" }),
      httpAdapter.listPrompts({ serverId: "http" }),
    ]);
    expect(stdioPrompts[0]?.name).toBe(httpPrompts[0]?.name);

    const [stdioToolResult, httpToolResult] = await Promise.all([
      stdioAdapter.callTool({ serverId: "stdio", toolName: "echo", args: { text: "hello" } }),
      httpAdapter.callTool({ serverId: "http", toolName: "echo", args: { text: "hello" } }),
    ]);
    expect(stdioToolResult.isError).toBe(false);
    expect(httpToolResult.isError).toBe(false);
    expect(stdioToolResult.content).toBe(httpToolResult.content);

    const [stdioResourceResult, httpResourceResult] = await Promise.all([
      stdioAdapter.readResource({ serverId: "stdio", uri: "friday://status" }),
      httpAdapter.readResource({ serverId: "http", uri: "friday://status" }),
    ]);
    expect(stdioResourceResult.content).toBe(httpResourceResult.content);

    const [stdioPromptResult, httpPromptResult] = await Promise.all([
      stdioAdapter.getPrompt({ serverId: "stdio", name: "hello", args: { name: "Friday" } }),
      httpAdapter.getPrompt({ serverId: "http", name: "hello", args: { name: "Friday" } }),
    ]);
    expect(stdioPromptResult.content).toBe(httpPromptResult.content);
  });

  it("maps transport tool failures to a consistent adapter error contract", async () => {
    const stdioAdapter = createFridayMcpAdapter({
      servers: [
        {
          id: "stdio",
          transport: "stdio",
          command: process.execPath,
          args: ["-e", buildStdioServerScript()],
          // Opt in so transport parity is exercised; the adapter now fails
          // closed without an allowlist or this explicit opt-in.
          policy: { allowAllTools: true },
        },
      ],
    });

    const fetchMock = createHttpFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const httpAdapter = createFridayMcpAdapter({
      servers: [
        {
          id: "http",
          transport: "http",
          url: PUBLIC_HTTP_MCP_TEST_URL,
          policy: { allowAllTools: true },
        },
      ],
    });

    await expect(
      stdioAdapter.callTool({ serverId: "stdio", toolName: "explode" }),
    ).rejects.toMatchObject({
      code: FRIDAY_MCP_ADAPTER_ERROR_CODES.REQUEST_FAILED,
      routeId: "mcp.adapter.tools.call",
    });

    await expect(
      httpAdapter.callTool({ serverId: "http", toolName: "explode" }),
    ).rejects.toMatchObject({
      code: FRIDAY_MCP_ADAPTER_ERROR_CODES.REQUEST_FAILED,
      routeId: "mcp.adapter.tools.call",
    });
  });

  it("enforces local tool allowlist and rate-limit policy before transport calls", async () => {
    const fetchMock = createHttpFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createFridayMcpAdapter({
      servers: [
        {
          id: "http",
          transport: "http",
          url: PUBLIC_HTTP_MCP_TEST_URL,
          policy: {
            toolAllowlist: ["echo"],
            rateLimit: {
              maxCalls: 1,
              windowMs: 60_000,
            },
          },
        },
      ],
    });

    await expect(
      adapter.callTool({ serverId: "http", toolName: "not-allowed" }),
    ).rejects.toMatchObject({
      code: FRIDAY_MCP_ADAPTER_ERROR_CODES.POLICY_TOOL_FORBIDDEN,
      routeId: "mcp.adapter.tools.call",
    });

    await expect(
      adapter.callTool({ serverId: "http", toolName: "echo", args: { text: "one" } }),
    ).resolves.toMatchObject({
      isError: false,
    });

    await expect(
      adapter.callTool({ serverId: "http", toolName: "echo", args: { text: "two" } }),
    ).rejects.toMatchObject({
      code: FRIDAY_MCP_ADAPTER_ERROR_CODES.POLICY_RATE_LIMITED,
      routeId: "mcp.adapter.tools.call",
    });
  });
});
