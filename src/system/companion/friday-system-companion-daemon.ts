import * as path from "node:path";

import { createFridaySystemUnixSocketCompanionServer } from "./friday-system-unix-socket-companion-server.js";

function resolveWorkspaceRoot(): string {
  return process.env.FRIDAY_WORKSPACE_ROOT
    ? path.resolve(process.env.FRIDAY_WORKSPACE_ROOT)
    : process.cwd();
}

function resolveNowIso(): string {
  return new Date().toISOString();
}

async function main(): Promise<void> {
  const workspaceRoot = resolveWorkspaceRoot();
  const socketPath = process.env.FRIDAY_SYSTEM_COMPANION_SOCKET_PATH
    ? path.resolve(process.env.FRIDAY_SYSTEM_COMPANION_SOCKET_PATH)
    : path.join(workspaceRoot, ".friday", "run", "system-companion.sock");
  const authToken = process.env.FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN;
  if (!authToken) {
    throw new Error("FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN is required for the companion daemon");
  }

  const server = createFridaySystemUnixSocketCompanionServer({
    id: process.env.FRIDAY_SYSTEM_COMPANION_ID ?? "friday-system-companion",
    platform: process.platform === "darwin" || process.platform === "linux" || process.platform === "win32"
      ? process.platform
      : "unknown",
    nowIso: resolveNowIso,
    runtimeKind: "node_daemon",
    authToken,
    socketPath,
    launchAtLoginEnabled: process.env.FRIDAY_SYSTEM_LAUNCH_AT_LOGIN !== "false",
    panicHotkey: process.env.FRIDAY_SYSTEM_PANIC_HOTKEY ?? "cmd+shift+escape",
    menuBarEnabled: true,
    overlayEnabled: true,
  });

  await server.start();
  console.log(`[friday-companion] listening on ${socketPath}`);

  const shutdown = async (signal: string) => {
    console.log(`[friday-companion] shutting down on ${signal}`);
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGHUP", () => { void shutdown("SIGHUP"); });
}

void main().catch((error: unknown) => {
  console.error(
    "[friday-companion] fatal:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
