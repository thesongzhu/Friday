#!/usr/bin/env node
/**
 * Minimal MCP stdio echo server for testing.
 * Responds to JSON-RPC initialize and tools/list via content-length framed messages on stdin/stdout.
 */

const SERVER_INFO = {
  name: "test-echo",
  version: "1.0.0",
};

const CAPABILITIES = {
  tools: { listChanged: false },
};

const TOOLS = [
  {
    name: "echo",
    description: "Echo input back",
    inputSchema: { type: "object", properties: { message: { type: "string" } } },
  },
];

let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  processBuffer();
});

function processBuffer() {
  // Try content-length framing first
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;

    const header = buffer.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      // Try JSONL fallback
      tryJsonl();
      return;
    }

    const contentLength = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + contentLength) break;

    const body = buffer.slice(bodyStart, bodyStart + contentLength);
    buffer = buffer.slice(bodyStart + contentLength);

    handleMessage(body);
  }
}

function tryJsonl() {
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) handleMessage(trimmed);
  }
}

function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  if (!msg.method) return;

  if (msg.method === "initialize") {
    sendResponse(msg.id, {
      protocolVersion: msg.params?.protocolVersion || "2024-11-05",
      serverInfo: SERVER_INFO,
      capabilities: CAPABILITIES,
    });
    return;
  }

  // notifications/initialized — no response needed
  if (msg.method === "notifications/initialized") return;

  if (msg.method === "tools/list") {
    sendResponse(msg.id, { tools: TOOLS });
    return;
  }

  if (msg.method === "tools/call") {
    const args = msg.params?.arguments || {};
    sendResponse(msg.id, {
      content: [{ type: "text", text: args.message || "echo" }],
      isError: false,
    });
    return;
  }

  // Unknown method
  sendError(msg.id, -32601, `Method not found: ${msg.method}`);
}

function sendResponse(id, result) {
  const response = JSON.stringify({ jsonrpc: "2.0", id, result });
  const header = `Content-Length: ${Buffer.byteLength(response)}\r\n\r\n`;
  process.stdout.write(header + response);
}

function sendError(id, code, message) {
  const response = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  const header = `Content-Length: ${Buffer.byteLength(response)}\r\n\r\n`;
  process.stdout.write(header + response);
}
