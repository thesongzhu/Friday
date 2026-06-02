/**
 * Pure validation for the first-run local passphrase gate. Kept dependency-free and
 * framework-free so it is unit-testable by the repo's standard vitest `default` project
 * (this repo has no React component-test harness). The UI component renders on top of this.
 */

/** Backend minimum for POST /v1/auth/bootstrap/local-passphrase (>= 12 chars after no trim). */
export const MIN_PASSPHRASE_LENGTH = 12;

export interface PassphraseGateState {
  /** passphrase is non-empty but shorter than the minimum. */
  tooShort: boolean;
  /** confirm is non-empty and does not equal passphrase. */
  mismatch: boolean;
  /** safe to submit: meets min length AND confirm matches. */
  canSubmit: boolean;
}

/**
 * Compute the gate state for a (passphrase, confirm) pair. `canSubmit` is the single
 * source of truth the component uses to enable submit — it is true ONLY when the
 * passphrase meets the minimum length and the confirmation matches exactly.
 */
export function evaluatePassphraseGate(passphrase: string, confirm: string): PassphraseGateState {
  const longEnough = passphrase.length >= MIN_PASSPHRASE_LENGTH;
  const matches = passphrase === confirm;
  return {
    tooShort: passphrase.length > 0 && !longEnough,
    mismatch: confirm.length > 0 && !matches,
    canSubmit: longEnough && matches,
  };
}
