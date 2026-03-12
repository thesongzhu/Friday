import type { FridayApprovalRequestEntity } from "#learning";

export interface FridayApprovalExpiryJobResult {
  expiredCount: number;
  expired: FridayApprovalRequestEntity[];
}
