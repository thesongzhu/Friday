export type FridayLearningEventKind =
  | "user_message"
  | "assistant_message"
  | "tool_result"
  | "user_correction"
  | "error_incident"
  | "workflow_outcome";

export interface FridayLearningEventAppendInput {
  eventId: string;
  ts: string;
  userId: string;
  sessionId?: string;
  runId?: string;
  kind: FridayLearningEventKind;
  payload: Record<string, unknown>;
}
