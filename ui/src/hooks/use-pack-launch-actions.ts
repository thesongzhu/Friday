import { useCallback, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAppNavigate } from "@/hooks/use-app-navigate";
import { agentApi } from "@/lib/api/agent";
import type { AgentRunRecord } from "@/lib/api/types";
import { localize } from "@/lib/i18n/localized-text";
import {
  buildAgentRunHref,
  buildCustomPackDisplayTask,
  buildCustomPackAdjustPrompt,
  buildCustomPackStartTask,
  findCustomPackInputByPackId,
  isCustomPackDefinition,
} from "@/lib/packs/custom-pack-runtime";
import { buildPackAssistantHref, buildPackChatHref, buildPackFlowHref } from "@/lib/packs/pack-links";
import type { CustomPackInput, FridayPackDefinition } from "@/lib/packs/pack-registry";
import { useAppLocale } from "@/providers/locale-provider";

export interface UsePackLaunchActionsOptions {
  surface: "packs" | "home" | "chat";
}

function createPackStartIdempotencyKey(packId: string): string {
  const normalizedPackId = encodeURIComponent(packId)
    .replace(/%/g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .slice(0, 120);
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `pack-start:${normalizedPackId}:${crypto.randomUUID()}`;
  }
  return `pack-start:${normalizedPackId}:${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function usePackLaunchActions(
  customPackInputs: CustomPackInput[],
  options: UsePackLaunchActionsOptions,
) {
  const navigate = useAppNavigate();
  const queryClient = useQueryClient();
  const { locale } = useAppLocale();
  const pendingCustomPackIdsRef = useRef(new Set<string>());

  const startCustomPackRun = useMutation({
    mutationFn: async (payload: { pack: FridayPackDefinition; idempotencyKey: string }) => {
      const { pack, idempotencyKey } = payload;
      const customPackInput = findCustomPackInputByPackId(customPackInputs, pack.id);
      if (!customPackInput) {
        throw new Error(localize(locale, "找不到这个自创任务的定义。", "Unable to find this custom pack definition."));
      }

      return agentApi.startRun({
        task: buildCustomPackDisplayTask(customPackInput, pack, locale),
        taskPrompt: buildCustomPackStartTask(customPackInput, pack, locale),
        idempotencyKey,
        executionContext: {
          surface: options.surface,
          interactive: true,
          packId: pack.id,
        },
      });
    },
    onSuccess: async () => {
      await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: ["packs", "recent-runs"] }),
        queryClient.invalidateQueries({ queryKey: ["assistant-inbox", "snapshot"] }),
      ]);
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : localize(locale, "无法启动这个自创任务。", "Failed to start this custom pack."),
      );
    },
  });

  const startPackNow = useCallback(async (pack: FridayPackDefinition) => {
    if (!isCustomPackDefinition(pack)) {
      navigate(buildPackFlowHref(pack));
      return;
    }

    if (pendingCustomPackIdsRef.current.has(pack.id)) {
      return;
    }

    pendingCustomPackIdsRef.current.add(pack.id);
    try {
      const result = await startCustomPackRun.mutateAsync({
        pack,
        idempotencyKey: createPackStartIdempotencyKey(pack.id),
      });
      navigate(buildAgentRunHref(result.runId));
    } finally {
      pendingCustomPackIdsRef.current.delete(pack.id);
    }
  }, [navigate, startCustomPackRun]);

  const adjustPackBeforeStart = useCallback((pack: FridayPackDefinition) => {
    if (!isCustomPackDefinition(pack)) {
      navigate(buildPackFlowHref(pack, { mode: "adjust" }));
      return;
    }

    const input = findCustomPackInputByPackId(customPackInputs, pack.id);
    if (!input) {
      toast.error(localize(locale, "找不到这个自创任务的定义。", "Unable to find this custom pack definition."));
      return;
    }

    navigate(buildPackChatHref(pack.id, buildCustomPackAdjustPrompt(input, pack, locale)));
  }, [customPackInputs, locale, navigate]);

  const continuePack = useCallback((pack: FridayPackDefinition, run?: AgentRunRecord | null) => {
    if (!isCustomPackDefinition(pack)) {
      navigate(buildPackFlowHref(pack));
      return;
    }

    if (run) {
      navigate(buildAgentRunHref(run.id));
      return;
    }

    const input = findCustomPackInputByPackId(customPackInputs, pack.id);
    if (!input) {
      toast.error(localize(locale, "找不到这个自创任务的定义。", "Unable to find this custom pack definition."));
      return;
    }

    navigate(buildPackChatHref(pack.id, buildCustomPackAdjustPrompt(input, pack, locale)));
  }, [customPackInputs, locale, navigate]);

  const openCurrentPackRun = useCallback((pack: FridayPackDefinition, run: AgentRunRecord) => {
    if (isCustomPackDefinition(pack)) {
      navigate(buildAgentRunHref(run.id));
      return;
    }

    navigate(buildPackAssistantHref(pack.id));
  }, [navigate]);

  return {
    startPackNow,
    adjustPackBeforeStart,
    continuePack,
    openCurrentPackRun,
    isStartingPack: startCustomPackRun.isPending,
  };
}
