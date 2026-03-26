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
