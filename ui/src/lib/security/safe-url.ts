const DEFAULT_ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export interface SafeHrefOptions {
  allowedProtocols?: readonly string[];
  allowRelative?: boolean;
}

function normalizeProtocol(protocol: string): string {
  return protocol.endsWith(":") ? protocol : `${protocol}:`;
}

function isRelativeHref(value: string): boolean {
  if (value.startsWith("//")) return false;
  if (value.startsWith("/") || value.startsWith("#") || value.startsWith("?")) return true;
  return value.startsWith("./") || value.startsWith("../");
}

export function toSafeHref(href: string, options: SafeHrefOptions = {}): string | null {
  const trimmed = href.trim();
  if (trimmed.length === 0) return null;

  if (options.allowRelative && isRelativeHref(trimmed)) {
    return trimmed;
  }

  const allowedProtocols = options.allowedProtocols
    ? new Set(options.allowedProtocols.map(normalizeProtocol))
    : DEFAULT_ALLOWED_PROTOCOLS;

  try {
    const parsed = new URL(trimmed);
    return allowedProtocols.has(parsed.protocol) ? trimmed : null;
  } catch {
    return null;
  }
}

export function isSafeHref(href: string, options: SafeHrefOptions = {}): boolean {
  return toSafeHref(href, options) !== null;
}
