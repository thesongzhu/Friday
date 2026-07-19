/**
 * ART-NONPROD-001 — protected-release-profile predicate + the canonical registry
 * of test-only ENV switches, shared by the hub bootstrap and secret-crypto so a
 * mock/test lane can NEVER be activatable in a production / tagged-release build.
 *
 * This is a LEAF module: it imports nothing from the Friday tree (only the
 * ambient `NodeJS.ProcessEnv` type), so both `friday-hub-bootstrap.ts` (`#hub`)
 * and `friday-secret-crypto.ts` (`#providers`) can import it WITHOUT creating an
 * import cycle. Keep it dependency-free.
 */

/**
 * A "protected" runtime profile is a production build (`NODE_ENV=production`) or
 * any tagged-release build (`FRIDAY_RELEASE_TAG` non-empty). Test-only switches
 * and mock lanes MUST fail closed in these profiles.
 *
 * This is the SINGLE source of truth for the protected-profile predicate; the
 * hub bootstrap's `isFridayCanonicalGateProtectedProfile` delegates to it so the
 * canonical mutating-action gate and the test-only switch gate agree exactly.
 */
export function isFridayProtectedReleaseProfile(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.NODE_ENV?.trim().toLowerCase() === "production"
    || Boolean(env.FRIDAY_RELEASE_TAG?.trim());
}

/**
 * Canonical, CLOSED registry of every `FRIDAY_ALLOW_TEST_ONLY_*` ENV switch that
 * activates a test/mock lane. Every entry MUST be refused in a protected profile.
 *
 * OPEN-WORLD GUARD: `test/unit/security/friday-protected-profile.test.ts`
 * enumerates every `FRIDAY_ALLOW_TEST_ONLY_*` literal referenced under `src/`
 * and asserts each is registered here AND refused in a protected profile — so a
 * future un-gated test-only switch fails the guard rather than silently shipping
 * an activatable mock lane in a release build.
 *
 * NOTE: the REAL signed-artifact / release-manifest observation scan is release
 * gated and intentionally OUT OF SCOPE here (mirrors the deferred real-observation
 * boundary documented in `tools/inventory/reconcile.mjs`); this registry is the
 * source-level, code-only guard.
 */
export const FRIDAY_TEST_ONLY_ENV_SWITCHES = [
  "FRIDAY_ALLOW_TEST_ONLY_PLUGIN_EXECUTION",
  "FRIDAY_ALLOW_TEST_ONLY_AUTONOMY_LIFECYCLE_EXECUTION",
  "FRIDAY_ALLOW_TEST_ONLY_MASTER_KEY_GENERATION",
] as const;

export type FridayTestOnlyEnvSwitch = (typeof FRIDAY_TEST_ONLY_ENV_SWITCHES)[number];

const FRIDAY_TEST_ONLY_ENV_SWITCH_SET: ReadonlySet<string> = new Set(
  FRIDAY_TEST_ONLY_ENV_SWITCHES,
);

/** True when `name` is a registered test-only ENV switch. */
export function isRegisteredFridayTestOnlyEnvSwitch(name: string): boolean {
  return FRIDAY_TEST_ONLY_ENV_SWITCH_SET.has(name);
}

/**
 * Canonical fail-closed message. Names the SPECIFIC switch so an operator sees
 * exactly which env var must be removed from a release build.
 */
export function fridayProtectedProfileTestOnlySwitchMessage(envVarName: string): string {
  return (
    `[friday] ${envVarName} (a FRIDAY_ALLOW_TEST_ONLY_* switch) cannot be enabled in `
    + "production/release profiles (NODE_ENV=production or FRIDAY_RELEASE_TAG set). "
    + "Use a development or test profile for mock lanes."
  );
}

/**
 * Fail closed if the named test-only switch would activate in a protected
 * profile. No-op in dev/test profiles (dev/test lanes stay unaffected).
 */
export function assertFridayTestOnlyEnvSwitchAllowed(
  envVarName: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (isFridayProtectedReleaseProfile(env)) {
    throw new Error(fridayProtectedProfileTestOnlySwitchMessage(envVarName));
  }
}
