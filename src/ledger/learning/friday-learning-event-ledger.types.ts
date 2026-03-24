export type FridayLearningEventKind =
  | "user_message"
  | "assistant_message"
  | "tool_result"
  | "user_correction"
  | "error_incident"
  | "workflow_outcome"
  | "automation_saved"
  | "automation_reused"
  | "asset_promoted"
  | "asset_published"
  | "asset_supported"
  | "request_fulfilled"
  | "outcome_confirmed";

export interface FridayLearningEventAppendInput {
  eventId: string;
  ts: string;
  userId: string;
  sessionId?: string;
  runId?: string;
  kind: FridayLearningEventKind;
  payload: Record<string, unknown>;
}
