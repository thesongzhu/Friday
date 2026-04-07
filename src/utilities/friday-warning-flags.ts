const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

export function isFridayTestSecurityWarningSuppressed(): boolean {
  const raw = process.env.FRIDAY_SUPPRESS_TEST_ENV_SECURITY_WARNINGS;
  if (!raw) {
    return false;
  }
  return TRUE_ENV_VALUES.has(raw.trim().toLowerCase());
}
