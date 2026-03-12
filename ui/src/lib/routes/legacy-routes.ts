export const LEGACY_ROUTE_PREFIXES = [
  "/sessions",
  "/memory",
] as const;

export function resolveLegacyRedirect(pathname: string): string | null {
  if (pathname.startsWith("/automations/")) {
    return "/automations";
  }

  for (const prefix of LEGACY_ROUTE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return "/";
    }
  }

  return null;
}
