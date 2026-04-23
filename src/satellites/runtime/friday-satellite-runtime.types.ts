import type { FridaySatelliteRegistrationService } from "../services/friday-satellite-registration-service.js";
import type { FridaySatellitePairingService } from "../services/friday-satellite-pairing-service.js";
import type { FridaySatelliteCapabilityService } from "../services/friday-satellite-capability-service.js";
import type { FridaySatelliteHeartbeatService } from "../services/friday-satellite-heartbeat-service.js";
import type { FridaySatelliteOfflineSweeper } from "../services/friday-satellite-offline-sweeper.js";
import type { FridayOutboxQueueService } from "../services/friday-outbox-queue-service.js";
import type { FridaySatelliteSyncService } from "../services/friday-satellite-sync-service.js";
import type { FridaySatelliteLocalRunnerService } from "../services/friday-satellite-local-runner-service.js";
import type { FridayLearningEventLedger, FridaySkillRunCheckpointWriter, FridaySkillRunStore } from "#ledger";
import type { FridayRetentionJob } from "#jobs";

/**
 * Composite runtime surface that exposes all Phase 2 services
 * for integration with hub transport endpoints.
 */
export interface FridaySatelliteRuntime {
  registration: FridaySatelliteRegistrationService;
  pairing: FridaySatellitePairingService;
  capabilities: FridaySatelliteCapabilityService;
  heartbeat: FridaySatelliteHeartbeatService;
  offlineSweeper: FridaySatelliteOfflineSweeper;
  outbox: FridayOutboxQueueService;
  sync: FridaySatelliteSyncService;
  localRunner: FridaySatelliteLocalRunnerService;
  learningLedger: FridayLearningEventLedger;
  skillRunStore: FridaySkillRunStore;
  checkpointWriter: FridaySkillRunCheckpointWriter;
  retention: FridayRetentionJob;
}
