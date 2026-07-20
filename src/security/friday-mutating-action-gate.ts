import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { ProviderApprovalDeviceProof } from "../api/auth/device-attest/friday-provider-approval-transcript.types.js";
import { deviceOwnerPrincipalId } from "./friday-device-owner-authority-precondition.js";

export const FRIDAY_MUTATING_ACTION_RISKS = [
  "read_only",
  "low",
  "medium",
  "high",
  "critical",
] as const;

export const FRIDAY_MUTATING_ACTION_DECISIONS = [
  "allow",
  "deny",
  "requires_approval",
] as const;

export type FridayMutatingActionRisk = (typeof FRIDAY_MUTATING_ACTION_RISKS)[number];
export type FridayMutatingActionDecision = (typeof FRIDAY_MUTATING_ACTION_DECISIONS)[number];
export type FridayCanonicalApprovalDecision = "approved" | "denied";

export interface FridayMutatingActionActor {
  readonly kind: string;
  readonly id: string;
  readonly principalId?: string;
  readonly displayName?: string;
  /**
   * SEC-APPROVAL-AUTHORITY-001 · CORE-A CR-2 (Option B*): the sentinel hash of the
   * device bound to this authenticated owner (`users.password_hash =
   * device-owner$v1$<hash>`), resolved SERVER-SIDE — `undefined` when the actor is
   * not a device-claimed owner. A device-authored approval admits ONLY when the
   * approval's signing key hashes (via the sentinel's own `sha256Hex` convention) to
   * THIS value, binding the approval to the authenticated owner's registered device
   * WITHOUT relying on the acting `principalId` (which stays `user.id`). It is NEVER
   * folded into the action digest (server-derived, not part of the signed action).
   */
  readonly boundDeviceOwnerSentinelHash?: string;
}

export interface FridayMutatingActionResource {
  readonly type: string;
  readonly id?: string;
  readonly displayName?: string;
  readonly digest?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface FridayMutatingActionRollbackScope {
  readonly planned: boolean;
  readonly planDigest?: string;
  readonly actions?: readonly string[];
}

export interface FridayMutatingActionLocalClaim {
  readonly guardId: string;
  readonly decision: "allow" | "deny" | "requires_approval";
  readonly risk?: FridayMutatingActionRisk;
  readonly reason?: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
}

export interface FridayCanonicalApprovalResolution {
  readonly decision: FridayCanonicalApprovalDecision;
  readonly approvalId: string;
  readonly decidedByPrincipalId: string;
  readonly actionDigest: string;
  readonly reason?: string;
  readonly expiresAt?: string;
  readonly childOfLifecycleTicketId?: string;
  /**
   * The authority that authored this approval:
   *  - `friday_canonical_gate` — a symmetric HMAC the Hub both mints AND verifies
   *    with `deps.tokenSecret` (the LEGACY plugin/mcp/channel/skill/workflow
   *    lifecycle path; out of CORE-A CR-2 scope).
   *  - `friday_device_owner` — a DEVICE-AUTHORED (P-256 ECDSA) approval. The Hub
   *    holds NO signing key; it only VERIFIES the `deviceProof` with the presented
   *    PUBLIC key. This is the SEC-APPROVAL-AUTHORITY-001 verify-only Hub path used
   *    by provider-setup mutations, where a Hub self-signed HMAC is refused.
   */
  readonly issuer?: "friday_canonical_gate" | "friday_device_owner";
  /** Symmetric-HMAC signature (LEGACY `friday_canonical_gate` issuer only). */
  readonly signature?: string;
  /**
   * The self-describing P-256 device proof (`friday_device_owner` issuer only):
   * the signed approval transcript + the device PUBLIC key + the raw signature.
   * Verified asymmetrically — the Hub never holds the private key.
   */
  readonly deviceProof?: ProviderApprovalDeviceProof;
}

/**
 * The injected ASYMMETRIC verifier for a `friday_device_owner` approval. Performs
 * the PURE P-256 proof-of-possession + transcript-field check ONLY (no request /
 * owner binding — the gate does that with the returned fields). Wired by the
 * runtime from `createFridayProviderApprovalPoPVerifier`. When absent, a
 * device-authored approval fails CLOSED (the gate cannot verify it).
 */
export type FridayDeviceApprovalVerifier = (
  proof: ProviderApprovalDeviceProof,
  nowMs: number,
) => FridayDeviceApprovalVerifyResult;

export interface FridayDeviceApprovalVerifyResult {
  readonly ok: boolean;
  readonly reason?: string;
  /** Canonical SHA-256 hex of the verified SPKI DER public key (present iff ok). */
  readonly devicePublicKeyHash?: string;
  readonly approvalId?: string;
  readonly actionDigest?: string;
  readonly decidedByPrincipalId?: string;
  readonly expiresAt?: string;
}

export interface FridayMutatingActionRequest {
  readonly action: string;
  readonly actor: FridayMutatingActionActor;
  readonly surface: string;
  readonly resource: FridayMutatingActionResource;
  readonly mutating: boolean;
  readonly risk?: FridayMutatingActionRisk;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly planDigest?: string;
  readonly rollback?: FridayMutatingActionRollbackScope;
  readonly idempotencyKey?: string;
  readonly localClaims?: readonly FridayMutatingActionLocalClaim[];
  readonly canonicalApproval?: FridayCanonicalApprovalResolution;
  readonly requestedAt?: string;
}

export interface FridaySystemIntentGateInput {
  readonly action?: string;
  readonly actorId?: string;
  readonly actorKind?: string;
  readonly target?: string;
  readonly targetKind?: string;
  readonly appIdentifier?: string;
  readonly windowId?: string;
  readonly url?: string;
  readonly projectPath?: string;
  readonly query?: string;
  readonly value?: string;
  readonly notificationId?: string;
  readonly notificationAction?: string;
  readonly approvalId?: string;
  readonly deviceId?: string;
  readonly riskLevel?: string;
  readonly reason?: string;
  readonly force?: boolean;
  readonly leaseTtlMs?: number;
  readonly layout?: string;
  readonly idempotencyKey?: string;
}

export interface FridaySystemIntentGateRequestOptions {
  readonly surface?: string;
  readonly defaultActorKind?: string;
  readonly defaultActorId?: string;
  readonly localClaims?: readonly FridayMutatingActionLocalClaim[];
}

export interface FridayMutatingActionTicket {
  readonly ticketId: string;
  readonly actionDigest: string;
  readonly action: string;
  readonly actor: FridayMutatingActionActor;
  readonly surface: string;
  readonly resource: FridayMutatingActionResource;
  readonly risk: FridayMutatingActionRisk;
  readonly approvalId: string;
  readonly approvedByPrincipalId: string;
  readonly issuedAt: string;
  readonly expiresAt?: string;
  readonly planDigest?: string;
  readonly childOfLifecycleTicketId?: string;
  readonly idempotencyKey?: string;
}

export interface FridayMutatingActionGateEvidenceRecord {
  readonly gateId: "friday_canonical_mutating_action_gate";
  readonly evaluatedAt: string;
  readonly decision: FridayMutatingActionDecision;
  readonly reason: string;
  readonly actionDigest: string;
  readonly action: string;
  readonly actor: FridayMutatingActionActor;
  readonly surface: string;
  readonly resource: FridayMutatingActionResource;
  readonly mutating: boolean;
  readonly risk: FridayMutatingActionRisk;
  readonly approvalRequired: boolean;
  readonly deniedBy?: string;
  readonly ticketId?: string;
  readonly approvalId?: string;
  readonly planDigest?: string;
  readonly rollback?: FridayMutatingActionRollbackScope;
  readonly localClaims: readonly FridayMutatingActionLocalClaim[];
}

export interface FridayMutatingActionGateResult {
  readonly decision: FridayMutatingActionDecision;
  readonly reason: string;
  readonly risk: FridayMutatingActionRisk;
  readonly actionDigest: string;
  readonly approvalRequired: boolean;
  readonly deniedBy?: string;
  readonly ticket?: FridayMutatingActionTicket;
  readonly localClaims: readonly FridayMutatingActionLocalClaim[];
  readonly evidenceRecord: FridayMutatingActionGateEvidenceRecord;
}

export interface FridayMutatingActionGateOptions {
  readonly nowIso?: () => string;
  readonly ticketIdGenerator?: () => string;
  readonly approvalSignatureSecret?: string;
  readonly requireApprovalSignature?: boolean;
  /**
   * ASYMMETRIC verifier for `friday_device_owner` (device-authored) approvals.
   * When absent, a device-authored approval fails closed. The Hub holds ONLY the
   * public key here — no signing secret is involved on the device-owner path.
   */
  readonly deviceApprovalVerifier?: FridayDeviceApprovalVerifier;
}

export interface FridayMutatingActionGate {
  evaluate(request: FridayMutatingActionRequest): FridayMutatingActionGateResult;
}

const RISK_WEIGHT: Record<FridayMutatingActionRisk, number> = {
  read_only: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const AGENT_RESERVED_APPROVAL_ACTIONS = new Set([
  "approve",
  "deny",
  "system.approve",
  "system.deny",
]);

const SYSTEM_MUTATING_INTENTS = new Set([
  "open",
  "focus",
  "arrange_windows",
  "launch_app",
  "close_app",
  "open_url",
  "open_project",
  "handoff_to_browser",
  "handoff_to_terminal",
  "notification_act",
  "resume_task",
  "recover_ui",
  "clipboard_read",
  "clipboard_write",
  "request_control",
  "release_control",
  "approve",
  "deny",
]);

const SYSTEM_HIGH_RISK_INTENTS = new Set([
  "approve",
  "deny",
  "close_app",
  "clipboard_read",
  "notification_act",
]);

const SYSTEM_MEDIUM_RISK_INTENTS = new Set([
  "arrange_windows",
  "launch_app",
  "open",
  "open_url",
  "open_project",
  "handoff_to_browser",
  "handoff_to_terminal",
  "clipboard_write",
  "request_control",
  "release_control",
  "resume_task",
  "recover_ui",
]);

export function compareFridayMutatingActionRisk(
  left: FridayMutatingActionRisk,
  right: FridayMutatingActionRisk,
): number {
  return RISK_WEIGHT[left] - RISK_WEIGHT[right];
}

export function isFridayMutatingActionRiskAtLeast(
  risk: FridayMutatingActionRisk,
  minimum: FridayMutatingActionRisk,
): boolean {
  return compareFridayMutatingActionRisk(risk, minimum) >= 0;
}

export function isFridayReservedApprovalActionForActor(
  request: Pick<FridayMutatingActionRequest, "action" | "actor" | "surface">,
): boolean {
  if (request.actor.kind !== "agent") {
    return false;
  }

  const normalizedAction = request.action.trim().toLowerCase();
  if (AGENT_RESERVED_APPROVAL_ACTIONS.has(normalizedAction)) {
    return true;
  }

  return request.surface === "system" && AGENT_RESERVED_APPROVAL_ACTIONS.has(normalizedAction);
}

export function createFridayMutatingActionDigest(
  request: FridayMutatingActionRequest,
  effectiveRisk = deriveFridayMutatingActionRisk(request),
): string {
  const payload = {
    version: 1,
    action: request.action,
    actor: {
      kind: request.actor.kind,
      id: request.actor.id,
      principalId: request.actor.principalId,
    },
    surface: request.surface,
    resource: {
      type: request.resource.type,
      id: request.resource.id,
      digest: request.resource.digest,
      attributes: request.resource.attributes,
    },
    mutating: request.mutating,
    risk: effectiveRisk,
    parameters: request.parameters,
    planDigest: request.planDigest,
    rollback: request.rollback,
    idempotencyKey: request.idempotencyKey,
  };

  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

export function signFridayCanonicalApproval(
  approval: FridayCanonicalApprovalResolution,
  secret: string,
): FridayCanonicalApprovalResolution {
  return {
    ...approval,
    issuer: "friday_canonical_gate",
    signature: createFridayCanonicalApprovalSignature(approval, secret),
  };
}

export function createFridayCanonicalApprovalSignature(
  approval: FridayCanonicalApprovalResolution,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(stableStringify(createCanonicalApprovalSignaturePayload(approval)))
    .digest("hex");
}

export function verifyFridayCanonicalApprovalSignature(
  approval: FridayCanonicalApprovalResolution,
  secret: string,
): boolean {
  if (approval.issuer !== "friday_canonical_gate" || typeof approval.signature !== "string") {
    return false;
  }

  const normalizedSignature = normalizeCanonicalApprovalSignatureText(approval.signature);
  if (normalizedSignature === null) {
    return false;
  }

  const expected = createFridayCanonicalApprovalSignature(approval, secret);
  const actualBuffer = Buffer.from(normalizedSignature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

/**
 * Verify the AUTHORITY of an `approved` canonical approval. Returns a deny reason
 * string, or `null` when the approval is authentic AND (for a device-authored
 * approval) bound to the exact action + owner device.
 *
 * Two disjoint authorities:
 *   - `friday_device_owner` — ASYMMETRIC P-256 proof-of-possession (the Hub holds
 *     NO signing key). ALWAYS cryptographically verified, then bound to the
 *     request action digest + acting owner + the owner's device key hash. This is
 *     the SEC-APPROVAL-AUTHORITY-001 verify-only path.
 *   - otherwise (`friday_canonical_gate` / unset) — the LEGACY symmetric HMAC,
 *     verified only when a signature is required/available (unchanged behaviour;
 *     used by the plugin/mcp/channel/skill/workflow lifecycle, NOT by providers).
 */
function verifyCanonicalApprovalAuthority(input: {
  approval: FridayCanonicalApprovalResolution;
  actionDigest: string;
  actorBoundDeviceOwnerSentinelHash: string | undefined;
  evaluatedAt: string;
  requireApprovalSignature: boolean;
  approvalSignatureSecret: string | undefined;
  deviceApprovalVerifier: FridayDeviceApprovalVerifier | undefined;
}): string | null {
  const { approval } = input;

  if (approval.issuer === "friday_device_owner") {
    return verifyDeviceOwnerApprovalAuthority(input);
  }

  // LEGACY symmetric-HMAC authority (plugin/mcp/channel/skill/workflow lifecycle).
  if (input.requireApprovalSignature || input.approvalSignatureSecret !== undefined) {
    if (
      input.approvalSignatureSecret === undefined
      || !verifyFridayCanonicalApprovalSignature(approval, input.approvalSignatureSecret)
    ) {
      return "canonical_approval_signature_invalid";
    }
  }
  return null;
}

/** Map a pure-verifier reject reason to a stable, non-sensitive gate deny reason. */
function mapDeviceApprovalRejectReason(reason: string | undefined): string {
  if (reason === "expired") return "canonical_approval_expired";
  return "device_approval_signature_invalid";
}

function verifyDeviceOwnerApprovalAuthority(input: {
  approval: FridayCanonicalApprovalResolution;
  actionDigest: string;
  /**
   * SEC-APPROVAL-AUTHORITY-001 · CORE-A CR-2 (Option B*): the authenticated owner's
   * durable device-binding sentinel hash, resolved SERVER-SIDE from
   * `users.password_hash` (`undefined` when the actor is not a device-claimed owner).
   */
  actorBoundDeviceOwnerSentinelHash: string | undefined;
  evaluatedAt: string;
  deviceApprovalVerifier: FridayDeviceApprovalVerifier | undefined;
}): string | null {
  const { approval, deviceApprovalVerifier } = input;
  // Fail closed: a device-authored approval that cannot be verified never admits.
  if (deviceApprovalVerifier === undefined) {
    return "device_approval_verifier_unavailable";
  }
  if (approval.deviceProof === undefined) {
    return "device_approval_proof_missing";
  }
  const nowMs = Date.parse(input.evaluatedAt);
  if (!Number.isFinite(nowMs)) {
    return "canonical_approval_expiration_invalid";
  }

  // (1) PURE asymmetric proof-of-possession over the signed transcript.
  const verified = deviceApprovalVerifier(approval.deviceProof, nowMs);
  if (!verified.ok || verified.devicePublicKeyHash === undefined) {
    return mapDeviceApprovalRejectReason(verified.reason);
  }

  // (2) The SIGNED transcript must cover EXACTLY the approval's claimed fields, and
  //     the approval's action digest must equal the request's recomputed digest —
  //     so a proof cannot be lifted onto a different action, owner, or expiry.
  if (
    verified.actionDigest !== approval.actionDigest
    || verified.actionDigest !== input.actionDigest
  ) {
    return "device_approval_action_digest_mismatch";
  }
  if (verified.approvalId !== approval.approvalId) {
    return "device_approval_id_mismatch";
  }
  if (verified.decidedByPrincipalId !== approval.decidedByPrincipalId) {
    return "device_approval_principal_mismatch";
  }
  if (verified.expiresAt !== approval.expiresAt) {
    return "device_approval_expiry_mismatch";
  }

  // (3) DURABLE OWNER-DEVICE binding (Option B*): the approval's signing device MUST
  //     be the device registered to the AUTHENTICATED owner. We compare the signing
  //     key against the owner's durable sentinel using the SENTINEL'S OWN hashing
  //     convention (`sha256Hex(devicePublicKey)` — the same one `deviceKeyLogin`
  //     already trusts), NOT the acting `principalId` (which is `user.id`, by design).
  //     A passphrase / unclaimed owner has NO sentinel (`undefined`) → refused.
  const boundSentinelHash = input.actorBoundDeviceOwnerSentinelHash;
  if (
    boundSentinelHash === undefined
    || boundSentinelHash.length === 0
    || sha256Hex(approval.deviceProof.devicePublicKey.value) !== boundSentinelHash
  ) {
    return "device_approval_actor_mismatch";
  }
  // (4) CANONICAL self-consistency (unchanged): the approval's declared principal
  //     must match its signing device key hash (`canonicalDevicePublicKeyHash`), so a
  //     valid proof cannot carry a foreign owner principal.
  if (deviceOwnerPrincipalId(verified.devicePublicKeyHash) !== approval.decidedByPrincipalId) {
    return "device_approval_device_not_bound_to_owner";
  }
  return null;
}

/** sha256 hex of a value — the sentinel's hashing convention (see auth-service). */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeCanonicalApprovalSignatureText(signature: string | undefined): string | null {
  if (typeof signature !== "string" || !/^[0-9a-fA-F]{64}$/.test(signature)) {
    return null;
  }
  return signature.toLowerCase();
}

function createCanonicalApprovalUseKey(approval: FridayCanonicalApprovalResolution): string {
  // Single-use is keyed on the approval identity AND the exact signing material, so
  // replaying a consumed approval (HMAC OR device proof) is refused. For a
  // device-authored approval the raw P-1363 signature is the single-use token.
  const deviceSignature = approval.deviceProof?.signature?.value ?? "";
  return [
    approval.approvalId,
    approval.actionDigest,
    approval.issuer ?? "",
    normalizeCanonicalApprovalSignatureText(approval.signature) ?? "",
    deviceSignature,
  ].join(":");
}

export function isFridaySystemIntentMutatingAction(action: string): boolean {
  return SYSTEM_MUTATING_INTENTS.has(action);
}

export function createFridaySystemIntentMutatingActionRequest(
  input: FridaySystemIntentGateInput,
  options: FridaySystemIntentGateRequestOptions = {},
): FridayMutatingActionRequest {
  const action = input.action?.trim() || "unknown";
  const actorKind = input.actorKind ?? options.defaultActorKind ?? "api";
  const actorId = input.actorId ?? options.defaultActorId ?? `${actorKind}:system-intent`;

  return {
    action: `system.${action}`,
    actor: {
      kind: actorKind,
      id: actorId,
      principalId: actorId,
    },
    surface: options.surface ?? "system",
    resource: createSystemIntentResource(input),
    mutating: isFridaySystemIntentMutatingAction(action),
    risk: mapSystemRiskLevel(input.riskLevel, action),
    parameters: createSystemIntentDigestParameters(input),
    idempotencyKey: input.idempotencyKey,
    localClaims: options.localClaims,
  };
}

export function createFridayMutatingActionGate(
  options: FridayMutatingActionGateOptions = {},
): FridayMutatingActionGate {
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const ticketIdGenerator = options.ticketIdGenerator ?? createDefaultTicketId;
  const approvalSignatureSecret = options.approvalSignatureSecret;
  const requireApprovalSignature = options.requireApprovalSignature ?? false;
  const deviceApprovalVerifier = options.deviceApprovalVerifier;
  const consumedCanonicalApprovalKeys = new Set<string>();

  return {
    evaluate(request: FridayMutatingActionRequest): FridayMutatingActionGateResult {
      const localClaims = [...(request.localClaims ?? [])];
      const risk = deriveFridayMutatingActionRisk(request);
      const actionDigest = createFridayMutatingActionDigest(request, risk);
      const evaluatedAt = nowIso();

      if (isFridayReservedApprovalActionForActor(request)) {
        return buildResult({
          request,
          actionDigest,
          risk,
          localClaims,
          evaluatedAt,
          decision: "deny",
          reason: "agent_cannot_execute_reserved_approval_action",
          approvalRequired: false,
          deniedBy: "canonical_gate",
        });
      }

      const localDeny = localClaims.find((claim) => claim.decision === "deny");
      if (localDeny !== undefined) {
        return buildResult({
          request,
          actionDigest,
          risk,
          localClaims,
          evaluatedAt,
          decision: "deny",
          reason: localDeny.reason ?? "local_guard_denied",
          approvalRequired: false,
          deniedBy: localDeny.guardId,
        });
      }

      const approvalRequired = requiresCanonicalApproval(request, risk, localClaims);
      const canonicalApproval = request.canonicalApproval;

      if (canonicalApproval !== undefined && canonicalApproval.actionDigest !== actionDigest) {
        return buildResult({
          request,
          actionDigest,
          risk,
          localClaims,
          evaluatedAt,
          decision: "deny",
          reason: "canonical_approval_digest_mismatch",
          approvalRequired,
          deniedBy: "canonical_gate",
        });
      }

      if (canonicalApproval?.decision === "approved") {
        const authorityDenyReason = verifyCanonicalApprovalAuthority({
          approval: canonicalApproval,
          actionDigest,
          actorBoundDeviceOwnerSentinelHash: request.actor.boundDeviceOwnerSentinelHash,
          evaluatedAt,
          requireApprovalSignature,
          approvalSignatureSecret,
          deviceApprovalVerifier,
        });
        if (authorityDenyReason !== null) {
          return buildResult({
            request,
            actionDigest,
            risk,
            localClaims,
            evaluatedAt,
            decision: "deny",
            reason: authorityDenyReason,
            approvalRequired,
            deniedBy: "canonical_gate",
            approvalId: canonicalApproval.approvalId,
          });
        }
      }

      if (canonicalApproval?.decision === "denied") {
        return buildResult({
          request,
          actionDigest,
          risk,
          localClaims,
          evaluatedAt,
          decision: "deny",
          reason: canonicalApproval.reason ?? "canonical_approval_denied",
          approvalRequired,
          deniedBy: "canonical_gate",
          approvalId: canonicalApproval.approvalId,
        });
      }

      if (canonicalApproval?.decision === "approved") {
        if (canonicalApproval.expiresAt === undefined) {
          return buildResult({
            request,
            actionDigest,
            risk,
            localClaims,
            evaluatedAt,
            decision: "deny",
            reason: "canonical_approval_expiration_required",
            approvalRequired,
            deniedBy: "canonical_gate",
            approvalId: canonicalApproval.approvalId,
          });
        }
        const approvalExpiresAtMs = Date.parse(canonicalApproval.expiresAt);
        const evaluatedAtMs = Date.parse(evaluatedAt);
        if (!Number.isFinite(approvalExpiresAtMs) || !Number.isFinite(evaluatedAtMs)) {
          return buildResult({
            request,
            actionDigest,
            risk,
            localClaims,
            evaluatedAt,
            decision: "deny",
            reason: "canonical_approval_expiration_invalid",
            approvalRequired,
            deniedBy: "canonical_gate",
            approvalId: canonicalApproval.approvalId,
          });
        }
        if (approvalExpiresAtMs <= evaluatedAtMs) {
          return buildResult({
            request,
            actionDigest,
            risk,
            localClaims,
            evaluatedAt,
            decision: "deny",
            reason: "canonical_approval_expired",
            approvalRequired,
            deniedBy: "canonical_gate",
            approvalId: canonicalApproval.approvalId,
          });
        }
      }

      if (!approvalRequired) {
        return buildResult({
          request,
          actionDigest,
          risk,
          localClaims,
          evaluatedAt,
          decision: "allow",
          reason: "read_only_action_allowed_without_ticket",
          approvalRequired: false,
        });
      }

      if (canonicalApproval?.decision !== "approved") {
        return buildResult({
          request,
          actionDigest,
          risk,
          localClaims,
          evaluatedAt,
          decision: "requires_approval",
          reason: "canonical_approval_required",
          approvalRequired: true,
        });
      }

      const canonicalApprovalUseKey = createCanonicalApprovalUseKey(canonicalApproval);
      if (consumedCanonicalApprovalKeys.has(canonicalApprovalUseKey)) {
        return buildResult({
          request,
          actionDigest,
          risk,
          localClaims,
          evaluatedAt,
          decision: "deny",
          reason: "canonical_approval_already_used",
          approvalRequired: true,
          deniedBy: "canonical_gate",
          approvalId: canonicalApproval.approvalId,
        });
      }

      const ticket: FridayMutatingActionTicket = {
        ticketId: ticketIdGenerator(),
        actionDigest,
        action: request.action,
        actor: request.actor,
        surface: request.surface,
        resource: request.resource,
        risk,
        approvalId: canonicalApproval.approvalId,
        approvedByPrincipalId: canonicalApproval.decidedByPrincipalId,
        issuedAt: evaluatedAt,
        expiresAt: canonicalApproval.expiresAt,
        planDigest: request.planDigest,
        childOfLifecycleTicketId: canonicalApproval.childOfLifecycleTicketId,
        idempotencyKey: request.idempotencyKey,
      };
      consumedCanonicalApprovalKeys.add(canonicalApprovalUseKey);

      return buildResult({
        request,
        actionDigest,
        risk,
        localClaims,
        evaluatedAt,
        decision: "allow",
        reason: "canonical_approval_ticket_issued",
        approvalRequired: true,
        ticket,
        approvalId: canonicalApproval.approvalId,
      });
    },
  };
}

function deriveFridayMutatingActionRisk(
  request: Pick<FridayMutatingActionRequest, "mutating" | "risk" | "localClaims">,
): FridayMutatingActionRisk {
  let risk: FridayMutatingActionRisk = request.risk ?? (request.mutating ? "medium" : "read_only");

  for (const claim of request.localClaims ?? []) {
    if (claim.risk !== undefined && compareFridayMutatingActionRisk(claim.risk, risk) > 0) {
      risk = claim.risk;
    }
  }

  return risk;
}

function requiresCanonicalApproval(
  request: FridayMutatingActionRequest,
  risk: FridayMutatingActionRisk,
  localClaims: readonly FridayMutatingActionLocalClaim[],
): boolean {
  if (request.mutating) {
    return true;
  }

  if (isFridayMutatingActionRiskAtLeast(risk, "high")) {
    return true;
  }

  return localClaims.some((claim) => claim.decision === "requires_approval");
}

function buildResult(input: {
  readonly request: FridayMutatingActionRequest;
  readonly actionDigest: string;
  readonly risk: FridayMutatingActionRisk;
  readonly localClaims: readonly FridayMutatingActionLocalClaim[];
  readonly evaluatedAt: string;
  readonly decision: FridayMutatingActionDecision;
  readonly reason: string;
  readonly approvalRequired: boolean;
  readonly deniedBy?: string;
  readonly ticket?: FridayMutatingActionTicket;
  readonly approvalId?: string;
}): FridayMutatingActionGateResult {
  const evidenceRecord: FridayMutatingActionGateEvidenceRecord = {
    gateId: "friday_canonical_mutating_action_gate",
    evaluatedAt: input.evaluatedAt,
    decision: input.decision,
    reason: input.reason,
    actionDigest: input.actionDigest,
    action: input.request.action,
    actor: input.request.actor,
    surface: input.request.surface,
    resource: input.request.resource,
    mutating: input.request.mutating,
    risk: input.risk,
    approvalRequired: input.approvalRequired,
    deniedBy: input.deniedBy,
    ticketId: input.ticket?.ticketId,
    approvalId: input.approvalId ?? input.ticket?.approvalId,
    planDigest: input.request.planDigest,
    rollback: input.request.rollback,
    localClaims: input.localClaims,
  };

  return {
    decision: input.decision,
    reason: input.reason,
    risk: input.risk,
    actionDigest: input.actionDigest,
    approvalRequired: input.approvalRequired,
    deniedBy: input.deniedBy,
    ticket: input.ticket,
    localClaims: input.localClaims,
    evidenceRecord,
  };
}

function createDefaultTicketId(): string {
  return `fmtag_${createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 24)}`;
}

function createSystemIntentResource(
  input: FridaySystemIntentGateInput,
): FridayMutatingActionResource {
  const action = input.action?.trim() || "unknown";
  const resourceId =
    input.appIdentifier
    ?? input.windowId
    ?? input.url
    ?? input.projectPath
    ?? input.notificationId
    ?? input.approvalId
    ?? input.deviceId
    ?? input.target
    ?? action;

  return {
    type: "system_intent",
    id: resourceId,
    attributes: {
      action,
      targetKind: input.targetKind,
      windowId: input.windowId,
      notificationAction: input.notificationAction,
      layout: input.layout,
      force: input.force,
    },
  };
}

function createSystemIntentDigestParameters(
  input: FridaySystemIntentGateInput,
): Readonly<Record<string, unknown>> {
  return {
    target: input.target,
    targetKind: input.targetKind,
    appIdentifier: input.appIdentifier,
    windowId: input.windowId,
    url: input.url,
    projectPath: input.projectPath,
    query: input.query,
    value: input.value,
    notificationId: input.notificationId,
    notificationAction: input.notificationAction,
    approvalId: input.approvalId,
    deviceId: input.deviceId,
    riskLevel: input.riskLevel,
    reason: input.reason,
    force: input.force,
    leaseTtlMs: input.leaseTtlMs,
    layout: input.layout,
  };
}

function mapSystemRiskLevel(
  riskLevel: string | undefined,
  action: string,
): FridayMutatingActionRisk {
  switch (riskLevel) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
      return "low";
    case "none":
      return "read_only";
    default:
      if (SYSTEM_HIGH_RISK_INTENTS.has(action)) {
        return "high";
      }
      if (SYSTEM_MEDIUM_RISK_INTENTS.has(action)) {
        return "medium";
      }
  return isFridaySystemIntentMutatingAction(action) ? "low" : "read_only";
  }
}

function createCanonicalApprovalSignaturePayload(
  approval: FridayCanonicalApprovalResolution,
): Readonly<Record<string, unknown>> {
  return {
    version: 1,
    decision: approval.decision,
    approvalId: approval.approvalId,
    decidedByPrincipalId: approval.decidedByPrincipalId,
    actionDigest: approval.actionDigest,
    reason: approval.reason,
    expiresAt: approval.expiresAt,
    childOfLifecycleTicketId: approval.childOfLifecycleTicketId,
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForStableStringify(value));
}

function normalizeForStableStringify(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeForStableStringify(item));
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item !== undefined && typeof item !== "function" && typeof item !== "symbol") {
        normalized[key] = normalizeForStableStringify(item);
      }
    }
    return normalized;
  }

  return null;
}
