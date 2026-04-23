import type { FridaySqliteLayer } from "#state";
import { createFridayRetentionJob } from "#jobs";
import type { FridayRetentionPolicy } from "#jobs";
import type { FridaySatelliteRuntime } from "./friday-satellite-runtime.types.js";
import type { FridayLearningEventAppendInput } from "#ledger";
import type { FridaySyncNodeResultInput } from "../services/friday-satellite-sync-service.js";

import { createFridaySatelliteRepository } from "../persistence/friday-satellite-repository.js";
import { createFridaySatellitePairingRequestRepository } from "../persistence/friday-satellite-pairing-request-repository.js";
import { createFridaySatelliteCapabilityRepository } from "../persistence/friday-satellite-capability-repository.js";
import { createFridaySatelliteHeartbeatRepository } from "../persistence/friday-satellite-heartbeat-repository.js";
import { createFridayOutboxMessageRepository } from "../persistence/friday-outbox-message-repository.js";
import { createFridayStreamCheckpointRepository } from "../persistence/friday-stream-checkpoint-repository.js";
import { createFridayApiTokenRepository } from "../persistence/friday-satellite-api-token-repository.js";
import { createFridayResumeCursorSigner } from "../protocol/friday-resume-cursor-signer.js";
import { createFridayAckResumeValidator } from "../protocol/friday-ack-resume-validator.js";
import { createFridaySatelliteRegistrationService } from "../services/friday-satellite-registration-service.js";
import { createFridaySatellitePairingService } from "../services/friday-satellite-pairing-service.js";
import { createFridaySatelliteCapabilityService } from "../services/friday-satellite-capability-service.js";
import { createFridaySatelliteHeartbeatService } from "../services/friday-satellite-heartbeat-service.js";
import { createFridaySatelliteOfflineSweeper } from "../services/friday-satellite-offline-sweeper.js";
import { createFridayOutboxQueueService } from "../services/friday-outbox-queue-service.js";
import { createFridaySatelliteSyncService } from "../services/friday-satellite-sync-service.js";
import { createFridaySatelliteLocalRunnerService } from "../services/friday-satellite-local-runner-service.js";
import { createFridayLearningEventLedger, createFridaySkillRunCheckpointWriter, createFridaySkillRunStore } from "#ledger";

export interface CreateFridaySatelliteRuntimeOptions {
  db: FridaySqliteLayer;
  cursorSecret: string;
  tokenSecret: string;
  idGenerator: () => string;
  nowIso: () => string;
  retentionPolicy?: FridayRetentionPolicy;
  pairingTtlMs?: number;
  expectedHeartbeatIntervalMs?: number;
  learningEventWriter?: (events: FridayLearningEventAppendInput[]) => void;
  remoteNodeResultWriter?: (input: FridaySyncNodeResultInput & { satelliteId: string }) => Promise<void>;
  onStatusTransition?: (input: {
    satelliteId: string;
    fromStatus: "pending" | "paired" | "online" | "degraded" | "offline" | "revoked";
    toStatus: "pending" | "paired" | "online" | "degraded" | "offline" | "revoked";
    at: string;
    failureRate1m?: number;
    explicitDisconnect?: boolean;
  }) => void;
}

/**
 * Wires all Phase 2 repositories, services, ledgers, and retention
 * into a single runtime composition.
 */
export function createFridaySatelliteRuntime(
  options: CreateFridaySatelliteRuntimeOptions,
): FridaySatelliteRuntime {
  const {
    db,
    cursorSecret,
    tokenSecret,
    idGenerator,
    nowIso,
    retentionPolicy,
    pairingTtlMs,
    expectedHeartbeatIntervalMs,
    learningEventWriter,
    remoteNodeResultWriter,
    onStatusTransition,
  } = options;

  // Repositories
  const satelliteRepo = createFridaySatelliteRepository();
  const pairingRequestRepo = createFridaySatellitePairingRequestRepository();
  const capabilityRepo = createFridaySatelliteCapabilityRepository();
  const heartbeatRepo = createFridaySatelliteHeartbeatRepository();
  const outboxRepo = createFridayOutboxMessageRepository();
  const checkpointRepo = createFridayStreamCheckpointRepository();
  const apiTokenRepo = createFridayApiTokenRepository();

  // Protocol
  const cursorSigner = createFridayResumeCursorSigner(cursorSecret);
  const ackValidator = createFridayAckResumeValidator(cursorSigner);

  // Bump epoch on runtime boot per protocol design
  db.withWriteTransaction((writerDb) => {
    checkpointRepo.bumpEpoch(writerDb, nowIso());
  });

  // Ledger
  const learningLedger = createFridayLearningEventLedger({ db });
  const skillRunStore = createFridaySkillRunStore({ db });
  const checkpointWriter = createFridaySkillRunCheckpointWriter({ db });

  // Services
  const registration = createFridaySatelliteRegistrationService({
    db,
    satelliteRepo,
    pairingRequestRepo,
    capabilityRepo,
    idGenerator,
    nowIso,
    pairingTtlMs,
  });

  const pairing = createFridaySatellitePairingService({
    db,
    satelliteRepo,
    pairingRequestRepo,
    apiTokenRepo,
    checkpointRepo,
    idGenerator,
    nowIso,
    tokenSecret,
  });

  const capabilities = createFridaySatelliteCapabilityService({
    db,
    satelliteRepo,
    capabilityRepo,
    idGenerator,
    nowIso,
    revisionCache: new Map(),
  });

  const heartbeat = createFridaySatelliteHeartbeatService({
    db,
    satelliteRepo,
    heartbeatRepo,
    idGenerator,
    nowIso,
    expectedIntervalMs: expectedHeartbeatIntervalMs,
    onStatusTransition,
  });

  const offlineSweeper = createFridaySatelliteOfflineSweeper({
    db,
    satelliteRepo,
    nowIso,
    onStatusTransition,
  });

  const outbox = createFridayOutboxQueueService({
    db,
    outboxRepo,
    idGenerator,
    nowIso,
  });

  const sync = createFridaySatelliteSyncService({
    db,
    checkpointRepo,
    outboxRepo,
    cursorSigner,
    ackValidator,
    nowIso,
    // By default, persist incoming local events to the learning ledger.
    // Hub bootstrap can override this to route through self-learning pipeline.
    learningEventWriter: learningEventWriter ?? ((events) => {
      learningLedger.appendBatch(events);
    }),
    remoteNodeResultWriter,
  });
  const localRunner = createFridaySatelliteLocalRunnerService({ sync });

  // Retention
  const retention = createFridayRetentionJob({
    db,
    pairingRequestRepo,
    heartbeatRepo,
    outboxRepo,
    learningLedger,
    skillRunStore,
    policy: retentionPolicy,
    nowIso,
  });

  return {
    registration,
    pairing,
    capabilities,
    heartbeat,
    offlineSweeper,
    outbox,
    sync,
    localRunner,
    learningLedger,
    skillRunStore,
    checkpointWriter,
    retention,
  };
}
