import type { ISODateTime, JsonObject, UUID } from "./friday-workflow.types.js";

// ─── Trigger Types ───

export type FridayWorkflowTriggerType = "manual" | "schedule" | "event";

// ─── Manual Trigger ───

export interface FridayManualTrigger {
  type: "manual";
}

// ─── Schedule Trigger ───

export interface FridayScheduleTrigger {
  type: "schedule";
  cron: string;
  timezone: string;
}

// ─── Event Trigger ───

export interface FridayEventTrigger {
  type: "event";
  source: string;
  event: string;
}

export type FridayWorkflowTriggerDef =
  | FridayManualTrigger
  | FridayScheduleTrigger
  | FridayEventTrigger;

// ─── Trigger Registration ───

export interface FridayTriggerRegistration {
  id: UUID;
  workflowId: UUID;
  workflowVersionId: UUID;
  trigger: FridayWorkflowTriggerDef;
  enabled: boolean;
  lastFiredAt?: ISODateTime;
  nextFireAt?: ISODateTime;
  createdAt: ISODateTime;
}

// ─── Trigger Fire Input ───

export interface FridayTriggerFireInput {
  workflowId: UUID;
  workflowVersionId: UUID;
  triggerType: FridayWorkflowTriggerType;
  triggerPayload?: JsonObject;
  startedByUserId?: UUID;
  correlationId?: string;
}

// ─── Cron Tick Context (for schedule trigger evaluation) ───

export interface FridayCronTickContext {
  nowIso: ISODateTime;
  registrations: FridayTriggerRegistration[];
}

// ─── Event Match Context ───

export interface FridayEventMatchContext {
  source: string;
  event: string;
  payload: JsonObject;
}
