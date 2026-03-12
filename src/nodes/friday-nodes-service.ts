// ─── Types ───

export interface FridayNodeInfo {
  nodeId: string;
  name: string;
  kind: string;
  status: "online" | "offline" | "unknown";
  lastSeen?: string;
  metadata?: Record<string, unknown>;
}

export interface FridayNodeControlResult {
  nodeId: string;
  command: string;
  success: boolean;
  response?: unknown;
  error?: string;
  durationMs?: number;
}

export interface FridayNodesServiceOptions {
  /** Discover implementation — returns currently known nodes. */
  discoverFn: (signal: AbortSignal) => Promise<FridayNodeInfo[]>;
  /** Get a single node's info by ID. */
  getFn: (nodeId: string, signal: AbortSignal) => Promise<FridayNodeInfo | null>;
  /** Send a control command to a node. */
  controlFn: (
    nodeId: string,
    command: string,
    args: Record<string, unknown> | undefined,
    timeoutMs: number | undefined,
    signal: AbortSignal,
  ) => Promise<FridayNodeControlResult>;
}

export interface FridayNodesService {
  discover(signal: AbortSignal): Promise<FridayNodeInfo[]>;
  get(nodeId: string, signal: AbortSignal): Promise<FridayNodeInfo | null>;
  control(
    nodeId: string,
    command: string,
    args?: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<FridayNodeControlResult>;
}

// ─── Factory ───

export function createFridayNodesService(
  options: FridayNodesServiceOptions,
): FridayNodesService {
  const { discoverFn, getFn, controlFn } = options;

  return {
    async discover(signal: AbortSignal): Promise<FridayNodeInfo[]> {
      return discoverFn(signal);
    },

    async get(nodeId: string, signal: AbortSignal): Promise<FridayNodeInfo | null> {
      return getFn(nodeId, signal);
    },

    async control(
      nodeId: string,
      command: string,
      args?: Record<string, unknown>,
      timeoutMs?: number,
      signal?: AbortSignal,
    ): Promise<FridayNodeControlResult> {
      const effectiveSignal = signal ?? new AbortController().signal;
      return controlFn(nodeId, command, args, timeoutMs, effectiveSignal);
    },
  };
}
