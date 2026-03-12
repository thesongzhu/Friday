/**
 * Health Check Manager — Component health checks with dependency status.
 *
 * Provides a framework for registering health checks for individual components
 * and their dependencies. Aggregates component health into an overall system
 * health status. Supports periodic health evaluation and status history.
 *
 * @module observability/engine
 */

import type {
  FridayObservabilityModule,
  ISODateTime,
} from "../model/friday-observability.types.js";

// ─── Immutability Helpers ───

/** Recursively freeze objects/arrays to enforce runtime immutability. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const nested = (value as Record<string, unknown>)[key];
    if (nested !== null && typeof nested === "object") deepFreeze(nested);
  }
  return Object.freeze(value);
}

/** Clone a value and return a deeply frozen copy. */
function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

// ─── Health Status ───

/** Health status of a single component. */
export type HealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

/** A dependency's health information. */
export interface DependencyHealth {
  /** Dependency name. */
  readonly name: string;
  /** Health status. */
  readonly status: HealthStatus;
  /** Optional message describing the status. */
  readonly message?: string;
  /** Response time of the last health check in milliseconds. */
  readonly responseTimeMs?: number;
  /** When this dependency was last checked. */
  readonly lastCheckedAt: ISODateTime;
}

/** A component's health check result. */
export interface ComponentHealth {
  /** Component name (usually the module name). */
  readonly name: string;
  /** Module this component belongs to. */
  readonly module: FridayObservabilityModule;
  /** Overall health status of this component. */
  readonly status: HealthStatus;
  /** Human-readable status message. */
  readonly message?: string;
  /** Health of this component's dependencies. */
  readonly dependencies: readonly DependencyHealth[];
  /** When this component was last checked. */
  readonly lastCheckedAt: ISODateTime;
  /** How long the check took in milliseconds. */
  readonly checkDurationMs: number;
}

/** Aggregated system health across all components. */
export interface SystemHealth {
  /** Overall system health (worst component status). */
  readonly status: HealthStatus;
  /** Individual component health results. */
  readonly components: readonly ComponentHealth[];
  /** Summary message. */
  readonly message: string;
  /** When this aggregate was computed. */
  readonly checkedAt: ISODateTime;
  /** Total number of healthy components. */
  readonly healthyCount: number;
  /** Total number of degraded components. */
  readonly degradedCount: number;
  /** Total number of unhealthy components. */
  readonly unhealthyCount: number;
}

// ─── Health Check Function ───

/** A health check function that returns a component health result. */
export type HealthCheckFn = () => Promise<ComponentHealth>;

// ─── Health Status Priority ───

/** Priority order: unhealthy > degraded > unknown > healthy. */
const STATUS_PRIORITY: Record<HealthStatus, number> = {
  unhealthy: 3,
  degraded: 2,
  unknown: 1,
  healthy: 0,
};

const DEFAULT_CHECK_TIMEOUT_MS = 5_000;

// ─── Health Check Manager ───

/**
 * Manages health checks for all platform components.
 *
 * Usage:
 * ```ts
 * const manager = new FridayHealthCheckManager();
 * manager.registerCheck("rules-engine", "rules", async () => ({
 *   name: "rules-engine",
 *   module: "rules",
 *   status: "healthy",
 *   dependencies: [],
 *   lastCheckedAt: new Date().toISOString(),
 *   checkDurationMs: 5,
 * }));
 * const health = await manager.checkAll();
 * ```
 */
export class FridayHealthCheckManager {
  private readonly checks = new Map<string, {
    module: FridayObservabilityModule;
    fn: HealthCheckFn;
    timeoutMs: number;
  }>();
  private readonly lastResults = new Map<string, ComponentHealth>();

  /** Register a health check for a component. */
  registerCheck(
    name: string,
    module: FridayObservabilityModule,
    fn: HealthCheckFn,
    timeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
  ): void {
    this.checks.set(name, {
      module,
      fn,
      timeoutMs: Math.max(1, timeoutMs),
    });
  }

  /** Unregister a health check. */
  unregisterCheck(name: string): boolean {
    this.lastResults.delete(name);
    return this.checks.delete(name);
  }

  /** Run a single component's health check. */
  async checkComponent(name: string): Promise<ComponentHealth | null> {
    const check = this.checks.get(name);
    if (!check) return null;

    const start = Date.now();
    try {
      const result = await this.runWithTimeout(name, check.timeoutMs, check.fn);
      this.lastResults.set(name, result);
      return result;
    } catch (error) {
      const failResult: ComponentHealth = {
        name,
        module: check.module,
        status: "unhealthy",
        message: error instanceof Error ? error.message : "Health check threw an exception",
        dependencies: [],
        lastCheckedAt: new Date().toISOString(),
        checkDurationMs: Date.now() - start,
      };
      this.lastResults.set(name, failResult);
      return failResult;
    }
  }

  /** Run all registered health checks and return aggregated system health. */
  async checkAll(): Promise<SystemHealth> {
    const names = Array.from(this.checks.keys());
    const settledResults = await Promise.allSettled(
      names.map((name) => this.checkComponent(name)),
    );

    const componentResults: ComponentHealth[] = [];
    for (const settled of settledResults) {
      if (settled.status === "fulfilled" && settled.value) {
        componentResults.push(settled.value);
      }
    }

    return this.aggregateHealth(componentResults);
  }

  /** Get the last known health result for a component (returns immutable snapshot). */
  getLastResult(name: string): ComponentHealth | null {
    const result = this.lastResults.get(name);
    return result ? cloneAndFreeze(result) : null;
  }

  /** Get the last known results for all components (returns immutable snapshots). */
  getLastResults(): Map<string, ComponentHealth> {
    const frozen = new Map<string, ComponentHealth>();
    for (const [key, value] of this.lastResults) {
      frozen.set(key, cloneAndFreeze(value));
    }
    return frozen;
  }

  /** Get all registered check names. */
  getRegisteredChecks(): string[] {
    return Array.from(this.checks.keys());
  }

  /** Create a simple health check function for a component with dependencies. */
  static createCheck(
    name: string,
    module: FridayObservabilityModule,
    dependencyChecks: Array<{ name: string; check: () => Promise<{ ok: boolean; message?: string; responseTimeMs?: number }> }> = [],
  ): HealthCheckFn {
    return async (): Promise<ComponentHealth> => {
      const start = Date.now();
      const dependencies: DependencyHealth[] = [];
      let worstStatus: HealthStatus = "healthy";

      for (const dep of dependencyChecks) {
        const depStart = Date.now();
        try {
          const result = await dep.check();
          const depHealth: DependencyHealth = {
            name: dep.name,
            status: result.ok ? "healthy" : "unhealthy",
            message: result.message,
            responseTimeMs: result.responseTimeMs ?? (Date.now() - depStart),
            lastCheckedAt: new Date().toISOString(),
          };
          dependencies.push(depHealth);
          if (!result.ok && STATUS_PRIORITY.unhealthy > STATUS_PRIORITY[worstStatus]) {
            worstStatus = "degraded"; // Dependency failure degrades the component
          }
        } catch (error) {
          dependencies.push({
            name: dep.name,
            status: "unhealthy",
            message: error instanceof Error ? error.message : "Check failed",
            responseTimeMs: Date.now() - depStart,
            lastCheckedAt: new Date().toISOString(),
          });
          worstStatus = "degraded";
        }
      }

      return {
        name,
        module,
        status: worstStatus,
        dependencies,
        lastCheckedAt: new Date().toISOString(),
        checkDurationMs: Date.now() - start,
      };
    };
  }

  /** Reset all state (for testing). */
  reset(): void {
    this.checks.clear();
    this.lastResults.clear();
  }

  // ─── Internal ───

  /** Execute a check with a timeout guard. */
  private runWithTimeout<T>(name: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Health check "${name}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      fn().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /** Aggregate component health into system health. */
  private aggregateHealth(components: ComponentHealth[]): SystemHealth {
    let worstStatus: HealthStatus = "healthy";
    let healthyCount = 0;
    let degradedCount = 0;
    let unhealthyCount = 0;

    for (const comp of components) {
      if (STATUS_PRIORITY[comp.status] > STATUS_PRIORITY[worstStatus]) {
        worstStatus = comp.status;
      }
      switch (comp.status) {
        case "healthy": healthyCount++; break;
        case "degraded": degradedCount++; break;
        case "unhealthy": unhealthyCount++; break;
        default: break;
      }
    }

    const total = components.length;
    let message: string;
    if (worstStatus === "healthy") {
      message = `All ${total} components healthy`;
    } else if (worstStatus === "unhealthy") {
      message = `${unhealthyCount}/${total} components unhealthy`;
    } else if (worstStatus === "degraded") {
      message = `${degradedCount}/${total} components degraded`;
    } else {
      message = total === 0 ? "No health checks registered" : `${total} components in unknown state`;
    }

    return {
      status: total === 0 ? "unknown" : worstStatus,
      components,
      message,
      checkedAt: new Date().toISOString(),
      healthyCount,
      degradedCount,
      unhealthyCount,
    };
  }
}
