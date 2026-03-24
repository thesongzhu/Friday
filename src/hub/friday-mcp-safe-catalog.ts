/**
 * MCP Self-Server Safe Catalog — Curated set of tools safe to expose via MCP.
 *
 * Only read-only, non-mutating, auditable tools belong here.
 * The env-var allowlist (`FRIDAY_MCP_SERVER_TOOL_ALLOWLIST`) can narrow this
 * set but never re-expose tools outside it.
 *
 * @module hub/friday-mcp-safe-catalog
 */

/**
 * Tools considered safe for MCP bridge exposure.
 * Criteria: read-only, no side-effects, no approval bypass, no exec.
 */
export const FRIDAY_MCP_SAFE_CATALOG = new Set([
  "capabilities",    // read-only runtime facts
  "task_status",     // read-only status query
  "skills_list",     // read-only skill listing
  "agents_list",     // read-only agent listing
  "web_search",      // information retrieval
  "web_fetch",       // URL fetching
  "read",            // file reading (read-only)
  "memory_search",   // memory recall (read-only)
]);

export function isMcpSafeCatalogTool(name: string): boolean {
  return FRIDAY_MCP_SAFE_CATALOG.has(name);
}

/**
 * Build the `isToolAllowed` filter for the self MCP server.
 *
 * - Empty `envAllowlist`: expose the full safe catalog.
 * - Non-empty `envAllowlist`: intersect with the safe catalog (can only narrow).
 */
export function buildMcpServerToolFilter(envAllowlist: string[]): {
  isToolAllowed: (toolName: string) => boolean;
} {
  if (envAllowlist.length === 0) {
    return { isToolAllowed: (toolName) => FRIDAY_MCP_SAFE_CATALOG.has(toolName) };
  }

  const envSet = new Set(envAllowlist);
  return {
    isToolAllowed: (toolName) =>
      FRIDAY_MCP_SAFE_CATALOG.has(toolName) && envSet.has(toolName),
  };
}
