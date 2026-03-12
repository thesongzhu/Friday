export type FridayOutboxStatus =
  | "queued"
  | "leased"
  | "acked"
  | "failed"
  | "dead_letter"
  | "expired";

export interface FridayOutboxEnqueueInput {
  satelliteId: string;
  queueKey: string;
  messageType: string;
  payloadCiphertext: string;
  nonce: string;
  keyId: string;
  idempotencyKey: string;
  maxAttempts?: number;
  deliverAfter?: string;
  expiresAt?: string;
}

export interface FridayOutboxMessageRow {
  id: string;
  satellite_id: string;
  queue_key: string;
  message_type: string;
  payload_ciphertext: string;
  nonce: string;
  key_id: string;
  idempotency_key: string;
  status: FridayOutboxStatus;
  attempts: number;
  max_attempts: number;
  deliver_after: string | null;
  expires_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  leased_until: string | null;
  acked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FridayOutboxLeasedItem {
  id: string;
  seq: number;
  payloadCiphertext: string;
  messageType: string;
}
