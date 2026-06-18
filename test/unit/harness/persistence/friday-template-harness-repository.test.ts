import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFridayTemplateHarnessRepository } from "#harness";
import type {
  FridayHarnessDeliveryContractV1,
  FridayHarnessHandoffArtifactV1,
  FridayHarnessPlanningSpecV1,
  FridayHarnessQaVerdictV1,
  FridayTemplateHarnessRepository,
} from "#harness";
import type { FridaySqliteLayer } from "#state";

const NOW = "2026-06-18T00:00:00.000Z";

function makeMockDb(): {
  db: FridaySqliteLayer;
  seedLegacy: (namespace: string, key: string, value: unknown) => void;
  memoryInsertCount: () => number;
} {
  const artifacts = new Map<string, { value_json: string }>();
  const legacy = new Map<string, { value_json: string }>();
  let memoryInserts = 0;

  function makeDb() {
    return {
      prepare: vi.fn((sql: string) => {
        if (sql.startsWith("INSERT INTO template_harness_artifacts")) {
          return {
            run: vi.fn(
              (
                artifactKind: string,
                artifactId: string,
                _scopeKind: string,
                _scopeId: string,
                _createdAt: string,
                _updatedAt: string,
                valueJson: string,
              ) => {
                artifacts.set(`${artifactKind}:${artifactId}`, { value_json: valueJson });
              },
            ),
          };
        }
        if (sql.startsWith("SELECT value_json FROM template_harness_artifacts")) {
          return {
            get: vi.fn((artifactKind: string, artifactId: string) =>
              artifacts.get(`${artifactKind}:${artifactId}`) ?? undefined),
          };
        }
        if (sql.startsWith("SELECT value_json FROM memory_items")) {
          return {
            get: vi.fn((namespace: string, key: string) =>
              legacy.get(`${namespace}:${key}`) ?? undefined),
          };
        }
        if (sql.startsWith("INSERT INTO memory_items")) {
          return {
            run: vi.fn(() => {
              memoryInserts += 1;
            }),
          };
        }
        return {
          run: vi.fn(),
          get: vi.fn(() => undefined),
          all: vi.fn(() => []),
        };
      }),
    };
  }

  const sqlite = makeDb();

  return {
    db: {
      withReadConnection: vi.fn((fn: (db: unknown) => unknown) => fn(sqlite)),
      withWriteTransaction: vi.fn((fn: (db: unknown) => void) => fn(sqlite)),
    } as unknown as FridaySqliteLayer,
    seedLegacy(namespace, key, value) {
      legacy.set(`${namespace}:${key}`, { value_json: JSON.stringify(value) });
    },
    memoryInsertCount() {
      return memoryInserts;
    },
  };
}

function makePlanningSpec(
  overrides?: Partial<FridayHarnessPlanningSpecV1>,
): FridayHarnessPlanningSpecV1 {
  return {
    artifactId: "planning-1",
    version: 1,
    scopeKind: "skill_generator",
    scopeId: "skill-1",
    objective: "Generate a skill",
    summary: "Skill planning spec",
    assumptions: [],
    unknowns: [],
    outOfScope: [],
    constraints: ["stay dark"],
    successTests: ["round-trip"],
    openQuestions: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeDeliveryContract(
  overrides?: Partial<FridayHarnessDeliveryContractV1>,
): FridayHarnessDeliveryContractV1 {
  return {
    artifactId: "delivery-1",
    version: 1,
    scopeKind: "skill_generator",
    scopeId: "skill-1",
    planningSpecId: "planning-1",
    deliverableKind: "skill",
    deliverables: ["skill bundle"],
    doneDefinition: ["tests pass"],
    acceptanceCriteria: ["usable"],
    evidenceRequirements: ["skill_self_test"],
    riskFlags: [],
    blockedBy: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeQaVerdict(
  overrides?: Partial<FridayHarnessQaVerdictV1>,
): FridayHarnessQaVerdictV1 {
  return {
    artifactId: "qa-1",
    version: 1,
    scopeKind: "skill_generator",
    scopeId: "skill-1",
    deliveryContractId: "delivery-1",
    verdict: "pass",
    summary: "Passed",
    passedCriteria: ["usable"],
    failedCriteria: [],
    blockedReasons: [],
    warnings: [],
    evidenceRefs: ["test://harness"],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeHandoffArtifact(
  overrides?: Partial<FridayHarnessHandoffArtifactV1>,
): FridayHarnessHandoffArtifactV1 {
  return {
    artifactId: "handoff-1",
    version: 1,
    scopeKind: "skill_generator",
    scopeId: "skill-1",
    stage: "handoff_ready",
    summary: "Ready for handoff",
    completedWork: ["planning"],
    remainingWork: [],
    blockers: [],
    nextActions: ["ship"],
    artifactRefs: ["planning-1", "delivery-1", "qa-1"],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("FridayTemplateHarnessRepository", () => {
  let repo: FridayTemplateHarnessRepository;
  let mock: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    mock = makeMockDb();
    repo = createFridayTemplateHarnessRepository({
      db: mock.db,
      idGenerator: () => "unused-id",
      nowIso: () => NOW,
    });
  });

  it("stores planning specs in the dedicated table without writing memory_items", () => {
    const spec = makePlanningSpec();
    repo.upsertPlanningSpec(spec);

    expect(repo.getPlanningSpec("planning-1")).toEqual(spec);
    expect(mock.memoryInsertCount()).toBe(0);
  });

  it("falls back to legacy memory_items rows when no dedicated artifact exists", () => {
    const spec = makePlanningSpec({ artifactId: "legacy-planning" });
    mock.seedLegacy("template-harness-planning-spec", "legacy-planning", spec);

    expect(repo.getPlanningSpec("legacy-planning")).toEqual(spec);
    expect(mock.memoryInsertCount()).toBe(0);
  });

  it("round-trips delivery contracts, QA verdicts, and handoff artifacts from the dedicated table", () => {
    const delivery = makeDeliveryContract();
    const qa = makeQaVerdict();
    const handoff = makeHandoffArtifact();

    repo.upsertDeliveryContract(delivery);
    repo.upsertQaVerdict(qa);
    repo.upsertHandoffArtifact(handoff);

    expect(repo.getDeliveryContract("delivery-1")).toEqual(delivery);
    expect(repo.getQaVerdict("qa-1")).toEqual(qa);
    expect(repo.getHandoffArtifact("handoff-1")).toEqual(handoff);
    expect(mock.memoryInsertCount()).toBe(0);
  });
});
