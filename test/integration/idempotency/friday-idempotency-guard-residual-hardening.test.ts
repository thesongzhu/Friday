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
 * DEFECT #2c (round-4 HIGH) — a re-serialization boundary defeats the #2 snapshot.
 *   The prior #2 fix serialized the result into a `JSON.parse(JSON.stringify(result))` snapshot, but
 *   that snapshot object still INHERITS `Object.prototype.toJSON`; complete() RE-serialized it, so
 *   under prototype pollution (a stateful `Object.prototype.toJSON`) inspection saw benign bytes while
 *   persistence wrote a raw secret into `response_json`. It also RECOMPUTED payload_digest at complete()
 *   instead of reusing the reservation's. The fix serializes the result to a STRING exactly once and
 *   operates only on strings downstream (no re-serialization of any result-derived object anywhere), and
 *   reuses the reserved principal/digest. RED (pre-fix): response_json holds the stateful secret and the
 *   stored payload_digest diverges from the reservation digest.
 *
 * All tests drive the REAL FridaySqliteOperationJournalStore (in-memory better-sqlite3 with the
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
const STATEFUL_SECRET = "sk-statefulLEAK0123456789abcdef01"; // pragma: allowlist secret

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

/**
 * Wraps a real store and captures the payload digest the guard passes to reserve() and to complete().
 * Used by #2c to prove completion REUSES the reservation digest (they must be EQUAL) rather than
 * recomputing it — a recompute under a stateful/polluted `Object.prototype.toJSON` would diverge.
 */
class ReserveCompleteCapturingStore implements FridayHttpIdempotencyStore {
  reservePayloadHash: string | undefined;
  completePayloadHash: string | undefined;

  constructor(private readonly inner: FridayHttpIdempotencyStore) {}

  get(key: string) {
    return this.inner.get(key);
  }
  reserve(key: string, input: FridayHttpIdempotencyReserveInput) {
    this.reservePayloadHash = input.payloadHash;
    this.inner.reserve(key, input);
  }
  complete(key: string, input: FridayHttpIdempotencyCompleteInput) {
    this.completePayloadHash = input.payloadHash;
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
    // Safety net: never let a #2c prototype-pollution leak escape into another test, even if that
    // test's own try/finally somehow did not run.
    delete (Object.prototype as { toJSON?: unknown }).toJSON;
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
    "#1b handler commits a durable effect and THEN throws — fails CLOSED (indeterminate), retry refused, effect not re-executed",
    async () => {
      layer = createTestDb();
      let effectCount = 0;
      const effectThenThrowRoute: FridayRouteEntry = {
        operationId: "test.effect.commit.then.throw",
        method: "POST",
        path: "/v1/test/effect-throw",
        auth: { public: true, allowUnauthenticatedMutation: true },
        handler: (async () => {
          // The durable side-effect commits, THEN the handler throws (e.g. a later step fails). The
          // completed-receipt write is never reached, so a promise-resolution heuristic would wrongly
          // treat this as "no effect" and release the reservation — the exact defect this guards.
          effectCount += 1;
          throw new Error("handler failed AFTER committing its side-effect");
        }) as FridayRouteEntry["handler"],
      };

      // Real durable store (no wrapper): the failure path is the HANDLER throwing, not complete().
      const store = new FridaySqliteOperationJournalStore(layer);
      booted = await bootServer([effectThenThrowRoute], store);

      const key = "effect-throw-key-1";
      const post = () =>
        fetch(`${booted!.baseUrl}/v1/test/effect-throw`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": key },
          body: JSON.stringify({ do: "commit-then-throw" }),
        });

      // First request: handler commits the effect (count → 1), then throws.
      const firstRes = await post();
      expect(firstRes.status).toBeGreaterThanOrEqual(500);
      expect(effectCount).toBe(1);

      // The reservation must NOT be deleted (release would let a retry re-execute); it is kept and
      // marked indeterminate (fail-closed) — a rejected handler is not proof that no effect committed.
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

  it(
    "#2b stateful toJSON cannot slip a raw secret past inspection into response_json (inspected bytes == stored bytes)",
    async () => {
      layer = createTestDb();
      let serializeCount = 0;
      const statefulRoute: FridayRouteEntry = {
        operationId: "test.stateful.tojson",
        method: "POST",
        path: "/v1/test/stateful",
        auth: { public: true, allowUnauthenticatedMutation: true },
        handler: (async () => {
          // A response whose serialization is STATEFUL: benign on the first two JSON.stringify calls
          // (the serializability assert + the secret inspection), then the raw secret on the third
          // (the at-rest persistence). A check/use gap would inspect the benign view but persist the
          // secret. With a single immutable snapshot, inspected bytes == stored bytes, so it cannot.
          return {
            toJSON() {
              serializeCount += 1;
              // Benign uses a non-credential key + clean value (so the detector does NOT fire on the
              // inspected view); the secret is a raw `sk-`-shaped VALUE (fires on shape) surfaced only
              // on the third serialization (the at-rest persistence).
              return serializeCount <= 2
                ? { note: "all-clear-placeholder" }
                : { note: STATEFUL_SECRET };
            },
          };
        }) as FridayRouteEntry["handler"],
      };

      const store = new FridaySqliteOperationJournalStore(layer);
      booted = await bootServer([statefulRoute], store);

      const key = "stateful-key-1";
      const res = await fetch(`${booted.baseUrl}/v1/test/stateful`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ do: "stateful" }),
      });
      expect(res.status).toBe(200);

      // The EXACT bytes persisted at rest must never contain a secret the detector was shown a benign
      // view of. Verified RED on the prior head (inspection saw benign, persistence emitted the secret).
      const stored = layer.writer
        .prepare("SELECT response_json FROM http_operation_journal WHERE idempotency_key = ?")
        .get(key) as { response_json: string | null } | undefined;
      expect(stored).toBeDefined();
      expect(stored?.response_json ?? "").not.toContain(STATEFUL_SECRET);
    },
  );

  it(
    "#2c inherited Object.prototype.toJSON pollution cannot slip a secret into response_json, and the stored digest equals the reservation digest",
    async () => {
      layer = createTestDb();
      // A PLAIN object result (no own toJSON): the leak vector is the INHERITED, polluted
      // Object.prototype.toJSON, and the snapshot the #2 fix produced also inherited it.
      const plainRoute: FridayRouteEntry = {
        operationId: "test.proto.tojson",
        method: "POST",
        path: "/v1/test/proto-tojson",
        auth: { public: true, allowUnauthenticatedMutation: true },
        handler: (async () => ({ ok: true })) as FridayRouteEntry["handler"],
      };

      const capturing = new ReserveCompleteCapturingStore(new FridaySqliteOperationJournalStore(layer));
      booted = await bootServer([plainRoute], capturing);

      const key = "proto-tojson-key-1";
      // Build the request body string BEFORE installing the pollution, so the client-side serialization
      // does not consume a counter tick and shift the server-side invocation window.
      const bodyStr = JSON.stringify({ do: "proto-tojson" });

      // Precondition: the prototype is clean going in.
      expect((Object.prototype as { toJSON?: unknown }).toJSON).toBeUndefined();

      // Stateful pollution: benign on the first two serializations (the reservation-hash serialize and
      // the ONE result serialize), then the raw secret afterward — mirroring #2b's counter. A check/use
      // gap that RE-serializes the result-derived object for persistence would emit the secret AT REST
      // while inspection saw a benign view. Non-enumerable so unrelated for-in loops are unaffected.
      let serializeCount = 0;
      Object.defineProperty(Object.prototype, "toJSON", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: function fridayPollutedToJSON() {
          serializeCount += 1;
          // `leaked` is a NON-credential key, so inspection only ever flags the raw `sk-`-shaped VALUE
          // by shape — never the benign view, which carries no secret at all.
          return serializeCount <= 2 ? { ok: true } : { leaked: STATEFUL_SECRET };
        },
      });

      let status: number | undefined;
      try {
        const res = await fetch(`${booted.baseUrl}/v1/test/proto-tojson`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": key },
          body: bodyStr,
        });
        status = res.status;
        // Drain the body (no JSON.stringify here, so no extra counter tick).
        await res.text();
      } finally {
        // CRITICAL: the pollution must NOT survive this test.
        delete (Object.prototype as { toJSON?: unknown }).toJSON;
      }

      // The pollution is gone — it cannot leak into another test.
      expect((Object.prototype as { toJSON?: unknown }).toJSON).toBeUndefined();

      // The request succeeded.
      expect(status).toBe(200);

      const stored = layer.writer
        .prepare(
          "SELECT response_json, payload_digest, status FROM http_operation_journal WHERE idempotency_key = ?",
        )
        .get(key) as
        | { response_json: string | null; payload_digest: string; status: string }
        | undefined;
      expect(stored).toBeDefined();
      expect(stored?.status).toBe("completed");

      // (A) The EXACT bytes persisted at rest must NEVER contain the secret the inspector was shown a
      // benign view of. RED pre-fix: complete() re-serialized the snapshot and emitted the secret here.
      expect(stored?.response_json ?? "").not.toContain(STATEFUL_SECRET);

      // (B) Completion REUSED the reservation digest instead of recomputing it. Under pollution a
      // recompute observes a later (secret-injected) toJSON tick, so the recomputed digest DIVERGES.
      expect(capturing.reservePayloadHash).toBeDefined();
      expect(capturing.completePayloadHash).toBe(capturing.reservePayloadHash);
      expect(stored?.payload_digest).toBe(capturing.reservePayloadHash);
    },
  );
});
