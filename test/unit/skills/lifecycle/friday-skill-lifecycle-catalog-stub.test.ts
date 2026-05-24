/**
 * B1 catalog truth-labeling tests.
 *
 * The `createFridaySkillLifecycleService` factory does not currently wire a
 * catalog backend through `CreateFridaySkillLifecycleServiceDeps`. As a result:
 *   1. A one-time INFO log is emitted at service creation advising operators
 *      that catalog-derived enrichments are proof_pending in this build.
 *   2. `listCatalog(query)` returns `{ items: [], total: 0 }` for every query.
 *   3. `getSkill(skillId)` returns a summary built from persisted + registry
 *      state only — `sourceDetails` and `catalogEntry` are always `undefined`.
 *
 * These tests lock in (1) and (2) as the current truthful behavior. (3) is
 * covered transitively by integration tests that exercise getSkill with
 * persisted skills and confirm the summary shape; this file does not
 * re-stub the full dep tree.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createFridaySkillLifecycleService, type FridaySkillRegistry } from "#skills";

function makeStubRegistry(): FridaySkillRegistry {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
    get: vi.fn(() => undefined),
    list: vi.fn(() => []),
    findByIntent: vi.fn(() => undefined),
    findByPhrase: vi.fn(() => undefined),
    refresh: vi.fn(async () => {}),
    listForChannel: vi.fn(() => []),
    setUserAuthorization: vi.fn(),
    getUserAuthorization: vi.fn(() => undefined),
  } as unknown as FridaySkillRegistry;
}

function makeMinimalDeps() {
  // Database stub: returns null/empty for every read; no writes expected in
  // listCatalog or getSkill(unknown).
  const db = {
    withReadConnection: <T,>(fn: (handle: unknown) => T): T => fn({}),
    withWriteTransaction: <T,>(fn: (handle: unknown) => T): T => fn({}),
    close: () => {},
  };
  return {
    db: db as never,
    nowIso: () => "2026-05-24T13:30:00.000Z",
    managedSkillsDir: "/tmp/friday-b1-test-skills",
    hubVersion: "1.0.0",
    supportedApiVersions: ["1"],
    registry: makeStubRegistry(),
    installations: {} as never,
    packageInstaller: {} as never,
    signatureVerifier: {} as never,
    trustScoring: {} as never,
    skillRepo: {
      getSkillById: vi.fn(() => null),
      listSkills: vi.fn(() => []),
    } as never,
    versionRepo: {
      listVersions: vi.fn(() => []),
    } as never,
    installationRepo: {
      listBySkill: vi.fn(() => []),
    } as never,
  };
}

describe("createFridaySkillLifecycleService — B1 catalog truth-labeling", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it("emits a one-time INFO log at service creation advising that catalog is proof_pending", () => {
    createFridaySkillLifecycleService(makeMinimalDeps());

    const catalogAdvisories = infoSpy.mock.calls.filter(([msg]) =>
      typeof msg === "string" && msg.includes("Catalog backend is not wired"),
    );
    expect(catalogAdvisories).toHaveLength(1);
    const [message] = catalogAdvisories[0]!;
    expect(message).toContain("listCatalog()");
    expect(message).toContain("getSkill()");
    expect(message).toContain("proof_pending");
  });

  it("listCatalog returns {items: [], total: 0} for any query (catalog backend not wired)", () => {
    const service = createFridaySkillLifecycleService(makeMinimalDeps());

    const result = service.listCatalog({} as never);
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("listCatalog returns empty for queries with filters too (no query parameter changes the result)", () => {
    const service = createFridaySkillLifecycleService(makeMinimalDeps());

    const result = service.listCatalog({
      query: "starter",
      tags: ["productivity"],
      category: "utility",
    } as never);
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("getSkill returns null for an unknown skillId when neither persisted nor registered", () => {
    const service = createFridaySkillLifecycleService(makeMinimalDeps());

    const result = service.getSkill("unknown-skill-id");
    expect(result).toBeNull();
  });

  it("creating multiple services emits one advisory per creation (no global de-dup)", () => {
    // The advisory is per-instance — operators get one notice per process-managed
    // service so the diagnostic is visible regardless of how many lifecycles exist.
    createFridaySkillLifecycleService(makeMinimalDeps());
    createFridaySkillLifecycleService(makeMinimalDeps());

    const catalogAdvisories = infoSpy.mock.calls.filter(([msg]) =>
      typeof msg === "string" && msg.includes("Catalog backend is not wired"),
    );
    expect(catalogAdvisories).toHaveLength(2);
  });
});
