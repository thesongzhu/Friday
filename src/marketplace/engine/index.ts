// ─── Marketplace and Commerce — Core Runtime Engine ───

// Shared Audit Event Contract
export {
  MARKETPLACE_SYSTEM_ACTOR,
} from "./audit-events.js";

export type {
  MarketplaceAuditEntityType,
  MarketplaceAuditEventMetadataValue,
  MarketplaceAuditEventMetadata,
  MarketplaceAuditEvent,
  MarketplaceAuditEventSink,
} from "./audit-events.js";

// Publisher Manager
export {
  PUBLISHER_ERROR_CODES,
  createPublisher,
  updatePublisher,
  submitVerification,
  reviewVerification,
  suspendPublisher,
  reinstatePublisher,
  isPublisherVerified,
} from "./publisher-manager.js";

export type {
  PublisherErrorCode,
  PublisherError,
  PublisherResult,
  CreatePublisherInput,
  UpdatePublisherInput,
  SubmitVerificationInput,
  ReviewVerificationInput,
  PublisherDeps,
} from "./publisher-manager.js";

// Listing Manager
export {
  LISTING_ERROR_CODES,
  createListing,
  createListingVersion,
  submitForReview,
  reviewListing,
  suspendListing,
  reinstateListing,
  archiveListing,
  canTransitionListing,
} from "./listing-manager.js";

export type {
  ListingErrorCode,
  ListingError,
  ListingResult,
  CreateListingInput,
  UpdateListingInput,
  ReviewListingInput,
  ListingDeps,
} from "./listing-manager.js";

// Pricing Engine
export {
  PRICING_ERROR_CODES,
  createPricingPlan,
  updatePricingPlan,
  deactivatePricingPlan,
  validatePricingPlan,
  calculatePlanCost,
  calculateUsageCost,
  calculatePlatformFee,
  bankersRound,
} from "./pricing-engine.js";

export type {
  PricingErrorCode,
  PricingError,
  PricingResult,
  PricingDeps,
} from "./pricing-engine.js";

// Purchase Manager
export {
  PURCHASE_ERROR_CODES,
  initiateCheckout,
  completePurchase,
  failPurchase,
  initiateRefund,
  completeRefund,
  failRefund,
} from "./purchase-manager.js";

export type {
  PurchaseErrorCode,
  PurchaseError,
  PurchaseResult,
  InitiateCheckoutInput,
  CompletePurchaseInput,
  InitiateRefundInput,
  CompleteRefundInput,
  FailRefundInput,
  CheckoutResult,
  PurchaseDeps,
} from "./purchase-manager.js";

// Entitlement Guard
export {
  ENTITLEMENT_GUARD_ERROR_CODES,
  assertListingExecutionReady,
} from "./entitlement-guard.js";

export type {
  EntitlementGuardDeps,
  EntitlementGuardError,
  EntitlementGuardErrorCode,
  EntitlementGuardInput,
  EntitlementGuardResult,
} from "./entitlement-guard.js";

// Install Dispatcher
export {
  INSTALL_DISPATCH_ERROR_CODES,
  dispatchInstall,
} from "./install-dispatcher.js";

export type {
  DispatchInstallInput,
  InstallDispatchErrorCode,
  InstallDispatchError,
  InstallDispatchResult,
  InstallDispatcherDeps,
} from "./install-dispatcher.js";

// Payout Engine
export {
  PAYOUT_ERROR_CODES,
  DEFAULT_MIN_PAYOUT_THRESHOLD_CENTS,
  DEFAULT_TAX_WITHHOLDING_BPS,
  BACKUP_TAX_WITHHOLDING_BPS,
  createPayoutEntry,
  createClawbackEntry,
  createPayoutBatch,
  completePayoutBatch,
  failPayoutBatch,
  computeEarningsSummary,
  reconcileBatch,
} from "./payout-engine.js";

export type {
  PayoutErrorCode,
  PayoutError,
  PayoutResult,
  PayoutDeps,
} from "./payout-engine.js";

// Search & Discovery
export {
  searchListings,
  getFeaturedListings,
  getTrendingListings,
  getListingsByCategory,
  extractCategories,
  getPublisherListings,
} from "./search-discovery.js";

export type {
  ListingSearchEntry,
  ListingSearchFilters,
  ListingSearchSort,
  ListingSearchResult,
} from "./search-discovery.js";
