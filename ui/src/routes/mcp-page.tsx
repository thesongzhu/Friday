import { useQuery } from "@tanstack/react-query";
import { mcpApi } from "@/lib/api/mcp";
import type { McpServerState } from "@/lib/api/mcp";

function useMcpServers() {
  return useQuery({
    queryKey: ["mcp-servers"],
    queryFn: () => mcpApi.listServers(),
    refetchInterval: 15_000,
  });
}

function statusBadge(status?: string) {
  switch (status) {
    case "connected":
      return <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">Connected</span>;
    case "error":
      return <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">Error</span>;
    case "disconnected":
      return <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">Disconnected</span>;
    default:
      return <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">Unknown</span>;
  }
}

export function McpPage() {
  const { data: servers = [], isLoading, isError } = useMcpServers();

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-[color:var(--color-text-primary)]">
          MCP Servers
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">
          Manage Model Context Protocol servers connected to Friday. MCP servers extend agent capabilities with external tools, resources, and prompts.
        </p>
      </div>

      {isLoading ? (
        <div className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-8 text-center text-sm text-[color:var(--color-text-secondary)]">
          Loading MCP server status...
        </div>
      ) : isError ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-8 text-center dark:border-red-900/50 dark:bg-red-900/20">
          <p className="text-sm font-medium text-red-700 dark:text-red-400">Failed to load MCP server status</p>
          <p className="mt-1 text-xs text-red-600 dark:text-red-500">Check that the Friday server is running and try refreshing the page.</p>
        </div>
      ) : servers.length === 0 ? (
        <div className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-8 text-center">
          <p className="text-sm font-medium text-[color:var(--color-text-primary)]">No MCP servers configured</p>
          <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">
            Add MCP servers via the <code className="rounded bg-zinc-100 px-1 py-0.5 dark:bg-zinc-800">FRIDAY_MCP_SERVERS</code> environment variable or through a deep link import.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {servers.map((server) => (
            <div
              key={server.id}
              className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400">
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 0 1-3-3m3 3a3 3 0 1 0 0 6h13.5a3 3 0 1 0 0-6m-16.5-3a3 3 0 0 1 3-3h13.5a3 3 0 0 1 3 3m-19.5 0a4.5 4.5 0 0 1 .9-2.7L5.737 5.1a3.375 3.375 0 0 1 2.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 0 1 .9 2.7m0 0a3 3 0 0 1-3 3m0 3h.008v.008h-.008v-.008Zm0-6h.008v.008h-.008v-.008Zm-3 6h.008v.008h-.008v-.008Zm0-6h.008v.008h-.008v-.008Z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-[color:var(--color-text-primary)]">{server.id}</p>
                    <p className="text-xs text-[color:var(--color-text-secondary)]">
                      {server.transport ?? "stdio"}
                      {server.toolCount != null ? ` · ${String(server.toolCount)} tools` : ""}
                      {server.resourceCount != null ? ` · ${String(server.resourceCount)} resources` : ""}
                    </p>
                  </div>
                </div>
                {statusBadge(server.status)}
              </div>
              {server.lastError ? (
                <p className="mt-2 rounded-lg bg-red-50 p-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-400">
                  {server.lastError}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <div className="mt-8 rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4">
        <h2 className="text-sm font-medium text-[color:var(--color-text-primary)]">Configuration</h2>
        <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">
          MCP servers are configured through the <code className="rounded bg-zinc-100 px-1 py-0.5 dark:bg-zinc-800">FRIDAY_MCP_SERVERS</code> environment variable as a JSON array. Each server entry specifies a transport type (stdio, sse, or streamable-http) and the corresponding connection parameters.
        </p>
      </div>
    </div>
  );
}
