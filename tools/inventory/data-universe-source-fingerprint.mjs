/**
 * INV-DATA-001 — canonical SOURCE FINGERPRINT for the authoritative data-universe
 * census. Plain JS (no TS deps) so BOTH the `.ts` oracle (which regenerates the
 * committed snapshot by ACTUALLY running the migrations under vitest) and the
 * `.mjs` reconcile CLI (which runs under plain node and reads the snapshot) share
 * ONE definition of "what source the census depends on".
 *
 * The fingerprint is a sha256 over the sorted (relative-path, sha256(content))
 * pairs of every file the authoritative census is derived from. The oracle stamps
 * it into the snapshot; the CLI recomputes it from disk and FAILS CLOSED if it no
 * longer matches — so a migration / schema / retention / oracle change that is
 * NOT followed by a snapshot regeneration turns the gate RED instead of serving a
 * stale (possibly false-clean) census. This is what keeps the committed snapshot
 * LIVE without a TypeScript runtime in the CLI.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");

const SQLITE_MIGRATIONS_DIR = join(REPO_ROOT, "src", "state", "sqlite", "migrations");

/**
 * The ordered, explicit set of source files the authoritative census depends on:
 *   - every SQLite migration `.ts` (incl. index.ts ordering + the migration types),
 *   - the migration runner (it creates `schema_migrations` + governs apply hooks),
 *   - the Rust-owned `schema.rs` (parsed statically — documented boundary),
 *   - the retention policy category constants (canonical governance source),
 *   - the canonical retention category → physical-target map
 *     (`friday-retention-targets.ts`) that BOTH the reaper and this census consume,
 *   - EVERY executable retention-target source — the reaper itself
 *     (`friday-retention-job.ts`, which runs the SQL-direct DELETEs) AND every
 *     repository that owns a repository-routed retention DELETE (skill-run store,
 *     heartbeat / outbox / pairing-request / bootstrap-nonce repos) — so a change
 *     to ANY real retention delete target invalidates the snapshot fingerprint, and
 *   - the census oracle itself (its introspection / rust-parse / mapping logic).
 * A change to ANY of these can change the census (or a real delete target), so
 * ANY change must re-stamp the snapshot.
 */
export function sourceInputFiles() {
  const files = [];
  for (const name of readdirSync(SQLITE_MIGRATIONS_DIR).filter((n) => n.endsWith(".ts")).sort()) {
    files.push(join(SQLITE_MIGRATIONS_DIR, name));
  }
  files.push(join(REPO_ROOT, "src", "state", "sqlite", "friday-migration-runner.ts"));
  files.push(join(REPO_ROOT, "rust-core", "crates", "friday-storage", "src", "schema.rs"));
  files.push(join(REPO_ROOT, "src", "jobs", "retention", "friday-retention.types.ts"));
  // Canonical category → physical-target authority (consumed by BOTH the reaper
  // and the oracle) + every executable retention-target source.
  files.push(join(REPO_ROOT, "src", "jobs", "retention", "friday-retention-targets.ts"));
  files.push(join(REPO_ROOT, "src", "jobs", "retention", "friday-retention-job.ts"));
  files.push(join(REPO_ROOT, "src", "ledger", "runs", "friday-skill-run-store.ts"));
  files.push(
    join(REPO_ROOT, "src", "satellites", "persistence", "friday-satellite-heartbeat-repository.ts"),
  );
  files.push(
    join(REPO_ROOT, "src", "satellites", "persistence", "friday-outbox-message-repository.ts"),
  );
  files.push(
    join(
      REPO_ROOT,
      "src",
      "satellites",
      "persistence",
      "friday-satellite-pairing-request-repository.ts",
    ),
  );
  files.push(
    join(REPO_ROOT, "src", "api", "persistence", "friday-setup-bootstrap-nonce-repository.ts"),
  );
  files.push(join(HERE, "data-universe-oracle.ts"));
  return files.sort();
}

/** Deterministic sha256 fingerprint over the census's source inputs on disk. */
export function computeSourceFingerprint() {
  const outer = createHash("sha256");
  for (const file of sourceInputFiles()) {
    const rel = relative(REPO_ROOT, file).split("\\").join("/");
    const inner = createHash("sha256").update(readFileSync(file, "utf8")).digest("hex");
    outer.update(rel);
    outer.update("\0");
    outer.update(inner);
    outer.update("\n");
  }
  return `sha256:${outer.digest("hex")}`;
}
