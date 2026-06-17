import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const auditScript = resolve(
  repoRoot,
  "scripts/diagnostics/friday-outcome-proof-audit.sh",
);

const tempRoots: string[] = [];

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const tempRoot = mkdtempSync(join(tmpdir(), "friday-outcome-proof-audit-"));
  tempRoots.push(tempRoot);
  return tempRoot;
}

type FixtureOptions = {
  receipt?: string;
  ledgerRunId?: string;
  fallback?: number;
  totalTokens?: number;
  ledgerCreatedAt?: number;
  workUpdatedAt?: number;
  proofReceiptsJson?: string;
};

function createFixtureDb(dbPath: string, options: FixtureOptions = {}) {
  const db = new Database(dbPath);
  const receipt =
    options.receipt ??
    "proof://outcome/AnswerProduced/run-1?signal=answer_len=12";
  const proofReceiptsJson =
    options.proofReceiptsJson ?? JSON.stringify([receipt]);

  db.exec(`
    CREATE TABLE work_item (
      work_item_id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      proof_receipts TEXT NOT NULL
    );
    CREATE TABLE token_ledger (
      ledger_id TEXT PRIMARY KEY,
      run_id TEXT,
      provider_kind TEXT NOT NULL,
      model TEXT NOT NULL,
      base_url_host TEXT NOT NULL,
      fallback INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO work_item
      (work_item_id, mission_id, status, updated_at_ms, proof_receipts)
      VALUES ('work-1', 'mission-1', 'completed_with_proof', ?, ?)`,
  ).run(options.workUpdatedAt ?? 1200, proofReceiptsJson);
  db.prepare(
    `INSERT INTO token_ledger
      (ledger_id, run_id, provider_kind, model, base_url_host, fallback, total_tokens, created_at)
      VALUES ('ledger-1', ?, 'anthropic', 'claude-opus-4-8', 'api.anthropic.com', ?, ?, ?)`,
  ).run(
    options.ledgerRunId ?? "run-1",
    options.fallback ?? 0,
    options.totalTokens ?? 12,
    options.ledgerCreatedAt ?? 1100,
  );
  db.close();
}

function runAudit(dbPath: string, extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [auditScript], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      FRIDAY_HUB_AGENT_RUN_DB_PATH: dbPath,
      FRIDAY_OUTCOME_PROOF_AUDIT_SINCE_MS: "1",
      FRIDAY_OUTCOME_PROOF_AUDIT_REQUIRED_RECEIPTS: "1",
      ...extraEnv,
    },
  });
}

describe("outcome proof audit", () => {
  it("keeps the script shell-parseable and scoped", () => {
    const bashResult = spawnSync("bash", ["-n", auditScript], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(bashResult.status, bashResult.stderr).toBe(0);

    const source = readFileSync(auditScript, "utf8");
    expect(source).toContain("FRIDAY_OUTCOME_PROOF_AUDIT_SINCE_MS");
    expect(source).toContain(
      "FRIDAY_OUTCOME_PROOF_AUDIT_ALLOW_UNSCOPED",
    );
    expect(source).toContain("json_valid(proof_receipts)");
    expect(source).toContain("proof://outcome/AnswerProduced/");
    expect(source).toContain("ledger.run_id = p.run_id");
    expect(source).toContain("ledger.fallback = 0");
    expect(source).toContain("ledger.total_tokens > 0");
    expect(source).toContain("ledger.created_at <= p.updated_at_ms");
    expect(source).toContain("p.run_id <> ''");
    expect(source).toContain("PASS - scoped AnswerProduced outcome receipts");
  });

  it("passes when AnswerProduced receipt joins same-run non-fallback ledger", () => {
    const dbPath = join(makeTempRoot(), "pass.sqlite");
    createFixtureDb(dbPath);

    const result = runAudit(dbPath);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("outcome_answer_receipts=1");
    expect(result.stdout).toContain("joined_answer_receipts=1");
    expect(result.stdout).toContain("weak_or_orphan_answer_receipts=0");
    expect(result.stdout).toContain("PASS - scoped AnswerProduced");
  });

  it("fails when the receipt run_id has no same-run ledger", () => {
    const dbPath = join(makeTempRoot(), "orphan.sqlite");
    createFixtureDb(dbPath, { ledgerRunId: "other-run" });

    const result = runAudit(dbPath);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("outcome_answer_receipts=1");
    expect(result.stdout).toContain("weak_or_orphan_answer_receipts=1");
    expect(result.stdout).toContain("FAIL - at least one AnswerProduced");
  });

  it("fails when the joined ledger is fallback or tokenless", () => {
    const dbPath = join(makeTempRoot(), "weak.sqlite");
    createFixtureDb(dbPath, { fallback: 1, totalTokens: 0 });

    const result = runAudit(dbPath);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("weak_or_orphan_answer_receipts=1");
  });

  it("fails when the ledger appears after WorkItem completion", () => {
    const dbPath = join(makeTempRoot(), "non-causal.sqlite");
    createFixtureDb(dbPath, { ledgerCreatedAt: 1500, workUpdatedAt: 1200 });

    const result = runAudit(dbPath);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("weak_or_orphan_answer_receipts=1");
  });

  it("fails malformed proof JSON before json_each can crash the audit", () => {
    const dbPath = join(makeTempRoot(), "malformed-json.sqlite");
    createFixtureDb(dbPath, { proofReceiptsJson: "[not-json" });

    const result = runAudit(dbPath);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("malformed_json_work_items=1");
    expect(result.stdout).toContain("FAIL - at least one scoped WorkItem");
  });
});
