import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Search, Tag, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ActionButton, ShellCard, StatusPill } from "@/components/core/primitives";
import { memoryApi } from "@/lib/api/memory";
import type { FridayMemoryItem } from "@/lib/api/types";

function formatTimestamp(value?: string): string {
  if (!value) return "Unknown";
  return new Date(value).toLocaleString();
}

function toneForNamespace(ns: string): "neutral" | "success" | "warning" {
  if (ns === "preference" || ns === "user") return "success";
  if (ns === "system" || ns === "agent") return "warning";
  return "neutral";
}

export function MemoryPage() {
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearch, setActiveSearch] = useState("");

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["memory", "items"],
    queryFn: () => memoryApi.listItems({ limit: 100 }),
  });

  const { data: searchResults } = useQuery({
    queryKey: ["memory", "search", activeSearch],
    queryFn: () => memoryApi.search({ query: activeSearch, limit: 20 }),
    enabled: activeSearch.length > 0,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => memoryApi.deleteItem(id),
    onSuccess: async () => {
      toast.success("Memory item deleted");
      await queryClient.invalidateQueries({ queryKey: ["memory"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to delete memory item");
    },
  });

  const pruneMutation = useMutation({
    mutationFn: () => memoryApi.prune({ expiredOnly: true }),
    onSuccess: async (result) => {
      toast.success(`Pruned ${String(result.deletedCount)} expired items`);
      await queryClient.invalidateQueries({ queryKey: ["memory"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to prune memory");
    },
  });

  const handleSearch = () => {
    setActiveSearch(searchQuery.trim());
  };

  const displayItems: FridayMemoryItem[] = activeSearch.length > 0
    ? (searchResults ?? []).map((r) => r.item)
    : items;

  return (
    <div className="space-y-4">
      <ShellCard eyebrow="Memory Store" title="Stored Knowledge">
        <div className="space-y-4">
          <p className="text-sm text-white/60">
            Friday remembers facts, preferences, and context across sessions.
            Items shown here are stored in the memory subsystem and used to personalize responses.
          </p>

          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" />
              <input
                type="text"
                placeholder="Search memories..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSearch();
                }}
                className="w-full rounded-2xl border border-white/10 bg-black/30 py-2 pl-10 pr-4 text-sm text-white placeholder:text-white/30 focus:border-white/20 focus:outline-none"
              />
            </div>
            <ActionButton onClick={handleSearch} disabled={searchQuery.trim().length === 0}>
              Search
            </ActionButton>
            {activeSearch.length > 0 && (
              <ActionButton
                tone="secondary"
                onClick={() => {
                  setSearchQuery("");
                  setActiveSearch("");
                }}
              >
                Clear
              </ActionButton>
            )}
          </div>

          <div className="flex items-center justify-between">
            <p className="text-xs text-white/40">
              {activeSearch
                ? `${String(displayItems.length)} results for "${activeSearch}"`
                : `${String(displayItems.length)} items total`}
            </p>
            <ActionButton tone="secondary" onClick={() => pruneMutation.mutate()} disabled={pruneMutation.isPending}>
              Prune Expired
            </ActionButton>
          </div>
        </div>
      </ShellCard>

      {isLoading ? (
        <ShellCard>
          <p className="text-sm text-white/60">Loading memories...</p>
        </ShellCard>
      ) : displayItems.length === 0 ? (
        <ShellCard>
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <Brain className="h-8 w-8 text-white/20" />
            <p className="text-sm text-white/50">
              {activeSearch ? "No memories match your search." : "No memories stored yet. Friday will learn as you interact."}
            </p>
          </div>
        </ShellCard>
      ) : (
        <div className="space-y-3">
          {displayItems.map((item) => (
            <ShellCard key={item.id}>
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill tone={toneForNamespace(item.namespace)}>{item.namespace}</StatusPill>
                      {item.source ? <StatusPill>{item.source}</StatusPill> : null}
                      {item.expiresAt ? (
                        <span className="text-xs text-white/30">
                          expires {formatTimestamp(item.expiresAt)}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-2 text-sm font-medium text-white">{item.key}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => deleteMutation.mutate(item.id)}
                    disabled={deleteMutation.isPending}
                    className="shrink-0 rounded-xl p-2 text-white/30 transition-colors hover:bg-red-500/10 hover:text-red-400"
                    title="Delete this memory"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                <p className="whitespace-pre-wrap text-sm text-white/70">{item.content}</p>

                {item.tags.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Tag className="h-3 w-3 text-white/20" />
                    {item.tags.map((tag) => (
                      <span key={tag} className="rounded-full bg-white/5 px-2 py-0.5 text-xs text-white/40">
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}

                <p className="text-xs text-white/30">
                  Created {formatTimestamp(item.createdAt)}
                  {item.updatedAt !== item.createdAt ? ` · Updated ${formatTimestamp(item.updatedAt)}` : ""}
                </p>
              </div>
            </ShellCard>
          ))}
        </div>
      )}
    </div>
  );
}
