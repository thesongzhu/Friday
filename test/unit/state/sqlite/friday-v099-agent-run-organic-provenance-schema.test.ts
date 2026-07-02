import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { FRIDAY_SQLITE_MIGRATIONS, runFridayMigrations } from "#state";

function columnNames(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((row) => row.name);
}

describe("V099 agent run organic provenance schema", () => {
  it("persists organic provenance as durable friday_agent_runs columns", () => {
    const db = new Database(":memory:");

    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    expect(columnNames(db, "friday_agent_runs")).toEqual(
      expect.arrayContaining([
        "organic",
        "organic_principal",
        "organic_source",
        "organic_attestation_ref",
      ]),
    );
  });

  it("records migration v099 in schema_migrations", () => {
    const db = new Database(":memory:");

    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    expect(
      db
        .prepare("SELECT version, name FROM schema_migrations WHERE version = 99")
        .get(),
    ).toMatchObject({
      version: 99,
      name: "v099-agent-run-organic-provenance",
    });
  });
});
