import { createFridaySqliteLayer } from "#state";

const [dbPath] = process.argv.slice(2);
if (!dbPath) {
  console.error("dbPath is required");
  process.exit(1);
}

let layer;
try {
  layer = createFridaySqliteLayer({
    dbPath,
    readPoolSize: 1,
    pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
  });
  console.log(JSON.stringify({ ok: true, dbPath: layer.dbPath }));
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
} finally {
  layer?.close();
}
