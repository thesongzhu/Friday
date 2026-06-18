import type Database from "better-sqlite3";

import type { FridaySqliteLayer } from "#state";
import { safeJsonParse } from "#utilities";

import type {
  FridayHarnessDeliveryContractV1,
  FridayHarnessHandoffArtifactV1,
  FridayHarnessPlanningSpecV1,
  FridayHarnessQaVerdictV1,
} from "../model/friday-template-harness.types.js";

const PLANNING_SPEC_NAMESPACE = "template-harness-planning-spec";
const DELIVERY_CONTRACT_NAMESPACE = "template-harness-delivery-contract";
const QA_VERDICT_NAMESPACE = "template-harness-qa-verdict";
const HANDOFF_NAMESPACE = "template-harness-handoff";

interface MemoryItemRow {
  value_json: string;
}

interface TemplateHarnessArtifactRow {
  value_json: string;
}

export interface CreateFridayTemplateHarnessRepositoryDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
}

export interface FridayTemplateHarnessRepository {
  upsertPlanningSpec(
    artifact: FridayHarnessPlanningSpecV1,
  ): FridayHarnessPlanningSpecV1;
  getPlanningSpec(artifactId: string): FridayHarnessPlanningSpecV1 | null;
  upsertDeliveryContract(
    artifact: FridayHarnessDeliveryContractV1,
  ): FridayHarnessDeliveryContractV1;
  getDeliveryContract(artifactId: string): FridayHarnessDeliveryContractV1 | null;
  upsertQaVerdict(
    artifact: FridayHarnessQaVerdictV1,
  ): FridayHarnessQaVerdictV1;
  getQaVerdict(artifactId: string): FridayHarnessQaVerdictV1 | null;
  upsertHandoffArtifact(
    artifact: FridayHarnessHandoffArtifactV1,
  ): FridayHarnessHandoffArtifactV1;
  getHandoffArtifact(artifactId: string): FridayHarnessHandoffArtifactV1 | null;
}

function upsertTemplateHarnessArtifact(
  db: Database.Database,
  artifact:
    | FridayHarnessPlanningSpecV1
    | FridayHarnessDeliveryContractV1
    | FridayHarnessQaVerdictV1
    | FridayHarnessHandoffArtifactV1,
): void {
  const artifactKind = namespaceForArtifact(artifact);
  db.prepare(
    `INSERT INTO template_harness_artifacts (
      artifact_kind, artifact_id, scope_kind, scope_id, created_at, updated_at, value_json, tags_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(artifact_kind, artifact_id) DO UPDATE SET
      scope_kind = excluded.scope_kind,
      scope_id = excluded.scope_id,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      value_json = excluded.value_json,
      tags_json = excluded.tags_json`,
  ).run(
    artifactKind,
    artifact.artifactId,
    artifact.scopeKind,
    artifact.scopeId,
    artifact.createdAt,
    artifact.updatedAt,
    JSON.stringify(artifact),
    JSON.stringify(tagsForArtifact(artifact)),
  );
}

function getTemplateHarnessArtifact(
  db: Database.Database,
  artifactKind: string,
  artifactId: string,
): TemplateHarnessArtifactRow | undefined {
  return db
    .prepare("SELECT value_json FROM template_harness_artifacts WHERE artifact_kind = ? AND artifact_id = ?")
    .get(artifactKind, artifactId) as TemplateHarnessArtifactRow | undefined;
}

function getMemoryItem(
  db: Database.Database,
  namespace: string,
  key: string,
): MemoryItemRow | undefined {
  return db
    .prepare("SELECT value_json FROM memory_items WHERE namespace = ? AND key = ?")
    .get(namespace, key) as MemoryItemRow | undefined;
}

function namespaceForArtifact(
  artifact:
    | FridayHarnessPlanningSpecV1
    | FridayHarnessDeliveryContractV1
    | FridayHarnessQaVerdictV1
    | FridayHarnessHandoffArtifactV1,
): string {
  if ("planningSpecId" in artifact && "deliverableKind" in artifact) {
    return DELIVERY_CONTRACT_NAMESPACE;
  }
  if ("deliveryContractId" in artifact) {
    return QA_VERDICT_NAMESPACE;
  }
  if ("stage" in artifact) {
    return HANDOFF_NAMESPACE;
  }
  return PLANNING_SPEC_NAMESPACE;
}

function tagsForArtifact(
  artifact:
    | FridayHarnessPlanningSpecV1
    | FridayHarnessDeliveryContractV1
    | FridayHarnessQaVerdictV1
    | FridayHarnessHandoffArtifactV1,
): string[] {
  const base = [artifact.scopeKind, artifact.scopeId];
  if ("deliveryContractId" in artifact) {
    return [...base, "qa_verdict", artifact.verdict];
  }
  if ("stage" in artifact) {
    return [...base, "handoff_artifact", artifact.stage];
  }
  if ("planningSpecId" in artifact && "deliverableKind" in artifact) {
    return [...base, "delivery_contract", artifact.deliverableKind];
  }
  return [...base, "planning_spec"];
}

function parseArtifact<T>(row: MemoryItemRow | undefined): T | null {
  if (!row) return null;
  return safeJsonParse<T>(row.value_json) ?? null;
}

function readArtifact<T>(
  db: Database.Database,
  artifactKind: string,
  artifactId: string,
): T | null {
  return parseArtifact<T>(
    getTemplateHarnessArtifact(db, artifactKind, artifactId)
      ?? getMemoryItem(db, artifactKind, artifactId),
  );
}

export function createFridayTemplateHarnessRepository(
  deps: CreateFridayTemplateHarnessRepositoryDeps,
): FridayTemplateHarnessRepository {
  const { db } = deps;

  function upsertArtifact<
    T extends
      | FridayHarnessPlanningSpecV1
      | FridayHarnessDeliveryContractV1
      | FridayHarnessQaVerdictV1
      | FridayHarnessHandoffArtifactV1,
  >(artifact: T): T {
    db.withWriteTransaction((writer) => {
      upsertTemplateHarnessArtifact(writer, artifact);
    });
    return artifact;
  }

  return {
    upsertPlanningSpec(artifact) {
      return upsertArtifact(artifact);
    },
    getPlanningSpec(artifactId) {
      return db.withReadConnection((reader) =>
        readArtifact<FridayHarnessPlanningSpecV1>(
          reader,
          PLANNING_SPEC_NAMESPACE,
          artifactId,
        ));
    },
    upsertDeliveryContract(artifact) {
      return upsertArtifact(artifact);
    },
    getDeliveryContract(artifactId) {
      return db.withReadConnection((reader) =>
        readArtifact<FridayHarnessDeliveryContractV1>(
          reader,
          DELIVERY_CONTRACT_NAMESPACE,
          artifactId,
        ));
    },
    upsertQaVerdict(artifact) {
      return upsertArtifact(artifact);
    },
    getQaVerdict(artifactId) {
      return db.withReadConnection((reader) =>
        readArtifact<FridayHarnessQaVerdictV1>(
          reader,
          QA_VERDICT_NAMESPACE,
          artifactId,
        ));
    },
    upsertHandoffArtifact(artifact) {
      return upsertArtifact(artifact);
    },
    getHandoffArtifact(artifactId) {
      return db.withReadConnection((reader) =>
        readArtifact<FridayHarnessHandoffArtifactV1>(
          reader,
          HANDOFF_NAMESPACE,
          artifactId,
        ));
    },
  };
}
