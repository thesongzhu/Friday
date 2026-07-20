import type {
  CreateProviderInput,
  FridayProviderMutationApproval,
  FridayProviderMutationPlan,
  PlanProviderMutationInput,
  UpdateProviderInput,
} from "@/lib/api/providers";
import type {
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
 * ## Owner-confirm handshake (CORE-RUNNABLE-001 / CORE-A CR-2)
 *
 * In a release profile the canonical mutating-action gate REQUIRES a plan digest
 * plus a signed canonical approval; without them the mutation fails closed with
 * `PROVIDER_MUTATION_PLAN_DIGEST_REQUIRED` (403). This helper therefore performs
 * the full three-step protocol rather than posting the mutation blind:
 *
 *   1. `providers.plan` — the SERVER sanitizes the intended parameters and
 *      derives the plan + action digests itself, returning a secret-free
 *      human-readable summary. The client never computes a digest, so parameter
 *      drift can only fail closed — it can never be forged client-side.
 *   2. the owner REVIEWS that summary and explicitly confirms (`confirmPlan`).
 *      Declining aborts before anything is minted or mutated.
 *   3. `providers.plan/confirm` mints a short-lived single-use canonical
 *      approval bound to the server-computed action digest, which is then
 *      replayed on the real mutation.
 *
 * The gate recomputes the action digest server-side from the request that
 * actually arrives, so a changed parameter between plan and mutation fails
 * closed. No step of this handshake weakens the gate.
 */

export interface ProviderSaveResult {
  provider: FridayProviderProfile;
  validation?: FridayProviderValidationState;
}

/**
 * The subset of `providersApi` this helper needs. Declaring it structurally
 * keeps the helper unit-testable with a mock and lets the real `providersApi`
 * satisfy it without an extra adapter.
 */
export interface ProviderValidateSaveClient {
  planMutation(input: PlanProviderMutationInput): Promise<FridayProviderMutationPlan>;
  confirmMutation(planDigest: string): Promise<FridayProviderMutationApproval>;
  create(input: CreateProviderInput): Promise<ProviderSaveResult>;
  update(providerId: string, patch: UpdateProviderInput): Promise<ProviderSaveResult>;
}

/**
 * Owner review + explicit confirmation of a server-produced plan.
 *
 * MUST resolve `true` only on a deliberate owner confirmation of THIS plan —
 * never defaulted, never auto-accepted. Resolving `false` aborts the save before
 * any approval is minted and before any mutation is sent.
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
 * Persist a provider only after the backend validates its credential AND the
 * owner has confirmed the server-derived plan.
 *
 * - When a provider of the same kind already exists, this updates it (so a
 *   re-submit / replay is idempotent — no duplicate provider, no double-persist
 *   of the credential) rather than creating a second one.
 * - `validateOnSave: true` is always set, so validation is never bypassed.
 * - The plan is derived by the server from the EXACT body the mutation will
 *   send, so the replayed approval cannot cover different parameters.
 */
export async function saveProviderWithValidation(
  client: ProviderValidateSaveClient,
  existing: { id: string } | undefined,
  input: CreateProviderInput,
  confirmPlan: ProviderPlanConfirmer,
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

  const plan = await client.planMutation({
    action: existing ? "providers.update" : "providers.create",
    providerId: existing?.id,
    params: body as unknown as Record<string, unknown>,
  });

  const confirmed = await confirmPlan(plan);
  if (confirmed !== true) {
    throw new ProviderMutationDeclinedError(plan.planDigest);
  }

  const approval = await client.confirmMutation(plan.planDigest);
  const controls = {
    planDigest: approval.planDigest,
    canonicalApproval: approval.canonicalApproval,
  };

  if (existing) {
    return client.update(existing.id, { ...(body as UpdateProviderInput), ...controls });
  }
  return client.create({ ...(body as CreateProviderInput), ...controls });
}
