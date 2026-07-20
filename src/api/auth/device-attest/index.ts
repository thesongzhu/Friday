// ─── SEC-SETUP-BOOTSTRAP-001 · Slice 2a — device-attest barrel ───
//
// Server-side proof-of-possession verifier for the device-bound owner-claim
// transcript. Verifies signature + private-key possession + transcript-field
// binding ONLY. Never asserts key protection, never grants owner authority.

export type {
  FridayOwnerClaimPoPVerifier,
  OwnerClaimKeyProtection,
  OwnerClaimNonceConsumeOutcome,
  OwnerClaimNonceConsumer,
  OwnerClaimPoPFailure,
  OwnerClaimPoPRejectReason,
  OwnerClaimPoPResult,
  OwnerClaimPoPSuccess,
  OwnerClaimPresentationFailure,
  OwnerClaimPresentationRejectReason,
  OwnerClaimPresentationResult,
  OwnerClaimPresentationSuccess,
  OwnerClaimPresentedPublicKey,
  OwnerClaimPresentedSignature,
  OwnerClaimSignatureAlgorithm,
  OwnerClaimTranscript,
  OwnerClaimTranscriptVersion,
  VerifyOwnerClaimPossessionInput,
  VerifyOwnerClaimPresentationInput,
} from "./friday-owner-claim-transcript.types.js";

export {
  createFridayOwnerClaimPoPVerifier,
  verifyOwnerClaimPresentation,
} from "./friday-device-poposession-verifier.js";

export { createInMemoryOwnerClaimNonceConsumer } from "./friday-owner-claim-nonce-consumer.js";
export type { InMemoryOwnerClaimNonceConsumer } from "./friday-owner-claim-nonce-consumer.js";

export {
  ALLOWED_ALGORITHMS,
  ALLOWED_TRANSCRIPT_VERSIONS,
  OWNER_CLAIM_ALGORITHM,
  OWNER_CLAIM_KIND,
  OWNER_CLAIM_TRANSCRIPT_VERSION,
  P256_HALF_ORDER,
  P256_ORDER_N,
  P256_P1363_SIGNATURE_BYTES,
  canonicalDevicePublicKeyHash,
  encodeOwnerClaimTranscript,
  isLowS,
  isP256PublicKey,
  ownerClaimTranscriptDigestHex,
  parseCanonicalP1363Signature,
} from "./friday-owner-claim-transcript.js";

// ─── SEC-APPROVAL-AUTHORITY-001 · CORE-A CR-2 — device-authored provider approval ───

export type {
  FridayProviderApprovalPoPVerifier,
  ProviderApprovalDeviceProof,
  ProviderApprovalPoPFailure,
  ProviderApprovalPoPRejectReason,
  ProviderApprovalPoPResult,
  ProviderApprovalPoPSuccess,
  ProviderApprovalPresentedPublicKey,
  ProviderApprovalPresentedSignature,
  ProviderApprovalSignatureAlgorithm,
  ProviderApprovalTranscript,
  ProviderApprovalTranscriptVersion,
  VerifyProviderApprovalPossessionInput,
} from "./friday-provider-approval-transcript.types.js";

export {
  PROVIDER_APPROVAL_ALGORITHM,
  PROVIDER_APPROVAL_ALLOWED_ALGORITHMS,
  PROVIDER_APPROVAL_ALLOWED_TRANSCRIPT_VERSIONS,
  PROVIDER_APPROVAL_KIND,
  PROVIDER_APPROVAL_TRANSCRIPT_VERSION,
  createFridayProviderApprovalPoPVerifier,
  encodeProviderApprovalTranscript,
  providerApprovalTranscriptDigestHex,
} from "./friday-provider-approval-transcript.js";
