import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

describe("V008 plugin system foundation schema", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // ─── plugins table ───

  it("creates plugins table", () => {
    const tables = db.withReadConnection((d) =>
      d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plugins'").all(),
    ) as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
  });

  it("plugins table has expected columns", () => {
    const cols = db.withReadConnection((d) =>
      d.prepare("PRAGMA table_info(plugins)").all(),
    ) as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);

    expect(colNames).toContain("id");
    expect(colNames).toContain("name");
    expect(colNames).toContain("description");
    expect(colNames).toContain("version");
    expect(colNames).toContain("source");
    expect(colNames).toContain("status");
    expect(colNames).toContain("enabled");
    expect(colNames).toContain("trust_mode");
    expect(colNames).toContain("install_path");
    expect(colNames).toContain("kinds_json");
    expect(colNames).toContain("manifest_json");
    expect(colNames).toContain("config_json");
    expect(colNames).toContain("signature_algorithm");
    expect(colNames).toContain("signature_key_id");
    expect(colNames).toContain("signature_value");
    expect(colNames).toContain("signature_verified");
    expect(colNames).toContain("trusted_fingerprint_sha256");
    expect(colNames).toContain("last_verified_at");
    expect(colNames).toContain("installed_at");
    expect(colNames).toContain("updated_at");
    expect(colNames).toContain("last_error_code");
    expect(colNames).toContain("last_error_message");
  });

  it("creates idx_plugins_status_enabled index", () => {
    const indexes = db.withReadConnection((d) =>
      d.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'plugins'",
      ).all(),
    ) as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_plugins_status_enabled");
  });

  it("creates idx_plugins_source_updated index", () => {
    const indexes = db.withReadConnection((d) =>
      d.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'plugins'",
      ).all(),
    ) as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_plugins_source_updated");
  });

  // ─── plugin_dependencies table ───

  it("creates plugin_dependencies table", () => {
    const tables = db.withReadConnection((d) =>
      d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plugin_dependencies'").all(),
    ) as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
  });

  it("plugin_dependencies has expected columns", () => {
    const cols = db.withReadConnection((d) =>
      d.prepare("PRAGMA table_info(plugin_dependencies)").all(),
    ) as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);

    expect(colNames).toContain("plugin_id");
    expect(colNames).toContain("dependency_plugin_id");
    expect(colNames).toContain("semver_range");
    expect(colNames).toContain("optional");
    expect(colNames).toContain("created_at");
    expect(colNames).toContain("updated_at");
  });

  it("creates idx_plugin_deps_dependency index", () => {
    const indexes = db.withReadConnection((d) =>
      d.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'plugin_dependencies'",
      ).all(),
    ) as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_plugin_deps_dependency");
  });

  // ─── plugin_versions table ───

  it("creates plugin_versions table", () => {
    const tables = db.withReadConnection((d) =>
      d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plugin_versions'").all(),
    ) as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
  });

  it("creates idx_plugin_versions_plugin_released index", () => {
    const indexes = db.withReadConnection((d) =>
      d.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'plugin_versions'",
      ).all(),
    ) as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_plugin_versions_plugin_released");
  });

  // ─── migration row ───

  it("migration row version=8 exists", () => {
    const row = db.withReadConnection((d) =>
      d.prepare("SELECT version, name FROM schema_migrations WHERE version = 8").get(),
    ) as { version: number; name: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.version).toBe(8);
    expect(row!.name).toBe("v008-plugin-system-foundation");
  });
});
