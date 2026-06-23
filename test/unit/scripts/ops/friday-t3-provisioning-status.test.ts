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
    CREATE TABLE device_identity (device_id TEXT);
    CREATE TABLE trusted_device (device_id TEXT);
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
  });

  it("requires active grant and every T3 row family before reporting ready", async () => {
    const statusModule = await loadStatusModule();
    const dbPath = makeDbPath();
    createProvisionTables(dbPath);
    execSql(
      dbPath,
      `
      INSERT INTO device_identity(device_id) VALUES ('device-1');
      INSERT INTO trusted_device(device_id) VALUES ('device-1');
      INSERT INTO trust_grant(grant_id, revoked, expires_at) VALUES ('grant-1', 0, 1900000000000);
      INSERT INTO context_passport(passport_id) VALUES ('passport-1');
      INSERT INTO context_passport_item(passport_id, item_id) VALUES ('passport-1', 'item-1');
    `,
    );

    const status = statusModule.buildT3ProvisioningStatus(dbPath, 1_780_000_000_000);

    expect(status.status).toBe("ready");
    expect(status.t3_provisioned).toBe(true);
    expect(status.active_trust_grants).toBe(1);
    expect(status.missing).toEqual([]);
    expect(status.caveat).toContain("does not claim END-BAR");
  });

  it("treats revoked or expired grants as not ready even when rows exist", async () => {
    const statusModule = await loadStatusModule();
    const dbPath = makeDbPath();
    createProvisionTables(dbPath);
    execSql(
      dbPath,
      `
      INSERT INTO device_identity(device_id) VALUES ('device-1');
      INSERT INTO trusted_device(device_id) VALUES ('device-1');
      INSERT INTO trust_grant(grant_id, revoked, expires_at) VALUES ('grant-1', 1, 1900000000000);
      INSERT INTO trust_grant(grant_id, revoked, expires_at) VALUES ('grant-2', 0, 1000);
      INSERT INTO context_passport(passport_id) VALUES ('passport-1');
      INSERT INTO context_passport_item(passport_id, item_id) VALUES ('passport-1', 'item-1');
    `,
    );

    const status = statusModule.buildT3ProvisioningStatus(dbPath, 1_780_000_000_000);

    expect(status.status).toBe("incomplete");
    expect(status.active_trust_grants).toBe(0);
    expect(status.missing).toEqual(["active_trust_grant"]);
  });
});
