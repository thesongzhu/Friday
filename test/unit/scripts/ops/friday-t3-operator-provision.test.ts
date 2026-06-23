import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const scriptPath = resolve(repoRoot, "scripts/ops/friday-t3-operator-provision.sh");
const source = readFileSync(scriptPath, "utf8");
const tempRoots: string[] = [];

function makeDbPath(): string {
  const root = mkdtempSync(resolve(tmpdir(), "friday-t3-operator-provision-test-"));
  tempRoots.push(root);
  return resolve(root, "hub.sqlite");
}

function execSql(dbPath: string, sql: string): void {
  execFileSync("sqlite3", [dbPath, sql], { encoding: "utf8" });
}

function runProvisionExpectFailure(dbPath: string): string {
  try {
    execFileSync("bash", [scriptPath], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        FRIDAY_T3_DB_PATH: dbPath,
        FRIDAY_T3_OPERATOR_PROVISION_ACK: "operator-runs-t3-provisioning",
      },
    });
  } catch (error) {
    const failure = error as { stderr?: Buffer | string; stdout?: Buffer | string };
    return `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`;
  }
  throw new Error("expected friday-t3-operator-provision.sh to fail before operator CLI execution");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("friday-t3-operator-provision.sh", () => {
  it("keeps T3 minting behind an explicit operator ceremony acknowledgement", () => {
    expect(source).toContain("FRIDAY_T3_OPERATOR_PROVISION_ACK");
    expect(source).toContain("operator-runs-t3-provisioning");
    expect(source).toContain("STEP");
    expect(source).toContain("grant|passport|both");
  });

  it("uses the operator CLI without reading signing keys or exposing an app mint endpoint", () => {
    expect(source).toContain("friday-operator-approve");
    expect(source).toContain("-p friday-operator-cli");
    expect(source).toContain("passport-mint");
    expect(source).not.toContain("operator-approve.key");
    expect(source).not.toContain("FRIDAY_OPERATOR_APPROVE_KEY");
    expect(source).not.toContain("launchctl");
    expect(source).not.toContain("curl ");
  });

  it("requires explicit grant boundaries and context passport inputs", () => {
    expect(source).toContain("FRIDAY_T3_GRANT_ID");
    expect(source).toContain("FRIDAY_T3_AGENT_ID");
    expect(source).toContain("FRIDAY_T3_RISK_CEILING");
    expect(source).toContain("at least one explicit grant boundary is required");
    expect(source).toContain("FRIDAY_T3_PASSPORT_ID");
    expect(source).toContain("FRIDAY_T3_MISSION_ID");
    expect(source).toContain("FRIDAY_T3_DESTINATION_LANE");
    expect(source).toContain("FRIDAY_T3_ITEMS_JSON");
  });

  it("requires an active trusted device instead of accepting revoked pairing rows", () => {
    expect(source).toContain("active_trusted_device_count");
    expect(source).toContain("FROM trusted_device WHERE revoked_at IS NULL");
    expect(source).toContain("active_trusted_device=");

    const dbPath = makeDbPath();
    execSql(
      dbPath,
      `
      CREATE TABLE device_identity (
        device_id TEXT,
        role TEXT,
        public_key BLOB,
        created_at INTEGER,
        display_name TEXT
      );
      CREATE TABLE trusted_device (
        device_id TEXT,
        public_key BLOB,
        paired_at INTEGER,
        revoked_at INTEGER,
        key_rotated_at INTEGER,
        label TEXT
      );
      INSERT INTO device_identity(device_id, role, public_key, created_at, display_name)
        VALUES ('device-revoked', 'ios', X'0101010101010101010101010101010101010101010101010101010101010101', 1700, 'Revoked iPhone');
      INSERT INTO trusted_device(device_id, public_key, paired_at, revoked_at, key_rotated_at, label)
        VALUES ('device-revoked', X'0101010101010101010101010101010101010101010101010101010101010101', 1800, 1900, NULL, 'Revoked iPhone');
    `,
    );

    const output = runProvisionExpectFailure(dbPath);

    expect(output).toContain("active_trusted_device=0");
    expect(output).toContain("completed active QR pairing");
    expect(output).not.toContain("Running operator trust_grant ceremony");
    expect(output).not.toContain("friday-operator-approve");
  });
});
