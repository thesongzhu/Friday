import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

type StatusModule = typeof import("../../../../scripts/ops/friday-t3-provisioning-status.mjs");

const repoRoot = process.cwd();
const scriptUrl = pathToFileURL(
  path.resolve(repoRoot, "scripts/ops/friday-t3-provisioning-status.mjs"),
).href;
const tempRoots: string[] = [];

async function loadStatusModule(): Promise<StatusModule> {
  return (await import(`${scriptUrl}?t=${Date.now()}`)) as StatusModule;
}

function makeDbPath(): string {
  const root = mkdtempSync(path.join(tmpdir(), "friday-t3-status-test-"));
  tempRoots.push(root);
  return path.join(root, "hub.sqlite");
}

function execSql(dbPath: string, sql: string): void {
  execFileSync("sqlite3", [dbPath, sql], { encoding: "utf8" });
}

function createProvisionTables(dbPath: string): void {
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
    CREATE TABLE trust_grant (grant_id TEXT, revoked INTEGER, expires_at INTEGER);
    CREATE TABLE context_passport (passport_id TEXT);
    CREATE TABLE context_passport_item (passport_id TEXT, item_id TEXT);
  `,
  );
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("friday-t3-provisioning-status", () => {
  it("reports incomplete without minting or overclaiming when provision rows are absent", async () => {
    const statusModule = await loadStatusModule();
    const dbPath = makeDbPath();
    createProvisionTables(dbPath);

    const status = statusModule.buildT3ProvisioningStatus(dbPath, 1_780_000_000_000);

    expect(status.status).toBe("incomplete");
    expect(status.t3_provisioned).toBe(false);
    expect(status.truth_label).toContain("read_only");
    expect(status.missing).toEqual([
      "device_identity",
      "trusted_device",
      "active_trusted_device",
      "trust_grant",
      "active_trust_grant",
      "context_passport",
      "context_passport_item",
    ]);
    expect(status.counts).toMatchObject({
      device_identity: 0,
      trusted_device: 0,
      trust_grant: 0,
      context_passport: 0,
      context_passport_item: 0,
    });
    expect(status.active_trusted_devices).toBe(0);
    expect(status.latest_device).toBeNull();
  });

  it("renders a pairing-only operator hint before a trusted device exists", async () => {
    const statusModule = await loadStatusModule();
    const dbPath = makeDbPath();
    createProvisionTables(dbPath);

    const status = statusModule.buildT3ProvisioningStatus(dbPath, 1_780_000_000_000);
    const action = statusModule.buildT3OperatorAction(status);
    const rendered = statusModule.renderOperatorAction(action);

    expect(action.status).toBe("pairing_required");
    expect(action.truth_label).toContain("read_only");
    expect(rendered).toContain("friday-t3-pairing-proof.sh --pair");
    expect(rendered).toContain("PairAck");
    expect(rendered).not.toContain("friday-t3-operator-provision.sh");
    expect(rendered).not.toContain("operator-approve.key");
  });

  it("requires active grant and every T3 row family before reporting ready", async () => {
    const statusModule = await loadStatusModule();
    const dbPath = makeDbPath();
    createProvisionTables(dbPath);
    execSql(
      dbPath,
      `
      INSERT INTO device_identity(device_id, role, public_key, created_at, display_name)
        VALUES ('device-1', 'ios', X'0101010101010101010101010101010101010101010101010101010101010101', 1700, 'Jarvis iPhone');
      INSERT INTO trusted_device(device_id, public_key, paired_at, revoked_at, key_rotated_at, label)
        VALUES ('device-1', X'0101010101010101010101010101010101010101010101010101010101010101', 1800, NULL, NULL, 'Jarvis iPhone');
      INSERT INTO trust_grant(grant_id, revoked, expires_at) VALUES ('grant-1', 0, 1900000000000);
      INSERT INTO context_passport(passport_id) VALUES ('passport-1');
      INSERT INTO context_passport_item(passport_id, item_id) VALUES ('passport-1', 'item-1');
    `,
    );

    const status = statusModule.buildT3ProvisioningStatus(dbPath, 1_780_000_000_000);

    expect(status.status).toBe("ready");
    expect(status.t3_provisioned).toBe(true);
    expect(status.active_trusted_devices).toBe(1);
    expect(status.active_trust_grants).toBe(1);
    expect(status.missing).toEqual([]);
    expect(status.caveat).toContain("does not claim END-BAR");
    expect(status.latest_device).toMatchObject({
      device_id: "device-1",
      role: "ios",
      label: "Jarvis iPhone",
      paired_at: 1800,
      revoked_at: null,
      key_rotated_at: null,
      pubkey_fingerprint: "01010101:01010101",
    });
    expect(JSON.stringify(status.latest_device)).not.toContain(
      "0101010101010101010101010101010101010101010101010101010101010101",
    );
  });

  it("renders an operator-only provisioning hint after device pairing but before grant/passport rows", async () => {
    const statusModule = await loadStatusModule();
    const dbPath = makeDbPath();
    createProvisionTables(dbPath);
    execSql(
      dbPath,
      `
      INSERT INTO device_identity(device_id, role, public_key, created_at, display_name)
        VALUES ('device-1', 'ios', X'0101010101010101010101010101010101010101010101010101010101010101', 1700, 'Jarvis iPhone');
      INSERT INTO trusted_device(device_id, public_key, paired_at, revoked_at, key_rotated_at, label)
        VALUES ('device-1', X'0101010101010101010101010101010101010101010101010101010101010101', 1800, NULL, NULL, 'Jarvis iPhone');
    `,
    );

    const status = statusModule.buildT3ProvisioningStatus(dbPath, 1_780_000_000_000);
    const action = statusModule.buildT3OperatorAction(status);
    const rendered = statusModule.renderOperatorAction(action);

    expect(action.status).toBe("operator_provision_required");
    expect(action.latest_device_id).toBe("device-1");
    expect(rendered).toContain(
      ["FRIDAY_T3_OPERATOR_PROVISION_ACK", "operator-runs-t3-provisioning"].join("="),
    );
    expect(rendered).toContain("FRIDAY_T3_STEP=both");
    expect(rendered).toContain("prepare_items_json:");
    expect(rendered).toContain("/usr/bin/printf");
    expect(rendered).toContain("context passport items JSON OK");
    expect(rendered).toContain("FRIDAY_T3_ITEMS_JSON='/tmp/friday-t3-passport-items-reviewed.json'");
    expect(rendered).toContain("At least one explicit grant boundary is required");
    expect(rendered).not.toContain("<<");
    expect(rendered).not.toContain("operator-approve.key");
  });

  it("renders a passport-only hint with a safe items-json template when only passport rows are missing", async () => {
    const statusModule = await loadStatusModule();
    const dbPath = makeDbPath();
    createProvisionTables(dbPath);
    execSql(
      dbPath,
      `
      INSERT INTO device_identity(device_id, role, public_key, created_at, display_name)
        VALUES ('device-1', 'ios', X'0101010101010101010101010101010101010101010101010101010101010101', 1700, 'Jarvis iPhone');
      INSERT INTO trusted_device(device_id, public_key, paired_at, revoked_at, key_rotated_at, label)
        VALUES ('device-1', X'0101010101010101010101010101010101010101010101010101010101010101', 1800, NULL, NULL, 'Jarvis iPhone');
      INSERT INTO trust_grant(grant_id, revoked, expires_at) VALUES ('grant-1', 0, 1900000000000);
    `,
    );

    const status = statusModule.buildT3ProvisioningStatus(dbPath, 1_780_000_000_000);
    const action = statusModule.buildT3OperatorAction(status);
    const rendered = statusModule.renderOperatorAction(action);

    expect(action.status).toBe("operator_provision_required");
    expect(rendered).toContain("FRIDAY_T3_STEP=passport");
    expect(rendered).toContain("prepare_items_json:");
    expect(rendered).toContain("/tmp/friday-t3-passport-items-reviewed.json");
    expect(rendered).toContain("FRIDAY_T3_ITEMS_JSON='/tmp/friday-t3-passport-items-reviewed.json'");
    expect(rendered).not.toContain("FRIDAY_T3_GRANT_ID='<operator-chosen-grant-id>'");
    expect(rendered).not.toContain("<<");
    expect(rendered).not.toContain("operator-approve.key");
  });

  it("treats revoked-only trusted devices as pairing-required before provisioning", async () => {
    const statusModule = await loadStatusModule();
    const dbPath = makeDbPath();
    createProvisionTables(dbPath);
    execSql(
      dbPath,
      `
      INSERT INTO device_identity(device_id, role, public_key, created_at, display_name)
        VALUES ('device-revoked', 'ios', X'0101010101010101010101010101010101010101010101010101010101010101', 1700, 'Revoked iPhone');
      INSERT INTO trusted_device(device_id, public_key, paired_at, revoked_at, key_rotated_at, label)
        VALUES ('device-revoked', X'0101010101010101010101010101010101010101010101010101010101010101', 1800, 1900, NULL, 'Revoked iPhone');
    `,
    );

    const status = statusModule.buildT3ProvisioningStatus(dbPath, 1_780_000_000_000);
    const action = statusModule.buildT3OperatorAction(status);
    const rendered = statusModule.renderOperatorAction(action);

    expect(status.status).toBe("incomplete");
    expect(status.active_trusted_devices).toBe(0);
    expect(status.missing).toContain("active_trusted_device");
    expect(status.latest_device).toMatchObject({
      device_id: "device-revoked",
      revoked_at: 1900,
    });
    expect(action.status).toBe("pairing_required");
    expect(rendered).toContain("friday-t3-pairing-proof.sh --pair");
    expect(rendered).not.toContain("friday-t3-operator-provision.sh");
  });

  it("renders a no-action hint for fully provisioned T3 rows without claiming release", async () => {
    const statusModule = await loadStatusModule();
    const dbPath = makeDbPath();
    createProvisionTables(dbPath);
    execSql(
      dbPath,
      `
      INSERT INTO device_identity(device_id, role, public_key, created_at, display_name)
        VALUES ('device-1', 'ios', X'0101010101010101010101010101010101010101010101010101010101010101', 1700, 'Jarvis iPhone');
      INSERT INTO trusted_device(device_id, public_key, paired_at, revoked_at, key_rotated_at, label)
        VALUES ('device-1', X'0101010101010101010101010101010101010101010101010101010101010101', 1800, NULL, NULL, 'Jarvis iPhone');
      INSERT INTO trust_grant(grant_id, revoked, expires_at) VALUES ('grant-1', 0, 1900000000000);
      INSERT INTO context_passport(passport_id) VALUES ('passport-1');
      INSERT INTO context_passport_item(passport_id, item_id) VALUES ('passport-1', 'item-1');
    `,
    );

    const status = statusModule.buildT3ProvisioningStatus(dbPath, 1_780_000_000_000);
    const action = statusModule.buildT3OperatorAction(status);
    const rendered = statusModule.renderOperatorAction(action);

    expect(action.status).toBe("ready");
    expect(action.command).toBeNull();
    expect(rendered).toContain("No missing T3 provision row family");
    expect(rendered).toContain("does not claim END-BAR");
  });

  it("treats revoked or expired grants as not ready even when rows exist", async () => {
    const statusModule = await loadStatusModule();
    const dbPath = makeDbPath();
    createProvisionTables(dbPath);
    execSql(
      dbPath,
      `
      INSERT INTO device_identity(device_id, role, public_key, created_at, display_name)
        VALUES ('device-1', 'ios', X'0101010101010101010101010101010101010101010101010101010101010101', 1700, 'Jarvis iPhone');
      INSERT INTO trusted_device(device_id, public_key, paired_at, revoked_at, key_rotated_at, label)
        VALUES ('device-1', X'0101010101010101010101010101010101010101010101010101010101010101', 1800, NULL, NULL, 'Jarvis iPhone');
      INSERT INTO trust_grant(grant_id, revoked, expires_at) VALUES ('grant-1', 1, 1900000000000);
      INSERT INTO trust_grant(grant_id, revoked, expires_at) VALUES ('grant-2', 0, 1000);
      INSERT INTO context_passport(passport_id) VALUES ('passport-1');
      INSERT INTO context_passport_item(passport_id, item_id) VALUES ('passport-1', 'item-1');
    `,
    );

    const status = statusModule.buildT3ProvisioningStatus(dbPath, 1_780_000_000_000);

    expect(status.status).toBe("incomplete");
    expect(status.active_trusted_devices).toBe(1);
    expect(status.active_trust_grants).toBe(0);
    expect(status.missing).toEqual(["active_trust_grant"]);
  });
});
