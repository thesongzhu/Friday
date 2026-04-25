/**
 * Friday CLI — daily brief subcommands.
 *
 * Talks to a running Friday daemon via HTTP. Requires the hub to be running
 * (the CLI is a thin client — the brief pipeline lives in-process on the hub).
 *
 * Subcommands:
 *   friday brief now     [--window-start <iso>] [--window-end <iso>] [--json]
 *   friday brief status  [--json]
 *   friday brief replay  <runId> [--json]
 */

import { FridayDomainError } from "#errors";

import type {
  FridayBriefConfig,
  FridayBriefRunRecord,
} from "#brief";

// ─── Input shape ───

export interface FridayCliBriefCommandInput {
  briefSubcommand: "now" | "status" | "replay" | undefined;
  runIdArg: string | undefined;
  windowStartIso: string | undefined;
  windowEndIso: string | undefined;
  json: boolean;
  baseUrl: string;
}

// ─── Auth helper ───

interface FridayCliAuthEnvelope {
  ok: boolean;
  data?: { accessToken?: string };
  error?: { code?: string; message?: string };
}

function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    return parsed.hostname === "127.0.0.1"
      || parsed.hostname === "localhost"
      || parsed.hostname === "::1";
  } catch {
    return false;
  }
}

function createAccessTokenResolver(baseUrl: string): () => Promise<string | undefined> {
  const configured = process.env.FRIDAY_CLI_ACCESS_TOKEN?.trim()
    || process.env.FRIDAY_TUI_ACCESS_TOKEN?.trim()
    || undefined;
  const loopback = isLoopbackBaseUrl(baseUrl);
  let cached: string | undefined = configured;

  return async () => {
    if (cached) return cached;
    if (!loopback) return undefined;
    const response = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ local: true }),
    });
    const body = await response.json().catch(() => null) as FridayCliAuthEnvelope | null;
    if (!response.ok || body?.ok !== true || typeof body.data?.accessToken !== "string") {
      throw new FridayDomainError(
        typeof body?.error?.code === "string" ? body.error.code : "UNAUTHORIZED",
        typeof body?.error?.message === "string"
          ? body.error.message
          : `auth/login HTTP ${response.status}: ${response.statusText}`,
        { httpStatus: response.status },
      );
    }
    cached = body.data.accessToken;
    return cached;
  };
}

// ─── Generic envelope fetcher ───

interface FridayApiEnvelope<T> {
  ok?: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

async function fetchBriefApi<T>(params: {
  baseUrl: string;
  method: string;
  path: string;
  body?: unknown;
  getToken: () => Promise<string | undefined>;
}): Promise<T> {
  const url = `${params.baseUrl.replace(/\/+$/, "")}${params.path}`;
  const token = await params.getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: params.method,
      headers,
      body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
    });
  } catch (err) {
    throw new FridayDomainError(
      "NETWORK_ERROR",
      `Could not reach ${url} — is the Friday daemon running? (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const envelope = await response.json().catch(() => null) as FridayApiEnvelope<T> | null;
  if (!response.ok || envelope?.ok === false) {
    throw new FridayDomainError(
      typeof envelope?.error?.code === "string" ? envelope.error.code : "HTTP_ERROR",
      typeof envelope?.error?.message === "string"
        ? envelope.error.message
        : `${params.method} ${params.path} → HTTP ${response.status}: ${response.statusText}`,
      { httpStatus: response.status },
    );
  }
  if (envelope?.data === undefined) {
    throw new FridayDomainError(
      "MALFORMED_RESPONSE",
      `${params.method} ${params.path} returned no data envelope`,
    );
  }
  return envelope.data;
}

// ─── Output helpers ───

function printRunPlain(run: FridayBriefRunRecord): void {
  console.log(`Run ${run.id}`);
  console.log(`  trigger:  ${run.triggeredBy}`);
  console.log(`  status:   ${run.status}${run.skipReason ? ` (${run.skipReason})` : ""}`);
  console.log(`  window:   ${run.windowStartAt}  →  ${run.windowEndAt}`);
  console.log(`  created:  ${run.createdAt}`);
  console.log(`  updated:  ${run.updatedAt}`);
  if (run.language) console.log(`  language: ${run.language}`);
  if (run.audio) {
    const durationPart = run.audio.durationSec !== undefined ? `, ${run.audio.durationSec.toFixed(1)}s` : "";
    console.log(`  audio:    ${run.audio.provider}/${run.audio.voice} — ${run.audio.bytes} bytes${durationPart}`);
  }
  if (run.sourceResults.length > 0) {
    console.log("  sources:");
    for (const source of run.sourceResults) {
      const skip = source.skipped ? ` [skipped${source.skipReason ? `: ${source.skipReason}` : ""}]` : "";
      const err = source.error ? ` [error: ${source.error.code}]` : "";
      console.log(`    - ${source.source}: ${source.eventCount} events, ${source.durationMs}ms${skip}${err}`);
    }
  }
  if (run.deliveryAttempts.length > 0) {
    console.log("  delivery:");
    for (const attempt of run.deliveryAttempts) {
      const result = attempt.ok ? "ok" : `failed: ${attempt.error?.code ?? "unknown"}`;
      const audioPart = attempt.audioAttached ? " (audio)" : " (text only)";
      console.log(`    - ${attempt.channel} [#${attempt.order}]: ${result}${audioPart}`);
    }
  }
  if (run.error) {
    console.log(`  error:    ${run.error.code} — ${run.error.message}`);
  }
  if (run.transcript) {
    console.log("\n  --- transcript ---");
    console.log(indent(run.transcript, "  "));
  }
}

function printConfigPlain(config: FridayBriefConfig): void {
  console.log("Friday daily brief — configuration");
  console.log(`  enabled:         ${String(config.enabled)}`);
  console.log(`  schedule:        ${config.cronExpression} (${config.timezone})`);
  console.log(`  length:          ${config.length}`);
  console.log(`  language:        ${config.languageOverride && config.languageOverride.trim().length > 0 ? config.languageOverride : "auto"}`);
  console.log(`  include text:    ${String(config.includeTranscript)}`);
  console.log(`  tts provider:    ${config.tts.provider}`);
  console.log(`  fallback order:  ${config.fallbackOrder.join(" → ")}`);
  console.log("  sources:");
  for (const [kind, src] of Object.entries(config.sources)) {
    const flag = (src as { enabled?: boolean })?.enabled ?? false;
    console.log(`    - ${kind}: ${flag ? "on" : "off"}`);
  }
  console.log("  channels:");
  for (const [kind, ch] of Object.entries(config.channels)) {
    const flag = (ch as { enabled?: boolean })?.enabled ?? false;
    console.log(`    - ${kind}: ${flag ? "on" : "off"}`);
  }
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function printBriefUsage(): void {
  console.error(`Usage:
  friday brief now     [--window-start <iso>] [--window-end <iso>] [--json]
  friday brief status  [--json]
  friday brief replay  <runId> [--json]`);
}

// ─── Subcommand handlers ───

async function runBriefNow(input: FridayCliBriefCommandInput): Promise<void> {
  const getToken = createAccessTokenResolver(input.baseUrl);
  const body: Record<string, unknown> = { triggeredBy: "manual_cli" };
  if (input.windowStartIso) body.windowStartIso = input.windowStartIso;
  if (input.windowEndIso) body.windowEndIso = input.windowEndIso;

  const data = await fetchBriefApi<{ run: FridayBriefRunRecord }>({
    baseUrl: input.baseUrl,
    method: "POST",
    path: "/v1/brief/runs",
    body,
    getToken,
  });

  if (input.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  printRunPlain(data.run);

  if (data.run.status === "failed" || data.run.status === "skipped") {
    process.exitCode = 1;
  }
}

async function runBriefStatus(input: FridayCliBriefCommandInput): Promise<void> {
  const getToken = createAccessTokenResolver(input.baseUrl);
  const [configData, historyData] = await Promise.all([
    fetchBriefApi<{ config: FridayBriefConfig }>({
      baseUrl: input.baseUrl,
      method: "GET",
      path: "/v1/brief/config",
      getToken,
    }),
    fetchBriefApi<{ items: FridayBriefRunRecord[]; nextCursor?: string }>({
      baseUrl: input.baseUrl,
      method: "GET",
      path: "/v1/brief/runs?limit=5",
      getToken,
    }),
  ]);

  if (input.json) {
    console.log(JSON.stringify({ config: configData.config, recent: historyData.items }, null, 2));
    return;
  }

  printConfigPlain(configData.config);
  console.log("");
  if (historyData.items.length === 0) {
    console.log("Recent runs: (none yet)");
    return;
  }
  console.log(`Recent runs (${historyData.items.length}):`);
  for (const run of historyData.items) {
    const skip = run.skipReason ? ` (${run.skipReason})` : "";
    console.log(`  - ${run.id}  ${run.status}${skip}  ${run.createdAt}  [${run.triggeredBy}]`);
  }
}

async function runBriefReplay(input: FridayCliBriefCommandInput): Promise<void> {
  if (!input.runIdArg) {
    console.error("Error: friday brief replay requires a <runId> argument.");
    printBriefUsage();
    process.exitCode = 1;
    return;
  }
  const getToken = createAccessTokenResolver(input.baseUrl);

  const prior = await fetchBriefApi<{ run: FridayBriefRunRecord }>({
    baseUrl: input.baseUrl,
    method: "GET",
    path: `/v1/brief/runs/${encodeURIComponent(input.runIdArg)}`,
    getToken,
  });

  const data = await fetchBriefApi<{ run: FridayBriefRunRecord }>({
    baseUrl: input.baseUrl,
    method: "POST",
    path: "/v1/brief/runs",
    body: {
      triggeredBy: "replay",
      windowStartIso: prior.run.windowStartAt,
      windowEndIso: prior.run.windowEndAt,
    },
    getToken,
  });

  if (input.json) {
    console.log(JSON.stringify({ replayedFrom: prior.run.id, run: data.run }, null, 2));
    return;
  }
  console.log(`Replayed from ${prior.run.id}.`);
  printRunPlain(data.run);

  if (data.run.status === "failed" || data.run.status === "skipped") {
    process.exitCode = 1;
  }
}

// ─── Dispatcher ───

export async function cmdBrief(input: FridayCliBriefCommandInput): Promise<void> {
  try {
    switch (input.briefSubcommand) {
      case "now":
        await runBriefNow(input);
        return;
      case "status":
        await runBriefStatus(input);
        return;
      case "replay":
        await runBriefReplay(input);
        return;
      default:
        printBriefUsage();
        process.exitCode = 1;
        return;
    }
  } catch (err) {
    if (err instanceof FridayDomainError) {
      console.error(`Error [${err.code}]: ${err.message}`);
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
  }
}
