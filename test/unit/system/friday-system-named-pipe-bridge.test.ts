import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFridaySystemNamedPipeBridge } from "../../../src/system/companion/friday-system-named-pipe-bridge.js";
import { createFridaySystemUnixSocketCompanionServer } from "../../../src/system/companion/friday-system-unix-socket-companion-server.js";

function createNowIso() {
  let tick = 0;
  const start = Date.parse("2026-03-06T12:00:00.000Z");
  return () => new Date(start + tick++ * 1000).toISOString();
}

describe("Friday system named pipe companion transport", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    while (cleanupPaths.length > 0) {
      const dir = cleanupPaths.pop()!;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("speaks the shared JSON-RPC contract and reports named_pipe transport metadata", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-system-pipe-"));
    cleanupPaths.push(tempDir);
    const transportPath = path.join(tempDir, "companion.pipe");
    const nowIso = createNowIso();
    const server = createFridaySystemUnixSocketCompanionServer({
      id: "companion-pipe",
      platform: "win32",
      nowIso,
      authToken: "secret-token",
      socketPath: transportPath,
      launchAtLoginEnabled: true,
      panicHotkey: "ctrl+shift+escape",
      menuBarEnabled: false,
      overlayEnabled: true,
      appCollector: async () => [
        {
          id: "app:terminal",
          name: "Windows Terminal",
          running: true,
          frontmost: true,
        },
      ],
    });

    await server.start();
    const bridge = createFridaySystemNamedPipeBridge({
      id: "companion-pipe",
      platform: "win32",
      nowIso,
      authToken: "secret-token",
      pipeName: transportPath,
      launchAtLoginEnabled: true,
      panicHotkey: "ctrl+shift+escape",
      overlayEnabled: true,
    });

    await bridge.connect();
    const status = await bridge.getStatus();
    const snapshot = await bridge.captureSnapshot();

    expect(status.connected).toBe(true);
    expect(status.transport.mode).toBe("named_pipe");
    expect(status.transport.pipeName).toBe(transportPath);
    expect(status.capabilities.actions.arrange_windows).toBe("unsupported");
    expect(snapshot.apps[0]?.name).toBe("Windows Terminal");

    await bridge.disconnect();
    await server.stop();
  });
});
