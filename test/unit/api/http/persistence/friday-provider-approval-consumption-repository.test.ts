// SEC-APPROVAL-AUTHORITY-001 · CORE-A round-3 Lane B (Advisor round-2 finding #3) —
// durable single-use ledger for canonical mutating-action approvals.
//
// Ground truth being closed: provider-approval single-use lived ONLY in the gate's
// process-local in-memory `Set` (`consumedCanonicalApprovalKeys`). On restart the Set was
// gone, so a fresh process re-admitted the SAME confirmed approval. This suite proves the
// durable ledger refuses a replay across (a) new store/gate instances on the same db, and
// (b) a REAL sqlite file closed and reopened.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "#state";
import { FRIDAY_SQLITE_MIGRATIONS, runFridayMigrations } from "#state";
import {
  FridayInMemoryApprovalConsumptionStore,
  FridaySqliteApprovalConsumptionStore,
  type FridayApprovalConsumptionReservation,
} from "../../../../../src/api/http/persistence/friday-provider-approval-consumption-repository.js";
import {
  createFridayMutatingActionDigest,
  createFridayMutatingActionGate,
  type FridayCanonicalApprovalResolution,
  type FridayMutatingActionRequest,
} from "../../../../../src/security/friday-mutating-action-gate.js";
import { createTestDb } from "../../../../helpers/friday-test-db.helper.js";

const NOW = "2026-05-04T12:00:00.000Z";

function reservation(
  overrides: Partial<FridayApprovalConsumptionReservation> = {},
): FridayApprovalConsumptionReservation {
  return {
    useKey: "approval-1:digest-abc::: ",
    actionDigest: "digest-abc",
    idempotencyKey: "idem-1",
    mutationOperationId: "providers.create",
    ...overrides,
  };
}

function createFileDbLayer(path: string): FridaySqliteLayer {
  const db = new Database(path);
  runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });
  return {
    dbPath: path,
    writer: db,
    reads: {
      size: 1,
      withReadConnection: <T>(fn: (c: Database.Database) => T): T => fn(db),
      close() {},
    },
    withWriteTransaction: <T>(fn: (c: Database.Database) => T): T => db.transaction(() => fn(db))(),
    withReadConnection: <T>(fn: (c: Database.Database) => T): T => fn(db),
    checkpoint() {},
    optimize() {},
    close() {
      db.close();
    },
  };
}

describe("v108 provider_mutation_approval_consumption migration", () => {
  const layers: FridaySqliteLayer[] = [];
  afterEach(() => {
    while (layers.length) layers.pop()!.close();
  });

  it("creates the ledger table with the use key as PRIMARY KEY", () => {
    const db = createTestDb();
    layers.push(db);
    const columns = db.withReadConnection((c) =>
      c.prepare("PRAGMA table_info(provider_mutation_approval_consumption)").all() as Array<{
        name: string;
        pk: number;
      }>,
    );
    const names = columns.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "use_key",
        "action_digest",
        "idempotency_key",
        "mutation_operation_id",
        "status",
        "consumed_at_ms",
        "created_at_ms",
      ]),
    );
    // use_key is the sole PRIMARY KEY.
    expect(columns.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(["use_key"]);
  });
});

describe("FridayApprovalConsumptionStore (in-memory + sqlite parity)", () => {
  const layers: FridaySqliteLayer[] = [];
  afterEach(() => {
    while (layers.length) layers.pop()!.close();
  });

  function stores(): Array<{ label: string; make: () => { db?: FridaySqliteLayer; store: FridaySqliteApprovalConsumptionStore | FridayInMemoryApprovalConsumptionStore } }> {
    return [
      {
        label: "in-memory",
        make: () => ({ store: new FridayInMemoryApprovalConsumptionStore() }),
      },
      {
        label: "sqlite",
        make: () => {
          const db = createTestDb();
          layers.push(db);
          return { db, store: new FridaySqliteApprovalConsumptionStore(db) };
        },
      },
    ];
  }

  for (const { label, make } of stores()) {
    it(`${label}: reserveConsumed is single-use (a replay of the same key is refused)`, () => {
      const { store } = make();
      expect(store.reserveConsumed(reservation())).toEqual({ ok: true });
      expect(store.reserveConsumed(reservation())).toEqual({
        ok: false,
        reason: "canonical_approval_already_used",
      });
      expect(store.hasConsumption(reservation().useKey)).toBe(true);
    });

    it(`${label}: reserveInFlight then completeConsumptionInTransaction, replay refused`, () => {
      const built = make();
      const { store } = built;
      expect(store.reserveInFlight(reservation())).toEqual({ ok: true });
      // A replay while in_flight already collides (single-use enforced at the reserve).
      expect(store.reserveInFlight(reservation())).toEqual({
        ok: false,
        reason: "canonical_approval_already_used",
      });
      // Finalize in the "mutation" transaction.
      if (built.db) {
        built.db.withWriteTransaction((c) => store.completeConsumptionInTransaction(c, reservation().useKey));
      } else {
        store.completeConsumptionInTransaction({} as never, reservation().useKey);
      }
      expect(store.hasConsumption(reservation().useKey)).toBe(true);
    });

    it(`${label}: releaseReservation frees an in_flight reservation but never a consumed one`, () => {
      const built = make();
      const { store } = built;
      store.reserveInFlight(reservation());
      store.releaseReservation(reservation().useKey);
      // Released → the owner may retry the same approval.
      expect(store.hasConsumption(reservation().useKey)).toBe(false);
      expect(store.reserveConsumed(reservation())).toEqual({ ok: true });
      // Now consumed: release is a no-op (scoped to in_flight), so single-use still holds.
      store.releaseReservation(reservation().useKey);
      expect(store.hasConsumption(reservation().useKey)).toBe(true);
    });

    it(`${label}: reconcileOrphanedReservations keeps an in_flight orphan single-use (fail-closed)`, () => {
      const { store } = make();
      store.reserveInFlight(reservation());
      store.reconcileOrphanedReservations();
      // Still present → a replay is still refused after reconcile.
      expect(store.hasConsumption(reservation().useKey)).toBe(true);
      expect(store.reserveConsumed(reservation())).toEqual({
        ok: false,
        reason: "canonical_approval_already_used",
      });
    });
  }

  it("sqlite: a throw AFTER completeConsumptionInTransaction rolls the completion BACK (atomicity)", () => {
    // Models a crash between the consume-complete and the mutation-commit: because both run
    // in ONE write transaction, the throw unwinds the completion too — the row stays
    // in_flight (never a consumed row without its paired effect). Boot reconcile then marks
    // the orphan indeterminate (fail-closed), so a replay is still refused.
    const db = createTestDb();
    layers.push(db);
    const store = new FridaySqliteApprovalConsumptionStore(db);
    store.reserveInFlight(reservation());

    expect(() =>
      db.withWriteTransaction((c) => {
        store.completeConsumptionInTransaction(c, reservation().useKey);
        throw new Error("simulated crash before mutation commit");
      }),
    ).toThrow("simulated crash");

    // The completion rolled back → the row is STILL in_flight (no consumed-without-effect).
    const statusAfter = db.withReadConnection((c) =>
      (c
        .prepare("SELECT status FROM provider_mutation_approval_consumption WHERE use_key = ?")
        .get(reservation().useKey) as { status: string }).status,
    );
    expect(statusAfter).toBe("in_flight");

    // Boot reconcile marks the orphan indeterminate — fail-closed; a replay is still refused.
    store.reconcileOrphanedReservations();
    const statusReconciled = db.withReadConnection((c) =>
      (c
        .prepare("SELECT status FROM provider_mutation_approval_consumption WHERE use_key = ?")
        .get(reservation().useKey) as { status: string }).status,
    );
    expect(statusReconciled).toBe("indeterminate");
    expect(store.reserveConsumed(reservation())).toEqual({
      ok: false,
      reason: "canonical_approval_already_used",
    });
  });

  it("sqlite: a NEW store instance on the SAME db refuses a replay (restart durability)", () => {
    const db = createTestDb();
    layers.push(db);
    const first = new FridaySqliteApprovalConsumptionStore(db);
    expect(first.reserveConsumed(reservation())).toEqual({ ok: true });

    // Simulate a process restart: a brand-new store object with NO in-memory carryover.
    const afterRestart = new FridaySqliteApprovalConsumptionStore(db);
    expect(afterRestart.reserveConsumed(reservation())).toEqual({
      ok: false,
      reason: "canonical_approval_already_used",
    });
  });

  it("sqlite FILE closed + reopened refuses a replay (authoritative durable-sink readback)", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-approval-consumption-"));
    const path = join(dir, "consumption.db");
    try {
      const before = createFileDbLayer(path);
      expect(new FridaySqliteApprovalConsumptionStore(before).reserveConsumed(reservation())).toEqual({
        ok: true,
      });
      before.close();

      // Reopen the SAME file — the consumption survived the close.
      const after = createFileDbLayer(path);
      try {
        expect(new FridaySqliteApprovalConsumptionStore(after).reserveConsumed(reservation())).toEqual({
          ok: false,
          reason: "canonical_approval_already_used",
        });
      } finally {
        after.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Gate-level durability (the seam the Advisor probed) ───

function makeApprovedRequest(): {
  request: FridayMutatingActionRequest;
  canonicalApproval: FridayCanonicalApprovalResolution;
} {
  const request: FridayMutatingActionRequest = {
    action: "providers.create",
    actor: { kind: "api", id: "api:req-1", principalId: "user-1" },
    surface: "api:/v1/providers/create",
    resource: { type: "provider", id: "p-1" },
    mutating: true,
    risk: "high",
    idempotencyKey: "idem-1",
  };
  const actionDigest = createFridayMutatingActionDigest(request);
  return {
    request,
    canonicalApproval: {
      decision: "approved",
      approvalId: "approval-1",
      decidedByPrincipalId: "user-1",
      actionDigest,
      expiresAt: "2026-05-04T13:00:00.000Z",
    },
  };
}

describe("mutating-action gate: durable approval single-use", () => {
  const layers: FridaySqliteLayer[] = [];
  afterEach(() => {
    while (layers.length) layers.pop()!.close();
  });

  it("RED (pre-fix behaviour): two gate instances with SEPARATE in-memory stores BOTH admit", () => {
    // This documents exactly the finding-#3 vulnerability: process-local single-use means a
    // fresh process (a NEW gate + a NEW in-memory store) re-admits the identical approval.
    const { request, canonicalApproval } = makeApprovedRequest();
    const gateA = createFridayMutatingActionGate({ nowIso: () => NOW });
    const gateB = createFridayMutatingActionGate({ nowIso: () => NOW });
    expect(gateA.evaluate({ ...request, canonicalApproval }).decision).toBe("allow");
    // Double-admit — the second (restarted) process has no memory of the first consumption.
    expect(gateB.evaluate({ ...request, canonicalApproval }).decision).toBe("allow");
  });

  it("GREEN: two gate instances SHARING a durable sqlite store refuse the replay across restart", () => {
    const db = createTestDb();
    layers.push(db);
    const store = new FridaySqliteApprovalConsumptionStore(db);
    const { request, canonicalApproval } = makeApprovedRequest();

    const gateBeforeRestart = createFridayMutatingActionGate({
      nowIso: () => NOW,
      approvalConsumptionStore: store,
    });
    expect(gateBeforeRestart.evaluate({ ...request, canonicalApproval }).decision).toBe("allow");

    // Fresh gate instance backed by the SAME durable store (== the same db after restart).
    const gateAfterRestart = createFridayMutatingActionGate({
      nowIso: () => NOW,
      approvalConsumptionStore: new FridaySqliteApprovalConsumptionStore(db),
    });
    const replay = gateAfterRestart.evaluate({ ...request, canonicalApproval });
    expect(replay.decision).toBe("deny");
    expect(replay.reason).toBe("canonical_approval_already_used");
    expect(replay.ticket).toBeUndefined();
  });

  it("deferred consumption returns the use key on the ticket and reserves in_flight (replay refused)", () => {
    const db = createTestDb();
    layers.push(db);
    const store = new FridaySqliteApprovalConsumptionStore(db);
    const gate = createFridayMutatingActionGate({ nowIso: () => NOW, approvalConsumptionStore: store });
    const { request, canonicalApproval } = makeApprovedRequest();

    const result = gate.evaluate({ ...request, canonicalApproval }, { deferApprovalConsumption: true });
    expect(result.decision).toBe("allow");
    const useKey = result.ticket?.canonicalApprovalUseKey;
    expect(useKey).toBeTruthy();
    // The reservation is already durable (in_flight): a concurrent/replayed evaluate is refused.
    const replay = gate.evaluate({ ...request, canonicalApproval }, { deferApprovalConsumption: true });
    expect(replay.decision).toBe("deny");
    expect(replay.reason).toBe("canonical_approval_already_used");

    // The caller finalizes it inside its mutation transaction.
    db.withWriteTransaction((c) => store.completeConsumptionInTransaction(c, useKey!));
    expect(store.hasConsumption(useKey!)).toBe(true);
  });

  it("inline (non-deferred) consumption does NOT expose a use key on the ticket", () => {
    const db = createTestDb();
    layers.push(db);
    const gate = createFridayMutatingActionGate({
      nowIso: () => NOW,
      approvalConsumptionStore: new FridaySqliteApprovalConsumptionStore(db),
    });
    const { request, canonicalApproval } = makeApprovedRequest();
    const result = gate.evaluate({ ...request, canonicalApproval });
    expect(result.decision).toBe("allow");
    expect(result.ticket?.canonicalApprovalUseKey).toBeUndefined();
  });
});
