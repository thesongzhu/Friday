import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { setupApi } from "@/lib/api/setup";
import { shouldRetryQuery } from "@/providers/query-provider";

export const setupKeys = {
  all: ["setup"] as const,
  status: () => [...setupKeys.all, "status"] as const,
  network: () => [...setupKeys.all, "network"] as const,
};

export function useSetupStatusQuery() {
  return useQuery({
    queryKey: setupKeys.status(),
    queryFn: () => setupApi.getStatus(),
    staleTime: 5_000,
    refetchOnMount: "always",
    retry: shouldRetryQuery,
  });
}

export function useNetworkQuery() {
  return useQuery({
    queryKey: setupKeys.network(),
    queryFn: () => setupApi.getNetwork(),
    staleTime: 60_000,
  });
}

export function useSaveNetworkMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: setupApi.saveNetwork,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: setupKeys.network() });
    },
  });
}

export function useSaveChannelsMutation() {
  return useMutation({
    mutationFn: setupApi.saveChannels,
  });
}

export function useCompleteSetupMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: setupApi.completeSetup,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: setupKeys.status() });
    },
  });
}

export function useDetectProviderMutation() {
  return useMutation({
    mutationFn: setupApi.detectProvider,
  });
}
