export function resolveFridayPublicRunUrl(
  runId: string,
  baseUrl = process.env.FRIDAY_PUBLIC_APP_BASE_URL,
): string | undefined {
  const normalizedBase = typeof baseUrl === "string" ? baseUrl.trim() : "";
  if (!normalizedBase) {
    return undefined;
  }

  try {
    const url = new URL("/command-center", normalizedBase.endsWith("/") ? normalizedBase : `${normalizedBase}/`);
    url.searchParams.set("runId", runId);
    return url.toString();
  } catch {
    return undefined;
  }
}
