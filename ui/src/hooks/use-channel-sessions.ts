import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { channelsApi } from "@/lib/api/channels";
import { sessionsApi } from "@/lib/api/sessions";
import type { ChannelRegistryView, FridaySessionRecord, FridaySessionMessageRecord } from "@/lib/api/types";

// ─── Channel overview: connected channels + their sessions ───

export function useChannelRegistryQuery() {
  const { isAuthenticated, isLoading } = useAuth();
  return useQuery<ChannelRegistryView[]>({
    queryKey: ["channels", "registry"],
    queryFn: async () => {
      const data = await channelsApi.list();
      return data;
    },
    staleTime: 10_000,
    refetchInterval: 15_000,
    enabled: isAuthenticated && !isLoading,
  });
}

export function useChannelSessionsQuery(channel?: string | string[]) {
  const { isAuthenticated, isLoading } = useAuth();
  const requestedKinds = Array.isArray(channel)
    ? Array.from(new Set(channel.map((item) => item.trim()).filter((item) => item.length > 0)))
    : typeof channel === "string" && channel.trim().length > 0
      ? [channel.trim()]
      : [];
  const queryKeySuffix = requestedKinds.length === 0 ? "all" : requestedKinds.join(",");
  return useQuery<FridaySessionRecord[]>({
    queryKey: ["channels", "sessions", queryKeySuffix],
    queryFn: async () => {
      const sessions = requestedKinds.length <= 1
        ? await sessionsApi.list({
          channel: requestedKinds[0],
          limit: 100,
        })
        : (await Promise.all(
          requestedKinds.map((kind) => sessionsApi.list({
            channel: kind,
            limit: 100,
          })),
        )).flat();
      const deduped = new Map<string, FridaySessionRecord>();
      for (const session of sessions) {
        deduped.set(session.key, session);
      }
      // Sort by most recent activity
      return Array.from(deduped.values()).sort((a, b) => {
        const aTime = a.lastActivityAt ?? a.updatedAt;
        const bTime = b.lastActivityAt ?? b.updatedAt;
        return bTime.localeCompare(aTime);
      });
    },
    staleTime: 5_000,
    refetchInterval: 5_000,
    enabled: isAuthenticated && !isLoading,
  });
}

export function useSessionMessagesQuery(sessionKey: string | null) {
  const { isAuthenticated, isLoading } = useAuth();
  return useQuery<FridaySessionMessageRecord[]>({
    queryKey: ["channels", "session-messages", sessionKey],
    queryFn: async () => {
      if (!sessionKey) return [];
      return sessionsApi.listMessages(sessionKey, { limit: 100 });
    },
    staleTime: 3_000,
    refetchInterval: 3_000,
    enabled: isAuthenticated && !isLoading && !!sessionKey,
  });
}

// ─── Helpers ───

export function getSessionChannelKind(session: FridaySessionRecord): string {
  return session.channel || "unknown";
}

export function getSessionDisplayName(session: FridaySessionRecord): string {
  const meta = session.metadata as Record<string, string> | undefined;
  if (meta?.senderName) return meta.senderName;
  if (session.userId) return session.userId;
  if (session.chatId) return session.chatId;
  return session.key;
}

export function groupSessionsByChannel(sessions: FridaySessionRecord[]): Map<string, FridaySessionRecord[]> {
  const groups = new Map<string, FridaySessionRecord[]>();
  for (const session of sessions) {
    const channel = getSessionChannelKind(session);
    const list = groups.get(channel) ?? [];
    list.push(session);
    groups.set(channel, list);
  }
  return groups;
}
