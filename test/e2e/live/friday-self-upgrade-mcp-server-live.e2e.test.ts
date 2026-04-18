import Database from "better-sqlite3";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LIVE_ANTHROPIC_MODEL } from "../_helpers/live-anthropic.js";
import {
  cleanupFridayDeepProofHubEnv,
  createFridayDeepProofHubEnv,
  FRIDAY_DEEP_PROOF_GATED,
  type RealHubEnv,
} from "./_helpers/deep-proof-env.js";

interface RuntimeVersionEnvelope {
  ok: boolean;
  data: {
    version: string;
    apiVersion: string;
  };
}

interface UpgradeStatusEnvelope {
  ok: boolean;
  data: {
    items: Array<{
      kind: string;
      id: string;
      status: string;
      promotionChannel: string;
      shadowVersionId?: string;
      canaryStats?: {
        sampleSize: number;
        successCount: number;
        failureCount: number;
        rollbackCount: number;
      };
      recordedCompatibilityStatus: string;
      derivedCompatibilityStatus: string;
      strategy: string;
      nextStage: string;
      details?: Record<string, unknown>;
      findings: Array<{ id: string; passed: boolean; severity: string }>;
    }>;
  };
}

interface McpActionEnvelope {
  ok: boolean;
  data: {
    server: {
      id: string;
      status: string;
      transport?: string;
      toolCount?: number;
      resourceCount?: number;
      promotionChannel?: string;
      compatibilityStatus?: string;
      shadowVersionId?: string;
      canaryStats?: {
        sampleSize: number;
        successCount: number;
        failureCount: number;
        rollbackCount: number;
      };
    };
    status: UpgradeStatusEnvelope["data"]["items"][number] | null;
  };
}

interface UpgradeStateRowReadback {
  compatibilityStatus: string;
  promotionChannel: string;
  shadowVersionId: string | null;
  canaryStatsJson: string;
  lastVerifiedRuntimeVersion: string | null;
  lastVerifiedProviderModel: string | null;
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
    "  if (id === undefined) { return; }",
    "  try {",
    "    let result = {};",
    "    switch (method) {",
    "      case 'initialize':",
    "        result = { protocolVersion: '2024-11-05', serverInfo: { name: 'deep-proof-mcp', version: '1.0.0' }, capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } } };",
    "        break;",
    "      case 'tools/list':",
    "        result = { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] };",
    "        break;",
    "      case 'tools/call':",
    "        result = { content: [{ type: 'text', text: `echo:${typeof params.arguments?.text === 'string' ? params.arguments.text : ''}` }] };",
    "        break;",
    "      case 'resources/list':",
    "        result = { resources: [{ uri: 'friday://status', name: 'status', mimeType: 'application/json' }] };",
    "        break;",
    "      case 'resources/read':",
    "        result = { contents: [{ uri: typeof params.uri === 'string' ? params.uri : 'friday://status', mimeType: 'application/json', text: JSON.stringify({ ok: true, server: 'deep-proof-mcp' }) }] };",
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

function openStateDb(stateDir: string): Database.Database {
  return new Database(path.join(stateDir, "friday.db"), { readonly: true, fileMustExist: true });
}

function readUpgradeStateRow(stateDir: string, subjectId: string): UpgradeStateRowReadback | null {
  const db = openStateDb(stateDir);
  try {
    return (
      db.prepare(
        `SELECT compatibility_status AS compatibilityStatus,
                promotion_channel AS promotionChannel,
                shadow_version_id AS shadowVersionId,
                canary_stats_json AS canaryStatsJson,
                last_verified_runtime_version AS lastVerifiedRuntimeVersion,
                last_verified_provider_model AS lastVerifiedProviderModel
           FROM autonomy_subject_upgrade_state
          WHERE subject_kind = 'mcp_server'
            AND subject_id = ?`,
      ).get(subjectId) as UpgradeStateRowReadback | undefined
    ) ?? null;
  } finally {
    db.close();
  }
}

async function getRuntimeVersion(env: RealHubEnv): Promise<string> {
  const response = await fetch(`${env.baseUrl}/v1/version`, {
    headers: { Authorization: `Bearer ${env.accessToken}` },
  });
  const json = await response.json() as RuntimeVersionEnvelope;
  expect(response.status).toBe(200);
  expect(json.ok).toBe(true);
  return json.data.version;
}

async function getUpgradeStatus(env: RealHubEnv, serverId: string): Promise<UpgradeStatusEnvelope["data"]["items"][number]> {
  const response = await fetch(
    `${env.baseUrl}/v1/autonomy/upgrade-status?kind=mcp_server&id=${encodeURIComponent(serverId)}`,
    {
      headers: { Authorization: `Bearer ${env.accessToken}` },
    },
  );
  const json = await response.json() as UpgradeStatusEnvelope;
  expect(response.status).toBe(200);
  expect(json.ok).toBe(true);
  expect(json.data.items).toHaveLength(1);
  return json.data.items[0]!;
}

describe.skipIf(!FRIDAY_DEEP_PROOF_GATED)("Friday MCP Server Self Upgrade Live (Anthropic API key lane)", () => {
  let env: RealHubEnv;
  let previousMcpServers: string | undefined;
  let previousMcpServerEnabled: string | undefined;
  const serverId = "deep-proof-mcp";

  beforeAll(async () => {
    previousMcpServers = process.env.FRIDAY_MCP_SERVERS;
    previousMcpServerEnabled = process.env.FRIDAY_MCP_SERVER_ENABLED;
    process.env.FRIDAY_MCP_SERVER_ENABLED = "true";
    process.env.FRIDAY_MCP_SERVERS = JSON.stringify([
      {
        id: serverId,
        transport: "stdio",
        command: process.execPath,
        args: ["-e", buildStdioServerScript()],
      },
    ]);
    env = await createFridayDeepProofHubEnv();
  }, 120_000);

  afterAll(async () => {
    if (env) {
      await cleanupFridayDeepProofHubEnv(env);
    }
    if (previousMcpServers === undefined) {
      delete process.env.FRIDAY_MCP_SERVERS;
    } else {
      process.env.FRIDAY_MCP_SERVERS = previousMcpServers;
    }
    if (previousMcpServerEnabled === undefined) {
      delete process.env.FRIDAY_MCP_SERVER_ENABLED;
    } else {
      process.env.FRIDAY_MCP_SERVER_ENABLED = previousMcpServerEnabled;
    }
  }, 30_000);

  it(
    "proves mcp_server detect-adapt-replay-shadow-canary-promote-rollback with API and SQLite readback",
    { timeout: 240_000, retry: 1 },
    async () => {
      const runtimeVersion = await getRuntimeVersion(env);

      const detectStatus = await getUpgradeStatus(env, serverId);
      expect(detectStatus.derivedCompatibilityStatus).toBe("blocked");
      expect(detectStatus.strategy).toBe("patch");
      expect(detectStatus.findings.some((finding) => finding.id === "mcp_runtime_state" && !finding.passed)).toBe(true);

      const tools = await env.hub!.mcpAdapter!.listTools({ serverId });
      expect(tools.map((tool) => tool.name)).toContain("echo");

      const replayToolRes = await env.hub!.mcpAdapter!.callTool({
        serverId,
        toolName: "echo",
        args: { text: "phase4" },
      });
      expect(replayToolRes.isError).toBe(false);
      expect(replayToolRes.content).toContain("echo:phase4");

      const resources = await env.hub!.mcpAdapter!.listResources({ serverId });
      expect(resources.map((resource) => resource.uri)).toContain("friday://status");

      const replayResourceRes = await env.hub!.mcpAdapter!.readResource({
        serverId,
        uri: "friday://status",
      });
      expect(replayResourceRes.content).toContain("\"ok\":true");

      const postAdaptStatus = await getUpgradeStatus(env, serverId);
      expect(postAdaptStatus.derivedCompatibilityStatus).toBe("compatible");
      expect(postAdaptStatus.status).toBe("loaded");
      expect(postAdaptStatus.strategy).toBe("noop");

      const firstShadowId = `${serverId}@shadow`;
      const shadowRes = await fetch(`${env.baseUrl}/v1/autonomy/mcp-servers/${encodeURIComponent(serverId)}/shadow`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          shadowVersionId: firstShadowId,
          runtimeVersion,
          providerModel: LIVE_ANTHROPIC_MODEL,
        }),
      });
      const shadowJson = await shadowRes.json() as McpActionEnvelope;
      expect(shadowRes.status).toBe(200);
      expect(shadowJson.ok).toBe(true);
      expect(shadowJson.data.server.promotionChannel).toBe("shadow");
      expect(shadowJson.data.status?.shadowVersionId).toBe(firstShadowId);

      const canaryRes = await fetch(`${env.baseUrl}/v1/autonomy/mcp-servers/${encodeURIComponent(serverId)}/canary`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ success: true }),
      });
      const canaryJson = await canaryRes.json() as McpActionEnvelope;
      expect(canaryRes.status).toBe(200);
      expect(canaryJson.ok).toBe(true);
      expect(canaryJson.data.server.promotionChannel).toBe("canary");
      expect(canaryJson.data.server.canaryStats?.sampleSize).toBe(1);
      expect(canaryJson.data.server.canaryStats?.successCount).toBe(1);

      const promoteRes = await fetch(`${env.baseUrl}/v1/autonomy/mcp-servers/${encodeURIComponent(serverId)}/promote`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          runtimeVersion,
          providerModel: LIVE_ANTHROPIC_MODEL,
        }),
      });
      const promoteJson = await promoteRes.json() as McpActionEnvelope;
      expect(promoteRes.status).toBe(200);
      expect(promoteJson.ok).toBe(true);
      expect(promoteJson.data.server.promotionChannel).toBe("active");
      expect(promoteJson.data.status?.derivedCompatibilityStatus).toBe("compatible");

      const rowAfterPromote = readUpgradeStateRow(env.stateDir!, serverId);
      expect(rowAfterPromote).not.toBeNull();
      expect(rowAfterPromote?.promotionChannel).toBe("active");
      expect(rowAfterPromote?.compatibilityStatus).toBe("compatible");
      expect(rowAfterPromote?.lastVerifiedRuntimeVersion).toBe(runtimeVersion);
      expect(rowAfterPromote?.lastVerifiedProviderModel).toBe(LIVE_ANTHROPIC_MODEL);

      const secondShadowId = `${serverId}@shadow-rollback`;
      await fetch(`${env.baseUrl}/v1/autonomy/mcp-servers/${encodeURIComponent(serverId)}/shadow`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          shadowVersionId: secondShadowId,
          runtimeVersion,
          providerModel: LIVE_ANTHROPIC_MODEL,
        }),
      });

      const failingCanaryRes = await fetch(`${env.baseUrl}/v1/autonomy/mcp-servers/${encodeURIComponent(serverId)}/canary`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ success: false }),
      });
      const failingCanaryJson = await failingCanaryRes.json() as McpActionEnvelope;
      expect(failingCanaryRes.status).toBe(200);
      expect(failingCanaryJson.data.server.canaryStats?.failureCount).toBeGreaterThanOrEqual(1);

      const rollbackRes = await fetch(`${env.baseUrl}/v1/autonomy/mcp-servers/${encodeURIComponent(serverId)}/rollback`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          runtimeVersion,
          providerModel: LIVE_ANTHROPIC_MODEL,
        }),
      });
      const rollbackJson = await rollbackRes.json() as McpActionEnvelope;
      expect(rollbackRes.status).toBe(200);
      expect(rollbackJson.ok).toBe(true);
      expect(rollbackJson.data.server.promotionChannel).toBe("rolled_back");
      expect(rollbackJson.data.status?.promotionChannel).toBe("rolled_back");

      const rowAfterRollback = readUpgradeStateRow(env.stateDir!, serverId);
      expect(rowAfterRollback?.promotionChannel).toBe("rolled_back");
      expect(rowAfterRollback?.compatibilityStatus).toBe("adaptation_required");
      expect(rowAfterRollback?.shadowVersionId).toBeNull();
      const rollbackStats = JSON.parse(rowAfterRollback?.canaryStatsJson ?? "{}") as { rollbackCount?: number };
      expect(rollbackStats.rollbackCount).toBeGreaterThanOrEqual(1);
    },
  );
});
