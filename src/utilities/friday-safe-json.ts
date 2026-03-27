/**
 * P2-DATA: Defensive JSON.parse that returns undefined instead of throwing on malformed data.
 * Use at persistence boundaries where stored JSON may have drifted from the expected schema.
 */
export function safeJsonParse<T>(json: string | null | undefined): T | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as T;
  } catch (err) {
    console.warn("[friday][safe-json] JSON parse failed:", err instanceof Error ? err.message : String(err));
    return undefined;
  }
}
