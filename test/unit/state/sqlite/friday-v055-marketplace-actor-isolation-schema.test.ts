import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { FRIDAY_SQLITE_MIGRATIONS, runFridayMigrations } from "#state";

describe("V055 — marketplace actor isolation schema", () => {
  const dbs: Database.Database[] = [];

  function freshDb(): Database.Database {
    const db = new Database(":memory:");
    dbs.push(db);
    return db;
  }

  afterEach(() => {
    for (const db of dbs) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
    dbs.length = 0;
  });

  it("adds actor isolation metadata columns to marketplace support and request tables", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const requestColumns = db.prepare("PRAGMA table_info(marketplace_requests)").all() as Array<{ name: string }>;
    const responseColumns = db.prepare("PRAGMA table_info(marketplace_request_responses)").all() as Array<{ name: string }>;
    const supportColumns = db.prepare("PRAGMA table_info(marketplace_support_events)").all() as Array<{ name: string }>;

    for (const name of ["actor_schema_version", "actor_quarantined", "actor_quarantine_reason"]) {
      expect(requestColumns.some((column) => column.name === name)).toBe(true);
      expect(responseColumns.some((column) => column.name === name)).toBe(true);
      expect(supportColumns.some((column) => column.name === name)).toBe(true);
    }
  });

  it("backfills distinct tenant/principal rows and quarantines unverifiable legacy rows", () => {
    const db = freshDb();
    const throughV054 = FRIDAY_SQLITE_MIGRATIONS.filter((migration) => migration.version <= 54);
    runFridayMigrations({ db, migrations: throughV054 });

    db.prepare(
      `INSERT INTO marketplace_requests (
         id, asset_kind, requester_tenant_id, requester_principal_id, title, goal, desired_outcome,
         constraints_json, budget_support_intent, privacy, publishability, risk_notes, status,
         accepted_response_id, created_at, updated_at, closed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "request-legacy",
      "workflow",
      "legacy-user",
      "legacy-user",
      "Legacy request",
      "Legacy goal",
      "Legacy outcome",
      "[]",
      null,
      "public",
      "allow_publication",
      null,
      "open",
      null,
      "2026-03-01T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
      null,
    );
    db.prepare(
      `INSERT INTO marketplace_request_responses (
         id, request_id, responder_tenant_id, responder_principal_id, responder_creator_id, message, proposal, deliverable_asset_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "response-live",
      "request-legacy",
      "tenant-creator",
      "principal-creator",
      "publisher:pub-1",
      "Response",
      null,
      null,
      "2026-03-01T00:01:00.000Z",
    );

    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const legacyRequest = db.prepare(
      "SELECT actor_schema_version, actor_quarantined, actor_quarantine_reason FROM marketplace_requests WHERE id = 'request-legacy'",
    ).get() as {
      actor_schema_version: number;
      actor_quarantined: number;
      actor_quarantine_reason: string | null;
    };
    const liveResponse = db.prepare(
      "SELECT actor_schema_version, actor_quarantined FROM marketplace_request_responses WHERE id = 'response-live'",
    ).get() as {
      actor_schema_version: number;
      actor_quarantined: number;
    };

    expect(legacyRequest).toEqual({
      actor_schema_version: 1,
      actor_quarantined: 1,
      actor_quarantine_reason: "legacy_actor_tenant_unverifiable",
    });
    expect(liveResponse).toEqual({
      actor_schema_version: 2,
      actor_quarantined: 0,
    });
  });

  it("records migration v055 in schema_migrations", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const row = db
      .prepare("SELECT version, name FROM schema_migrations WHERE version = 55")
      .get() as { version: number; name: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.version).toBe(55);
    expect(row?.name).toBe("v055-marketplace-actor-isolation");
  });
});
