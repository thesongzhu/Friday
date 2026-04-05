import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { FRIDAY_SQLITE_MIGRATIONS, runFridayMigrations } from "#state";

describe("V064 — learning enhancements schema", () => {
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
        // no-op
      }
    }
    dbs.length = 0;
  });

  it("adds emotional_valence column to preference_facts", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const columns = db
      .prepare("PRAGMA table_info(preference_facts)")
      .all() as Array<{ name: string; type: string }>;
    const col = columns.find((c) => c.name === "emotional_valence");

    expect(col).toBeDefined();
    expect(col?.type).toBe("REAL");
  });

  it("adds metadata_json column to preference_facts", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const columns = db
      .prepare("PRAGMA table_info(preference_facts)")
      .all() as Array<{ name: string; type: string }>;
    const col = columns.find((c) => c.name === "metadata_json");

    expect(col).toBeDefined();
    expect(col?.type).toBe("TEXT");
  });

  it("creates the friday_consolidated_episodes table", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const columns = db
      .prepare("PRAGMA table_info(friday_consolidated_episodes)")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((c) => c.name));

    expect(names.has("episode_id")).toBe(true);
    expect(names.has("consolidated_at")).toBe(true);
    expect(names.has("target_memory_id")).toBe(true);
  });

  it("records migration v064 in schema_migrations", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const row = db
      .prepare("SELECT version, name FROM schema_migrations WHERE version = 64")
      .get() as { version: number; name: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.version).toBe(64);
    expect(row?.name).toBe("v064-learning-enhancements");
  });
});
