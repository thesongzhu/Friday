/**
 * Channel Registry — manages channel plugin lifecycle, routing, and allowlists.
 *
 * Responsibilities:
 * - Register/unregister channel plugin instances
 * - Start/stop all registered channels
 * - Route inbound messages through allowlist filtering
 * - Provide lookup for outbound sends
 * - Route through adapters when present, fallback to legacy methods
 */

import { FridayDomainError } from "#errors";
import type { FridayChannelStatus } from "./friday-channel-adapters.types.js";
import type {
  FridayChannelCapabilityContract,
  FridayChannelMessage,
  FridayChannelPlugin,
  FridayChannelSendOptions,
} from "./friday-channel.types.js";

// ─── Types ───

export interface FridayChannelAllowlistConfig {
  /** If set, only these sender IDs are allowed. Empty array = block all. */
  allowedUsers?: string[];
  /** If set, only these chat IDs are allowed. Empty array = block all. */
  allowedChats?: string[];
}

export interface FridayChannelRegistryEntry {
  plugin: FridayChannelPlugin;
  allowlist: FridayChannelAllowlistConfig;
  running: boolean;
}

export type FridayChannelCredentialStatus =
  | "unknown"
  | "configured"
  | "missing"
  | "invalid";

export interface FridayChannelHealthSummary {
  state: FridayChannelStatus;
  restartCount: number;
  lastError?: string;
  blockedReason?: string;
  credentialStatus: FridayChannelCredentialStatus;
}

export interface FridayChannelRegistryView {
  kind: string;
  running: boolean;
  status: FridayChannelStatus;
  health: FridayChannelHealthSummary;
  diagnostics?: Record<string, unknown>;
  contract?: FridayChannelCapabilityContract;
  allowlist: {
    hasAllowedUsers: boolean;
    allowedUsersCount: number;
    hasAllowedChats: boolean;
    allowedChatsCount: number;
  };
}

export type FridayChannelMessageHandler = (msg: FridayChannelMessage) => void;

export interface FridayChannelStartFailure {
  kind: string;
  message: string;
}

export interface FridayChannelStartSummary {
  startedKinds: string[];
  failed: FridayChannelStartFailure[];
}

export interface FridayChannelRegistry {
  /** Register a channel plugin with optional allowlist filtering. */
  register(plugin: FridayChannelPlugin, allowlist?: FridayChannelAllowlistConfig): void;

  /** Unregister a channel plugin by kind. Stops it if running. */
  unregister(kind: string): Promise<void>;

  /** Start all registered channels. Inbound messages are routed to handler. */
  startAll(handler: FridayChannelMessageHandler): Promise<void>;

  /**
   * Start all registered channels without rolling back healthy channels when one fails.
   * Returns a summary of started and failed channel kinds.
   */
  startAllBestEffort(handler: FridayChannelMessageHandler): Promise<FridayChannelStartSummary>;

  /** Stop all running channels. */
  stopAll(): Promise<void>;

  /** Get a registered channel plugin by kind. */
  get(kind: string): FridayChannelRegistryEntry | undefined;

  /** List all registered channel kinds. */
  list(): string[];

  /** Describe a registered channel with status, diagnostics, and contract metadata. */
  describe(kind: string): FridayChannelRegistryView | undefined;

  /** List channel views including status, diagnostics, and contract metadata. */
  listViews(): FridayChannelRegistryView[];

  /** Send a message through a specific channel kind. */
  send(kind: string, options: FridayChannelSendOptions): Promise<{ messageId: string }>;

  /** Optionally signal typing state for a specific channel kind/chat. */
  signalTyping(kind: string, chatId: string): Promise<void>;

  /** Get channel status (uses status adapter if available, else derives from running state). */
  status(kind: string): FridayChannelStatus;

  /** Get channel diagnostics (uses status adapter if available). */
  diagnostics(kind: string): Record<string, unknown> | undefined;

  /** Start a background health monitor that auto-restarts disconnected channels. */
  startHealthMonitor(
    handler: FridayChannelMessageHandler,
    options?: { intervalMs?: number },
  ): void;

  /** Stop the health monitor. */
  stopHealthMonitor(): void;
}

// ─── Implementation ───

const HEALTH_CHECK_DEFAULT_INTERVAL_MS = 30_000;

export interface FridayChannelRegistryOptions {
  /** Optional grant check called before register/unregister mutations. Throws if denied. */
  checkMutationGrant?: (action: "register" | "unregister", kind: string) => void;
}

export function createFridayChannelRegistry(options?: FridayChannelRegistryOptions): FridayChannelRegistry {
  const entries = new Map<string, FridayChannelRegistryEntry>();
  const healthState = new Map<string, {
    restartCount: number;
    lastError?: string;
    blockedReason?: string;
  }>();
  let healthMonitorTimer: ReturnType<typeof setInterval> | null = null;
  let healthHandler: FridayChannelMessageHandler | null = null;
  // Track channels currently being restarted to avoid duplicate restart attempts
  const restarting = new Set<string>();
  // Track channels that were attempted by startAll/startAllBestEffort but failed
  const failedStart = new Set<string>();

  function checkAllowlist(
    msg: FridayChannelMessage,
    allowlist: FridayChannelAllowlistConfig,
  ): boolean {
    if (allowlist.allowedUsers !== undefined) {
      if (!allowlist.allowedUsers.includes(msg.senderId)) {
        return false;
      }
    }
    if (allowlist.allowedChats !== undefined) {
      if (!allowlist.allowedChats.includes(msg.chatId)) {
        return false;
      }
    }
    return true;
  }

  function buildStartPromise(
    entry: FridayChannelRegistryEntry,
    handler: FridayChannelMessageHandler,
    options: { restart?: boolean } = {},
  ): Promise<void> {
    const { plugin } = entry;
    const lifecycle = plugin.adapters?.lifecycle;
    const inbound = plugin.adapters?.inbound;
    const health = healthState.get(plugin.kind);

    const markConnected = () => {
      entry.running = true;
      if (health) {
        if (options.restart) {
          health.restartCount += 1;
        }
        health.lastError = undefined;
        health.blockedReason = undefined;
      }
    };

    if (lifecycle) {
      const wrappedEventHandler = (rawEvent: unknown) => {
        if (inbound) {
          if (inbound.normalizeAllAsync) {
            void inbound.normalizeAllAsync(rawEvent)
              .then((msgs) => {
                for (const msg of msgs) {
                  if (!checkAllowlist(msg, entry.allowlist)) continue;
                  handler(msg);
                }
              })
              .catch((err: unknown) => {
                const message = err instanceof Error ? err.message : String(err);
                healthState.get(plugin.kind)!.lastError = message;
                console.warn(`[friday][channel-registry] async inbound normalizeAll failed for ${plugin.kind}: ${message}`);
              });
            return;
          }

          if (inbound.normalizeAsync) {
            void inbound.normalizeAsync(rawEvent)
              .then((msg) => {
                if (!msg) return;
                if (!checkAllowlist(msg, entry.allowlist)) return;
                handler(msg);
              })
              .catch((err: unknown) => {
                const message = err instanceof Error ? err.message : String(err);
                healthState.get(plugin.kind)!.lastError = message;
                console.warn(`[friday][channel-registry] async inbound normalize failed for ${plugin.kind}: ${message}`);
              });
            return;
          }

          if (inbound.normalizeAll) {
            const msgs = inbound.normalizeAll(rawEvent);
            for (const msg of msgs) {
              if (!checkAllowlist(msg, entry.allowlist)) continue;
              handler(msg);
            }
            return;
          }

          const msg = inbound.normalize(rawEvent);
          if (!msg) return;
          if (!checkAllowlist(msg, entry.allowlist)) return;
          handler(msg);
          return;
        }

        const msg = rawEvent as FridayChannelMessage;
        if (!checkAllowlist(msg, entry.allowlist)) return;
        handler(msg);
      };

      return lifecycle.connect(wrappedEventHandler).then(markConnected);
    }

    const wrappedHandler = (msg: FridayChannelMessage) => {
      if (!checkAllowlist(msg, entry.allowlist)) return;
      handler(msg);
    };

    return plugin.start(wrappedHandler).then(markConnected);
  }

  function formatStartError(reason: unknown): string {
    if (reason instanceof Error) return reason.message;
    return String(reason);
  }

  function buildAllowlistSummary(allowlist: FridayChannelAllowlistConfig) {
    return {
      hasAllowedUsers: allowlist.allowedUsers !== undefined,
      allowedUsersCount: allowlist.allowedUsers?.length ?? 0,
      hasAllowedChats: allowlist.allowedChats !== undefined,
      allowedChatsCount: allowlist.allowedChats?.length ?? 0,
    };
  }

  function inferCredentialStatus(
    diagnostics: Record<string, unknown> | undefined,
    lastError: string | undefined,
  ): FridayChannelCredentialStatus {
    const raw = typeof diagnostics?.credentialStatus === "string"
      ? diagnostics.credentialStatus.trim().toLowerCase()
      : "";
    if (raw === "configured" || raw === "missing" || raw === "invalid" || raw === "unknown") {
      return raw;
    }
    const normalizedError = lastError?.toLowerCase() ?? "";
    if (/\b(missing|not set|not found)\b/.test(normalizedError)) {
      return "missing";
    }
    if (/\b(invalid|unauthorized|forbidden|expired)\b/.test(normalizedError)) {
      return "invalid";
    }
    return "unknown";
  }

  return {
    register(plugin, allowlist = {}) {
      options?.checkMutationGrant?.("register", plugin.kind);
      if (entries.has(plugin.kind)) {
        throw new FridayDomainError("CONFLICT", `Channel kind "${plugin.kind}" is already registered`, { httpStatus: 409 });
      }
      entries.set(plugin.kind, { plugin, allowlist, running: false });
      healthState.set(plugin.kind, { restartCount: 0 });
    },

    async unregister(kind) {
      options?.checkMutationGrant?.("unregister", kind);
      const entry = entries.get(kind);
      if (!entry) return;
      if (entry.running) {
        // Use lifecycle adapter if available, otherwise legacy stop
        if (entry.plugin.adapters?.lifecycle) {
          await entry.plugin.adapters.lifecycle.disconnect();
        } else {
          await entry.plugin.stop();
        }
      }
      entries.delete(kind);
      healthState.delete(kind);
    },

    async startAll(handler) {
      const attempts: Array<{ kind: string; promise: Promise<void> }> = [];
      const startedKinds: string[] = [];

      for (const [kind, entry] of entries) {
        if (entry.running) continue;
        attempts.push({
          kind,
          promise: buildStartPromise(entry, handler),
        });
      }

      const results = await Promise.allSettled(
        attempts.map((attempt) =>
          attempt.promise.then(() => {
            startedKinds.push(attempt.kind);
          }),
        ),
      );

      const failures: FridayChannelStartFailure[] = [];
      for (const [index, result] of results.entries()) {
        if (result.status !== "rejected") continue;
        const kind = attempts[index]?.kind ?? "unknown";
        const health = healthState.get(kind);
        if (health) {
          health.lastError = formatStartError(result.reason);
          health.blockedReason = "start_failed";
        }
        failures.push({
          kind,
          message: formatStartError(result.reason),
        });
      }

      if (failures.length === 0) {
        return;
      }

      await Promise.allSettled(
        startedKinds.map((kind) => {
          const started = entries.get(kind);
          if (!started?.running) return Promise.resolve();

          const stopFn = started.plugin.adapters?.lifecycle
            ? () => started.plugin.adapters!.lifecycle!.disconnect()
            : () => started.plugin.stop();

          return stopFn().finally(() => {
            started.running = false;
          });
        }),
      );

      throw new FridayDomainError(
        "INTERNAL_ERROR",
        `Failed to start ${String(failures.length)} channel(s): ` +
          failures
            .map((failure) => `${failure.kind}: ${failure.message}`)
            .join("; "),
        { httpStatus: 500 },
      );
    },

    async startAllBestEffort(handler) {
      const attempts: Array<{ kind: string; promise: Promise<void> }> = [];
      for (const [kind, entry] of entries) {
        if (entry.running) continue;
        attempts.push({
          kind,
          promise: buildStartPromise(entry, handler),
        });
      }

      const results = await Promise.allSettled(attempts.map((attempt) => attempt.promise));
      const summary: FridayChannelStartSummary = {
        startedKinds: [],
        failed: [],
      };

      for (const [index, result] of results.entries()) {
        const kind = attempts[index]?.kind ?? "unknown";
        if (result.status === "fulfilled") {
          summary.startedKinds.push(kind);
          failedStart.delete(kind);
          const health = healthState.get(kind);
          if (health) {
            health.blockedReason = undefined;
            health.lastError = undefined;
          }
        } else {
          const health = healthState.get(kind);
          if (health) {
            health.lastError = formatStartError(result.reason);
            health.blockedReason = "start_failed";
          }
          summary.failed.push({
            kind,
            message: formatStartError(result.reason),
          });
          failedStart.add(kind);
        }
      }

      return summary;
    },

    async stopAll() {
      // Stop health monitor first to prevent restart attempts during shutdown
      this.stopHealthMonitor();

      const stopPromises: Promise<void>[] = [];

      for (const [, entry] of entries) {
        if (!entry.running) continue;

        const stopFn = entry.plugin.adapters?.lifecycle
          ? () => entry.plugin.adapters!.lifecycle!.disconnect()
          : () => entry.plugin.stop();

        stopPromises.push(
          stopFn().finally(() => {
            entry.running = false;
          }),
        );
      }

      const results = await Promise.allSettled(stopPromises);
      const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failures.length > 0) {
        throw new FridayDomainError(
          "INTERNAL_ERROR",
          `Failed to stop ${String(failures.length)} channel(s): ` +
            failures
              .map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason)))
              .join("; "),
          { httpStatus: 500 },
        );
      }
    },

    get(kind) {
      return entries.get(kind);
    },

    list() {
      return Array.from(entries.keys());
    },

    describe(kind) {
      const entry = entries.get(kind);
      if (!entry) {
        return undefined;
      }
      return {
        kind,
        running: entry.running,
        status: this.status(kind),
        health: {
          state: this.status(kind),
          restartCount: healthState.get(kind)?.restartCount ?? 0,
          lastError: healthState.get(kind)?.lastError,
          blockedReason: healthState.get(kind)?.blockedReason,
          credentialStatus: inferCredentialStatus(
            this.diagnostics(kind),
            healthState.get(kind)?.lastError,
          ),
        },
        diagnostics: this.diagnostics(kind),
        contract: entry.plugin.contract,
        allowlist: buildAllowlistSummary(entry.allowlist),
      };
    },

    listViews() {
      return this.list()
        .map((kind) => this.describe(kind))
        .filter((view): view is FridayChannelRegistryView => view !== undefined);
    },

    async send(kind, options) {
      const entry = entries.get(kind);
      if (!entry) {
        throw new FridayDomainError("NOT_FOUND", `Channel kind "${kind}" is not registered`, { httpStatus: 404 });
      }
      if (!entry.running) {
        throw new FridayDomainError("NOT_INITIALIZED", `Channel kind "${kind}" is not running`, { httpStatus: 503 });
      }

      // Use outbound adapter if available, otherwise legacy send
      if (entry.plugin.adapters?.outbound) {
        return entry.plugin.adapters.outbound.send(options);
      }
      return entry.plugin.send(options);
    },

    async signalTyping(kind, chatId) {
      const entry = entries.get(kind);
      if (!entry || !entry.running) return;
      await entry.plugin.adapters?.outbound?.typing?.(chatId);
    },

    status(kind) {
      const entry = entries.get(kind);
      if (!entry) return "disconnected";

      // Use status adapter if available
      if (entry.plugin.adapters?.status) {
        return entry.plugin.adapters.status.status();
      }

      // Derive from running state
      return entry.running ? "connected" : "disconnected";
    },

    diagnostics(kind) {
      const entry = entries.get(kind);
      if (!entry) return undefined;

      if (entry.plugin.adapters?.status?.diagnostics) {
        return entry.plugin.adapters.status.diagnostics();
      }
      return undefined;
    },

    startHealthMonitor(handler, options = {}) {
      const intervalMs = options.intervalMs ?? HEALTH_CHECK_DEFAULT_INTERVAL_MS;
      healthHandler = handler;

      if (healthMonitorTimer !== null) {
        clearInterval(healthMonitorTimer);
      }

      // Log channels without status adapters — their health cannot be auto-monitored.
      for (const [kind, entry] of entries) {
        if (entry.running && !entry.plugin.adapters?.status) {
          console.warn(
            `[friday] Channel "${kind}" has no status adapter — health monitoring will rely on running flag only`,
          );
        }
      }

      healthMonitorTimer = setInterval(() => {
        for (const [kind, entry] of entries) {
          if (restarting.has(kind)) continue;

          if (entry.running) {
            // Only channels with a status adapter can report real connection state.
            // Channels without one derive status from entry.running (always "connected").
            const channelStatus = entry.plugin.adapters?.status?.status();
            if (channelStatus !== "disconnected" && channelStatus !== "error") continue;

            console.warn(
              `[friday] Channel "${kind}" is ${channelStatus} while marked running — attempting restart`,
            );
            entry.running = false;
            const health = healthState.get(kind);
            if (health) {
              health.blockedReason = `status:${channelStatus}`;
            }
          } else if (failedStart.has(kind)) {
            // Channel was attempted by startAllBestEffort but failed (e.g. network down at boot)
            console.warn(
              `[friday] Channel "${kind}" failed initial start — retrying connection`,
            );
          } else {
            // Channel was never attempted or was intentionally stopped — skip
            continue;
          }

          restarting.add(kind);

          buildStartPromise(entry, healthHandler!, { restart: true })
            .then(() => {
              failedStart.delete(kind);
              console.log(`[friday] Channel "${kind}" auto-restarted successfully`);
            })
            .catch((err: unknown) => {
              const health = healthState.get(kind);
              if (health) {
                health.lastError = err instanceof Error ? err.message : String(err);
                health.blockedReason = "restart_failed";
              }
              console.error(
                `[friday] Channel "${kind}" auto-restart failed:`,
                err instanceof Error ? err.message : String(err),
              );
            })
            .finally(() => {
              restarting.delete(kind);
            });
        }
      }, intervalMs);
    },

    stopHealthMonitor() {
      if (healthMonitorTimer !== null) {
        clearInterval(healthMonitorTimer);
        healthMonitorTimer = null;
      }
      healthHandler = null;
      restarting.clear();
      failedStart.clear();
    },
  };
}
