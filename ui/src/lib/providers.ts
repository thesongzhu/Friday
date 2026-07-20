import type {
  CreateProviderInput,
  FridayProviderMutationApproval,
  FridayProviderMutationPlan,
  PlanProviderMutationInput,
  SetRoutingInput,
  UpdateProviderInput,
} from "@/lib/api/providers";
import type { ProviderApprovalAuthor, ProviderApprovalDeviceProof } from "@/lib/auth/device-key";
import type {
  FridayModelRoutingConfig,
  FridayProviderProfile,
  FridayProviderValidationState,
} from "@/lib/api/types";

/**
 * Shared BYOK "validate-before-persist" save helper.
 *
 * This is the SAME live path the Settings page uses to connect a key provider:
 * `providersApi.create` / `providersApi.update` with `validateOnSave: true`, so
 * the backend validates the entered credential BEFORE persisting it (an invalid
 * key is rejected and never stored; a valid key is stored as a secret-ref).
 *
 * The onboarding setup wizard routes its validate/save button through this
 * helper instead of the retired `POST /v1/providers/detect` route (which is
 * fail-closed 503 in the default production runtime).
 *
 * ## Owner-confirm handshake (SEC-APPROVAL-AUTHORITY-001 / CORE-A CR-2)
 *
 * In a release profile the canonical mutating-action gate REQUIRES a plan digest
 * plus a DEVICE-AUTHORED approval; without them the mutation fails closed with
 * `PROVIDER_MUTATION_PLAN_DIGEST_REQUIRED` (403). This helper therefore performs
 * the full four-step protocol rather than posting the mutation blind:
 *
 *   1. `providers.plan` — the SERVER sanitizes the intended parameters and derives
 *      the plan + action digests itself, returning a secret-free human-readable
 *      summary. The client never computes a digest, so parameter drift can only
 *      fail closed — it can never be forged client-side.
 *   2. the owner REVIEWS that summary and explicitly confirms (`confirmPlan`).
 *      Declining aborts before anything is signed or mutated.
 *   3. the owner DEVICE signs an approval transcript binding the SERVER-computed
 *      action digest (`authorApproval`). The Hub holds NO signing key.
 *   4. `providers.plan/confirm` VERIFIES that device proof (asymmetric P-256) and
 *      returns the device-authored, single-use canonical approval, which is then
 *      replayed on the real mutation.
 *
 * The gate recomputes the action digest server-side from the request that actually
 * arrives AND re-verifies the device proof, so a changed parameter between plan and
 * mutation fails closed. No step of this handshake weakens the gate.
 */

export interface ProviderSaveResult {
  provider: FridayProviderProfile;
  validation?: FridayProviderValidationState;
}

/**
 * The subset of `providersApi` these helpers need. Declaring it structurally keeps
 * the helpers unit-testable with a mock and lets the real `providersApi` satisfy it
 * without an extra adapter.
 */
export interface ProviderValidateSaveClient {
  planMutation(input: PlanProviderMutationInput): Promise<FridayProviderMutationPlan>;
  confirmMutation(
    planDigest: string,
    deviceApproval: ProviderApprovalDeviceProof,
  ): Promise<FridayProviderMutationApproval>;
  create(input: CreateProviderInput): Promise<ProviderSaveResult>;
  update(providerId: string, patch: UpdateProviderInput): Promise<ProviderSaveResult>;
}

/** The routing seam, needed by {@link saveProviderWithRouting}. */
export interface ProviderRoutingSaveClient extends ProviderValidateSaveClient {
  setRouting(input: SetRoutingInput): Promise<FridayModelRoutingConfig>;
}

/**
 * Owner review + explicit confirmation of a server-produced plan.
 *
 * MUST resolve `true` only on a deliberate owner confirmation of THIS plan —
 * never defaulted, never auto-accepted. Resolving `false` aborts before any
 * approval is authored and before any mutation is sent.
 */
export type ProviderPlanConfirmer = (plan: FridayProviderMutationPlan) => Promise<boolean>;

/** Thrown when the owner reviewed the plan and declined it. Nothing was mutated. */
export class ProviderMutationDeclinedError extends Error {
  readonly planDigest: string;

  constructor(planDigest: string) {
    super("Provider change was not confirmed by the owner; nothing was saved.");
    this.name = "ProviderMutationDeclinedError";
    this.planDigest = planDigest;
  }
}

/**
 * Thrown when a provider was created/updated (and its credential persisted) but the
 * follow-up routing step failed. This surfaces the partial state TRUTHFULLY — naming
 * the persisted provider — instead of masquerading as a total save failure that
 * hides the created provider (SAFE-ROLLBACK-PRECONDITION-001 / Advisor #1628 #3).
 */
export class ProviderRoutingAfterSaveError extends Error {
  readonly provider: FridayProviderProfile;
  readonly cause: unknown;

  constructor(provider: FridayProviderProfile, cause: unknown) {
    super(
      "The provider was saved but its default-routing could not be set. "
        + "The provider exists; set it as the default from the provider list to finish.",
    );
    this.name = "ProviderRoutingAfterSaveError";
    this.provider = provider;
    this.cause = cause;
  }
}

/**
 * Run ONE gated provider mutation through the full owner-confirm handshake and
 * return the control fields (`planDigest` + device-authored `canonicalApproval`)
 * to replay on the real mutation. Shared by create/update AND routing so NO gated
 * provider mutation is ever posted without a confirmed, device-authored approval.
 */
async function confirmProviderMutationPlan(
  client: ProviderValidateSaveClient,
  planInput: PlanProviderMutationInput,
  confirmPlan: ProviderPlanConfirmer,
  authorApproval: ProviderApprovalAuthor,
): Promise<{ planDigest: string; canonicalApproval: unknown }> {
  const plan = await client.planMutation(planInput);

  const confirmed = await confirmPlan(plan);
  if (confirmed !== true) {
    throw new ProviderMutationDeclinedError(plan.planDigest);
  }

  // The owner DEVICE authors the approval over the SERVER-computed action digest.
  const deviceApproval = await authorApproval({ actionDigest: plan.actionDigest });
  const approval = await client.confirmMutation(plan.planDigest, deviceApproval);
  return {
    planDigest: approval.planDigest,
    canonicalApproval: approval.canonicalApproval,
  };
}

/**
 * Persist a provider only after the backend validates its credential AND the owner
 * has confirmed the server-derived plan with a device-authored approval.
 *
 * - When a provider of the same kind already exists, this updates it (so a
 *   re-submit / replay is idempotent — no duplicate provider, no double-persist of
 *   the credential) rather than creating a second one.
 * - `validateOnSave: true` is always set, so validation is never bypassed.
 * - The plan is derived by the server from the EXACT body the mutation will send,
 *   so the replayed approval cannot cover different parameters.
 */
export async function saveProviderWithValidation(
  client: ProviderValidateSaveClient,
  existing: { id: string } | undefined,
  input: CreateProviderInput,
  confirmPlan: ProviderPlanConfirmer,
  authorApproval: ProviderApprovalAuthor,
): Promise<ProviderSaveResult> {
  // Build the exact mutation body FIRST so the plan the owner reviews is derived
  // from the same parameters the mutation will actually carry.
  let body: CreateProviderInput | UpdateProviderInput;
  if (existing) {
    // An update patch carries no `kind` (the provider's kind is immutable).
    const { kind, ...rest } = input;
    void kind;
    body = { ...rest, validateOnSave: true };
  } else {
    body = { ...input, validateOnSave: true };
  }

  const controls = await confirmProviderMutationPlan(
    client,
    {
      action: existing ? "providers.update" : "providers.create",
      providerId: existing?.id,
      params: body as unknown as Record<string, unknown>,
    },
    confirmPlan,
    authorApproval,
  );

  if (existing) {
    return client.update(existing.id, { ...(body as UpdateProviderInput), ...controls });
  }
  return client.create({ ...(body as CreateProviderInput), ...controls });
}

/**
 * Set the model routing config through the SAME owner-confirm + device-authored
 * handshake as create/update. `providers.routing.set` is a GATED mutation, so a
 * bare `setRouting` fails closed (403) in a release profile — every routing change
 * must carry a confirmed, device-authored approval.
 */
export async function setRoutingWithConfirmation(
  client: ProviderRoutingSaveClient,
  routingBody: Omit<SetRoutingInput, "planDigest" | "canonicalApproval">,
  confirmPlan: ProviderPlanConfirmer,
  authorApproval: ProviderApprovalAuthor,
): Promise<FridayModelRoutingConfig> {
  const controls = await confirmProviderMutationPlan(
    client,
    { action: "providers.routing.set", params: routingBody as unknown as Record<string, unknown> },
    confirmPlan,
    authorApproval,
  );
  return client.setRouting({ ...routingBody, ...controls });
}

/**
 * Persist a provider AND set it as the default route as ONE owner-reviewed
 * operation — each gated mutation flowing through its OWN confirmed, device-authored
 * plan (SAFE-ROLLBACK-PRECONDITION-001 / Advisor #1628 #3).
 *
 * The previous setup path called `providersApi.setRouting` WITHOUT a plan/approval
 * right after a successful create; in a release profile that guarantees a 403 AFTER
 * the provider is persisted, leaving a created-but-unrouted provider surfaced as a
 * total save failure. Here routing is a first-class confirmed mutation, so it can
 * never 403-after-persist; and if it fails for any OTHER reason, the partial state
 * is reported truthfully (the provider is named) instead of hidden.
 */
export async function saveProviderWithRouting(
  client: ProviderRoutingSaveClient,
  existing: { id: string } | undefined,
  input: CreateProviderInput,
  buildRouting: (provider: FridayProviderProfile) => Omit<SetRoutingInput, "planDigest" | "canonicalApproval">,
  confirmPlan: ProviderPlanConfirmer,
  authorApproval: ProviderApprovalAuthor,
): Promise<ProviderSaveResult & { routing: FridayModelRoutingConfig }> {
  const saved = await saveProviderWithValidation(client, existing, input, confirmPlan, authorApproval);

  try {
    const routing = await setRoutingWithConfirmation(
      client,
      buildRouting(saved.provider),
      confirmPlan,
      authorApproval,
    );
    return { ...saved, routing };
  } catch (error) {
    // The owner declined the routing plan → propagate the decline unchanged (the
    // provider is saved, which is the reviewed-and-confirmed first step).
    if (error instanceof ProviderMutationDeclinedError) {
      throw error;
    }
    // Any other routing failure AFTER a successful save is reported truthfully so
    // the created provider is never hidden behind a generic save error.
    throw new ProviderRoutingAfterSaveError(saved.provider, error);
  }
}
