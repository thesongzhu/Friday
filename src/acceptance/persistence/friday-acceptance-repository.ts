import type Database from "better-sqlite3";
import type {
  FridayAcceptanceRunResult,
  FridayAcceptanceRunRow,
  FridayAcceptanceTest,
  FridayAcceptanceTestRow,
  FridayAcceptanceTestVersion,
  FridayAcceptanceTestVersionRow,
} from "../model/friday-acceptance.types.js";

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    console.warn("[friday][acceptance-repository] JSON parse failed:", err instanceof Error ? err.message : String(err));
    return fallback;
  }
}

function rowToTest(row: FridayAcceptanceTestRow): FridayAcceptanceTest {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    artifactType: row.artifact_type as FridayAcceptanceTest["artifactType"],
    checkConfig: parseJson(row.config_json, {} as FridayAcceptanceTest["checkConfig"]),
    priority: row.priority,
    enabled: row.enabled === 1,
    shortCircuit: row.short_circuit === 1,
    rulePolicyBundleId: row.rule_policy_bundle_id ?? undefined,
    tags: parseJson<string[]>(row.tags_json, []),
    version: row.version,
    etag: row.etag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
  };
}

function rowToVersion(row: FridayAcceptanceTestVersionRow): FridayAcceptanceTestVersion {
  return {
    id: row.id,
    testId: row.test_id,
    version: row.version,
    snapshot: parseJson<FridayAcceptanceTest>(row.snapshot_json, {} as FridayAcceptanceTest),
    changedBy: row.changed_by ?? undefined,
    changeNote: row.change_note ?? undefined,
    createdAt: row.created_at,
  };
}

function rowToRun(row: FridayAcceptanceRunRow): FridayAcceptanceRunResult {
  return parseJson<FridayAcceptanceRunResult>(row.result_json, {
    id: row.id,
    executionId: row.execution_id,
    artifactUri: row.artifact_uri,
    artifactType: row.artifact_type as FridayAcceptanceRunResult["artifactType"],
    overallVerdict: row.overall_verdict as FridayAcceptanceRunResult["overallVerdict"],
    overallSeverity: row.overall_severity as FridayAcceptanceRunResult["overallSeverity"],
    state: row.state as FridayAcceptanceRunResult["state"],
    stateTransitions: [],
    checks: [],
    checksTotal: row.checks_total,
    checksPassed: row.checks_passed,
    checksFailed: row.checks_failed,
    checksWarned: row.checks_warned,
    checksSkipped: row.checks_skipped,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  });
}

export interface FridayAcceptanceRepository {
  listTests(db: Database.Database, opts?: {
    artifactType?: string;
    checkType?: string;
    enabled?: boolean;
    tag?: string;
    includeDeleted?: boolean;
    limit?: number;
    offset?: number;
  }): FridayAcceptanceTest[];
  getTestById(db: Database.Database, testId: string): FridayAcceptanceTest | null;
  insertTest(db: Database.Database, row: FridayAcceptanceTestRow): void;
  updateTest(db: Database.Database, row: FridayAcceptanceTestRow): void;
  insertVersion(db: Database.Database, row: FridayAcceptanceTestVersionRow): void;
  listVersions(db: Database.Database, testId: string, limit?: number, offset?: number): FridayAcceptanceTestVersion[];
  insertRun(db: Database.Database, row: FridayAcceptanceRunRow): void;
  getRunById(db: Database.Database, runId: string): FridayAcceptanceRunResult | null;
  listRuns(db: Database.Database, opts?: {
    executionId?: string;
    overallVerdict?: string;
    limit?: number;
    offset?: number;
  }): FridayAcceptanceRunResult[];
  listRunsByArtifact(db: Database.Database, artifactUri: string, opts?: {
    verdict?: string;
    severity?: string;
    after?: string;
    before?: string;
    limit?: number;
    offset?: number;
  }): FridayAcceptanceRunResult[];
}

export function createFridayAcceptanceRepository(): FridayAcceptanceRepository {
  return {
    listTests(db, opts = {}) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (!opts.includeDeleted) {
        clauses.push("deleted_at IS NULL");
      }
      if (opts.artifactType) {
        clauses.push("artifact_type = ?");
        params.push(opts.artifactType);
      }
      if (opts.checkType) {
        clauses.push("check_type = ?");
        params.push(opts.checkType);
      }
      if (typeof opts.enabled === "boolean") {
        clauses.push("enabled = ?");
        params.push(opts.enabled ? 1 : 0);
      }
      if (opts.tag) {
        clauses.push("tags_json LIKE ?");
        params.push(`%\"${opts.tag}\"%`);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const limit = opts.limit ?? 100;
      const offset = opts.offset ?? 0;
      const rows = db
        .prepare(
          `SELECT * FROM acceptance_tests
           ${where}
           ORDER BY priority ASC, updated_at DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset) as FridayAcceptanceTestRow[];
      return rows.map(rowToTest);
    },

    getTestById(db, testId) {
      const row = db
        .prepare(`SELECT * FROM acceptance_tests WHERE id = ?`)
        .get(testId) as FridayAcceptanceTestRow | undefined;
      return row ? rowToTest(row) : null;
    },

    insertTest(db, row) {
      db.prepare(
        `INSERT INTO acceptance_tests (
           id, name, description, artifact_type, check_type, config_json, priority, enabled,
           short_circuit, rule_policy_bundle_id, tags_json, version, etag, created_at, updated_at, deleted_at
         ) VALUES (
           @id, @name, @description, @artifact_type, @check_type, @config_json, @priority, @enabled,
           @short_circuit, @rule_policy_bundle_id, @tags_json, @version, @etag, @created_at, @updated_at, @deleted_at
         )`,
      ).run(row);
    },

    updateTest(db, row) {
      db.prepare(
        `UPDATE acceptance_tests SET
           name = @name,
           description = @description,
           artifact_type = @artifact_type,
           check_type = @check_type,
           config_json = @config_json,
           priority = @priority,
           enabled = @enabled,
           short_circuit = @short_circuit,
           rule_policy_bundle_id = @rule_policy_bundle_id,
           tags_json = @tags_json,
           version = @version,
           etag = @etag,
           updated_at = @updated_at,
           deleted_at = @deleted_at
         WHERE id = @id`,
      ).run(row);
    },

    insertVersion(db, row) {
      db.prepare(
        `INSERT INTO acceptance_test_versions (
           id, test_id, version, snapshot_json, changed_by, change_note, created_at
         ) VALUES (
           @id, @test_id, @version, @snapshot_json, @changed_by, @change_note, @created_at
         )`,
      ).run(row);
    },

    listVersions(db, testId, limit = 50, offset = 0) {
      const rows = db
        .prepare(
          `SELECT * FROM acceptance_test_versions
           WHERE test_id = ?
           ORDER BY version DESC
           LIMIT ? OFFSET ?`,
        )
        .all(testId, limit, offset) as FridayAcceptanceTestVersionRow[];
      return rows.map(rowToVersion);
    },

    insertRun(db, row) {
      db.prepare(
        `INSERT INTO acceptance_runs (
           id, execution_id, artifact_uri, artifact_type, overall_verdict, overall_severity, state,
           checks_total, checks_passed, checks_failed, checks_warned, checks_skipped, duration_ms,
           result_json, artifact_json, idempotency_key, created_at, updated_at
         ) VALUES (
           @id, @execution_id, @artifact_uri, @artifact_type, @overall_verdict, @overall_severity, @state,
           @checks_total, @checks_passed, @checks_failed, @checks_warned, @checks_skipped, @duration_ms,
           @result_json, @artifact_json, @idempotency_key, @created_at, @updated_at
         )`,
      ).run(row);
    },

    getRunById(db, runId) {
      const row = db
        .prepare(`SELECT * FROM acceptance_runs WHERE id = ?`)
        .get(runId) as FridayAcceptanceRunRow | undefined;
      return row ? rowToRun(row) : null;
    },

    listRuns(db, opts = {}) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (opts.executionId) {
        clauses.push("execution_id = ?");
        params.push(opts.executionId);
      }
      if (opts.overallVerdict) {
        clauses.push("overall_verdict = ?");
        params.push(opts.overallVerdict);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db
        .prepare(
          `SELECT * FROM acceptance_runs
           ${where}
           ORDER BY created_at DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...params, opts.limit ?? 100, opts.offset ?? 0) as FridayAcceptanceRunRow[];
      return rows.map(rowToRun);
    },

    listRunsByArtifact(db, artifactUri, opts = {}) {
      const clauses = ["artifact_uri = ?"];
      const params: unknown[] = [artifactUri];
      if (opts.verdict) {
        clauses.push("overall_verdict = ?");
        params.push(opts.verdict);
      }
      if (opts.severity) {
        clauses.push("overall_severity = ?");
        params.push(opts.severity);
      }
      if (opts.after) {
        clauses.push("created_at >= ?");
        params.push(opts.after);
      }
      if (opts.before) {
        clauses.push("created_at < ?");
        params.push(opts.before);
      }
      const rows = db
        .prepare(
          `SELECT * FROM acceptance_runs
           WHERE ${clauses.join(" AND ")}
           ORDER BY created_at DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...params, opts.limit ?? 100, opts.offset ?? 0) as FridayAcceptanceRunRow[];
      return rows.map(rowToRun);
    },
  };
}
