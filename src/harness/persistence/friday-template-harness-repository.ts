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
  id: string;
  value_json: string;
}

interface UpsertMemoryItemInput {
  id: string;
  namespace: string;
  key: string;
  value: unknown;
  summary: string;
  metadata: Record<string, unknown>;
  tags: string[];
  nowIso: string;
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

function upsertMemoryItem(db: Database.Database, input: UpsertMemoryItemInput): void {
  db.prepare(
    `INSERT INTO memory_items (
      id, namespace, key, value_json, tags_json, created_at, updated_at, content_text, source, metadata_json, tags_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'system', ?, ?)
    ON CONFLICT(namespace, key) DO UPDATE SET
      value_json = excluded.value_json,
      tags_json = excluded.tags_json,
      updated_at = excluded.updated_at,
      content_text = excluded.content_text,
      metadata_json = excluded.metadata_json,
      tags_text = excluded.tags_text`,
  ).run(
    input.id,
    input.namespace,
    input.key,
    JSON.stringify(input.value),
    JSON.stringify(input.tags),
    input.nowIso,
    input.nowIso,
    input.summary,
    JSON.stringify(input.metadata),
    input.tags.join(" "),
  );
}

function getMemoryItem(
  db: Database.Database,
  namespace: string,
  key: string,
): MemoryItemRow | undefined {
  return db
    .prepare("SELECT id, value_json FROM memory_items WHERE namespace = ? AND key = ?")
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

function summaryForArtifact(
  artifact:
    | FridayHarnessPlanningSpecV1
    | FridayHarnessDeliveryContractV1
    | FridayHarnessQaVerdictV1
    | FridayHarnessHandoffArtifactV1,
): string {
  if ("deliveryContractId" in artifact) {
    return artifact.summary;
  }
  if ("stage" in artifact) {
    return artifact.summary;
  }
  if ("planningSpecId" in artifact && "deliverableKind" in artifact) {
    return artifact.acceptanceCriteria[0] ?? artifact.doneDefinition[0] ?? artifact.deliverables[0] ?? artifact.scopeId;
  }
  return artifact.summary;
}

function metadataForArtifact(
  artifact:
    | FridayHarnessPlanningSpecV1
    | FridayHarnessDeliveryContractV1
    | FridayHarnessQaVerdictV1
    | FridayHarnessHandoffArtifactV1,
): Record<string, unknown> {
  return {
    scopeKind: artifact.scopeKind,
    scopeId: artifact.scopeId,
    artifactId: artifact.artifactId,
    artifactKind: namespaceForArtifact(artifact),
  };
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
      const namespace = namespaceForArtifact(artifact);
      const existing = getMemoryItem(writer, namespace, artifact.artifactId);
      upsertMemoryItem(writer, {
        id: existing?.id ?? deps.idGenerator(),
        namespace,
        key: artifact.artifactId,
        value: artifact,
        summary: summaryForArtifact(artifact),
        metadata: metadataForArtifact(artifact),
        tags: tagsForArtifact(artifact),
        nowIso: deps.nowIso(),
      });
    });
    return artifact;
  }

  return {
    upsertPlanningSpec(artifact) {
      return upsertArtifact(artifact);
    },
    getPlanningSpec(artifactId) {
      return db.withReadConnection((reader) =>
        parseArtifact<FridayHarnessPlanningSpecV1>(
          getMemoryItem(reader, PLANNING_SPEC_NAMESPACE, artifactId),
        ));
    },
    upsertDeliveryContract(artifact) {
      return upsertArtifact(artifact);
    },
    getDeliveryContract(artifactId) {
      return db.withReadConnection((reader) =>
        parseArtifact<FridayHarnessDeliveryContractV1>(
          getMemoryItem(reader, DELIVERY_CONTRACT_NAMESPACE, artifactId),
        ));
    },
    upsertQaVerdict(artifact) {
      return upsertArtifact(artifact);
    },
    getQaVerdict(artifactId) {
      return db.withReadConnection((reader) =>
        parseArtifact<FridayHarnessQaVerdictV1>(
          getMemoryItem(reader, QA_VERDICT_NAMESPACE, artifactId),
        ));
    },
    upsertHandoffArtifact(artifact) {
      return upsertArtifact(artifact);
    },
    getHandoffArtifact(artifactId) {
      return db.withReadConnection((reader) =>
        parseArtifact<FridayHarnessHandoffArtifactV1>(
          getMemoryItem(reader, HANDOFF_NAMESPACE, artifactId),
        ));
    },
  };
}

