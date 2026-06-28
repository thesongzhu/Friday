import { useQuery } from "@tanstack/react-query";
import { healthApi } from "@/lib/api/health";

export type SystemHealthStatus = "healthy" | "degraded" | "unavailable" | "offline";

/**
 * Collapses the full health response into a single shell indicator:
 *   healthy  — every reachable provider reports healthy
 *   degraded    — at least one provider is degraded / in safe mode
 *   unavailable — the Hub responded, but the capability surface is not ready
 *   offline     — request failed or the Hub cannot be reached
 */
export async function loadSystemHealth(): Promise<{ status: SystemHealthStatus; raw: unknown }> {
  try {
    const raw = await healthApi.getCapabilityHealth();
    const capability = (raw as { capabilities?: { system?: { healthStatus?: string } } }).capabilities;
    const reported = capability?.system?.healthStatus;
    if (reported === "unavailable") {
      return { status: "unavailable", raw };
    }
    if (reported === "degraded" || reported === "safe_mode") {
      return { status: "degraded", raw };
    }
    return { status: "healthy", raw };
  } catch (error) {
    return { status: "offline", raw: error };
  }
}

export function useSystemHealthQuery() {
  return useQuery({
    queryKey: ["shell", "system-health"],
    queryFn: loadSystemHealth,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}
