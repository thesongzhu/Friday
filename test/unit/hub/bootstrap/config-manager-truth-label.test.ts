import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * B9 / FRI-AUD-021 regression guard.
 *
 * Pre-fix state at origin/main < 2026-05-26: the hub bootstrap comment at
 * `src/hub/friday-hub-bootstrap.ts:1042` claimed both `configManager` and
 * `memoryState` were "intentionally stubbed for v0.4.x standalone mode" and
 * that "Config mutations via API are silently no-ops". The configManager
 * portion of this comment was stale — the underlying `createStubConfigManager`
 * (`src/hub/bootstrap/hub-helpers.ts:861`) actually persists snapshots +
 * revisions in SQLite (`hub_settings` table) and `/v1/config/*` HTTP routes
 * are wired into the API runtime.
 *
 * Post-fix invariant:
 *   - `createStubConfigManager` is renamed to `createPersistentConfigManager`
 *     wherever it is exported / imported / called.
 *   - The misleading "Config mutations via API are silently no-ops" wording
 *     is removed from the bootstrap comment.
 *   - The bootstrap comment explicitly distinguishes the persistent
 *     configManager from the memoryState. (Audit E3 update: memoryState's
 *     EXPLICIT skill lifecycle transitions are now DURABLE —
 *     `createDurableMemoryState` persists `updateSkillStatus` to the `skills`
 *     table; discovery + session/memory-item methods stay in-memory.)
 *   - The audit-finding anchor (`B9 / FRI-AUD-021`) is present in both the
 *     factory JSDoc + the bootstrap comment for future readers.
 */

const HUB_BOOTSTRAP_PATH = "src/hub/friday-hub-bootstrap.ts" as const;
const HUB_HELPERS_PATH = "src/hub/bootstrap/hub-helpers.ts" as const;
const BOOTSTRAP_INDEX_PATH = "src/hub/bootstrap/index.ts" as const;

describe("configManager rename + stale-comment fix (B9 / FRI-AUD-021)", () => {
  const bootstrapSource = readFileSync(HUB_BOOTSTRAP_PATH, "utf8");
  const helpersSource = readFileSync(HUB_HELPERS_PATH, "utf8");
  const indexSource = readFileSync(BOOTSTRAP_INDEX_PATH, "utf8");

  it("removes the stale 'createStubConfigManager' identifier from all hub bootstrap files", () => {
    expect(bootstrapSource).not.toContain("createStubConfigManager");
    expect(helpersSource).not.toContain("createStubConfigManager");
    expect(indexSource).not.toContain("createStubConfigManager");
  });

  it("introduces the truth-labeled 'createPersistentConfigManager' identifier", () => {
    expect(helpersSource).toContain("export function createPersistentConfigManager(");
    expect(indexSource).toContain("createPersistentConfigManager,");
    expect(bootstrapSource).toContain("createPersistentConfigManager,");
    expect(bootstrapSource).toContain("createPersistentConfigManager({ ...config, workspaceRoot }, stateRuntime)");
  });

  it("removes the stale 'Config mutations via API are silently no-ops' wording", () => {
    expect(bootstrapSource).not.toContain("Config mutations via API are silently no-ops");
    expect(bootstrapSource).not.toContain("intentionally stubbed for v0.4.x");
  });

  it("anchors the rename + comment fix to the audit finding", () => {
    expect(helpersSource).toContain("B9 / FRI-AUD-021 truth-label rename");
    expect(bootstrapSource).toContain("B9 / FRI-AUD-021 truth-label");
  });

  it("explicitly distinguishes the persistent configManager from the (durable-explicit-transition) memoryState", () => {
    // Use regex with `\s+` to tolerate the line-wrapped multi-line comment.
    expect(bootstrapSource).toMatch(/persists\s+\/\/\s+snapshots\/revisions in SQLite/);
    expect(bootstrapSource).toContain("/v1/config/*");
    expect(bootstrapSource).toContain("HTTP routes are wired");
    // Audit E3: explicit skill lifecycle transitions are now PERSISTED to the
    // skills table; only the session/memory-item methods remain no-ops.
    expect(bootstrapSource).toContain("audit E3");
    expect(bootstrapSource).toContain("PERSISTED to the `skills`");
    expect(bootstrapSource).toContain("ZERO production consumers");
    expect(bootstrapSource).toContain("B5_B6_B8_VERIFIED.md");
  });

  it("wires the durable memoryState in bootstrap while preserving the `createStubMemoryState` factory", () => {
    // The stub factory remains exported (used by tests + as the durable base).
    expect(helpersSource).toContain("export function createStubMemoryState(auditLogPath?: string)");
    // Audit E3: bootstrap uses the durable variant; only updateSkillStatus is durable.
    expect(helpersSource).toContain("export function createDurableMemoryState(");
    expect(bootstrapSource).toContain("createDurableMemoryState,");
    expect(bootstrapSource).toContain("createDurableMemoryState({");
    expect(bootstrapSource).not.toContain("createStubMemoryState(auditLogPath)");
  });
});
