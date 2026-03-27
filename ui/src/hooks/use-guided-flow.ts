import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { systemApi } from "@/lib/api/system";
import type { FridayGuidedWizardState, FridayUixWizardResponse } from "@/lib/api/system-types";

export interface UseGuidedFlowOptions {
  wizardId: string;
  assistantSessionKey?: string;
  enabled?: boolean;
}

export interface UseGuidedFlowResult {
  wizard: FridayGuidedWizardState | null;
  wizardResponse: FridayUixWizardResponse | null;
  isLoading: boolean;
  isStarting: boolean;
  isContinuing: boolean;
  error: Error | null;
  start: () => void;
  continueStep: (values: Record<string, unknown>) => void;
  cancel: () => void;
  reset: () => void;
}

export function useGuidedFlow(options: UseGuidedFlowOptions): UseGuidedFlowResult {
  const { wizardId, assistantSessionKey, enabled = true } = options;
  const queryClient = useQueryClient();
  const [activeContextId, setActiveContextId] = useState<string | null>(null);
  const [wizardState, setWizardState] = useState<FridayGuidedWizardState | null>(null);
  const [wizardResponse, setWizardResponse] = useState<FridayUixWizardResponse | null>(null);
  const [cancelled, setCancelled] = useState(false);

  const startMutation = useMutation({
    mutationFn: async () => {
      return systemApi.startAssistantWizard(wizardId, assistantSessionKey);
    },
    onSuccess: (wizard) => {
      setWizardState(wizard);
      setActiveContextId(wizard.contextId);
      setCancelled(false);
    },
  });

  const continueMutation = useMutation({
    mutationFn: async (values: Record<string, unknown>) => {
      if (!activeContextId) {
        throw new Error("No active wizard context");
      }
      return systemApi.continueAssistantWizard({
        wizardId,
        contextId: activeContextId,
        values,
        assistantSessionKey,
      });
    },
    onSuccess: (response) => {
      setWizardState(response.wizard);
      setWizardResponse(response);
    },
  });

  const start = useCallback(() => {
    if (enabled && !startMutation.isPending) {
      startMutation.mutate();
    }
  }, [enabled, startMutation]);

  const continueStep = useCallback(
    (values: Record<string, unknown>) => {
      if (!continueMutation.isPending && activeContextId) {
        continueMutation.mutate(values);
      }
    },
    [continueMutation, activeContextId],
  );

  const cancel = useCallback(() => {
    setCancelled(true);
    setWizardState(null);
    setWizardResponse(null);
    setActiveContextId(null);
  }, []);

  const reset = useCallback(() => {
    setCancelled(false);
    setWizardState(null);
    setWizardResponse(null);
    setActiveContextId(null);
    startMutation.reset();
    continueMutation.reset();
  }, [startMutation, continueMutation]);

  return useMemo(
    () => ({
      wizard: cancelled ? null : wizardState,
      wizardResponse: cancelled ? null : wizardResponse,
      isLoading: startMutation.isPending || continueMutation.isPending,
      isStarting: startMutation.isPending,
      isContinuing: continueMutation.isPending,
      error: startMutation.error ?? continueMutation.error ?? null,
      start,
      continueStep,
      cancel,
      reset,
    }),
    [
      cancelled,
      wizardState,
      wizardResponse,
      startMutation.isPending,
      startMutation.error,
      continueMutation.isPending,
      continueMutation.error,
      start,
      continueStep,
      cancel,
      reset,
    ],
  );
}
