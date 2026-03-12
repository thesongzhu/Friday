/**
 * Marketplace Engine Audit Events — Transition event contract.
 *
 * Provides a lightweight, callback-based audit contract for engine mutators.
 *
 * @module marketplace/engine/audit-events
 */

import type { ISODateTime, UUID } from "../model/friday-marketplace.types.js";

export const MARKETPLACE_SYSTEM_ACTOR = "system";

export type MarketplaceAuditEntityType =
  | "listing"
  | "listing_version"
  | "listing_review"
  | "pricing_plan"
  | "publisher"
  | "publisher_verification"
  | "purchase"
  | "refund"
  | "entitlement"
  | "subscription"
  | "payout_entry"
  | "payout_batch";

export type MarketplaceAuditEventMetadataValue = string | number | boolean | null;

export type MarketplaceAuditEventMetadata = Readonly<
  Record<string, MarketplaceAuditEventMetadataValue>
>;

export interface MarketplaceAuditEvent {
  /** Entity class being transitioned. */
  readonly entityType: MarketplaceAuditEntityType;
  /** Entity identifier. */
  readonly entityId: UUID;
  /** Dot-namespaced action label. */
  readonly action: string;
  /** Prior lifecycle/status state; null for creation. */
  readonly fromState: string | null;
  /** New lifecycle/status state. */
  readonly toState: string;
  /** Transition timestamp. */
  readonly timestamp: ISODateTime;
  /** Actor responsible for the transition. */
  readonly actor: string;
  /** Additional context. */
  readonly metadata?: MarketplaceAuditEventMetadata;
}

export type MarketplaceAuditEventSink = (event: MarketplaceAuditEvent) => void;
