import { FridayDomainError } from "#errors";
import { spawn } from "node:child_process";

import { FRIDAY_VERSION } from "../../lib/version.js";
import type {
  FridayMcpAdapter,
  FridayMcpCallToolInput,
  FridayMcpCallToolResult,
  FridayMcpDiscoveryState,
  FridayMcpGetPromptInput,
  FridayMcpGetPromptResult,
  FridayMcpPromptDescriptor,
  FridayMcpReadResourceInput,
  FridayMcpReadResourceResult,
  FridayMcpResourceDescriptor,
  FridayMcpServerConfig,
  FridayMcpServerPolicy,
  FridayMcpServerState,
  FridayMcpToolDescriptor,
  FridayMcpTransport,
} from "./friday-mcp-adapter.types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const MAX_LIST_PAGES = 20;
const FRAME_SEPARATOR = Buffer.from("\r\n\r\n", "utf8");

type SpawnLike = typeof spawn;
type WarnLike = (message: string) => void;

interface CreateFridayMcpAdapterOptions {
  servers: FridayMcpServerConfig[];
  requestTimeoutMs?: number;
  spawnImpl?: SpawnLike;
  lazyDiscovery?: boolean;
}

interface JsonRpcResponseError {
  code: number;
  message: string;
  data?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  cleanupAbort?: () => void;
}

interface McpSession {
  request(
    method: string,
    params: unknown,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<unknown>;
  notify(method: string, params: unknown): void;
  close(): Promise<void>;
}

export const FRIDAY_MCP_ADAPTER_ERROR_CODES = {
  SERVER_NOT_CONFIGURED: "MCP_SERVER_NOT_CONFIGURED",
  CONFIG_INVALID: "MCP_CONFIG_INVALID",
  TRANSPORT_UNSUPPORTED: "MCP_TRANSPORT_UNSUPPORTED",
  TRANSPORT_ERROR: "MCP_TRANSPORT_ERROR",
  REQUEST_FAILED: "MCP_REQUEST_FAILED",
  POLICY_TOOL_FORBIDDEN: "MCP_POLICY_TOOL_FORBIDDEN",
  POLICY_RATE_LIMITED: "MCP_POLICY_RATE_LIMITED",
} as const;

type FridayMcpAdapterErrorCode =
  (typeof FRIDAY_MCP_ADAPTER_ERROR_CODES)[keyof typeof FRIDAY_MCP_ADAPTER_ERROR_CODES];

export interface FridayMcpAdapterError extends Error {
  code: FridayMcpAdapterErrorCode;
  routeId: string;
  correlationId: string;
  details?: Record<string, unknown>;
}

export function isFridayMcpAdapterError(error: unknown): error is FridayMcpAdapterError {
  if (!(error instanceof Error)) return false;
  const record = error as Partial<FridayMcpAdapterError>;
  return (
    typeof record.code === "string" &&
    typeof record.routeId === "string" &&
    typeof record.correlationId === "string"
  );
}

function createFridayMcpAdapterError(input: {
  code: FridayMcpAdapterErrorCode;
  message: string;
  routeId: string;
  correlationId: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}): FridayMcpAdapterError {
  const error = new Error(input.message, {
    cause: input.cause,
  }) as FridayMcpAdapterError;
  error.name = "FridayMcpAdapterError";
  error.code = input.code;
  error.routeId = input.routeId;
  error.correlationId = input.correlationId;
  if (input.details && Object.keys(input.details).length > 0) {
    error.details = input.details;
  }
  return error;
}

// ─── Env var security denylist ───

const FORBIDDEN_ENV_PREFIXES = [
  "LD_", // LD_PRELOAD, LD_LIBRARY_PATH
  "DYLD_", // macOS dynamic linker injection
  "_NSGet", // macOS internals
];

const FORBIDDEN_ENV_EXACT = new Set([
  "NODE_OPTIONS", // --require, --import injection
  "NODE_EXTRA_CA_CERTS", // CA certificate override
  "ELECTRON_RUN_AS_NODE",
  "BASH_ENV",
  "ENV", // sh ENV file
  "CDPATH",
  "PYTHONSTARTUP",
  "PERL5OPT",
  "RUBYOPT",
]);

export function isForbiddenEnvVar(key: string): boolean {
  const upper = key.toUpperCase();
  if (FORBIDDEN_ENV_EXACT.has(upper)) return true;
  return FORBIDDEN_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

// ─── Safe env for child processes ───

/**
 * Env var prefixes that are safe to forward to MCP child processes.
 * Everything else from the parent process.env is stripped to prevent
 * leaking Friday secrets (FRIDAY_TOKEN_SECRET, FRIDAY_MASTER_KEY,
 * provider API keys, etc.) to third-party MCP servers.
 */
const SAFE_ENV_PREFIXES = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_",
  "TERM", "COLORTERM", "TMPDIR", "TMP", "TEMP", "HOSTNAME",
  "XDG_", "DISPLAY", "WAYLAND_DISPLAY",
  // Node.js needs these for module resolution
  "NODE_PATH",
  // Common build tooling
  "npm_config_",
  "EDITOR", "VISUAL", "PAGER",
];

const SAFE_ENV_EXACT = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL",
  "LANG", "LANGUAGE",
  "TERM", "COLORTERM",
  "TMPDIR", "TMP", "TEMP",
  "HOSTNAME", "SHLVL",
  "DISPLAY", "WAYLAND_DISPLAY",
  "NODE_PATH",
  "EDITOR", "VISUAL", "PAGER",
  "PWD", "OLDPWD",
  "SYSTEMROOT", "COMSPEC", // Windows essentials
]);

function isSafeEnvVar(key: string): boolean {
  if (SAFE_ENV_EXACT.has(key)) return true;
  return SAFE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Build a safe environment for MCP child processes by only forwarding
 * standard system variables from process.env. Friday-specific secrets
 * and provider API keys are excluded.
 */
export function buildSafeChildEnv(
  overrides?: Record<string, string>,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && isSafeEnvVar(key) && !isForbiddenEnvVar(key)) {
      safe[key] = value;
    }
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (!isForbiddenEnvVar(key)) {
        safe[key] = value;
      }
    }
  }
  return safe;
}

export function parseFridayMcpServersFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  warn: WarnLike = (message) => console.warn(message),
): FridayMcpServerConfig[] {
  const raw = env.FRIDAY_MCP_SERVERS;
  if (!raw || raw.trim() === "") {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warn(`[friday] WARNING: FRIDAY_MCP_SERVERS is not valid JSON; MCP adapter disabled: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  if (!Array.isArray(parsed)) {
    warn("[friday] WARNING: FRIDAY_MCP_SERVERS must be a JSON array; MCP adapter disabled.");
    return [];
  }

  const servers: FridayMcpServerConfig[] = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const entry = parsed[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      warn(`[friday] WARNING: FRIDAY_MCP_SERVERS[${String(index)}] is not an object; skipping.`);
      continue;
    }

    const row = entry as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (id.length === 0) {
      warn(`[friday] WARNING: FRIDAY_MCP_SERVERS[${String(index)}] requires non-empty id; skipping.`);
      continue;
    }

    const transport = detectTransport(row, index, warn);
    const timeoutMs = parsePositiveNumber(row.timeoutMs);
    const policy = parseServerPolicy(row, index, warn);

    if (transport === "http") {
      const url = typeof row.url === "string" ? row.url.trim() : "";
      if (!url) {
        warn(`[friday] WARNING: FRIDAY_MCP_SERVERS[${String(index)}] with transport=http requires url; skipping.`);
        continue;
      }

      const headers = parseHeaders(row.headers);
      servers.push({
        id,
        transport,
        url,
        ...(headers ? { headers } : {}),
        ...(policy ? { policy } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
      });
      continue;
    }

    const command = typeof row.command === "string" ? row.command.trim() : "";
    if (command.length === 0) {
      warn(`[friday] WARNING: FRIDAY_MCP_SERVERS[${String(index)}] requires non-empty command for stdio transport; skipping.`);
      continue;
    }

    const args = Array.isArray(row.args)
      ? row.args.filter((value): value is string => typeof value === "string")
      : undefined;
    const cwd = typeof row.cwd === "string" && row.cwd.trim() !== ""
      ? row.cwd.trim()
      : undefined;

    let envOverrides: Record<string, string> | undefined;
    if (row.env && typeof row.env === "object" && !Array.isArray(row.env)) {
      const copied: Record<string, string> = {};
      for (const [key, value] of Object.entries(row.env as Record<string, unknown>)) {
        if (typeof value !== "string") continue;

        // Security: reject dangerous environment variables that could inject
        // code into child processes (LD_PRELOAD, NODE_OPTIONS, DYLD_*, etc.)
        if (isForbiddenEnvVar(key)) {
          warn(`[friday] WARNING: FRIDAY_MCP_SERVERS[${String(index)}] env key '${key}' is forbidden for security reasons; skipping.`);
          continue;
        }
        copied[key] = value;
      }
      if (Object.keys(copied).length > 0) {
        envOverrides = copied;
      }
    }

    servers.push({
      id,
      transport,
      command,
      ...(args && args.length > 0 ? { args } : {}),
      ...(cwd ? { cwd } : {}),
      ...(envOverrides ? { env: envOverrides } : {}),
      ...(policy ? { policy } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    });
  }

  return servers;
}

export function createFridayMcpAdapter(
  options: CreateFridayMcpAdapterOptions,
): FridayMcpAdapter {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const spawnImpl = options.spawnImpl ?? spawn;
  const lazyDiscovery = options.lazyDiscovery ?? true;
  const servers = dedupeServers(options.servers);
  const serverById = new Map(servers.map((server) => [server.id, server]));
  const rateLimitWindows = new Map<string, number[]>();
  const serverStateCache = new Map<string, FridayMcpServerState>(
    servers.map((server) => [
      server.id,
      {
        serverId: server.id,
        transport: server.transport ?? "stdio",
        state: lazyDiscovery ? "deferred" : "configured",
        lazyDiscovery,
      } satisfies FridayMcpServerState,
    ]),
  );

  function markServerState(
    serverId: string,
    nextState: FridayMcpDiscoveryState,
    extras?: Partial<FridayMcpServerState>,
  ): void {
    const previous = serverStateCache.get(serverId) ?? {
      serverId,
      transport: "stdio" as FridayMcpTransport,
      state: lazyDiscovery ? "deferred" : "configured",
      lazyDiscovery,
    };
    serverStateCache.set(serverId, {
      ...previous,
      ...extras,
      state: nextState,
    });
  }

  return {
    listServers(): readonly FridayMcpServerConfig[] {
      return servers;
    },

    listServerStates(): readonly FridayMcpServerState[] {
      return servers.map((server) =>
        serverStateCache.get(server.id) ?? {
          serverId: server.id,
          transport: server.transport ?? "stdio",
          state: lazyDiscovery ? "deferred" : "configured",
          lazyDiscovery,
        });
    },

    async listTools(input): Promise<FridayMcpToolDescriptor[]> {
      const routeId = "mcp.adapter.tools.list";
      const targets = input?.serverId
        ? [requireServer(serverById, input.serverId, routeId)]
        : servers;

      const collected: FridayMcpToolDescriptor[] = [];
      for (const server of targets) {
        markServerState(server.id, "discoverable");
        const correlationId = nextCorrelationId(server.id, "tools.list");
        const tools = await withMcpSession({
          server,
          signal: input?.signal,
          spawnImpl,
          requestTimeoutMs,
          correlationId,
          routeId,
          run: async (session) => {
            const items: FridayMcpToolDescriptor[] = [];
            let cursor: string | undefined;

            for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
              const params = cursor ? { cursor } : {};
              const raw = await session.request("tools/list", params, {
                signal: input?.signal,
                timeoutMs: server.timeoutMs ?? requestTimeoutMs,
              });
              const pageResult = normalizeRecord(raw);
              const rawTools = Array.isArray(pageResult.tools) ? pageResult.tools : [];
              for (const rawTool of rawTools) {
                const descriptor = toToolDescriptor(server.id, rawTool);
                if (descriptor) {
                  items.push(descriptor);
                }
              }

              const nextCursor = toNextCursor(pageResult);
              if (!nextCursor) break;
              cursor = nextCursor;
            }

            return items;
          },
        });

        const filtered = applyToolAllowlist(server.policy, tools);
        markServerState(server.id, "loaded", {
          toolCount: filtered.length,
          lastLoadedAt: new Date().toISOString(),
        });
        collected.push(...filtered);
      }

      return collected;
    },

    async searchTools(input): Promise<FridayMcpToolDescriptor[]> {
      const query = input.query.trim().toLowerCase();
      const tools = await this.listTools({
        serverId: input.serverId,
        signal: input.signal,
      });
      if (query.length === 0) {
        return tools;
      }
      return tools.filter((tool) =>
        tool.name.toLowerCase().includes(query)
        || (tool.description ?? "").toLowerCase().includes(query),
      );
    },

    async callTool(input: FridayMcpCallToolInput): Promise<FridayMcpCallToolResult> {
      const routeId = "mcp.adapter.tools.call";
      const server = requireServer(serverById, input.serverId, routeId);
      const correlationId = nextCorrelationId(server.id, `tools.call.${input.toolName}`);

      markServerState(server.id, "discoverable");
      enforceToolAllowlist(server, input.toolName, routeId, correlationId);
      enforceRateLimit(server, input.toolName, rateLimitWindows, routeId, correlationId);

      const result = await withMcpSession({
        server,
        signal: input.signal,
        spawnImpl,
        requestTimeoutMs,
        correlationId,
        routeId,
        run: async (session) => {
          const raw = await session.request(
            "tools/call",
            {
              name: input.toolName,
              arguments: input.args ?? {},
            },
            {
              signal: input.signal,
              timeoutMs: server.timeoutMs ?? requestTimeoutMs,
            },
          );
          const rawResult = normalizeRecord(raw);
          return {
            content: extractMcpContent(rawResult),
            isError: rawResult.isError === true,
            raw,
          };
        },
      });
      markServerState(server.id, "loaded", {
        lastLoadedAt: new Date().toISOString(),
      });
      return result;
    },

    async listResources(input): Promise<FridayMcpResourceDescriptor[]> {
      const routeId = "mcp.adapter.resources.list";
      const targets = input?.serverId
        ? [requireServer(serverById, input.serverId, routeId)]
        : servers;

      const collected: FridayMcpResourceDescriptor[] = [];
      for (const server of targets) {
        markServerState(server.id, "discoverable");
        const correlationId = nextCorrelationId(server.id, "resources.list");
        const resources = await withMcpSession({
          server,
          signal: input?.signal,
          spawnImpl,
          requestTimeoutMs,
          correlationId,
          routeId,
          run: async (session) => {
            const items: FridayMcpResourceDescriptor[] = [];
            let cursor: string | undefined;

            for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
              const params = cursor ? { cursor } : {};
              const raw = await session.request("resources/list", params, {
                signal: input?.signal,
                timeoutMs: server.timeoutMs ?? requestTimeoutMs,
              });
              const pageResult = normalizeRecord(raw);
              const rawResources = Array.isArray(pageResult.resources) ? pageResult.resources : [];
              for (const rawResource of rawResources) {
                const descriptor = toResourceDescriptor(server.id, rawResource);
                if (descriptor) {
                  items.push(descriptor);
                }
              }

              const nextCursor = toNextCursor(pageResult);
              if (!nextCursor) break;
              cursor = nextCursor;
            }

            return items;
          },
        });

        markServerState(server.id, "loaded", {
          resourceCount: resources.length,
          lastLoadedAt: new Date().toISOString(),
        });
        collected.push(...resources);
      }

      return collected;
    },

    async readResource(input: FridayMcpReadResourceInput): Promise<FridayMcpReadResourceResult> {
      const routeId = "mcp.adapter.resources.read";
      const server = requireServer(serverById, input.serverId, routeId);
      const correlationId = nextCorrelationId(server.id, "resources.read");

      markServerState(server.id, "discoverable");
      const result = await withMcpSession({
        server,
        signal: input.signal,
        spawnImpl,
        requestTimeoutMs,
        correlationId,
        routeId,
        run: async (session) => {
          const raw = await session.request(
            "resources/read",
            { uri: input.uri },
            {
              signal: input.signal,
              timeoutMs: server.timeoutMs ?? requestTimeoutMs,
            },
          );

          const rawResult = normalizeRecord(raw);
          return {
            content: extractMcpResourceContent(rawResult),
            raw,
          };
        },
      });
      markServerState(server.id, "loaded", {
        lastLoadedAt: new Date().toISOString(),
      });
      return result;
    },

    async listPrompts(input): Promise<FridayMcpPromptDescriptor[]> {
      const routeId = "mcp.adapter.prompts.list";
      const targets = input?.serverId
        ? [requireServer(serverById, input.serverId, routeId)]
        : servers;

      const collected: FridayMcpPromptDescriptor[] = [];
      for (const server of targets) {
        markServerState(server.id, "discoverable");
        const correlationId = nextCorrelationId(server.id, "prompts.list");
        const prompts = await withMcpSession({
          server,
          signal: input?.signal,
          spawnImpl,
          requestTimeoutMs,
          correlationId,
          routeId,
          run: async (session) => {
            const items: FridayMcpPromptDescriptor[] = [];
            let cursor: string | undefined;

            for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
              const params = cursor ? { cursor } : {};
              const raw = await session.request("prompts/list", params, {
                signal: input?.signal,
                timeoutMs: server.timeoutMs ?? requestTimeoutMs,
              });
              const pageResult = normalizeRecord(raw);
              const rawPrompts = Array.isArray(pageResult.prompts) ? pageResult.prompts : [];
              for (const rawPrompt of rawPrompts) {
                const descriptor = toPromptDescriptor(server.id, rawPrompt);
                if (descriptor) {
                  items.push(descriptor);
                }
              }

              const nextCursor = toNextCursor(pageResult);
              if (!nextCursor) break;
              cursor = nextCursor;
            }

            return items;
          },
        });

        markServerState(server.id, "loaded", {
          promptCount: prompts.length,
          lastLoadedAt: new Date().toISOString(),
        });
        collected.push(...prompts);
      }

      return collected;
    },

    async getPrompt(input: FridayMcpGetPromptInput): Promise<FridayMcpGetPromptResult> {
      const routeId = "mcp.adapter.prompts.get";
      const server = requireServer(serverById, input.serverId, routeId);
      const correlationId = nextCorrelationId(server.id, `prompts.get.${input.name}`);

      markServerState(server.id, "discoverable");
      const result = await withMcpSession({
        server,
        signal: input.signal,
        spawnImpl,
        requestTimeoutMs,
        correlationId,
        routeId,
        run: async (session) => {
          const raw = await session.request(
            "prompts/get",
            {
              name: input.name,
              arguments: input.args ?? {},
            },
            {
              signal: input.signal,
              timeoutMs: server.timeoutMs ?? requestTimeoutMs,
            },
          );

          const rawResult = normalizeRecord(raw);
          return {
            content: extractMcpPromptContent(rawResult),
            raw,
          };
        },
      });
      markServerState(server.id, "loaded", {
        lastLoadedAt: new Date().toISOString(),
      });
      return result;
    },
  };
}

function dedupeServers(input: FridayMcpServerConfig[]): FridayMcpServerConfig[] {
  const seen = new Set<string>();
  const output: FridayMcpServerConfig[] = [];
  for (const rawServer of input) {
    const server = normalizeServerConfig(rawServer);
    if (!server) continue;
    if (seen.has(server.id)) continue;
    seen.add(server.id);
    output.push(server);
  }
  return output;
}

function normalizeServerConfig(server: FridayMcpServerConfig): FridayMcpServerConfig | null {
  const id = server.id.trim();
  if (!id) return null;

  const transport = server.transport === "http" ? "http" : "stdio";
  const timeoutMs = parsePositiveNumber(server.timeoutMs);
  const policy = normalizeServerPolicy(server.policy);

  if (transport === "http") {
    const url = typeof server.url === "string" ? server.url.trim() : "";
    if (!url) return null;
    const headers = normalizeStringRecord(server.headers);
    return {
      id,
      transport,
      url,
      ...(headers ? { headers } : {}),
      ...(policy ? { policy } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    };
  }

  const command = typeof server.command === "string" ? server.command.trim() : "";
  if (!command) return null;

  const args = Array.isArray(server.args)
    ? server.args.filter((value): value is string => typeof value === "string")
    : undefined;
  const cwd = typeof server.cwd === "string" && server.cwd.trim() !== ""
    ? server.cwd.trim()
    : undefined;
  const env = normalizeStringRecord(server.env);

  return {
    id,
    transport,
    command,
    ...(args && args.length > 0 ? { args } : {}),
    ...(cwd ? { cwd } : {}),
    ...(env ? { env } : {}),
    ...(policy ? { policy } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  };
}

function normalizeServerPolicy(policy: FridayMcpServerPolicy | undefined): FridayMcpServerPolicy | undefined {
  if (!policy) return undefined;

  const toolAllowlist = Array.isArray(policy.toolAllowlist)
    ? policy.toolAllowlist
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
    : undefined;

  const maxCalls = parsePositiveNumber(policy.rateLimit?.maxCalls);
  const windowMs = parsePositiveNumber(policy.rateLimit?.windowMs);
  const rateLimit = maxCalls && windowMs
    ? { maxCalls, windowMs }
    : undefined;

  if ((!toolAllowlist || toolAllowlist.length === 0) && !rateLimit) {
    return undefined;
  }

  return {
    ...(toolAllowlist && toolAllowlist.length > 0 ? { toolAllowlist } : {}),
    ...(rateLimit ? { rateLimit } : {}),
  };
}

function parseServerPolicy(
  row: Record<string, unknown>,
  index: number,
  warn: WarnLike,
): FridayMcpServerPolicy | undefined {
  let policyRow: Record<string, unknown> = {};
  if (row.policy && typeof row.policy === "object" && !Array.isArray(row.policy)) {
    policyRow = row.policy as Record<string, unknown>;
  }

  const allowlistRaw = policyRow.toolAllowlist ?? row.allowTools;
  const toolAllowlist = Array.isArray(allowlistRaw)
    ? allowlistRaw
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
    : undefined;

  const rateLimitRaw = policyRow.rateLimit ?? row.rateLimit;
  let rateLimit: { maxCalls: number; windowMs: number } | undefined;
  if (rateLimitRaw !== undefined) {
    if (rateLimitRaw && typeof rateLimitRaw === "object" && !Array.isArray(rateLimitRaw)) {
      const obj = rateLimitRaw as Record<string, unknown>;
      const maxCalls = parsePositiveNumber(obj.maxCalls);
      const windowMs = parsePositiveNumber(obj.windowMs);
      if (maxCalls && windowMs) {
        rateLimit = { maxCalls, windowMs };
      } else {
        warn(`[friday] WARNING: FRIDAY_MCP_SERVERS[${String(index)}] rateLimit requires positive maxCalls and windowMs; ignoring.`);
      }
    } else {
      warn(`[friday] WARNING: FRIDAY_MCP_SERVERS[${String(index)}] rateLimit must be an object; ignoring.`);
    }
  }

  if ((!toolAllowlist || toolAllowlist.length === 0) && !rateLimit) {
    return undefined;
  }

  return {
    ...(toolAllowlist && toolAllowlist.length > 0 ? { toolAllowlist } : {}),
    ...(rateLimit ? { rateLimit } : {}),
  };
}

function parseHeaders(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const headerName = key.trim();
    if (!headerName) continue;
    output[headerName] = value;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function parsePositiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function normalizeStringRecord(input: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!input) return undefined;
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") continue;
    const nextKey = key.trim();
    if (!nextKey) continue;
    output[nextKey] = value;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function detectTransport(
  row: Record<string, unknown>,
  index: number,
  warn: WarnLike,
): FridayMcpTransport {
  const rawTransport = typeof row.transport === "string"
    ? row.transport.trim().toLowerCase()
    : "";

  if (!rawTransport) {
    if (typeof row.url === "string" && row.url.trim() !== "" && !row.command) {
      return "http";
    }
    return "stdio";
  }

  if (rawTransport === "stdio" || rawTransport === "http") {
    return rawTransport;
  }

  warn(`[friday] WARNING: FRIDAY_MCP_SERVERS[${String(index)}] has unsupported transport '${rawTransport}', fallback to stdio.`);
  return "stdio";
}

function requireServer(
  serverById: Map<string, FridayMcpServerConfig>,
  serverId: string,
  routeId: string,
): FridayMcpServerConfig {
  const found = serverById.get(serverId);
  if (!found) {
    throw createFridayMcpAdapterError({
      code: FRIDAY_MCP_ADAPTER_ERROR_CODES.SERVER_NOT_CONFIGURED,
      message: `MCP server '${serverId}' is not configured`,
      routeId,
      correlationId: `${serverId}:missing`,
      details: { serverId },
    });
  }
  return found;
}

function nextCorrelationId(serverId: string, operation: string): string {
  return `${serverId}:${operation}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

function enforceToolAllowlist(
  server: FridayMcpServerConfig,
  toolName: string,
  routeId: string,
  correlationId: string,
): void {
  const allowlist = server.policy?.toolAllowlist;
  if (!allowlist || allowlist.length === 0) return;
  if (allowlist.includes(toolName)) return;

  throw createFridayMcpAdapterError({
    code: FRIDAY_MCP_ADAPTER_ERROR_CODES.POLICY_TOOL_FORBIDDEN,
    message: `MCP tool '${toolName}' is not allowed on server '${server.id}'`,
    routeId,
    correlationId,
    details: {
      serverId: server.id,
      toolName,
      allowlist,
    },
  });
}

function applyToolAllowlist(
  policy: FridayMcpServerPolicy | undefined,
  tools: FridayMcpToolDescriptor[],
): FridayMcpToolDescriptor[] {
  const allowlist = policy?.toolAllowlist;
  if (!allowlist || allowlist.length === 0) {
    return tools;
  }
  return tools.filter((tool) => allowlist.includes(tool.name));
}

function enforceRateLimit(
  server: FridayMcpServerConfig,
  toolName: string,
  windows: Map<string, number[]>,
  routeId: string,
  correlationId: string,
): void {
  const policy = server.policy?.rateLimit;
  if (!policy) return;

  const key = `${server.id}:${toolName}`;
  const now = Date.now();
  const oldest = now - policy.windowMs;
  const timeline = (windows.get(key) ?? []).filter((ts) => ts >= oldest);
  if (timeline.length >= policy.maxCalls) {
    // Store pruned timeline even on rejection to avoid stale entries
    windows.set(key, timeline);
    throw createFridayMcpAdapterError({
      code: FRIDAY_MCP_ADAPTER_ERROR_CODES.POLICY_RATE_LIMITED,
      message: `MCP tool '${toolName}' on server '${server.id}' exceeded local rate limit (${String(policy.maxCalls)} calls/${String(policy.windowMs)}ms)`,
      routeId,
      correlationId,
      details: {
        serverId: server.id,
        toolName,
        maxCalls: policy.maxCalls,
        windowMs: policy.windowMs,
      },
    });
  }

  timeline.push(now);
  windows.set(key, timeline);

  // Prune entries for tools that have gone idle (all timestamps expired).
  // Runs opportunistically on each call to avoid unbounded map growth.
  if (windows.size > 100) {
    for (const [k, ts] of windows) {
      if (k === key) continue;
      if (ts.length === 0 || ts.every((t) => t < oldest)) {
        windows.delete(k);
      }
    }
  }
}

async function withMcpSession<T>(params: {
  server: FridayMcpServerConfig;
  signal?: AbortSignal;
  spawnImpl: SpawnLike;
  requestTimeoutMs: number;
  routeId: string;
  correlationId: string;
  run: (session: McpSession) => Promise<T>;
}): Promise<T> {
  const session = createTransportSession({
    server: params.server,
    spawnImpl: params.spawnImpl,
    requestTimeoutMs: params.requestTimeoutMs,
    routeId: params.routeId,
    correlationId: params.correlationId,
  });

  try {
    await session.request(
      "initialize",
      {
        protocolVersion: DEFAULT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "friday", version: FRIDAY_VERSION },
      },
      {
        signal: params.signal,
        timeoutMs: params.server.timeoutMs ?? params.requestTimeoutMs,
      },
    );
    session.notify("notifications/initialized", {});
    return await params.run(session);
  } catch (error) {
    throw wrapMcpError(error, {
      routeId: params.routeId,
      correlationId: params.correlationId,
      serverId: params.server.id,
      transport: params.server.transport ?? "stdio",
    });
  } finally {
    await session.close();
  }
}

function wrapMcpError(
  error: unknown,
  context: {
    routeId: string;
    correlationId: string;
    serverId: string;
    transport: FridayMcpTransport;
  },
): FridayMcpAdapterError {
  if (isFridayMcpAdapterError(error)) return error;
  return createFridayMcpAdapterError({
    code: FRIDAY_MCP_ADAPTER_ERROR_CODES.REQUEST_FAILED,
    message: toError(error).message,
    routeId: context.routeId,
    correlationId: context.correlationId,
    details: {
      serverId: context.serverId,
      transport: context.transport,
    },
    cause: error,
  });
}

function createTransportSession(params: {
  server: FridayMcpServerConfig;
  spawnImpl: SpawnLike;
  requestTimeoutMs: number;
  routeId: string;
  correlationId: string;
}): McpSession {
  const transport = params.server.transport ?? "stdio";
  if (transport === "stdio") {
    return createStdioMcpSession(params);
  }
  if (transport === "http") {
    return createHttpMcpSession(params);
  }

  throw createFridayMcpAdapterError({
    code: FRIDAY_MCP_ADAPTER_ERROR_CODES.TRANSPORT_UNSUPPORTED,
    message: `Unsupported MCP transport '${String(transport)}'`,
    routeId: params.routeId,
    correlationId: params.correlationId,
    details: {
      serverId: params.server.id,
      transport,
    },
  });
}

function createHttpMcpSession(params: {
  server: FridayMcpServerConfig;
  requestTimeoutMs: number;
  routeId: string;
  correlationId: string;
}): McpSession {
  const url = typeof params.server.url === "string" ? params.server.url.trim() : "";
  if (!url) {
    throw createFridayMcpAdapterError({
      code: FRIDAY_MCP_ADAPTER_ERROR_CODES.CONFIG_INVALID,
      message: `MCP server '${params.server.id}' requires a URL for http transport`,
      routeId: params.routeId,
      correlationId: params.correlationId,
      details: { serverId: params.server.id, transport: "http" },
    });
  }

  let nextId = 1;
  let closed = false;

  return {
    async request(method, requestParams, options): Promise<unknown> {
      if (closed) {
        throw new FridayDomainError("NOT_INITIALIZED", `MCP session is closed for server '${params.server.id}'`, { httpStatus: 503 });
      }

      const id = nextId;
      nextId += 1;

      const payload = {
        jsonrpc: "2.0",
        id,
        method,
        params: requestParams,
      };

      const response = await sendHttpRpc(payload, {
        url,
        headers: params.server.headers,
        timeoutMs: options?.timeoutMs ?? params.server.timeoutMs ?? params.requestTimeoutMs,
        signal: options?.signal,
      });

      const message = normalizeRecord(response);
      if (Object.prototype.hasOwnProperty.call(message, "error")) {
        const rpcError = normalizeRpcError(message.error);
        throw new FridayDomainError("INTERNAL_ERROR", `MCP error ${String(rpcError.code)}: ${rpcError.message}`, { httpStatus: 500 });
      }

      return message.result;
    },

    notify(method, requestParams): void {
      if (closed) return;

      const payload = {
        jsonrpc: "2.0",
        method,
        params: requestParams,
      };

      void sendHttpRpc(payload, {
        url,
        headers: params.server.headers,
        timeoutMs: params.server.timeoutMs ?? params.requestTimeoutMs,
      }).catch(() => {
        // Best-effort notification only.
      });
    },

    async close(): Promise<void> {
      closed = true;
    },
  };
}

async function sendHttpRpc(
  payload: Record<string, unknown>,
  input: {
    url: string;
    headers?: Record<string, string>;
    timeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<unknown> {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => {
    timeoutController.abort(new Error("MCP HTTP request timed out"));
  }, input.timeoutMs);

  let cleanupAbort: (() => void) | undefined;
  if (input.signal) {
    if (input.signal.aborted) {
      clearTimeout(timeout);
      throw new FridayDomainError("INTERNAL_ERROR", "MCP HTTP request aborted", { httpStatus: 500 });
    }
    const onAbort = () => timeoutController.abort(input.signal?.reason);
    input.signal.addEventListener("abort", onAbort, { once: true });
    cleanupAbort = () => input.signal?.removeEventListener("abort", onAbort);
  }

  try {
    const response = await fetch(input.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(input.headers ?? {}),
      },
      body: JSON.stringify(payload),
      signal: timeoutController.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new FridayDomainError("INTERNAL_ERROR", `MCP HTTP ${String(response.status)} ${response.statusText}${body ? `: ${body}` : ""}`, { httpStatus: 500 });
    }

    const rawText = await response.text();
    if (!rawText.trim()) {
      return {};
    }

    try {
      return JSON.parse(rawText);
    } catch (err) {
      console.warn("[friday][mcp-adapter] parse-http-response:", err instanceof Error ? err.message : String(err));
      throw new FridayDomainError("INTERNAL_ERROR", "MCP HTTP response is not valid JSON", { httpStatus: 500 });
    }
  } catch (error) {
    throw toError(error);
  } finally {
    clearTimeout(timeout);
    cleanupAbort?.();
  }
}

function createStdioMcpSession(params: {
  server: FridayMcpServerConfig;
  spawnImpl: SpawnLike;
  requestTimeoutMs: number;
  routeId: string;
  correlationId: string;
}): McpSession {
  const command = typeof params.server.command === "string"
    ? params.server.command.trim()
    : "";
  if (!command) {
    throw createFridayMcpAdapterError({
      code: FRIDAY_MCP_ADAPTER_ERROR_CODES.CONFIG_INVALID,
      message: `MCP server '${params.server.id}' requires command for stdio transport`,
      routeId: params.routeId,
      correlationId: params.correlationId,
      details: {
        serverId: params.server.id,
        transport: "stdio",
      },
    });
  }

  const child = params.spawnImpl(command, params.server.args ?? [], {
    cwd: params.server.cwd,
    env: buildSafeChildEnv(params.server.env),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let nextId = 1;
  let isClosed = false;
  let stderrTail = "";
  const pending = new Map<string, PendingRequest>();

  const exitPromise = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });

  child.stdout.on("data", (chunk: Uint8Array) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    try {
      for (const message of decodeFrames(() => buffer, (next) => { buffer = next; })) {
        handleInboundMessage(message);
      }
    } catch (error) {
      failSession(toError(error));
    }
  });

  child.stderr.on("data", (chunk: Uint8Array) => {
    stderrTail = `${stderrTail}${Buffer.from(chunk).toString("utf8")}`;
    if (stderrTail.length > 4_000) {
      stderrTail = stderrTail.slice(-4_000);
    }
  });

  child.on("error", (error) => {
    failSession(error instanceof Error ? error : new Error(String(error)));
  });

  child.on("exit", (code, signal) => {
    const reason = new Error(
      `MCP server '${params.server.id}' exited` +
      ` (code=${String(code)}, signal=${String(signal)})` +
      (stderrTail.trim() ? `: ${stderrTail.trim()}` : ""),
    );
    failSession(reason);
  });

  return {
    async request(method, requestParams, options): Promise<unknown> {
      if (isClosed) {
        throw new FridayDomainError("NOT_INITIALIZED", `MCP session is closed for server '${params.server.id}'`, { httpStatus: 503 });
      }

      const id = nextId;
      nextId += 1;
      const key = String(id);
      const timeoutMs = options?.timeoutMs ?? params.server.timeoutMs ?? params.requestTimeoutMs;

      return new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(key);
          reject(new Error(`MCP request timed out: ${method}`));
        }, timeoutMs);

        let cleanupAbort: (() => void) | undefined;
        if (options?.signal) {
          if (options.signal.aborted) {
            clearTimeout(timeout);
            reject(new Error(`MCP request aborted: ${method}`));
            return;
          }
          const onAbort = () => {
            pending.delete(key);
            clearTimeout(timeout);
            reject(new Error(`MCP request aborted: ${method}`));
          };
          options.signal.addEventListener("abort", onAbort, { once: true });
          cleanupAbort = () => options.signal?.removeEventListener("abort", onAbort);
        }

        pending.set(key, {
          resolve,
          reject,
          timeout,
          cleanupAbort,
        });

        try {
          writeFrame(
            child.stdin,
            {
              jsonrpc: "2.0",
              id,
              method,
              params: requestParams,
            },
          );
        } catch (error) {
          pending.delete(key);
          clearTimeout(timeout);
          cleanupAbort?.();
          reject(toError(error));
        }
      });
    },

    notify(method, requestParams): void {
      if (isClosed) {
        return;
      }
      try {
        writeFrame(
          child.stdin,
          {
            jsonrpc: "2.0",
            method,
            params: requestParams,
          },
        );
      } catch (err) {
        // Best-effort notification only.
        console.warn("[friday][mcp-adapter] send-notification:", err instanceof Error ? err.message : String(err));
      }
    },

    async close(): Promise<void> {
      if (isClosed) {
        return;
      }

      try {
        writeFrame(
          child.stdin,
          {
            jsonrpc: "2.0",
            method: "exit",
            params: {},
          },
        );
      } catch (err) {
        // ignore
        console.warn("[friday][mcp-adapter] write-exit-frame:", err instanceof Error ? err.message : String(err));
      }

      try {
        child.stdin.end();
      } catch (err) {
        // ignore
        console.warn("[friday][mcp-adapter] end-stdin:", err instanceof Error ? err.message : String(err));
      }

      await Promise.race([
        exitPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
      ]);

      if (!isClosed) {
        try {
          child.kill("SIGTERM");
        } catch (err) {
          // ignore
          console.warn("[friday][mcp-adapter] kill-sigterm:", err instanceof Error ? err.message : String(err));
        }
        await Promise.race([
          exitPromise,
          new Promise<void>((resolve) => setTimeout(resolve, 250)),
        ]);
      }

      if (!isClosed) {
        try {
          child.kill("SIGKILL");
        } catch (err) {
          // ignore
          console.warn("[friday][mcp-adapter] kill-sigkill:", err instanceof Error ? err.message : String(err));
        }
      }
    },
  };

  function handleInboundMessage(rawMessage: unknown): void {
    const message = normalizeRecord(rawMessage);
    if (!Object.prototype.hasOwnProperty.call(message, "id")) {
      return;
    }

    const key = String(message.id);
    const request = pending.get(key);
    if (!request) {
      return;
    }
    pending.delete(key);
    clearTimeout(request.timeout);
    request.cleanupAbort?.();

    if (Object.prototype.hasOwnProperty.call(message, "error")) {
      const rpcError = normalizeRpcError(message.error);
      request.reject(new Error(`MCP error ${String(rpcError.code)}: ${rpcError.message}`));
      return;
    }

    request.resolve(message.result);
  }

  function failSession(error: Error): void {
    if (isClosed) {
      return;
    }
    isClosed = true;
    for (const [key, pendingRequest] of pending) {
      pending.delete(key);
      clearTimeout(pendingRequest.timeout);
      pendingRequest.cleanupAbort?.();
      pendingRequest.reject(error);
    }
  }
}

function writeFrame(
  stream: NodeJS.WritableStream,
  payload: Record<string, unknown>,
): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.from(`Content-Length: ${String(body.length)}\r\n\r\n`, "utf8");
  stream.write(Buffer.concat([header, body]));
}

function* decodeFrames(
  getBuffer: () => Buffer<ArrayBufferLike>,
  setBuffer: (buffer: Buffer<ArrayBufferLike>) => void,
): Generator<unknown, void, unknown> {
  while (true) {
    const buffer = getBuffer();
    const headerEnd = buffer.indexOf(FRAME_SEPARATOR);
    if (headerEnd < 0) {
      return;
    }

    const headerText = buffer.subarray(0, headerEnd).toString("utf8");
    const contentLength = readContentLength(headerText);
    if (contentLength < 0) {
      throw new FridayDomainError("VALIDATION_ERROR", "MCP frame missing Content-Length header", { httpStatus: 400 });
    }

    const messageStart = headerEnd + FRAME_SEPARATOR.length;
    const frameEnd = messageStart + contentLength;
    if (buffer.length < frameEnd) {
      return;
    }

    const body = buffer.subarray(messageStart, frameEnd).toString("utf8");
    setBuffer(buffer.subarray(frameEnd));
    yield JSON.parse(body);
  }
}

function readContentLength(headerText: string): number {
  const lines = headerText.split("\r\n");
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;

    const name = line.slice(0, separator).trim().toLowerCase();
    if (name !== "content-length") continue;

    const value = Number.parseInt(line.slice(separator + 1).trim(), 10);
    if (Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return -1;
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function normalizeRpcError(value: unknown): JsonRpcResponseError {
  const record = normalizeRecord(value);
  const code = typeof record.code === "number" ? record.code : -32000;
  const message = typeof record.message === "string" ? record.message : "Unknown MCP error";
  return { code, message, data: record.data };
}

function toToolDescriptor(
  serverId: string,
  rawTool: unknown,
): FridayMcpToolDescriptor | null {
  const tool = normalizeRecord(rawTool);
  const name = typeof tool.name === "string" ? tool.name.trim() : "";
  if (!name) return null;

  const description = typeof tool.description === "string"
    ? tool.description
    : undefined;
  const inputSchema = normalizeToolSchema(tool.inputSchema ?? tool.input_schema);
  return {
    serverId,
    name,
    ...(description ? { description } : {}),
    inputSchema,
  };
}

function toResourceDescriptor(
  serverId: string,
  rawResource: unknown,
): FridayMcpResourceDescriptor | null {
  const resource = normalizeRecord(rawResource);
  const uri = typeof resource.uri === "string" ? resource.uri.trim() : "";
  if (!uri) return null;

  const name = typeof resource.name === "string" ? resource.name : undefined;
  const description = typeof resource.description === "string" ? resource.description : undefined;
  const mimeType = typeof resource.mimeType === "string"
    ? resource.mimeType
    : typeof resource.mime_type === "string"
      ? resource.mime_type
      : undefined;

  return {
    serverId,
    uri,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(mimeType ? { mimeType } : {}),
  };
}

function toPromptDescriptor(
  serverId: string,
  rawPrompt: unknown,
): FridayMcpPromptDescriptor | null {
  const prompt = normalizeRecord(rawPrompt);
  const name = typeof prompt.name === "string" ? prompt.name.trim() : "";
  if (!name) return null;

  const description = typeof prompt.description === "string" ? prompt.description : undefined;
  return {
    serverId,
    name,
    ...(description ? { description } : {}),
  };
}

function normalizeToolSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return {
      type: "object",
      properties: {},
    };
  }
  const normalized = {
    ...(schema as Record<string, unknown>),
  };
  if (normalized.type === undefined) {
    normalized.type = "object";
  }
  if (normalized.properties === undefined || typeof normalized.properties !== "object" || Array.isArray(normalized.properties)) {
    normalized.properties = {};
  }
  return normalized;
}

function toNextCursor(result: Record<string, unknown>): string | undefined {
  if (typeof result.nextCursor === "string" && result.nextCursor) {
    return result.nextCursor;
  }
  if (typeof result.next_cursor === "string" && result.next_cursor) {
    return result.next_cursor;
  }
  return undefined;
}

function extractMcpContent(callResult: Record<string, unknown>): string {
  const content = callResult.content;
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const chunks: string[] = [];
    for (const item of content) {
      const block = normalizeRecord(item);
      if (block.type === "text" && typeof block.text === "string") {
        chunks.push(block.text);
        continue;
      }
      if (block.type === "resource" && typeof block.uri === "string") {
        chunks.push(`[resource] ${block.uri}`);
        continue;
      }
      if (block.type === "image") {
        chunks.push("[image]");
        continue;
      }
      chunks.push(JSON.stringify(block));
    }
    return chunks.filter(Boolean).join("\n").trim();
  }

  if (Object.prototype.hasOwnProperty.call(callResult, "structuredContent")) {
    return JSON.stringify(callResult.structuredContent, null, 2);
  }

  return JSON.stringify(callResult, null, 2);
}

function extractMcpResourceContent(result: Record<string, unknown>): string {
  const contents = Array.isArray(result.contents) ? result.contents : [];
  if (contents.length === 0) {
    return JSON.stringify(result, null, 2);
  }

  const chunks: string[] = [];
  for (const item of contents) {
    const entry = normalizeRecord(item);
    if (typeof entry.text === "string") {
      chunks.push(entry.text);
      continue;
    }
    if (typeof entry.blob === "string") {
      const mimeType = typeof entry.mimeType === "string" ? entry.mimeType : "application/octet-stream";
      chunks.push(`[blob:${mimeType}] ${entry.blob.length} bytes(base64)`);
      continue;
    }
    if (typeof entry.uri === "string") {
      chunks.push(`[resource] ${entry.uri}`);
      continue;
    }
    chunks.push(JSON.stringify(entry));
  }

  return chunks.filter(Boolean).join("\n").trim();
}

function extractMcpPromptContent(result: Record<string, unknown>): string {
  const messages = Array.isArray(result.messages) ? result.messages : [];
  if (messages.length === 0) {
    if (typeof result.description === "string") return result.description;
    return JSON.stringify(result, null, 2);
  }

  const chunks: string[] = [];
  for (const item of messages) {
    const message = normalizeRecord(item);
    const content = message.content;
    if (typeof content === "string") {
      chunks.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        const block = normalizeRecord(part);
        if (typeof block.text === "string") {
          chunks.push(block.text);
        } else {
          chunks.push(JSON.stringify(block));
        }
      }
      continue;
    }
    chunks.push(JSON.stringify(message));
  }

  return chunks.filter(Boolean).join("\n").trim();
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(String(value));
}
