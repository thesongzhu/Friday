/**
 * DUR-OPERATION-JOURNAL-001 — HTTP idempotency durability across a process restart
 * (production posture: real hub, real SQLite state dir, real HTTP server, real reboot).
 *
 * The generic non-GET idempotency guard in friday-http-server.ts reserved/completed
 * idempotency keys in an in-memory `Map`. The handler commits its durable side-effect
 * FIRST, then the Map is upgraded to `completed`. On a process restart the Map is gone,
 * so a retry with the same `Idempotency-Key` MISSES and the handler RE-EXECUTES —
 * duplicating the effect.
 *
 * This test boots a real hub, issues a mutating POST /v1/agent/automations with a fixed
 * `Idempotency-Key` (which commits a durable `friday_agent_automations` row via a
 * server-minted id — NO natural dedup key, so a re-execution is directly countable),
 * shuts the hub down (crash), reboots from the SAME state dir, and replays the
 * byte-identical POST + same key.
 *
 * The durable operation journal makes the reboot resolve the replay from SQLite:
 *   - the second response carries `Idempotency-Replayed: true`
 *   - the automation row COUNT stays 1 (the effect happened exactly once)
 *   - the replayed body returns the SAME automation id
 *
 * On the unmodified code the durable store + injection point do not exist, so the
 * store injection fails to load (RED). After the fix it passes (GREEN). When ONLY the
 * production fix is reverted (store class kept, injection reverted), the injected
 * durable store is ignored → the effect duplicates → COUNT 2 (behavioral REVERT-RED).
 *
 * No live LLM provider is required: the automation-create side-effect is a pure SQLite
 * write, so this runs deterministically offline while still exercising the real HTTP +
 * SQLite + reboot path the defect lives on.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createFridayHub, type FridayHub } from "#hub";
import { createFridayHttpServer, type FridayHttpServer } from "#api";
import { FridaySqliteOperationJournalStore } from "../../../src/api/http/persistence/friday-operation-journal-repository.js";

const LOCAL_PASSPHRASE = "friday-op-journal-durability-passphrase-123"; // pragma: allowlist secret

interface DurabilityHubEnv {
  hub: FridayHub;
  httpServer: FridayHttpServer;
  baseUrl: string;
  accessToken: string;
  stateDir: string;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("Could not determine free port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function bootDurabilityHub(stateDir: string): Promise<DurabilityHubEnv> {
  const hub = await createFridayHub({
    stateDir,
    skillDirs: [],
    port: 0,
    logRequests: false,
    // Test-oracle opt-ins so the agent runtime (and thus the automation route) is live
    // in an isolated hub — production leaves these unset.
    allowTestOnlyAgentRunStartExecution: true,
    allowTestOnlyAgentRunControlExecution: true,
    allowTestOnlyAgentRunExecution: true,
  });
  await hub.start();

  // Wire the DURABLE cross-store operation journal exactly as the production CLI run
  // loop does — this is the fix under test.
  const idempotencyStore = new FridaySqliteOperationJournalStore(hub.apiRuntime.db!);

  const port = await findFreePort();
  const httpServer = createFridayHttpServer({
    routes: hub.apiRuntime.routes,
    wsGateway: hub.apiRuntime.wsGateway,
    middleware: hub.apiRuntime.middleware,
    webchatWsService: hub.webchatWsService,
    idempotencyStore,
    port,
    host: "127.0.0.1",
    logRequests: false,
  });
  await httpServer.listen();
  const baseUrl = `http://127.0.0.1:${String(port)}`;

  const bootstrapStatusRes = await fetch(`${baseUrl}/v1/auth/bootstrap/status`);
  const bootstrapStatus = (await bootstrapStatusRes.json()) as {
    data?: { bootstrapRequired?: boolean };
    bootstrapRequired?: boolean;
  };
  const bootstrapRequired =
    bootstrapStatus.data?.bootstrapRequired ?? bootstrapStatus.bootstrapRequired ?? false;
  if (bootstrapRequired) {
    const bootstrapRes = await fetch(`${baseUrl}/v1/auth/bootstrap/local-passphrase`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPassphrase: LOCAL_PASSPHRASE }),
    });
    if (!bootstrapRes.ok) {
      throw new Error(`Local passphrase bootstrap failed: ${String(bootstrapRes.status)}`);
    }
  }

  const loginRes = await fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ localPassphrase: LOCAL_PASSPHRASE }),
  });
  const loginJson = (await loginRes.json()) as {
    ok: boolean;
    data?: { accessToken?: string };
  };
  if (!loginJson.ok || !loginJson.data?.accessToken) {
    throw new Error(`Admin login failed: ${JSON.stringify(loginJson)}`);
  }

  return { hub, httpServer, baseUrl, accessToken: loginJson.data.accessToken, stateDir };
}

async function shutdownDurabilityHub(env: DurabilityHubEnv): Promise<void> {
  try {
    await env.httpServer.close();
  } catch {
    /* best effort */
  }
  try {
    await env.hub.stop();
  } catch {
    /* best effort */
  }
}

function countAutomations(env: DurabilityHubEnv): number {
  return env.hub.apiRuntime.db!.withReadConnection(
    (db) =>
      (db.prepare("SELECT COUNT(*) AS n FROM friday_agent_automations").get() as { n: number }).n,
  );
}

describe("Friday HTTP operation journal — idempotency survives a process restart", () => {
  let stateDir: string | undefined;

  afterEach(() => {
    if (stateDir) {
      try {
        fs.rmSync(stateDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      stateDir = undefined;
    }
  });

  it(
    "replays the completed response after a crash+reboot instead of re-executing the side-effect",
    { timeout: 120_000 },
    async () => {
      stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-op-journal-e2e-"));
      const idempotencyKey = `op-journal-durability-${Date.now()}`;
      const body = JSON.stringify({
        name: "Durability Proof Automation",
        taskTemplate: "echo durability",
        schedule: { type: "cron", cron: "0 9 * * *", timezone: "UTC" },
        enabled: false,
      });

      // ── Boot 1: commit the durable side-effect through the generic idempotency guard ──
      let env = await bootDurabilityHub(stateDir);
      try {
        expect(countAutomations(env)).toBe(0);

        const firstRes = await fetch(`${env.baseUrl}/v1/agent/automations`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.accessToken}`,
            "Idempotency-Key": idempotencyKey,
          },
          body,
        });
        expect(firstRes.status).toBe(200);
        expect(firstRes.headers.get("idempotency-replayed")).toBeNull();
        const firstJson = (await firstRes.json()) as {
          ok: boolean;
          data?: { automation?: { id?: string } };
        };
        expect(firstJson.ok).toBe(true);
        const firstAutomationId = firstJson.data?.automation?.id;
        expect(firstAutomationId).toBeTruthy();
        expect(countAutomations(env)).toBe(1);
      } finally {
        await shutdownDurabilityHub(env);
      }

      // ── Boot 2: reboot from the SAME state dir (the in-memory Map is gone) ──
      env = await bootDurabilityHub(stateDir);
      try {
        // Effect is still durably present from boot 1.
        expect(countAutomations(env)).toBe(1);

        const replayRes = await fetch(`${env.baseUrl}/v1/agent/automations`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.accessToken}`,
            "Idempotency-Key": idempotencyKey,
          },
          body,
        });
        expect(replayRes.status).toBe(200);

        // DURABILITY: the replay is resolved from the SQLite journal, not re-executed.
        expect(replayRes.headers.get("idempotency-replayed")).toBe("true");

        // The side-effect happened EXACTLY ONCE across the restart.
        expect(countAutomations(env)).toBe(1);
      } finally {
        await shutdownDurabilityHub(env);
      }
    },
  );
});
