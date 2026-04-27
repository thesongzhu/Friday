// Shared helpers for the new long-term phases (Y..NN).
//
// Conventions:
// - Each helper is a thin wrapper over Friday's REST surface (no DB writes
//   directly), so phases stay declarative.
// - Each helper logs via util.log so its work shows up in the orchestrator log.
// - Helpers never persist secrets to disk; tokens stay in memory only.

import { api, authedApi, log, sleep, STATE_DIR, LOG_DIR } from "./util.mjs";
import { bootFriday, killFriday } from "./friday-process.mjs";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import Database from "better-sqlite3";

// ─── Tenant provisioning (HH multi-tenant isolation) ───
//
// Friday's single-admin design exposes user creation only via the
// multi-tenant security routes. provisionTenant creates a tenant and returns
// its identifier so the caller can drive cross-tenant isolation assertions.
export async function provisionTenant(ctx, displayName) {
  const slug = displayName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40);
  const create = await authedApi(ctx, "/v1/security/tenants", {
    method: "POST",
    body: JSON.stringify({ displayName, slug }),
  });
  if (!create.body?.ok) {
    throw new Error(`provisionTenant(${displayName}) failed: ${create.status} ${JSON.stringify(create.body).slice(0, 240)}`);
  }
  const tenantId = create.body?.data?.tenant?.id ?? create.body?.data?.id;
  log(`[helpers.provisionTenant] tenantId=${tenantId} displayName=${displayName}`);
  return { tenantId, displayName, slug };
}

// ─── Error injection (CC long-term self-heal) ───
//
// 6 deterministic failure patterns that flow through the agent runtime →
// learning pipeline → diagnosis → auto-fix surfaces. Each kind picks a
// different failure fingerprint so the learning_lessons table accumulates
// distinct rows.
const ERROR_INJECTION_PROMPTS = {
  provider_429: "Use the agent route to invoke a provider that we know is rate-limited; we want to capture a 429 incident.",
  mcp_disconnect: "Use the MCP tool 'definitely-disconnected-mcp-server' (it does not exist) to call any operation.",
  skill_timeout: "Use skill 'definitely-not-real-timeout-skill' with input {} and wait for it.",
  workflow_node_missing: "Run workflow 'definitely-missing-workflow-id-cc' which does not exist.",
  memory_backpressure: "Insert 1000 memory items in a tight loop into namespace 'cc-injection-burst' so the writer queue backs up.",
  agent_loop_budget_exceeded: "Open a chat session and ask the agent to recursively diagnose itself for 50 iterations using diagnosis tools.",
};
export async function injectError(ctx, kind, sessionPrefix = "cc") {
  const prompt = ERROR_INJECTION_PROMPTS[kind];
  if (!prompt) throw new Error(`injectError unknown kind: ${kind}`);
  const create = await authedApi(ctx, "/v1/sessions", {
    method: "POST",
    body: JSON.stringify({ channel: "stab", chatId: `${sessionPrefix}-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }),
  });
  const key = create.body?.data?.session?.key;
  if (!key) throw new Error(`injectError(${kind}) session create failed: ${JSON.stringify(create.body).slice(0, 240)}`);
  await authedApi(ctx, `/v1/sessions/${key}/messages`, {
    method: "POST",
    body: JSON.stringify({ role: "user", content: prompt }),
  });
  const r = await authedApi(ctx, `/v1/sessions/${key}/run`, {
    method: "POST",
    body: JSON.stringify({ useLastUserMessage: true }),
  });
  return { kind, sessionKey: key, runStatus: r.status, ok: r.body?.ok, reply: String(r.body?.data?.run?.finalResponse ?? "").slice(0, 240) };
}

// ─── State-dir snapshot/restore (LL backup/restore) ───
//
// rsync-equivalent copy that flushes the WAL first via a SQLite checkpoint
// so the snapshot is a consistent point-in-time. Without the checkpoint the
// destination friday.db could be missing recent committed rows.
export function snapshotStateDir(srcDir, dstDir) {
  if (!existsSync(srcDir)) throw new Error(`snapshotStateDir: srcDir ${srcDir} does not exist`);
  mkdirSync(dstDir, { recursive: true });
  // Best-effort WAL checkpoint so the snapshot is point-in-time consistent.
  try {
    if (existsSync(`${srcDir}/friday.db`)) {
      const db = new Database(`${srcDir}/friday.db`);
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();
    }
  } catch (err) {
    log(`[helpers.snapshotStateDir] WAL checkpoint skipped: ${err?.message || err}`);
  }
  // -a preserves perms, --delete clears stale dst files; trailing slash on src
  // copies CONTENTS rather than the directory itself.
  const result = spawnSync("rsync", ["-a", "--delete", `${srcDir}/`, `${dstDir}/`]);
  if (result.status !== 0) {
    throw new Error(`snapshotStateDir rsync failed exit=${result.status} stderr=${result.stderr?.toString().slice(0, 240)}`);
  }
  return { srcDir, dstDir, sizeBytes: dirSizeBytes(dstDir) };
}

function dirSizeBytes(dir) {
  let total = 0;
  try {
    for (const entry of readdirSync(dir)) {
      try { total += statSync(`${dir}/${entry}`).size ?? 0; } catch {}
    }
  } catch {}
  return total;
}

// ─── Boot a secondary Friday on a different port (LL / KK) ───
//
// Re-uses friday-process.bootFriday but lets phase code drive the lifecycle
// without manually wiring health-wait ports.
export async function bootSecondary({ stateDir, port, logName }) {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  return bootFriday({ stateDir, port, logName: logName ?? `friday-secondary-${port}.log` });
}

export async function killSecondary(pid) {
  return killFriday(pid);
}

// ─── Run metadata extraction (Y / FF) ───
//
// /v1/agent/runs/:runId/audit returns the curated event timeline. We pull the
// route_selected + completed events to compose `actualProviderKind`,
// `actualModel`, `actualSkillId`, `costUsd` for downstream assertions.
export async function runMetaForRun(ctx, runId) {
  const r = await authedApi(ctx, `/v1/agent/runs/${runId}/audit`);
  if (!r.body?.ok) {
    return { runId, ok: false, status: r.status, reason: r.body?.error?.message ?? "audit fetch failed" };
  }
  const events = r.body?.data?.events ?? [];
  const routeSelected = events.find((e) => e.eventName === "agent.run.route_selected");
  const completed = events.find((e) => e.eventName === "agent.run.completed");
  return {
    runId,
    ok: true,
    actualProviderKind: routeSelected?.payload?.providerKind,
    actualModel: routeSelected?.payload?.model,
    actualSkillId: completed?.payload?.skillId,
    costUsd: completed?.payload?.costUsd,
    inputTokens: completed?.payload?.inputTokens,
    outputTokens: completed?.payload?.outputTokens,
    eventCount: events.length,
  };
}

// ─── Skill-generator session polling (Y) ───
//
// Polls /v1/skills/generator/sessions/:id every 3 s until status indicates
// the draft is ready or the budget elapses. Returns the latest body so the
// caller can decide what to do (import / inspect / cancel).
export async function waitForGenerator(ctx, sessionId, maxMs = 5 * 60 * 1000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < maxMs) {
    const r = await authedApi(ctx, `/v1/skills/generator/sessions/${sessionId}`);
    last = r;
    const status = r.body?.data?.session?.status ?? r.body?.data?.status;
    const mode = r.body?.data?.session?.mode ?? r.body?.data?.mode;
    if (status === "ready" || mode === "draft" || mode === "ready") {
      return { sessionId, status, mode, body: r.body, waitedMs: Date.now() - start };
    }
    if (status === "failed" || status === "rejected") {
      return { sessionId, status, mode, body: r.body, waitedMs: Date.now() - start, terminal: true };
    }
    await sleep(3000);
  }
  return { sessionId, timedOut: true, lastBody: last?.body, waitedMs: maxMs };
}

// ─── Fake-fail provider creation (P / MM) ───
//
// Two flavors: "401" (existing P pattern, invalid API key) and "500"
// (unreachable host so the request errors out at the transport level).
// Both register with validateOnSave:false so creation itself succeeds.
export async function createFakeFailProvider(ctx, { kind, name, baseProviderKind = "deepseek" }) {
  const baseUrl = kind === "500"
    ? "http://127.0.0.1:65500" // nothing listens here; ECONNREFUSED
    : "https://api.deepseek.com";
  const apiKey = kind === "500"
    ? "sk-fake-overnight-mm-500" // pragma: allowlist secret
    : "sk-fake-overnight-mm-401-deliberately-invalid"; // pragma: allowlist secret
  const r = await authedApi(ctx, "/v1/providers", {
    method: "POST",
    body: JSON.stringify({
      kind: baseProviderKind,
      name: name ?? `fake-fail-${kind}-${Date.now()}`,
      baseUrl,
      api: "openai-completions",
      authMode: "bearer-token",
      apiKey,
      supportedModels: ["deepseek-v4-pro"],
      defaultModel: "deepseek-v4-pro",
      validateOnSave: false,
    }),
  });
  return {
    kind,
    status: r.status,
    id: r.body?.data?.id ?? r.body?.data?.profile?.id ?? r.body?.data?.provider?.id,
    body: r.body,
  };
}

// ─── Memory-export polling (lifted from Phase O so BB can reuse) ───
//
// Polls a directory for an exported file matching a namespace. Returns the
// first match path or null on timeout.
export async function waitForMemoryExport({ namespace, exportDir, maxMs = 90_000, log: logger = log }) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const dir = readdirSync(exportDir);
      const matches = dir.filter((f) => f.includes(namespace));
      if (matches.length > 0) return { found: `${exportDir}/${matches[0]}`, waitedMs: Date.now() - start };
    } catch (err) {
      logger(`[helpers.waitForMemoryExport] readdir error: ${err?.message || err}`);
    }
    await sleep(2000);
  }
  return { found: null, waitedMs: maxMs };
}

// ─── Dual-key helper: list verified providers ───
//
// Used by Wave 1 verification (and by phases that need embeddings via
// OpenAI while text routes via DeepSeek). Returns the verified provider ids
// so phases can pin requestedProviderId when they want to drive a specific
// provider.
export async function listVerifiedProviders(ctx) {
  const r = await authedApi(ctx, "/v1/providers");
  if (!r.body?.ok) return { verified: [], all: [], error: r.body };
  const items = r.body?.data?.items ?? [];
  const verified = items.filter((p) => p?.config?.validation?.status === "ok");
  return {
    all: items.map((p) => ({ id: p.id, kind: p.kind, validation: p?.config?.validation?.status })),
    verified: verified.map((p) => ({ id: p.id, kind: p.kind, baseUrl: p.baseUrl, defaultModel: p.defaultModel })),
  };
}
