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
// Direct file import (not the #api barrel) — src/api already imports #satellites,
// so a satellites -> #api edge would close a module cycle. This repo file has no
// cross-module imports, so importing it directly is cycle-free.
import { createFridaySetupBootstrapNonceRepository } from "../../api/persistence/friday-setup-bootstrap-nonce-repository.js";
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
import { createFridaySatelliteResumeCoordinator } from "./friday-satellite-resume-coordinator.js";
import type { FridaySatelliteResumeSignal } from "./friday-satellite-resume-coordinator.js";
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
  onSatelliteResumeEligible?: (signal: FridaySatelliteResumeSignal) => void;
  /**
   * Test-oracle only (TS Runtime Retirement, method-level guards): forwarded to
   * the inbound satellite-runtime services (heartbeat/capabilities/sync) so the
   * legacy TypeScript mutations remain reachable in test/validation harnesses.
   * Default/live hub leaves this unset so the methods fail closed (mirroring the
   * route fence). See the per-service guard for behavior.
   */
  allowTestOnlySatelliteRuntimeExecution?: boolean;
  /**
   * Test-oracle only (TS Runtime Retirement, method-level guards): forwarded to
   * the inbound satellite-pairing services (registration/pairing) so the legacy
   * TypeScript mutations remain reachable in test/validation harnesses.
   * Default/live hub leaves this unset so the methods fail closed.
   */
  allowTestOnlySatellitePairingExecution?: boolean;
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
    onSatelliteResumeEligible,
    allowTestOnlySatelliteRuntimeExecution,
    allowTestOnlySatellitePairingExecution,
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

  const resumeCoordinator = createFridaySatelliteResumeCoordinator({
    db,
    onResumeEligible: onSatelliteResumeEligible,
  });

  const chainedStatusTransition: CreateFridaySatelliteRuntimeOptions["onStatusTransition"] = (input) => {
    resumeCoordinator.handleStatusTransition({
      satelliteId: input.satelliteId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      at: input.at,
    });
    onStatusTransition?.(input);
  };

  // Services
  const registration = createFridaySatelliteRegistrationService({
    db,
    satelliteRepo,
    pairingRequestRepo,
    capabilityRepo,
    idGenerator,
    nowIso,
    pairingTtlMs,
    allowTestOnlySatellitePairingExecution,
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
    allowTestOnlySatellitePairingExecution,
  });

  const capabilities = createFridaySatelliteCapabilityService({
    db,
    satelliteRepo,
    capabilityRepo,
    idGenerator,
    nowIso,
    revisionCache: new Map(),
    allowTestOnlySatelliteRuntimeExecution,
  });

  const heartbeat = createFridaySatelliteHeartbeatService({
    db,
    satelliteRepo,
    heartbeatRepo,
    idGenerator,
    nowIso,
    expectedIntervalMs: expectedHeartbeatIntervalMs,
    onStatusTransition: chainedStatusTransition,
    allowTestOnlySatelliteRuntimeExecution,
  });

  const offlineSweeper = createFridaySatelliteOfflineSweeper({
    db,
    satelliteRepo,
    nowIso,
    onStatusTransition: chainedStatusTransition,
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
    allowTestOnlySatelliteRuntimeExecution,
  });
  const localRunner = createFridaySatelliteLocalRunnerService({ sync });

  // Retention
  const bootstrapNonceRepo = createFridaySetupBootstrapNonceRepository();
  const retention = createFridayRetentionJob({
    db,
    pairingRequestRepo,
    heartbeatRepo,
    outboxRepo,
    learningLedger,
    skillRunStore,
    bootstrapNonceRepo,
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
    resumeCoordinator,
    learningLedger,
    skillRunStore,
    checkpointWriter,
    retention,
  };
}
