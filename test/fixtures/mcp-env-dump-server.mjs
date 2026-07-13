#!/usr/bin/env node
/**
 * Canary leak-scan MCP stdio server for SEC-PROVIDER-SECRET-PROCESS-001.
 *
 * On startup it writes its OWN received process.env and process.argv (exactly
 * what the OS handed this child) to the JSON file named in argv[2], then speaks
 * the minimal MCP handshake (initialize + tools/list) over content-length
 * framing so `createFridayMcpAdapter().listTools()` completes.
 *
 * The contract test reads the dumped env/argv back and asserts the synthetic
 * provider-secret canary is ABSENT — proving the real child-env construction
 * path (`buildSafeChildEnv`) never forwards provider secrets to a spawned child.
 *
 * This fixture never reads or emits any real secret; the only "secret" in the
 * flow is the synthetic canary chosen by the test.
 */
import { writeFileSync } from "node:fs";

const dumpPath = process.argv[2];
if (dumpPath) {
  // Snapshot the environment/argv this child actually received.
  writeFileSync(
    dumpPath,
    JSON.stringify({ env: process.env, argv: process.argv }),
    "utf8",
  );
}

const SERVER_INFO = { name: "friday-env-dump", version: "1.0.0" };
const CAPABILITIES = { tools: { listChanged: false } };
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
// Exit cleanly once the parent closes stdin so the test leaves no stray child.
process.stdin.on("end", () => process.exit(0));

function processBuffer() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const header = buffer.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = "";
      break;
    }
    const contentLength = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + contentLength) break;
    const body = buffer.slice(bodyStart, bodyStart + contentLength);
    buffer = buffer.slice(bodyStart + contentLength);
    handleMessage(body);
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
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    sendResponse(msg.id, { tools: TOOLS });
    return;
  }
  if (msg.method === "exit") {
    process.exit(0);
  }
  sendError(msg.id, -32601, `Method not found: ${msg.method}`);
}

function sendResponse(id, result) {
  const response = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(response)}\r\n\r\n${response}`);
}

function sendError(id, code, message) {
  const response = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(response)}\r\n\r\n${response}`);
}
