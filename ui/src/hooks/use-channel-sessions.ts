import { useQuery } from "@tanstack/react-query";
import { channelsApi } from "@/lib/api/channels";
import { sessionsApi } from "@/lib/api/sessions";
import type { ChannelRegistryView, FridaySessionRecord, FridaySessionMessageRecord } from "@/lib/api/types";

// ─── Channel overview: connected channels + their sessions ───

export function useChannelRegistryQuery() {
  return useQuery<ChannelRegistryView[]>({
    queryKey: ["channels", "registry"],
    queryFn: async () => {
      const data = await channelsApi.list();
      return data;
    },
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}

export function useChannelSessionsQuery(channel?: string) {
  return useQuery<FridaySessionRecord[]>({
    queryKey: ["channels", "sessions", channel ?? "all"],
    queryFn: async () => {
      const sessions = await sessionsApi.list({
        channel: channel || undefined,
        limit: 100,
      });
      // Sort by most recent activity
      return sessions.sort((a, b) => {
        const aTime = a.lastActivityAt ?? a.updatedAt;
        const bTime = b.lastActivityAt ?? b.updatedAt;
        return bTime.localeCompare(aTime);
      });
    },
    staleTime: 5_000,
    refetchInterval: 5_000,
    enabled: true,
  });
}

export function useSessionMessagesQuery(sessionKey: string | null) {
  return useQuery<FridaySessionMessageRecord[]>({
    queryKey: ["channels", "session-messages", sessionKey],
    queryFn: async () => {
      if (!sessionKey) return [];
      return sessionsApi.listMessages(sessionKey, { limit: 100 });
    },
    staleTime: 3_000,
    refetchInterval: 3_000,
    enabled: !!sessionKey,
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
