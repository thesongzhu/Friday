export type FridayMcpTransport = "stdio" | "http";
export type FridayMcpDiscoveryState = "configured" | "discoverable" | "loaded" | "deferred";

export interface FridayMcpServerRateLimitPolicy {
  maxCalls: number;
  windowMs: number;
}

export interface FridayMcpServerPolicy {
  toolAllowlist?: string[];
  rateLimit?: FridayMcpServerRateLimitPolicy;
}

export interface FridayMcpServerConfig {
  id: string;
  transport?: FridayMcpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  policy?: FridayMcpServerPolicy;
  timeoutMs?: number;
}

export interface FridayMcpServerState {
  serverId: string;
  transport: FridayMcpTransport;
  state: FridayMcpDiscoveryState;
  lazyDiscovery: boolean;
  toolCount?: number;
  resourceCount?: number;
  promptCount?: number;
  lastLoadedAt?: string;
}

export interface FridayMcpToolDescriptor {
  serverId: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface FridayMcpCallToolInput {
  serverId: string;
  toolName: string;
  args?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface FridayMcpCallToolResult {
  content: string;
  isError: boolean;
  raw: unknown;
}

export interface FridayMcpResourceDescriptor {
  serverId: string;
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface FridayMcpReadResourceInput {
  serverId: string;
  uri: string;
  signal?: AbortSignal;
}

export interface FridayMcpReadResourceResult {
  content: string;
  raw: unknown;
}

export interface FridayMcpPromptDescriptor {
  serverId: string;
  name: string;
  description?: string;
}

export interface FridayMcpGetPromptInput {
  serverId: string;
  name: string;
  args?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface FridayMcpGetPromptResult {
  content: string;
  raw: unknown;
}

// ─── Typed protocol schemas (Initiative C.2) ───

/** Primitive types allowed in MCP tool arguments. */
export type FridayMcpPrimitive = string | number | boolean | null;

/** Typed tool argument value (recursive for nested objects). */
export type FridayMcpArgValue =
  | FridayMcpPrimitive
  | FridayMcpPrimitive[]
  | FridayMcpArgMap
  | FridayMcpArgMap[];

/** Typed tool argument map. */
export type FridayMcpArgMap = { [key: string]: FridayMcpArgValue };

/** MCP error codes as a typed union. */
export type FridayMcpErrorCode =
  | "SERVER_NOT_CONFIGURED"
  | "CONFIG_INVALID"
  | "TRANSPORT_UNSUPPORTED"
  | "TRANSPORT_ERROR"
  | "REQUEST_FAILED"
  | "REQUEST_TIMEOUT"
  | "POLICY_TOOL_FORBIDDEN"
  | "POLICY_RATE_LIMITED"
  | "DEDUP_CACHE_HIT";

/** Structured MCP error with typed codes. */
export interface FridayMcpError {
  code: FridayMcpErrorCode;
  message: string;
  serverId?: string;
  toolName?: string;
  routeId?: string;
  correlationId?: string;
}

/** Type guard: check if a value is a valid MCP argument map. */
export function isMcpArgMap(value: unknown): value is FridayMcpArgMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(isMcpArgValue);
}

/** Type guard: check if a value is a valid MCP argument value. */
export function isMcpArgValue(value: unknown): value is FridayMcpArgValue {
  if (value === null) return true;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return true;
  if (Array.isArray(value)) return value.every(isMcpArgValue);
  if (t === "object") return isMcpArgMap(value);
  return false;
}

// ─── Adapter interface ───

export interface FridayMcpAdapter {
  listServers(): readonly FridayMcpServerConfig[];
  listServerStates(): readonly FridayMcpServerState[];
  listTools(input?: { serverId?: string; signal?: AbortSignal }): Promise<FridayMcpToolDescriptor[]>;
  searchTools(input: { query: string; serverId?: string; signal?: AbortSignal }): Promise<FridayMcpToolDescriptor[]>;
  callTool(input: FridayMcpCallToolInput): Promise<FridayMcpCallToolResult>;
  listResources(input?: { serverId?: string; signal?: AbortSignal }): Promise<FridayMcpResourceDescriptor[]>;
  readResource(input: FridayMcpReadResourceInput): Promise<FridayMcpReadResourceResult>;
  listPrompts(input?: { serverId?: string; signal?: AbortSignal }): Promise<FridayMcpPromptDescriptor[]>;
  getPrompt(input: FridayMcpGetPromptInput): Promise<FridayMcpGetPromptResult>;
}
