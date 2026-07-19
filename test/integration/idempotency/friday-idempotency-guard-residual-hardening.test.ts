/**
 * DUR-OPERATION-JOURNAL-001 — two residual HIGH hardening guards on the generic non-GET
 * HTTP idempotency guard (friday-http-server.ts + the operation-journal store).
 *
 * DEFECT #1 — complete()-failure must NOT release the reservation.
 *   The handler commits its durable side-effect FIRST; the completed receipt is written in a
 *   SEPARATE transaction. If that receipt write throws (SQLITE_BUSY/IOERR AFTER the effect
 *   committed), the generic catch used to `release()` the reservation — DELETING the row. A retry
 *   with the same key then missed the journal, re-reserved, and RE-EXECUTED the already-committed
 *   effect. The fix marks the row `indeterminate` (kept, never deleted) so the retry is refused.
 *   RED (pre-fix): the row is deleted and the retry re-runs the handler (effectCount → 2, retry 200).
 *
 * DEFECT #2 — never persist raw secrets in the cached replay body.
 *   complete() stored the FULL handler return verbatim into `http_operation_journal.response_json`
 *   (24h TTL). A route returning secrets (tokens, secret values) leaked them at rest. The fix
 *   stores a non-replayable sentinel when the serialized result contains ANY secret shape (canonical
 *   detector), still SENDS the real result to the first caller, and refuses a replay with 409.
 *   RED (pre-fix): response_json holds the raw token and the replay returns it (200, cached).
 *
 * Both tests drive the REAL FridaySqliteOperationJournalStore (in-memory better-sqlite3 with the
 * v100 migration applied) through the REAL createFridayHttpServer guard over a real route.
 */

import * as net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFridayHttpServer,
  type FridayHttpServer,
  type FridayAuthMiddlewareFactory,
  type FridayRealtimeWsGateway,
} from "#api";
import type { FridaySqliteLayer } from "#state";
import {
  createFridayHttpRouteRegistry,
  type FridayRouteEntry,
} from "../../../src/api/http/friday-http-route-registry.js";
import {
  FridaySqliteOperationJournalStore,
  type FridayHttpIdempotencyStore,
  type FridayHttpIdempotencyReserveInput,
  type FridayHttpIdempotencyCompleteInput,
} from "../../../src/api/http/persistence/friday-operation-journal-repository.js";
import { createTestDb } from "../../unit/satellites/_helpers/create-test-db.helper.js";

// A value the canonical secret-shape detector flags (OpenAI-style `sk-` + 30 base62 chars).
const SECRET_TOKEN = "sk-livesecret0123456789abcdef0123"; // pragma: allowlist secret

// ─── Minimal wiring: public routes, so the guard runs without an auth/bearer dance ───

const NOOP_MIDDLEWARE: FridayAuthMiddlewareFactory = {
  requireAuth: () => ({ passed: true }),
  requireAnyScope: () => ({ passed: true }),
  requireAnyRole: () => ({ passed: true }),
  enforceRateLimit: () => ({ passed: true }),
};

// wsGateway is only dereferenced inside the WebSocket upgrade handler, never on a plain HTTP
// request path, so a cast stub is safe for these HTTP-only tests.
const STUB_WS_GATEWAY = {} as unknown as FridayRealtimeWsGateway;

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

interface BootedServer {
  server: FridayHttpServer;
  baseUrl: string;
}

async function bootServer(
  routes: readonly FridayRouteEntry[],
  idempotencyStore: FridayHttpIdempotencyStore,
): Promise<BootedServer> {
  const registry = createFridayHttpRouteRegistry();
  for (const route of routes) registry.register(route);
  const port = await findFreePort();
  const server = createFridayHttpServer({
    routes: registry,
    wsGateway: STUB_WS_GATEWAY,
    middleware: NOOP_MIDDLEWARE,
    idempotencyStore,
    port,
    host: "127.0.0.1",
    logRequests: false,
  });
  await server.listen();
  return { server, baseUrl: `http://127.0.0.1:${String(port)}` };
}

/**
 * Wraps a real idempotency store and makes the FIRST complete() call throw a simulated SQLITE_BUSY
 * (exactly the "side-effect committed, completed-receipt write failed" boundary). Every other method
 * delegates to the real durable store.
 */
class CompleteOnceFailsStore implements FridayHttpIdempotencyStore {
  private failNextComplete = true;

  constructor(private readonly inner: FridayHttpIdempotencyStore) {}

  get(key: string) {
    return this.inner.get(key);
  }
  reserve(key: string, input: FridayHttpIdempotencyReserveInput) {
    this.inner.reserve(key, input);
  }
  complete(key: string, input: FridayHttpIdempotencyCompleteInput) {
    if (this.failNextComplete) {
      this.failNextComplete = false;
      const err = new Error("simulated SQLITE_BUSY: database is locked") as Error & { code?: string };
      err.code = "SQLITE_BUSY";
      throw err;
    }
    this.inner.complete(key, input);
  }
  release(key: string) {
    this.inner.release(key);
  }
  markIndeterminate(key: string) {
    this.inner.markIndeterminate(key);
  }
  pruneExpired(nowMs: number) {
    this.inner.pruneExpired(nowMs);
  }
  reconcileOrphanedReservations() {
    this.inner.reconcileOrphanedReservations();
  }
}

describe("HTTP idempotency guard — residual hardening (DUR-OPERATION-JOURNAL-001)", () => {
  let layer: FridaySqliteLayer | undefined;
  let booted: BootedServer | undefined;

  afterEach(async () => {
    if (booted) {
      try {
        await booted.server.close();
      } catch {
        /* best effort */
      }
      booted = undefined;
    }
    if (layer) {
      layer.close();
      layer = undefined;
    }
  });

  it(
    "#1 complete()-failure fails CLOSED (indeterminate, kept) — a retry is refused, never re-executes",
    async () => {
      layer = createTestDb();
      let effectCount = 0;
      const effectRoute: FridayRouteEntry = {
        operationId: "test.effect.commit",
        method: "POST",
        path: "/v1/test/effect",
        auth: { public: true, allowUnauthenticatedMutation: true },
        handler: (async () => {
          // The durable side-effect: committed BEFORE the completed-receipt write.
          effectCount += 1;
          return { committed: true, effectCount };
        }) as FridayRouteEntry["handler"],
      };

      const store = new CompleteOnceFailsStore(new FridaySqliteOperationJournalStore(layer));
      booted = await bootServer([effectRoute], store);

      const key = "effect-key-1";
      const post = () =>
        fetch(`${booted!.baseUrl}/v1/test/effect`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": key },
          body: JSON.stringify({ do: "commit" }),
        });

      // First request: handler commits the effect (count → 1), then complete() throws.
      const firstRes = await post();
      // The effect committed but the receipt write failed → the request surfaces as a 5xx error.
      expect(firstRes.status).toBeGreaterThanOrEqual(500);
      expect(effectCount).toBe(1);

      // The reservation row must NOT have been deleted; it is kept and flipped to indeterminate.
      const row = layer.writer
        .prepare("SELECT status FROM http_operation_journal WHERE idempotency_key = ?")
        .get(key) as { status: string } | undefined;
      expect(row).toBeDefined();
      expect(row?.status).toBe("indeterminate");

      // Retry with the SAME key: refused (non-retryable indeterminate 409); handler NOT re-run.
      const retryRes = await post();
      expect(retryRes.status).toBe(409);
      const retryJson = (await retryRes.json()) as {
        ok: boolean;
        error?: { code?: string; retryable?: boolean };
      };
      expect(retryJson.ok).toBe(false);
      expect(retryJson.error?.code).toBe("SECURITY_IDEMPOTENCY_INDETERMINATE");
      expect(retryJson.error?.retryable).toBe(false);

      // The committed side-effect happened EXACTLY ONCE (no re-execution across the retry).
      expect(effectCount).toBe(1);
    },
  );

  it(
    "#2 a secret-shaped response is sent to the first caller but never persisted; a replay is refused 409",
    async () => {
      layer = createTestDb();
      const secretRoute: FridayRouteEntry = {
        operationId: "test.secret.echo",
        method: "POST",
        path: "/v1/test/secret",
        auth: { public: true, allowUnauthenticatedMutation: true },
        handler: (async () => ({
          accessToken: SECRET_TOKEN,
          note: "session-established",
        })) as FridayRouteEntry["handler"],
      };

      const store = new FridaySqliteOperationJournalStore(layer);
      booted = await bootServer([secretRoute], store);

      const key = "secret-key-1";
      const post = () =>
        fetch(`${booted!.baseUrl}/v1/test/secret`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": key },
          body: JSON.stringify({ want: "token" }),
        });

      // (a) The FIRST response returned to the client CONTAINS the real token (no-degrade: the first
      // call legitimately needs it).
      const firstRes = await post();
      expect(firstRes.status).toBe(200);
      const firstText = await firstRes.text();
      expect(firstText).toContain(SECRET_TOKEN);

      // (b) The STORED cached-for-replay copy does NOT contain the raw token (holds the sentinel).
      const stored = layer.writer
        .prepare("SELECT response_json FROM http_operation_journal WHERE idempotency_key = ?")
        .get(key) as { response_json: string | null } | undefined;
      expect(stored).toBeDefined();
      expect(stored?.response_json ?? "").not.toContain(SECRET_TOKEN);
      expect(stored?.response_json ?? "").toContain("__fridayNonReplayable");

      // (c) A replay with the same key is refused with 409 SECURITY_IDEMPOTENCY_NONREPLAYABLE — the
      // cached secret is never served.
      const replayRes = await post();
      expect(replayRes.status).toBe(409);
      const replayText = await replayRes.text();
      expect(replayText).not.toContain(SECRET_TOKEN);
      const replayJson = JSON.parse(replayText) as {
        ok: boolean;
        error?: { code?: string; retryable?: boolean };
      };
      expect(replayJson.ok).toBe(false);
      expect(replayJson.error?.code).toBe("SECURITY_IDEMPOTENCY_NONREPLAYABLE");
      expect(replayJson.error?.retryable).toBe(false);
    },
  );
});
