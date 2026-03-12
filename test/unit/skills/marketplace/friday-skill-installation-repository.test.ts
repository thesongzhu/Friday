import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridaySkillInstallationRepository } from "#skills";
import { createTestDb, NOW } from "./marketplace.helper.js";

describe("FridaySkillInstallationRepository", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
    // Insert a skill for FK
    db.withWriteTransaction((conn) => {
      conn.prepare(
        `INSERT INTO skills (id, name, source, origin, status, created_at, updated_at)
         VALUES ('skill-1', 'Test Skill', 'marketplace', 'managed', 'not_installed', ?, ?)`,
      ).run(NOW, NOW);
    });
  });

  afterEach(() => {
    db.close();
  });

  function createRepo() {
    return createFridaySkillInstallationRepository();
  }

  it("inserts and retrieves an installation", () => {
    const repo = createRepo();
    const entity = db.withWriteTransaction((conn) =>
      repo.insertInstallation(conn, {
        id: "inst-1",
        skillId: "skill-1",
        version: "1.0.0",
        status: "installing",
        permissionsGranted: ["network.connect", "filesystem.read"],
        nowIso: NOW,
      }),
    );

    expect(entity.id).toBe("inst-1");
    expect(entity.skillId).toBe("skill-1");
    expect(entity.status).toBe("installing");
    expect(entity.permissionsGranted).toEqual(["network.connect", "filesystem.read"]);
    expect(entity.satelliteId).toBeUndefined();
    expect(entity.lastError).toBeUndefined();
  });

  it("updates installation status", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertInstallation(conn, { id: "inst-1", skillId: "skill-1", version: "1.0.0", status: "installing", permissionsGranted: [], nowIso: NOW });
      repo.setInstallationStatus(conn, "inst-1", "installed", NOW);
    });

    const installations = db.withReadConnection((conn) => repo.listBySkill(conn, "skill-1"));
    expect(installations[0].status).toBe("installed");
  });

  it("records installation error", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertInstallation(conn, { id: "inst-1", skillId: "skill-1", version: "1.0.0", status: "installing", permissionsGranted: [], nowIso: NOW });
      repo.setInstallationError(conn, "inst-1", "Checksum mismatch", NOW);
    });

    const installations = db.withReadConnection((conn) => repo.listBySkill(conn, "skill-1"));
    expect(installations[0].status).toBe("failed");
    expect(installations[0].lastError).toBe("Checksum mismatch");
  });

  it("lists installed history", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertInstallation(conn, { id: "inst-1", skillId: "skill-1", version: "1.0.0", status: "installed", permissionsGranted: [], nowIso: "2025-01-01T00:00:00.000Z" });
      repo.insertInstallation(conn, { id: "inst-2", skillId: "skill-1", version: "2.0.0", status: "installed", permissionsGranted: [], nowIso: "2025-06-01T00:00:00.000Z" });
      repo.insertInstallation(conn, { id: "inst-3", skillId: "skill-1", version: "3.0.0", status: "failed", permissionsGranted: [], nowIso: NOW });
    });

    const history = db.withReadConnection((conn) =>
      repo.listInstalledHistory(conn, "skill-1"),
    );
    // Only installed status, most recent first
    expect(history).toHaveLength(2);
    expect(history[0].version).toBe("2.0.0");
    expect(history[1].version).toBe("1.0.0");
  });

  it("lists by satellite and status", () => {
    const repo = createRepo();
    // Insert a satellite for FK
    db.withWriteTransaction((conn) => {
      conn.prepare(
        `INSERT INTO satellites (id, type, display_name, pairing_status, trust_level, public_key, platform, arch, app_version, node_version, created_at, updated_at)
         VALUES ('sat-1', 'desktop', 'My Desktop', 'approved', 'standard', 'pk', 'darwin', 'arm64', '0.1.0', '22', ?, ?)`,
      ).run(NOW, NOW);

      repo.insertInstallation(conn, { id: "inst-1", skillId: "skill-1", version: "1.0.0", satelliteId: "sat-1", status: "installed", permissionsGranted: [], nowIso: NOW });
      repo.insertInstallation(conn, { id: "inst-2", skillId: "skill-1", version: "2.0.0", satelliteId: "sat-1", status: "failed", permissionsGranted: [], nowIso: NOW });
    });

    const installed = db.withReadConnection((conn) =>
      repo.listBySatelliteAndStatus(conn, "sat-1", "installed"),
    );
    expect(installed).toHaveLength(1);
    expect(installed[0].version).toBe("1.0.0");
  });

  it("handles installation with satellite ID", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      conn.prepare(
        `INSERT INTO satellites (id, type, display_name, pairing_status, trust_level, public_key, platform, arch, app_version, node_version, created_at, updated_at)
         VALUES ('sat-1', 'desktop', 'My Desktop', 'approved', 'standard', 'pk', 'darwin', 'arm64', '0.1.0', '22', ?, ?)`,
      ).run(NOW, NOW);

      repo.insertInstallation(conn, { id: "inst-1", skillId: "skill-1", version: "1.0.0", satelliteId: "sat-1", status: "installing", permissionsGranted: [], nowIso: NOW });
    });

    const inst = db.withReadConnection((conn) =>
      repo.listBySkill(conn, "skill-1"),
    );
    expect(inst[0].satelliteId).toBe("sat-1");
  });
});
