import * as crypto from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createFridaySystemUnixSocketBridge } from "../../../src/system/companion/friday-system-unix-socket-bridge.js";

const execFileAsync = promisify(execFile);
const describeIfDarwin = process.platform === "darwin" ? describe : describe.skip;

interface NativeCompanionHandle {
  child: ChildProcess;
  tempDir: string;
  socketPath: string;
  authToken: string;
  readStdout: () => string;
  readStderr: () => string;
}

async function buildNativeCompanionBinary(repoRoot: string): Promise<string> {
  const packagePath = path.join(repoRoot, "apps/macos/FridayCompanion");
  await execFileAsync("swift", ["build", "-c", "debug", "--package-path", packagePath], {
    cwd: repoRoot,
  });
  return path.join(packagePath, ".build", "debug", "FridayCompanion");
}

async function buildNativeCompanionApp(repoRoot: string): Promise<string> {
  const { stdout } = await execFileAsync("bash", ["scripts/ops/build-friday-companion-app.sh", repoRoot], {
    cwd: repoRoot,
  });
  return stdout.trim();
}

async function seedNotificationDatabase(databasePath: string): Promise<void> {
  const seedScript = `
import os
import plistlib
import sqlite3
import sys

database_path = sys.argv[1]
os.makedirs(os.path.dirname(database_path), exist_ok=True)
connection = sqlite3.connect(database_path)
connection.executescript("""
CREATE TABLE app (app_id INTEGER PRIMARY KEY, identifier VARCHAR, badge INTEGER NULL);
CREATE TABLE delivered (app_id INTEGER PRIMARY KEY, list BLOB);
CREATE TABLE displayed (app_id INTEGER PRIMARY KEY, list BLOB);
CREATE TABLE requests (app_id INTEGER PRIMARY KEY, list BLOB);
CREATE TABLE record (
  rec_id INTEGER PRIMARY KEY,
  app_id INTEGER,
  uuid BLOB,
  data BLOB,
  request_date REAL,
  request_last_date REAL,
  delivered_date REAL,
  presented Bool,
  style INTEGER,
  snooze_fire_date REAL
);
""")
payload = plistlib.dumps({
  "app": "com.openai.codex",
  "req": {
    "titl": "Build complete",
    "body": "All tests passed",
    "iden": "com.openai.codex:notification:test-1",
    "durl": "codex://thread/1"
  }
}, fmt=plistlib.FMT_BINARY)
delivered = 794549257.601622
connection.execute(
  "INSERT INTO app (app_id, identifier, badge) VALUES (1, ?, NULL)",
  ("com.openai.codex",),
)
connection.execute(
  """
  INSERT INTO record (
    app_id,
    uuid,
    data,
    request_date,
    request_last_date,
    delivered_date,
    presented,
    style,
    snooze_fire_date
  ) VALUES (1, ?, ?, ?, ?, ?, 0, 0, NULL)
  """,
  (bytes.fromhex("11111111111111111111111111111111"), payload, delivered, delivered, delivered),
)
uuid_list = bytes.fromhex("11111111111111111111111111111111")
for table in ("delivered", "displayed", "requests"):
    connection.execute(
      f"INSERT INTO {table} (app_id, list) VALUES (1, ?)",
      (uuid_list,),
    )
connection.commit()
connection.close()
`;
  await execFileAsync("python3", ["-c", seedScript, databasePath]);
}

async function notificationListContains(
  databasePath: string,
  table: "delivered" | "displayed" | "requests",
  uuidHex: string,
): Promise<boolean> {
  const inspectScript = `
import binascii
import sqlite3
import sys

database_path, table_name, uuid_hex = sys.argv[1], sys.argv[2], sys.argv[3]
connection = sqlite3.connect(database_path)
row = connection.execute(f"SELECT list FROM {table_name} WHERE app_id = 1").fetchone()
connection.close()
blob = row[0] if row else None
if blob is None:
    print("false")
else:
    print("true" if uuid_hex.encode() in binascii.hexlify(blob) else "false")
`;
  const { stdout } = await execFileAsync("python3", ["-c", inspectScript, databasePath, table, uuidHex]);
  return stdout.trim() === "true";
}

async function spawnNativeCompanionProcess(
  repoRoot: string,
  command: string,
  args: string[],
  workspaceRoot: string | "__TEMP_DIR__" | undefined,
  envOverrides: Record<string, string> = {},
): Promise<NativeCompanionHandle> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-native-companion-"));
  const socketPath = path.join(tempDir, "system-companion.sock");
  const authToken = crypto.randomBytes(32).toString("hex");
  const authTokenFile = path.join(tempDir, "system-companion.auth.token");
  await fs.writeFile(authTokenFile, authToken, { encoding: "utf8", mode: 0o600 });

  let stdout = "";
  let stderr = "";
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      FRIDAY_SYSTEM_COMPANION_ID: "friday-native-test",
      FRIDAY_SYSTEM_COMPANION_SOCKET_PATH: socketPath,
      FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN_FILE: authTokenFile,
      FRIDAY_SYSTEM_LAUNCH_AT_LOGIN: "false",
      FRIDAY_SYSTEM_COMPANION_HEARTBEAT_MS: "1000",
      ...(workspaceRoot
        ? {
            FRIDAY_WORKSPACE_ROOT: workspaceRoot === "__TEMP_DIR__"
              ? tempDir
              : workspaceRoot,
          }
        : {}),
      ...envOverrides,
    },
  });

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const bridge = createFridaySystemUnixSocketBridge({
    id: "friday-native-bridge",
    platform: "darwin",
    nowIso: () => new Date().toISOString(),
    authToken,
    socketPath,
    requestTimeoutMs: 1_000,
    launchAtLoginEnabled: false,
    panicHotkey: "cmd+shift+escape",
    menuBarEnabled: true,
    overlayEnabled: true,
  });

  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(
        `Native companion exited before accepting socket connections (code=${child.exitCode}). stderr=${stderr.trim()}`,
      );
    }
    try {
      await bridge.connect();
      await bridge.disconnect();
      return {
        child,
        tempDir,
        socketPath,
        authToken,
        readStdout: () => stdout,
        readStderr: () => stderr,
      };
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }

  child.kill("SIGKILL");
  await fs.rm(tempDir, { recursive: true, force: true });
  throw new Error(
    `Native companion socket did not become ready. lastError=${String(lastError)} stderr=${stderr.trim()} stdout=${stdout.trim()}`,
  );
}

describeIfDarwin("Friday native Swift companion integration", () => {
  const cleanup: NativeCompanionHandle[] = [];
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const handle = cleanup.pop()!;
      if (handle.child.exitCode === null) {
        handle.child.kill("SIGTERM");
        await delay(500);
      }
      if (handle.child.exitCode === null) {
        handle.child.kill("SIGKILL");
      }
      await fs.rm(handle.tempDir, { recursive: true, force: true });
    }
    while (cleanupDirs.length > 0) {
      const directory = cleanupDirs.pop()!;
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("spawns the real Swift companion and serves authenticated unix-socket RPC", async () => {
    const repoRoot = process.cwd();
    const binaryPath = await buildNativeCompanionBinary(repoRoot);
    const notificationDbDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-native-usernoted-"));
    const notificationDbPath = path.join(notificationDbDir, "usernoted.db");
    await seedNotificationDatabase(notificationDbPath);
    const handle = await spawnNativeCompanionProcess(
      repoRoot,
      binaryPath,
      [],
      "__TEMP_DIR__",
      {
        FRIDAY_SYSTEM_NOTIFICATION_DB_PATH: notificationDbPath,
      },
    );
    cleanup.push(handle);
    cleanupDirs.push(notificationDbDir);

    const authToken = await fs.readFile(
      path.join(handle.tempDir, "system-companion.auth.token"),
      "utf8",
    );
    const bridge = createFridaySystemUnixSocketBridge({
      id: "friday-native-bridge",
      platform: "darwin",
      nowIso: () => new Date().toISOString(),
      authToken: authToken.trim(),
      socketPath: path.join(handle.tempDir, "system-companion.sock"),
      requestTimeoutMs: 1_000,
      launchAtLoginEnabled: false,
      panicHotkey: "cmd+shift+escape",
      menuBarEnabled: true,
      overlayEnabled: true,
    });

    await bridge.connect();
    const ping = await bridge.ping();
    const status = await bridge.getStatus();
    const snapshot = await bridge.captureSnapshot();
    const notifications = await bridge.listNotifications();
    const markedRead = await bridge.actOnNotification({
      notificationId: "com.openai.codex:notification:test-1",
      action: "mark_read",
    });
    const displayedAfterMarkRead = await notificationListContains(
      notificationDbPath,
      "displayed",
      "11111111111111111111111111111111",
    );
    const dismissed = await bridge.actOnNotification({
      notificationId: "com.openai.codex:notification:test-1",
      action: "dismiss",
    });
    const deliveredAfterDismiss = await notificationListContains(
      notificationDbPath,
      "delivered",
      "11111111111111111111111111111111",
    );
    const requestsAfterDismiss = await notificationListContains(
      notificationDbPath,
      "requests",
      "11111111111111111111111111111111",
    );
    const notificationsAfterDismiss = await bridge.listNotifications();
    const overlayEnabled = await bridge.setOverlayVisible(true);
    const overlayDisabled = await bridge.setOverlayVisible(false);
    const updatedStatus = await bridge.getStatus();

    expect(ping.ok).toBe(true);
    expect(status.connected).toBe(true);
    expect(status.runtimeKind).toBe("swift_binary");
    expect(status.transport.mode).toBe("unix_socket");
    expect(status.transport.authenticated).toBe(true);
    expect(status.capabilities.surfaces.menuBar).toBe(true);
    expect(status.capabilities.surfaces.overlay).toBe(true);
    expect(status.capabilities.surfaces.globalHotkey).toBe(true);
    expect(status.capabilities.actions.arrange_windows).toBe("supported");
    expect(status.launchAtLoginEnabled).toBe(false);
    expect(Array.isArray(status.permissions)).toBe(true);
    expect(Array.isArray(snapshot.apps)).toBe(true);
    expect(Array.isArray(snapshot.windows)).toBe(true);
    expect(notifications).toEqual([
      {
        id: "com.openai.codex:notification:test-1",
        sourceApp: "com.openai.codex",
        title: "Build complete",
        body: "All tests passed",
        deepLinkUrl: "codex://thread/1",
        receivedAt: "2026-03-07T04:07:37.602Z",
        read: false,
      },
    ]);
    expect(snapshot.notifications).toEqual(notifications);
    expect(markedRead?.notification.read).toBe(true);
    expect(displayedAfterMarkRead).toBe(false);
    expect(dismissed?.notification.read).toBe(true);
    expect(deliveredAfterDismiss).toBe(false);
    expect(requestsAfterDismiss).toBe(false);
    expect(notificationsAfterDismiss).toEqual([]);
    expect(overlayEnabled.visible).toBe(true);
    expect(overlayDisabled.visible).toBe(false);
    expect(updatedStatus.overlayVisible).toBe(false);
    expect(updatedStatus.safeMode).toBe(false);
    expect(handle.readStderr()).not.toContain("failed to start socket server");

    await bridge.disconnect();
  }, 180_000);

  it("prefers the packaged app through the operational runner and reports swift_app runtime", async () => {
    const repoRoot = process.cwd();
    const appDir = await buildNativeCompanionApp(repoRoot);
    const appBinary = path.join(appDir, "Contents", "MacOS", "FridayCompanion");
    const handle = await spawnNativeCompanionProcess(
      repoRoot,
      "bash",
      [path.join(repoRoot, "scripts/ops/friday-companion-run.sh"), repoRoot],
      repoRoot,
      {
        FRIDAY_BUILD_ON_START: "never",
        FRIDAY_SYSTEM_NATIVE_COMPANION_MODE: "auto",
        FRIDAY_SYSTEM_COMPANION_APP_BINARY: appBinary,
      },
    );
    cleanup.push(handle);

    const bridge = createFridaySystemUnixSocketBridge({
      id: "friday-native-runner-bridge",
      platform: "darwin",
      nowIso: () => new Date().toISOString(),
      authToken: handle.authToken,
      socketPath: handle.socketPath,
      requestTimeoutMs: 1_000,
      launchAtLoginEnabled: false,
      panicHotkey: "cmd+shift+escape",
      menuBarEnabled: true,
      overlayEnabled: true,
    });

    await bridge.connect();
    const status = await bridge.getStatus();

    expect(status.connected).toBe(true);
    expect(status.runtimeKind).toBe("swift_app");
    expect(status.transport.mode).toBe("unix_socket");
    expect(handle.readStderr()).toContain("starting packaged native companion");

    await bridge.disconnect();
  }, 120_000);
});
