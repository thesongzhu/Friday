import type { CreateProviderInput, UpdateProviderInput } from "@/lib/api/providers";
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
  create(input: CreateProviderInput): Promise<ProviderSaveResult>;
  update(providerId: string, patch: UpdateProviderInput): Promise<ProviderSaveResult>;
}

/**
 * Persist a provider only after the backend validates its credential.
 *
 * - When a provider of the same kind already exists, this updates it (so a
 *   re-submit / replay is idempotent — no duplicate provider, no double-persist
 *   of the credential) rather than creating a second one.
 * - `validateOnSave: true` is always set, so validation is never bypassed.
 */
export async function saveProviderWithValidation(
  client: ProviderValidateSaveClient,
  existing: { id: string } | undefined,
  input: CreateProviderInput,
): Promise<ProviderSaveResult> {
  if (!existing) {
    return client.create({ ...input, validateOnSave: true });
  }
  // An update patch carries no `kind` (the provider's kind is immutable).
  const { kind, ...rest } = input;
  void kind;
  const patch: UpdateProviderInput = { ...rest, validateOnSave: true };
  return client.update(existing.id, patch);
}
