const REDACTION = "[secret redacted]";

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /\bmfa\.[A-Za-z0-9_-]{20,}\b/g,
  /\b[A-Za-z0-9_-]{23,32}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g,
];

export function redactSecretLikeText(input: string): string {
  let output = input;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, REDACTION);
  }
  return output;
}

export function redactSecretLikeValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return redactSecretLikeText(value);
  if (typeof value === "object") return redactSecretLikeText(JSON.stringify(value, null, 2));
  return redactSecretLikeText(String(value));
}
