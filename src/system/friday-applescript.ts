import { FridayDomainError } from "#errors";

const UNSAFE_APPLESCRIPT_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const UNSAFE_APPLESCRIPT_BIDI = /[\u202A-\u202E\u2066-\u2069]/u;
const UNSAFE_APPLESCRIPT_IDENTIFIER_BREAK = /[\n\r\u2028\u2029]/u;

function escapeAppleScriptSegment(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function assertSafeAppleScriptText(value: string): void {
  if (UNSAFE_APPLESCRIPT_CONTROL.test(value) || UNSAFE_APPLESCRIPT_BIDI.test(value)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "Unsafe AppleScript input: control characters are not allowed",
      { httpStatus: 400 },
    );
  }
}

export function toAppleScriptStringLiteral(value: string): string {
  assertSafeAppleScriptText(value);

  const normalized = value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u2028|\u2029/gu, "\n");

  return normalized
    .split("\n")
    .map((segment) => `"${escapeAppleScriptSegment(segment)}"`)
    .join(" & linefeed & ");
}

export function assertSafeAppleScriptIdentifier(value: string, fieldName = "value"): string {
  assertSafeAppleScriptText(value);
  if (UNSAFE_APPLESCRIPT_IDENTIFIER_BREAK.test(value)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `Unsafe AppleScript ${fieldName}: line breaks are not allowed`,
      { httpStatus: 400 },
    );
  }
  return value;
}

export function toAppleScriptIdentifierLiteral(value: string, fieldName = "value"): string {
  return toAppleScriptStringLiteral(assertSafeAppleScriptIdentifier(value, fieldName));
}
