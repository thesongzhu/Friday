import { useQuery } from "@tanstack/react-query";
import { sessionsApi } from "@/lib/api/sessions";

export function useRecentSessionsQuery(limit = 5) {
  return useQuery({
    queryKey: ["shell", "recent-sessions", limit],
    queryFn: async () => {
      try {
        return await sessionsApi.list({ limit });
      } catch {
        return [];
      }
    },
    staleTime: 30_000,
  });
}
