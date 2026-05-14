import type { ISODateTime } from "../../cross-program/model/friday-cross-program.types.js";

export const FRIDAY_CROSS_BORDER_PACK_ID = "industry-cross-border-ecommerce" as const;

export type FridayCrossBorderRegionFocus = "sea_tiktok" | "na_amazon";
export type FridayCrossBorderStoreStage = "new_store" | "scaling" | "mature";
export type FridayCrossBorderFulfillmentMode =
  | "platform_fulfilled"
  | "third_party_warehouse"
  | "self_fulfilled"
  | "hybrid";
export type FridayCrossBorderAdUsage = "none" | "light" | "active" | "aggressive";
export type FridayCrossBorderCustomerServiceMode = "solo_inbox" | "shared_team" | "outsourced";
export type FridayCrossBorderMonitoringDepth = "lean" | "standard" | "deep";
export type FridayCrossBorderSourcePlatform = "tiktok_shop" | "amazon" | "public_web";
export type FridayCrossBorderWatchTargetType = "category" | "seller" | "product" | "keyword";
export type FridayCrossBorderWorkflowId =
  | "daily-store-health-check"
  | "daily-category-top10-watch"
  | "daily-price-gap-watch"
  | "daily-customer-service-sweep"
  | "weekly-hot-product-review"
  | "weekly-operating-profile-tune";
export type FridayCrossBorderWorkflowTemplateId =
  | "builtin-cross-border-daily-store-health-check"
  | "builtin-cross-border-daily-category-top10-watch"
  | "builtin-cross-border-daily-price-gap-watch"
  | "builtin-cross-border-daily-customer-service-sweep"
  | "builtin-cross-border-weekly-hot-product-review"
  | "builtin-cross-border-weekly-operating-profile-tune";
export type FridayCrossBorderImportKind =
  | "store_report"
  | "category_watch_seed"
  | "price_check_seed"
  | "customer_service_notes"
  | "listing_review_notes"
  | "public_link_seed";
export type FridayCrossBorderImportSource = "paste" | "csv_upload" | "image_upload" | "public_link";
export type FridayCrossBorderRecommendationTone = "neutral" | "watch" | "urgent";
export type FridayCrossBorderRecommendationKind = "today" | "week" | "approval" | "tune";
export type FridayCrossBorderWorkflowAutomationStatus = "inactive" | "active" | "paused";
export type FridayCrossBorderWorkflowGuidanceState = "active_recommended" | "pause_recommended" | "hold_until_ready";

export interface FridayCrossBorderLocalizedText {
  zh: string;
  en: string;
}

export interface FridayCrossBorderWatchTarget {
  id: string;
  type: FridayCrossBorderWatchTargetType;
  label: string;
  platform?: FridayCrossBorderSourcePlatform;
  notes?: string;
}

export interface FridayCrossBorderCompetitorTarget {
  id: string;
  sellerName: string;
  platform: FridayCrossBorderSourcePlatform;
  productName?: string;
  listingUrl?: string;
  notes?: string;
}

export interface FridayCrossBorderAdaptationState {
  status: "initializing" | "tracking" | "tuning";
  firstReviewDueAt: ISODateTime;
  stableReviewDueAt: ISODateTime;
  lastRecommendedAt?: ISODateTime;
  lastLearningAt?: ISODateTime;
  learningNotes?: string[];
}

export interface FridayCrossBorderOperatingProfile {
  packId: typeof FRIDAY_CROSS_BORDER_PACK_ID;
  regionFocus: FridayCrossBorderRegionFocus;
  platformPrimary: FridayCrossBorderSourcePlatform;
  platformSecondary?: FridayCrossBorderSourcePlatform;
  storeStage: FridayCrossBorderStoreStage;
  categoryL1: string;
  categoryL2: string;
  fulfillmentMode: FridayCrossBorderFulfillmentMode;
  priceBand: string;
  adUsage: FridayCrossBorderAdUsage;
  customerServiceMode: FridayCrossBorderCustomerServiceMode;
  monitoringDepth: FridayCrossBorderMonitoringDepth;
  watchTargets: FridayCrossBorderWatchTarget[];
  competitorTargets: FridayCrossBorderCompetitorTarget[];
  workflowPreset: FridayCrossBorderWorkflowId[];
  adaptationState: FridayCrossBorderAdaptationState;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface FridayCrossBorderImportBatch {
  id: string;
  kind: FridayCrossBorderImportKind;
  source: FridayCrossBorderImportSource;
  title: string;
  rawText?: string;
  publicLinks: string[];
  fileNames: string[];
  stale?: boolean;
  createdAt: ISODateTime;
}

export interface FridayCrossBorderRunEvidence {
  id: string;
  workflowId: FridayCrossBorderWorkflowId;
  managedWorkflowId: string;
  status: "completed" | "failed" | "skipped";
  summary: string;
  capturedAt: ISODateTime;
  inputSnapshotAt?: ISODateTime;
}

export interface FridayCrossBorderWorkflowRecommendation {
  id: FridayCrossBorderWorkflowId;
  templateId: FridayCrossBorderWorkflowTemplateId;
  cadence: "daily" | "weekly";
  enabledByDefault: boolean;
  rationale: string;
  automation: FridayCrossBorderWorkflowAutomationState | null;
  policy: FridayCrossBorderWorkflowPolicy;
}

export interface FridayCrossBorderWorkflowAutomationState {
  workflowId: FridayCrossBorderWorkflowId;
  templateId: FridayCrossBorderWorkflowTemplateId;
  managedWorkflowId: string;
  managedWorkflowVersionId?: string;
  managedWorkflowSlug: string;
  managedWorkflowName: string;
  status: FridayCrossBorderWorkflowAutomationStatus;
  schedule: {
    cron: string;
    timezone: string;
  };
  triggerRegistrationId?: string;
  nextRunAt?: ISODateTime;
  lastPublishedAt: ISODateTime;
  lastSyncedAt: ISODateTime;
}

export interface FridayCrossBorderWorkflowCadencePolicy {
  cron: string;
  timezoneMode: "user_local";
  summary: FridayCrossBorderLocalizedText;
}

export interface FridayCrossBorderWorkflowGuidancePolicy {
  state: FridayCrossBorderWorkflowGuidanceState;
  shouldStartPaused: boolean;
  summary: FridayCrossBorderLocalizedText;
}

export interface FridayCrossBorderWorkflowPolicy {
  cadence: FridayCrossBorderWorkflowCadencePolicy;
  pauseConditions: FridayCrossBorderLocalizedText[];
  approvalBoundaries: FridayCrossBorderLocalizedText[];
  currentGuidance: FridayCrossBorderWorkflowGuidancePolicy;
}

export interface FridayCrossBorderRecommendation {
  id: string;
  title: string;
  summary: string;
  tone: FridayCrossBorderRecommendationTone;
  kind: FridayCrossBorderRecommendationKind;
  requiresApproval: boolean;
}

export interface FridayCrossBorderBoard {
  title: string;
  summary: string;
  bullets: string[];
  tone: FridayCrossBorderRecommendationTone;
}

export interface FridayCrossBorderSnapshot {
  generatedAt: ISODateTime;
  profile: FridayCrossBorderOperatingProfile | null;
  storeHealth: FridayCrossBorderBoard | null;
  categoryWatch: FridayCrossBorderBoard | null;
  spikingProducts: FridayCrossBorderBoard | null;
  priceGapBoard: FridayCrossBorderBoard | null;
  listingQualityBoard: FridayCrossBorderBoard | null;
  customerServiceBoard: FridayCrossBorderBoard | null;
  workflowRecommendations: FridayCrossBorderWorkflowRecommendation[];
  riskClusters: FridayCrossBorderRecommendation[];
  nextActions: FridayCrossBorderRecommendation[];
  importSummary: {
    lastImportedAt: ISODateTime | null;
    totalImports: number;
    sourceTypes: FridayCrossBorderImportSource[];
  };
  runEvidenceLog: FridayCrossBorderRunEvidence[];
}
