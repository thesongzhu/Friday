import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createFridayRustHubWorkflowCatalogBridgeService } from "../../../../src/api/mission-spine/friday-rust-hub-workflow-catalog-bridge-service.js";

/**
 * DARK (Rust-wired-DEV) bridge test for the `hub_workflow_catalog` bin (#657). Spawns a
 * SCRIPTED MOCK bin (no real Rust compile, no SQLite, hermetic in CI) via `adapterBin`,
 * mirroring the chmod-0o755 shebang-mock idiom from the run-task-bridge test. Covers each of
 * the five catalog ops the retired TS `workflows.*` surface maps to, plus the fail-closed
 * cases: non-zero exit, malformed JSON, timeout, `ok:false`, and the verbatim/body-leak
 * rejection that mirrors the bin's own output guard.
 */
describe("friday-rust-hub-workflow-catalog-bridge-service (Tier-2 workflow catalog mutation bridge)", () => {
  let scratch: string | undefined;

  afterEach(() => {
    if (scratch) {
      rmSync(scratch, { recursive: true, force: true });
      scratch = undefined;
    }
  });

  /**
   * Write a scripted-mock bin + an empty DB file (the bridge checks the DB path EXISTS before
   * spawning), returning both paths. The mock echoes back parts of argv it received so a test
   * can assert the argv mapping (op + flags) when it wants to.
   */
  function setup(mockSource: string): { binPath: string; dbPath: string } {
    scratch = mkdtempSync(join(tmpdir(), "friday-hub-workflow-catalog-bridge-"));
    const binPath = join(scratch, "hub_workflow_catalog_mock.mjs");
    writeFileSync(binPath, `#!/usr/bin/env node\n${mockSource}`);
    chmodSync(binPath, 0o755);
    const dbPath = join(scratch, "hub.sqlite");
    writeFileSync(dbPath, "");
    return { binPath, dbPath };
  }

  function setupPrebuilt(mockSource: string): { repoRoot: string; dbPath: string } {
    scratch = mkdtempSync(join(tmpdir(), "friday-hub-workflow-catalog-prebuilt-"));
    const releaseDir = join(scratch, "rust-core", "target", "release");
    mkdirSync(releaseDir, { recursive: true });
    const binPath = join(releaseDir, "hub_workflow_catalog");
    writeFileSync(binPath, `#!/usr/bin/env node\n${mockSource}`);
    chmodSync(binPath, 0o755);
    const dbPath = join(scratch, "hub.sqlite");
    writeFileSync(dbPath, "");
    return { repoRoot: scratch, dbPath };
  }

  /** A scripted mock that emits a valid refs-only receipt echoing the op + any extra fields. */
  function okMock(extraJson = "{}"): string {
    return `
      const argv = process.argv.slice(2);
      const get = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
      const out = {
        truth_label: "rust_wired_dev",
        proof_only: true,
        ok: true,
        op: get("--op"),
        workflow_id: get("--workflow-id"),
        slug_sha256: "00",
        slug_len: 2,
        name_sha256: "11",
        name_len: 3,
        description_sha256: null,
        description_len: null,
        tags_json_sha256: "22",
        tags_json_len: 2,
        is_archived: false,
        revision: 1,
        etag: "${"e".repeat(64)}",
        deployed_version: null,
        created_at_ms: 100,
        updated_at_ms: 100,
        ...${extraJson},
      };
      process.stdout.write(JSON.stringify(out));
    `;
  }

  it("create: maps fields to argv and parses a refs-only receipt", async () => {
    const { binPath, dbPath } = setup(`
      const argv = process.argv.slice(2);
      const get = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
      process.stdout.write(JSON.stringify({
        truth_label: "rust_wired_dev",
        proof_only: true,
        ok: true,
        op: get("--op"),
        workflow_id: get("--workflow-id"),
        // Echo the def-json presence + tags so the test asserts argv mapping.
        slug_sha256: get("--slug") ? "aa" : "00",
        slug_len: 2,
        name_sha256: get("--name") ? "bb" : "00",
        name_len: 3,
        description_sha256: get("--description") ? "cc" : null,
        description_len: get("--description") ? 4 : null,
        tags_json_sha256: get("--tags-json") ? "dd" : "00",
        tags_json_len: 2,
        is_archived: false,
        revision: 1,
        etag: "${"e".repeat(64)}",
        deployed_version: null,
        created_at_ms: 100,
        updated_at_ms: 100,
        _def_present: get("--def-json") !== undefined,
      }));
    `);
    const service = createFridayRustHubWorkflowCatalogBridgeService({ adapterBin: binPath, dbPath });

    const receipt = await service.mutateCatalog({
      op: "create",
      workflowId: "wf1",
      slug: "research-wf",
      name: "Research",
      description: "a research workflow",
      tagsJson: JSON.stringify(["ai"]),
      defJson: JSON.stringify({ schema_version: 1, name: "Research", steps: [] }),
      nowMs: 100,
    });

    expect(receipt).toMatchObject({
      truthLabel: "rust_wired_dev",
      proofOnly: true,
      op: "create",
      workflowId: "wf1",
      slugSha256: "aa",
      nameSha256: "bb",
      descriptionSha256: "cc",
      tagsJsonSha256: "dd",
      revision: 1,
      isArchived: false,
      deployedVersion: null,
    });
  });

  it("uses the prebuilt release bin when FRIDAY_HUB_WORKFLOW_CATALOG_BIN is not configured", async () => {
    const previousBin = process.env.FRIDAY_HUB_WORKFLOW_CATALOG_BIN;
    const previousRustRoot = process.env.FRIDAY_MISSION_SPINE_RUST_CORE_ROOT;
    delete process.env.FRIDAY_HUB_WORKFLOW_CATALOG_BIN;
    delete process.env.FRIDAY_MISSION_SPINE_RUST_CORE_ROOT;

    try {
      const { repoRoot, dbPath } = setupPrebuilt(okMock());
      const service = createFridayRustHubWorkflowCatalogBridgeService({ repoRoot, dbPath });

      await expect(
        service.mutateCatalog({ op: "publish", workflowId: "wf-prebuilt", version: 1 }),
      ).resolves.toMatchObject({
        truthLabel: "rust_wired_dev",
        proofOnly: true,
        op: "publish",
        workflowId: "wf-prebuilt",
      });
    } finally {
      if (previousBin === undefined) {
        delete process.env.FRIDAY_HUB_WORKFLOW_CATALOG_BIN;
      } else {
        process.env.FRIDAY_HUB_WORKFLOW_CATALOG_BIN = previousBin;
      }
      if (previousRustRoot === undefined) {
        delete process.env.FRIDAY_MISSION_SPINE_RUST_CORE_ROOT;
      } else {
        process.env.FRIDAY_MISSION_SPINE_RUST_CORE_ROOT = previousRustRoot;
      }
    }
  });

  it("fails closed instead of cargo-running when no prebuilt bin is available", async () => {
    const previousBin = process.env.FRIDAY_HUB_WORKFLOW_CATALOG_BIN;
    const previousRustRoot = process.env.FRIDAY_MISSION_SPINE_RUST_CORE_ROOT;
    delete process.env.FRIDAY_HUB_WORKFLOW_CATALOG_BIN;
    delete process.env.FRIDAY_MISSION_SPINE_RUST_CORE_ROOT;

    try {
      scratch = mkdtempSync(join(tmpdir(), "friday-hub-workflow-catalog-no-bin-"));
      const dbPath = join(scratch, "hub.sqlite");
      writeFileSync(dbPath, "");
      const service = createFridayRustHubWorkflowCatalogBridgeService({ repoRoot: scratch, dbPath });

      await expect(
        service.mutateCatalog({ op: "publish", workflowId: "wf-no-bin", version: 1 }),
      ).rejects.toMatchObject({
        code: "MISSION_SPINE_RUST_WORKFLOW_CATALOG_BRIDGE_UNAVAILABLE",
        httpStatus: 503,
        message: expect.stringContaining("requires a prebuilt binary"),
      });
    } finally {
      if (previousBin === undefined) {
        delete process.env.FRIDAY_HUB_WORKFLOW_CATALOG_BIN;
      } else {
        process.env.FRIDAY_HUB_WORKFLOW_CATALOG_BIN = previousBin;
      }
      if (previousRustRoot === undefined) {
        delete process.env.FRIDAY_MISSION_SPINE_RUST_CORE_ROOT;
      } else {
        process.env.FRIDAY_MISSION_SPINE_RUST_CORE_ROOT = previousRustRoot;
      }
    }
  });

  it("update: passes --expected-revision and the tri-state clear, never a verbatim body", async () => {
    const { binPath, dbPath } = setup(`
      const argv = process.argv.slice(2);
      const has = (n) => argv.includes(n);
      const get = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
      process.stdout.write(JSON.stringify({
        truth_label: "rust_wired_dev", proof_only: true, ok: true,
        op: get("--op"), workflow_id: get("--workflow-id"),
        slug_sha256: "00", slug_len: 2, name_sha256: "11", name_len: 3,
        // CLEAR: --clear-description present → description null.
        description_sha256: has("--clear-description") ? null : "cc",
        description_len: has("--clear-description") ? null : 4,
        tags_json_sha256: "22", tags_json_len: 2, is_archived: false,
        revision: Number(get("--expected-revision")) + 1,
        etag: "${"e".repeat(64)}", deployed_version: null,
        created_at_ms: 100, updated_at_ms: 200,
      }));
    `);
    const service = createFridayRustHubWorkflowCatalogBridgeService({ adapterBin: binPath, dbPath });

    const receipt = await service.mutateCatalog({
      op: "update",
      workflowId: "wf1",
      expectedRevision: 1,
      name: "Research v2",
      description: null, // clear
    });

    expect(receipt.op).toBe("update");
    expect(receipt.revision).toBe(2);
    expect(receipt.descriptionSha256).toBeNull();
    expect(receipt.descriptionLen).toBeNull();
  });

  it("publish: carries the just-published version", async () => {
    const { binPath, dbPath } = setup(okMock(`{ op: get("--op"), published_version: Number(get("--version")) }`));
    const service = createFridayRustHubWorkflowCatalogBridgeService({ adapterBin: binPath, dbPath });

    const receipt = await service.mutateCatalog({ op: "publish", workflowId: "wf1", version: 2 });

    expect(receipt.op).toBe("publish");
    expect(receipt.publishedVersion).toBe(2);
  });

  it("deploy: carries the deployed_version pointer", async () => {
    const { binPath, dbPath } = setup(okMock(`{ op: get("--op"), deployed_version: 2 }`));
    const service = createFridayRustHubWorkflowCatalogBridgeService({ adapterBin: binPath, dbPath });

    const receipt = await service.mutateCatalog({
      op: "deploy",
      workflowId: "wf1",
      expectedRevision: 2,
    });

    expect(receipt.op).toBe("deploy");
    expect(receipt.deployedVersion).toBe(2);
  });

  it("archive: parses the archived receipt", async () => {
    const { binPath, dbPath } = setup(okMock(`{ op: get("--op"), is_archived: true }`));
    const service = createFridayRustHubWorkflowCatalogBridgeService({ adapterBin: binPath, dbPath });

    const receipt = await service.mutateCatalog({
      op: "archive",
      workflowId: "wf1",
      expectedRevision: 3,
    });

    expect(receipt.op).toBe("archive");
    expect(receipt.isArchived).toBe(true);
  });

  it("fails closed (503) when no DB path is configured", async () => {
    const { binPath } = setup(okMock());
    const service = createFridayRustHubWorkflowCatalogBridgeService({ adapterBin: binPath });

    await expect(
      service.mutateCatalog({ op: "publish", workflowId: "wf1", version: 1 }),
    ).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_WORKFLOW_CATALOG_BRIDGE_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("fails closed (503) when the DB path does not exist", async () => {
    const { binPath } = setup(okMock());
    const service = createFridayRustHubWorkflowCatalogBridgeService({
      adapterBin: binPath,
      dbPath: join(tmpdir(), "friday-nonexistent-hub-db-xyz.sqlite"),
    });

    await expect(
      service.mutateCatalog({ op: "publish", workflowId: "wf1", version: 1 }),
    ).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_WORKFLOW_CATALOG_BRIDGE_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("fails closed (503) on a non-zero exit", async () => {
    const { binPath, dbPath } = setup(`
      process.stderr.write("hub_workflow_catalog_unavailable: conflict");
      process.exit(2);
    `);
    const service = createFridayRustHubWorkflowCatalogBridgeService({ adapterBin: binPath, dbPath });

    await expect(
      service.mutateCatalog({ op: "publish", workflowId: "wf1", version: 1 }),
    ).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_WORKFLOW_CATALOG_BRIDGE_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("fails closed on malformed JSON", async () => {
    const { binPath, dbPath } = setup(`process.stdout.write("not json {");`);
    const service = createFridayRustHubWorkflowCatalogBridgeService({ adapterBin: binPath, dbPath });

    await expect(
      service.mutateCatalog({ op: "publish", workflowId: "wf1", version: 1 }),
    ).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_WORKFLOW_CATALOG_BRIDGE_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("fails closed on timeout", async () => {
    const { binPath, dbPath } = setup(`setTimeout(() => process.stdout.write("late"), 5000);`);
    const service = createFridayRustHubWorkflowCatalogBridgeService({
      adapterBin: binPath,
      dbPath,
      timeoutMs: 200,
    });

    await expect(
      service.mutateCatalog({ op: "publish", workflowId: "wf1", version: 1 }),
    ).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_WORKFLOW_CATALOG_BRIDGE_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("fails closed on an ok:false receipt", async () => {
    const { binPath, dbPath } = setup(`
      process.stdout.write(JSON.stringify({
        truth_label: "rust_wired_dev", proof_only: true, ok: false, error_kind: "conflict",
      }));
    `);
    const service = createFridayRustHubWorkflowCatalogBridgeService({ adapterBin: binPath, dbPath });

    await expect(
      service.mutateCatalog({ op: "publish", workflowId: "wf1", version: 1 }),
    ).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_WORKFLOW_CATALOG_BRIDGE_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("rejects a payload that carries a verbatim free-form field (no-body boundary)", async () => {
    const { binPath, dbPath } = setup(`
      process.stdout.write(JSON.stringify({
        truth_label: "rust_wired_dev", proof_only: true, ok: true,
        op: "create", workflow_id: "wf1",
        // A verbatim free-form column must NEVER cross the bridge.
        name: "the raw workflow name that must never cross",
        slug_sha256: "00", slug_len: 2, name_sha256: "11", name_len: 3,
        description_sha256: null, description_len: null,
        tags_json_sha256: "22", tags_json_len: 2, is_archived: false,
        revision: 1, etag: "${"e".repeat(64)}", deployed_version: null,
        created_at_ms: 100, updated_at_ms: 100,
      }));
    `);
    const service = createFridayRustHubWorkflowCatalogBridgeService({ adapterBin: binPath, dbPath });

    await expect(
      service.mutateCatalog({
        op: "create",
        workflowId: "wf1",
        slug: "s",
        name: "n",
        defJson: "{}",
      }),
    ).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_WORKFLOW_CATALOG_BRIDGE_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("rejects a payload that carries a definition body field (no-body boundary)", async () => {
    const { binPath, dbPath } = setup(`
      process.stdout.write(JSON.stringify({
        truth_label: "rust_wired_dev", proof_only: true, ok: true,
        op: "create", workflow_id: "wf1",
        definition_json: "{\\"schema_version\\":1}",
        slug_sha256: "00", slug_len: 2, name_sha256: "11", name_len: 3,
        description_sha256: null, description_len: null,
        tags_json_sha256: "22", tags_json_len: 2, is_archived: false,
        revision: 1, etag: "${"e".repeat(64)}", deployed_version: null,
        created_at_ms: 100, updated_at_ms: 100,
      }));
    `);
    const service = createFridayRustHubWorkflowCatalogBridgeService({ adapterBin: binPath, dbPath });

    await expect(
      service.mutateCatalog({ op: "create", workflowId: "wf1", slug: "s", name: "n", defJson: "{}" }),
    ).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_WORKFLOW_CATALOG_BRIDGE_UNAVAILABLE",
      httpStatus: 503,
    });
  });
});
