/**
 * Plugin Health Monitor — Initiative G.2
 *
 * Tracks consecutive failure counts per plugin. When a plugin
 * exceeds the failure threshold, it is automatically disabled
 * and a warning event is emitted.
 *
 * This is a lightweight in-memory monitor. Plugin state changes
 * (disable) are persisted through the existing plugin service.
 */

// ─── Types ───

export interface FridayPluginHealthState {
  pluginId: string;
  consecutiveFailures: number;
  lastFailureAt?: string;
  lastSuccessAt?: string;
  autoDisabled: boolean;
}

export interface FridayPluginHealthMonitorOptions {
  /** Number of consecutive failures before auto-disable. Default: 3. */
  failureThreshold?: number;
  /** Callback when a plugin is auto-disabled. */
  onAutoDisable?: (pluginId: string, failures: number) => void;
}

export interface FridayPluginHealthMonitor {
  /** Record a successful plugin operation. Resets failure counter. */
  recordSuccess(pluginId: string): void;
  /** Record a failed plugin operation. May trigger auto-disable. */
  recordFailure(pluginId: string): FridayPluginHealthState;
  /** Get current health state for a plugin. */
  getState(pluginId: string): FridayPluginHealthState | undefined;
  /** List all plugins with non-zero failure counts. */
  listUnhealthy(): FridayPluginHealthState[];
  /** Reset health state for a plugin (e.g. after manual re-enable). */
  reset(pluginId: string): void;
  /** Clear all tracked state. */
  clear(): void;
}

// ─── Factory ───

const DEFAULT_FAILURE_THRESHOLD = 3;

export function createFridayPluginHealthMonitor(
  options?: FridayPluginHealthMonitorOptions,
): FridayPluginHealthMonitor {
  const threshold = options?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  const onAutoDisable = options?.onAutoDisable;
  const states = new Map<string, FridayPluginHealthState>();

  function getOrCreate(pluginId: string): FridayPluginHealthState {
    let state = states.get(pluginId);
    if (!state) {
      state = { pluginId, consecutiveFailures: 0, autoDisabled: false };
      states.set(pluginId, state);
    }
    return state;
  }

  function recordSuccess(pluginId: string): void {
    const state = getOrCreate(pluginId);
    state.consecutiveFailures = 0;
    state.lastSuccessAt = new Date().toISOString();
  }

  function recordFailure(pluginId: string): FridayPluginHealthState {
    const state = getOrCreate(pluginId);
    state.consecutiveFailures += 1;
    state.lastFailureAt = new Date().toISOString();

    if (state.consecutiveFailures >= threshold && !state.autoDisabled) {
      state.autoDisabled = true;
      onAutoDisable?.(pluginId, state.consecutiveFailures);
    }

    return { ...state };
  }

  function getState(pluginId: string): FridayPluginHealthState | undefined {
    const state = states.get(pluginId);
    return state ? { ...state } : undefined;
  }

  function listUnhealthy(): FridayPluginHealthState[] {
    return [...states.values()]
      .filter((s) => s.consecutiveFailures > 0)
      .map((s) => ({ ...s }));
  }

  function reset(pluginId: string): void {
    states.delete(pluginId);
  }

  function clear(): void {
    states.clear();
  }

  return { recordSuccess, recordFailure, getState, listUnhealthy, reset, clear };
}
