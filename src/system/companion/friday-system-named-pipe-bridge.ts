import * as net from "node:net";

import type { FridaySystemCompanionStatus, ISODateTime } from "../model/friday-system.types.js";
import type {
  FridaySystemCompanionBridge,
  FridaySystemCompanionFocusTargetInput,
  FridaySystemCompanionSnapshot,
  FridaySystemCompanionWindowArrangementResult,
} from "./friday-system-companion.types.js";
import {
  buildFridaySystemCompanionStatus,
  type FridaySystemCompanionRuntimeOptions,
} from "./friday-system-companion-runtime.js";

interface FridayJsonRpcResponse {
  jsonrpc: "2.0";
  id: string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

export interface CreateFridaySystemNamedPipeBridgeOptions
  extends FridaySystemCompanionRuntimeOptions {
  authToken: string;
  pipeName: string;
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

function normalizeCompanionStatus(
  status: FridaySystemCompanionStatus,
  options: CreateFridaySystemNamedPipeBridgeOptions,
): FridaySystemCompanionStatus {
  const rawCapabilities = status.capabilities as unknown as Record<string, unknown>;
  const hasStructuredCapabilities =
    typeof rawCapabilities === "object"
    && rawCapabilities !== null
    && "surfaces" in rawCapabilities
    && "actions" in rawCapabilities;

  return {
    ...status,
    transport: {
      ...status.transport,
      mode: "named_pipe",
      pipeName: options.pipeName,
      socketPath: undefined,
    },
    capabilities: hasStructuredCapabilities
      ? status.capabilities
      : {
        surfaces: {
          launchAtLogin: Boolean(rawCapabilities.launchAtLogin),
          menuBar: Boolean(rawCapabilities.menuBar),
          overlay: Boolean(rawCapabilities.overlay),
          globalHotkey: Boolean(rawCapabilities.globalHotkey),
          windowInventory: Boolean(rawCapabilities.windowInventory),
          notificationIntake: Boolean(rawCapabilities.notificationIntake),
          screenCapture: Boolean(rawCapabilities.screenCapture),
        },
        actions: {
          snapshot: "supported",
          launch_app: "supported",
          focus: "supported",
          open_url: "supported",
          open_project: "supported",
          handoff_to_browser: "supported",
          handoff_to_terminal: "supported",
          arrange_windows: rawCapabilities.windowInventory ? "supported" : "unsupported",
          notification_list: rawCapabilities.notificationIntake ? "supported" : "unsupported",
          read_notification: rawCapabilities.notificationIntake ? "supported" : "unsupported",
          notification_act: rawCapabilities.notificationIntake ? "supported" : "unsupported",
          recover_ui: "supported",
        },
      },
  };
}

export function createFridaySystemNamedPipeBridge(
  options: CreateFridaySystemNamedPipeBridgeOptions,
): FridaySystemCompanionBridge {
  let connected = false;
  let lastHeartbeatAt = options.nowIso();

  async function callRpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const requestId = `${options.id}:${method}:${options.nowIso()}`;
    const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    return new Promise<T>((resolve, reject) => {
      const socket = net.createConnection(options.pipeName);
      let settled = false;
      let buffer = "";

      const cleanup = () => {
        socket.removeAllListeners();
      };

      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        cleanup();
        fn();
      };

      const timeout = setTimeout(() => {
        finish(() => {
          socket.destroy();
          reject(new Error(`Companion request timed out: ${method}`));
        });
      }, timeoutMs);

      socket.setEncoding("utf8");

      socket.on("connect", () => {
        socket.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          method,
          params: {
            authToken: options.authToken,
            ...(params ?? {}),
          },
        })}\n`);
      });

      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0) {
          return;
        }
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length === 0) {
          return;
        }

        let response: FridayJsonRpcResponse;
        try {
          response = JSON.parse(line) as FridayJsonRpcResponse;
        } catch (err) {
          console.warn("[friday][named-pipe-bridge] parse-rpc-response:", err instanceof Error ? err.message : String(err));
          finish(() => {
            socket.destroy();
            reject(new Error("Invalid JSON-RPC response from companion"));
          });
          return;
        }

        if (response.error) {
          finish(() => {
            socket.end();
            reject(new Error(response.error!.message));
          });
          return;
        }

        finish(() => {
          socket.end();
          resolve(response.result as T);
        });
      });

      socket.on("error", (error) => {
        finish(() => {
          socket.destroy();
          reject(error);
        });
      });

      socket.on("end", () => {
        if (!settled && buffer.trim().length === 0) {
          finish(() => {
            reject(new Error(`Companion closed connection before responding: ${method}`));
          });
        }
      });
    });
  }

  return {
    async connect(): Promise<void> {
      await callRpc<{ ok: boolean; serverTime: ISODateTime }>("companion.ping");
      connected = true;
      lastHeartbeatAt = options.nowIso();
    },

    async disconnect(): Promise<void> {
      connected = false;
      lastHeartbeatAt = options.nowIso();
    },

    isConnected(): boolean {
      return connected;
    },

    async ping() {
      const result = await callRpc<{ ok: boolean; serverTime: ISODateTime }>("companion.ping");
      connected = true;
      lastHeartbeatAt = result.serverTime;
      return result;
    },

    async getStatus(): Promise<FridaySystemCompanionStatus> {
      try {
        const status = normalizeCompanionStatus(
          await callRpc<FridaySystemCompanionStatus>("companion.getStatus"),
          options,
        );
        connected = true;
        lastHeartbeatAt = status.lastHeartbeatAt;
        return status;
      } catch (err) {
        console.warn("[friday][named-pipe-bridge] getStatus:", err instanceof Error ? err.message : String(err));
        connected = false;
        lastHeartbeatAt = options.nowIso();
        return buildFridaySystemCompanionStatus(options, {
          connected: false,
          authenticated: false,
          transportMode: "named_pipe",
          lastHeartbeatAt,
        });
      }
    },

    async captureSnapshot(): Promise<FridaySystemCompanionSnapshot> {
      try {
        const snapshot = await callRpc<FridaySystemCompanionSnapshot>("companion.captureSnapshot");
        connected = true;
        lastHeartbeatAt = options.nowIso();
        return snapshot;
      } catch (err) {
        console.warn("[friday][named-pipe-bridge] captureSnapshot:", err instanceof Error ? err.message : String(err));
        connected = false;
        lastHeartbeatAt = options.nowIso();
        return {
          apps: [],
          windows: [],
          notifications: [],
        };
      }
    },

    async arrangeWindows(layout) {
      try {
        const result = await callRpc<FridaySystemCompanionWindowArrangementResult | null>(
          "companion.arrangeWindows",
          layout ? { layout } : undefined,
        );
        connected = true;
        lastHeartbeatAt = options.nowIso();
        return result;
      } catch (err) {
        console.warn("[friday][named-pipe-bridge] arrangeWindows:", err instanceof Error ? err.message : String(err));
        connected = false;
        lastHeartbeatAt = options.nowIso();
        return null;
      }
    },

    async launchApp(appIdentifier) {
      try {
        const result = await callRpc("companion.launchApp", { appIdentifier });
        connected = true;
        lastHeartbeatAt = options.nowIso();
        return result as Awaited<ReturnType<FridaySystemCompanionBridge["launchApp"]>>;
      } catch (err) {
        console.warn("[friday][named-pipe-bridge] launchApp:", err instanceof Error ? err.message : String(err));
        connected = false;
        lastHeartbeatAt = options.nowIso();
        return null;
      }
    },

    async focusTarget(input: FridaySystemCompanionFocusTargetInput) {
      try {
        const result = await callRpc("companion.focusTarget", {
          ...(input.appIdentifier ? { appIdentifier: input.appIdentifier } : {}),
          ...(input.windowId ? { windowId: input.windowId } : {}),
        });
        connected = true;
        lastHeartbeatAt = options.nowIso();
        return result as Awaited<ReturnType<FridaySystemCompanionBridge["focusTarget"]>>;
      } catch (err) {
        console.warn("[friday][named-pipe-bridge] focusTarget:", err instanceof Error ? err.message : String(err));
        connected = false;
        lastHeartbeatAt = options.nowIso();
        return null;
      }
    },

    async openUrl(url) {
      try {
        const result = await callRpc("companion.openUrl", { url });
        connected = true;
        lastHeartbeatAt = options.nowIso();
        return result as Awaited<ReturnType<FridaySystemCompanionBridge["openUrl"]>>;
      } catch (err) {
        console.warn("[friday][named-pipe-bridge] openUrl:", err instanceof Error ? err.message : String(err));
        connected = false;
        lastHeartbeatAt = options.nowIso();
        return null;
      }
    },

    async openProject(projectPath) {
      try {
        const result = await callRpc("companion.openProject", { projectPath });
        connected = true;
        lastHeartbeatAt = options.nowIso();
        return result as Awaited<ReturnType<FridaySystemCompanionBridge["openProject"]>>;
      } catch (err) {
        console.warn("[friday][named-pipe-bridge] openProject:", err instanceof Error ? err.message : String(err));
        connected = false;
        lastHeartbeatAt = options.nowIso();
        return null;
      }
    },

    async listNotifications() {
      try {
        const result = await callRpc("companion.listNotifications");
        connected = true;
        lastHeartbeatAt = options.nowIso();
        return result as Awaited<ReturnType<FridaySystemCompanionBridge["listNotifications"]>>;
      } catch (err) {
        console.warn("[friday][named-pipe-bridge] listNotifications:", err instanceof Error ? err.message : String(err));
        connected = false;
        lastHeartbeatAt = options.nowIso();
        return [];
      }
    },

    async actOnNotification(input) {
      try {
        const result = await callRpc("companion.actOnNotification", {
          notificationId: input.notificationId,
          action: input.action,
        });
        connected = true;
        lastHeartbeatAt = options.nowIso();
        return result as Awaited<ReturnType<FridaySystemCompanionBridge["actOnNotification"]>>;
      } catch (err) {
        console.warn("[friday][named-pipe-bridge] actOnNotification:", err instanceof Error ? err.message : String(err));
        connected = false;
        lastHeartbeatAt = options.nowIso();
        return null;
      }
    },

    async setOverlayVisible(visible) {
      try {
        const result = await callRpc("companion.setOverlayVisible", { visible });
        connected = true;
        lastHeartbeatAt = options.nowIso();
        return result as Awaited<ReturnType<FridaySystemCompanionBridge["setOverlayVisible"]>>;
      } catch (err) {
        console.warn("[friday][named-pipe-bridge] setOverlayVisible:", err instanceof Error ? err.message : String(err));
        connected = false;
        lastHeartbeatAt = options.nowIso();
        return {
          visible,
          changedAt: options.nowIso(),
        };
      }
    },
  };
}
