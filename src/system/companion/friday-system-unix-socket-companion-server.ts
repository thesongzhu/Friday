import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { FridayDomainError } from "#errors";

import {
  createFridaySystemCompanionRuntimeController,
  type FridaySystemCompanionRuntimeOptions,
} from "./friday-system-companion-runtime.js";
import type { FridayGuideLensOverlayCommand } from "../../guide-lens/model/friday-guide-lens.types.js";

interface FridayJsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface FridayJsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

export interface CreateFridaySystemUnixSocketCompanionServerOptions
  extends FridaySystemCompanionRuntimeOptions {
  authToken: string;
  socketPath: string;
}

export interface FridaySystemUnixSocketCompanionServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
}

async function removeUnixSocketIfPresent(socketPath: string): Promise<void> {
  try {
    const stat = await fs.lstat(socketPath);
    if (stat.isSocket()) {
      await fs.unlink(socketPath);
      return;
    }
    if (stat.isFile()) {
      throw new FridayDomainError(
        "SYSTEM_COMPANION_SOCKET_PATH_BLOCKED",
        `Refusing to remove non-socket file at companion socket path: ${socketPath}`,
        { httpStatus: 500 },
      );
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw err;
    }
  }
}

function buildErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
): FridayJsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  };
}

export function createFridaySystemUnixSocketCompanionServer(
  options: CreateFridaySystemUnixSocketCompanionServerOptions,
): FridaySystemUnixSocketCompanionServer {
  let running = false;
  let server: net.Server | null = null;
  let lastHeartbeatAt = options.nowIso();
  const sockets = new Set<net.Socket>();
  const controller = createFridaySystemCompanionRuntimeController(options);

  async function handleMethod(
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    lastHeartbeatAt = options.nowIso();
    switch (method) {
      case "companion.ping":
        return controller.ping();
      case "companion.getStatus":
        return controller.getStatus({
          connected: true,
          authenticated: true,
          transportMode: "unix_socket",
          lastHeartbeatAt,
        });
      case "companion.captureSnapshot":
        return controller.captureSnapshot();
      case "companion.arrangeWindows":
        return controller.arrangeWindows(
          typeof params?.layout === "string" ? params.layout as Parameters<typeof controller.arrangeWindows>[0] : undefined,
        );
      case "companion.launchApp":
        return controller.launchApp(String(params?.appIdentifier ?? ""));
      case "companion.focusTarget":
        return controller.focusTarget({
          appIdentifier: typeof params?.appIdentifier === "string" ? params.appIdentifier : undefined,
          windowId: typeof params?.windowId === "string" ? params.windowId : undefined,
        });
      case "companion.openUrl":
        return controller.openUrl(String(params?.url ?? ""));
      case "companion.openProject":
        return controller.openProject(String(params?.projectPath ?? ""));
      case "companion.listNotifications":
        return controller.listNotifications();
      case "companion.actOnNotification":
        return controller.actOnNotification({
          notificationId: String(params?.notificationId ?? ""),
          action: String(params?.action ?? "open") as "open" | "dismiss" | "mark_read",
        });
      case "companion.setOverlayVisible":
        return controller.setOverlayVisible(Boolean(params?.visible));
      case "companion.showGuideOverlay":
        return controller.showGuideOverlay(params?.command as FridayGuideLensOverlayCommand);
      case "companion.clearGuideOverlay":
        return controller.clearGuideOverlay();
      default:
        throw new FridayDomainError("VALIDATION_ERROR", `Unknown companion method: ${method}`, { httpStatus: 400 });
    }
  }

  async function handleRequest(raw: string): Promise<FridayJsonRpcResponse> {
    let request: FridayJsonRpcRequest;
    try {
      request = JSON.parse(raw) as FridayJsonRpcRequest;
    } catch (err) {
      console.warn("[friday][unix-socket-companion-server] JSON-RPC parse error:", err instanceof Error ? err.message : String(err));
      return buildErrorResponse(null, -32700, "Parse error");
    }

    const id = request.id ?? null;
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      return buildErrorResponse(id, -32600, "Invalid Request");
    }

    const authToken = typeof request.params?.authToken === "string"
      ? request.params.authToken
      : undefined;
    if (authToken !== options.authToken) {
      return buildErrorResponse(id, -32001, "Unauthorized");
    }

    try {
      const result = await handleMethod(request.method, request.params);
      return {
        jsonrpc: "2.0",
        id,
        result,
      };
    } catch (error) {
      return buildErrorResponse(
        id,
        -32603,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return {
    async start(): Promise<void> {
      if (running) {
        return;
      }

      await fs.mkdir(path.dirname(options.socketPath), { recursive: true });
      await removeUnixSocketIfPresent(options.socketPath);

      server = net.createServer((socket) => {
        sockets.add(socket);
        let buffer = "";

        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          buffer += chunk;
          const frames = buffer.split("\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const trimmed = frame.trim();
            if (trimmed.length === 0) {
              continue;
            }
            void handleRequest(trimmed)
              .then((response) => {
                socket.write(`${JSON.stringify(response)}\n`);
                socket.end();
              })
              .catch(() => {
                socket.end(`${JSON.stringify(buildErrorResponse(null, -32603, "Internal error"))}\n`);
              });
          }
        });

        const removeSocket = () => {
          sockets.delete(socket);
        };

        socket.on("close", removeSocket);
        socket.on("error", removeSocket);
      });

      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(options.socketPath, () => {
          server!.off("error", reject);
          running = true;
          resolve();
        });
      });
    },

    async stop(): Promise<void> {
      if (!running) {
        return;
      }

      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();

      await new Promise<void>((resolve, reject) => {
        server?.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

      server = null;
      running = false;
      await removeUnixSocketIfPresent(options.socketPath);
    },

    isRunning(): boolean {
      return running;
    },
  };
}
