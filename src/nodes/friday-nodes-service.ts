/**
 * Generic FridayNodesService interface + a reference factory.
 *
 * **B4 truth-labeling note:** the production hub-bootstrap uses
 * `createFridaySatelliteNodesService` from `friday-satellite-nodes-service.ts`
 * to instantiate `FridayNodesService`. The generic `createFridayNodesService`
 * factory below has zero in-tree callers as of the B4 capability inventory
 * (no production, no tests). The TYPES (`FridayNodesService`,
 * `FridayNodeInfo`, `FridayNodeControlResult`, `FridayNodesServiceOptions`)
 * are still consumed by production at `src/agent/tools/friday-agent-tool-registry.ts`
 * and `src/agent/tools/friday-agent-nodes-tool.ts`, and are stable.
 *
 * The factory is preserved (rather than removed) because it ships with
 * a stable interface that an out-of-tree consumer could reasonably depend
 * on through the parent barrel. A one-time `console.info` advisory fires
 * at first construction so anyone accidentally wiring it in production
 * sees the proof_pending state (the satellite variant is the real
 * implementation).
 */

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

let fridayNodesServiceAdvisoryEmitted = false;

/** Warn-once advisory at first construction. See file header. */
function emitFridayNodesServiceAdvisoryOnce(): void {
  if (fridayNodesServiceAdvisoryEmitted) return;
  fridayNodesServiceAdvisoryEmitted = true;
  console.info(
    "[friday][nodes][generic-factory] advisory: createFridayNodesService is a reference / test-helper factory with zero production callers as of the B4 capability inventory; production uses createFridaySatelliteNodesService. Wiring this generic factory into production is proof_pending — see file header.",
  );
}

/**
 * B4 truth-labeling: proof_pending reference factory. See file header.
 */
export function createFridayNodesService(
  options: FridayNodesServiceOptions,
): FridayNodesService {
  emitFridayNodesServiceAdvisoryOnce();
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
