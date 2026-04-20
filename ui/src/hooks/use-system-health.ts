import { useQuery } from "@tanstack/react-query";
import { healthApi } from "@/lib/api/health";

export type SystemHealthStatus = "healthy" | "degraded" | "offline";

/**
 * Collapses the full health response into a single shell indicator:
 *   healthy  — every reachable provider reports healthy
 *   degraded — at least one provider is degraded / in safe mode
 *   offline  — request failed or capability status is "unavailable"
 */
export function useSystemHealthQuery() {
  return useQuery({
    queryKey: ["shell", "system-health"],
    queryFn: async (): Promise<{ status: SystemHealthStatus; raw: unknown }> => {
      try {
        const raw = await healthApi.getCapabilityHealth();
        const capability = (raw as { capabilities?: { system?: { healthStatus?: string } } }).capabilities;
        const reported = capability?.system?.healthStatus;
        if (reported === "unavailable") {
          return { status: "offline", raw };
        }
        if (reported === "degraded" || reported === "safe_mode") {
          return { status: "degraded", raw };
        }
        return { status: "healthy", raw };
      } catch (error) {
        return { status: "offline", raw: error };
      }
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}
