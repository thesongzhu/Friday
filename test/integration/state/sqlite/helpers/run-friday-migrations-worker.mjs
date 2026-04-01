import Database from "better-sqlite3";

import { runFridayMigrations } from "#state";

const [dbPath, holdMsArg] = process.argv.slice(2);
if (!dbPath) {
  console.error("dbPath is required");
  process.exit(1);
}

const holdMs = Number(holdMsArg ?? "0");
const db = new Database(dbPath);
db.pragma("busy_timeout = 5000");

const migrations = [
  {
    version: 1,
    name: "v001_concurrency_probe",
    checksum: "concurrency-probe-v1",
    apply(writer) {
      const end = Date.now() + holdMs;
      while (Date.now() < end) {
        // Keep the migration transaction busy long enough for the second process to contend.
      }
      writer.exec("CREATE TABLE IF NOT EXISTS concurrency_probe (id TEXT PRIMARY KEY)");
    },
  },
];

try {
  const result = runFridayMigrations({ db, migrations });
  console.log(JSON.stringify({ ok: true, result }));
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
} finally {
  db.close();
}
