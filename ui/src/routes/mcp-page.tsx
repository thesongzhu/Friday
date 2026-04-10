import { useQuery } from "@tanstack/react-query";
import { mcpApi } from "@/lib/api/mcp";
import type { McpServerState } from "@/lib/api/mcp";
import { SkeletonCard } from "@/components/core/primitives";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";

function useMcpServers() {
  return useQuery({
    queryKey: ["mcp-servers"],
    queryFn: () => mcpApi.listServers(),
    refetchInterval: 15_000,
  });
}

function statusBadge(status: string | undefined, locale: import("@/lib/i18n/localized-text").AppLocale) {
  switch (status) {
    case "connected":
      return <span className="inline-flex items-center gap-1 rounded-full bg-[color:var(--color-accent-soft)] px-2 py-0.5 text-xs font-medium text-[color:var(--color-accent)]">{localize(locale, "已连接", "Connected")}</span>;
    case "error":
      return <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium status-error">{localize(locale, "错误", "Error")}</span>;
    case "disconnected":
      return <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium status-warning">{localize(locale, "已断开", "Disconnected")}</span>;
    default:
      return <span className="inline-flex items-center gap-1 rounded-full bg-[color:var(--color-bg-subtle)] px-2 py-0.5 text-xs font-medium text-[color:var(--color-text-tertiary)]">{localize(locale, "未知", "Unknown")}</span>;
  }
}

export function McpPage() {
  const { data: servers = [], isLoading, isError } = useMcpServers();
  const { locale } = useAppLocale();

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-[color:var(--color-text-primary)]">
          {localize(locale, "MCP 服务器", "MCP Servers")}
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">
          {localize(
            locale,
            "管理连接到 Friday 的 Model Context Protocol 服务器。MCP 服务器通过外部工具、资源和提示扩展 agent 能力。",
            "Manage Model Context Protocol servers connected to Friday. MCP servers extend agent capabilities with external tools, resources, and prompts.",
          )}
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <SkeletonCard lines={2} />
          <SkeletonCard lines={2} />
        </div>
      ) : isError ? (
        <div className="rounded-xl border border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] p-8 text-center">
          <p className="text-sm font-medium status-error">{localize(locale, "加载 MCP 服务器状态失败", "Failed to load MCP server status")}</p>
          <p className="mt-1 text-xs text-[color:var(--color-text-tertiary)]">{localize(locale, "请检查 Friday 服务器是否运行中，然后刷新页面。", "Check that the Friday server is running and try refreshing the page.")}</p>
        </div>
      ) : servers.length === 0 ? (
        <div className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-8 text-center">
          <p className="text-sm font-medium text-[color:var(--color-text-primary)]">{localize(locale, "暂无 MCP 服务器", "No MCP servers configured")}</p>
          <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">
            {localize(
              locale,
              "通过 FRIDAY_MCP_SERVERS 环境变量或深度链接导入来添加 MCP 服务器。",
              "Add MCP servers via the FRIDAY_MCP_SERVERS environment variable or through a deep link import.",
            )}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {servers.map((server) => (
            <div
              key={server.id}
              className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4 transition-all hover:border-[color:var(--color-border-strong)] hover:shadow-[var(--shadow-floating)]"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent)]">
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 0 1-3-3m3 3a3 3 0 1 0 0 6h13.5a3 3 0 1 0 0-6m-16.5-3a3 3 0 0 1 3-3h13.5a3 3 0 0 1 3 3m-19.5 0a4.5 4.5 0 0 1 .9-2.7L5.737 5.1a3.375 3.375 0 0 1 2.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 0 1 .9 2.7m0 0a3 3 0 0 1-3 3m0 3h.008v.008h-.008v-.008Zm0-6h.008v.008h-.008v-.008Zm-3 6h.008v.008h-.008v-.008Zm0-6h.008v.008h-.008v-.008Z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-[color:var(--color-text-primary)]">{server.id}</p>
                    <p className="text-xs text-[color:var(--color-text-secondary)]">
                      {server.transport ?? "stdio"}
                      {server.toolCount != null ? ` · ${String(server.toolCount)} ${localize(locale, "个工具", "tools")}` : ""}
                      {server.resourceCount != null ? ` · ${String(server.resourceCount)} ${localize(locale, "个资源", "resources")}` : ""}
                    </p>
                  </div>
                </div>
                {statusBadge(server.status, locale)}
              </div>
              {server.lastError ? (
                <p className="mt-2 rounded-lg bg-[color:var(--color-bg-contrast)] p-2 text-xs status-error">
                  {server.lastError}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <div className="mt-8 rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4">
        <h2 className="text-sm font-medium text-[color:var(--color-text-primary)]">{localize(locale, "配置说明", "Configuration")}</h2>
        <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">
          {localize(
            locale,
            "MCP 服务器通过 FRIDAY_MCP_SERVERS 环境变量配置，格式为 JSON 数组。每个服务器条目指定传输类型（stdio、sse 或 streamable-http）和对应的连接参数。",
            "MCP servers are configured through the FRIDAY_MCP_SERVERS environment variable as a JSON array. Each server entry specifies a transport type (stdio, sse, or streamable-http) and the corresponding connection parameters.",
          )}
        </p>
      </div>
    </div>
  );
}
