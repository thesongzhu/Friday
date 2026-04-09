import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { crossBorderPackApi } from "@/lib/api/cross-border-pack";
import { localize } from "@/lib/i18n/localized-text";
import { persistCrossBorderAssistantNavigationSnapshot } from "@/lib/packs/cross-border-snapshot";
import { useAppLocale } from "@/providers/locale-provider";
import type { FridayCrossBorderSnapshot, FridayCrossBorderWorkflowId } from "../../../src/packs/cross-border/friday-cross-border-pack.types";

function resolveBrowserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function useCrossBorderWorkflowPresets() {
  const queryClient = useQueryClient();
  const { locale } = useAppLocale();

  const syncSnapshotCaches = (snapshot: FridayCrossBorderSnapshot) => {
    queryClient.setQueryData(["cross-border-pack", "snapshot"], snapshot);
    queryClient.setQueryData(["cross-border-pack", "snapshot", "home"], snapshot);
    persistCrossBorderAssistantNavigationSnapshot(snapshot);
  };

  const applyMutation = useMutation({
    mutationFn: async (workflowIds?: FridayCrossBorderWorkflowId[]) =>
      crossBorderPackApi.applyWorkflowPreset({
        workflowIds,
        timezone: resolveBrowserTimezone(),
      }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["cross-border-pack"] });
    },
    onSuccess: async (snapshot) => {
      syncSnapshotCaches(snapshot);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["home", "snapshot", "task-first"] }),
        queryClient.invalidateQueries({ queryKey: ["assistant-inbox", "snapshot"] }),
      ]);
      toast.success(localize(locale, "默认稳定流程已启用。", "Default stable workflows are now enabled."));
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "启用默认流程失败", "Failed to enable the default workflows"));
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async (input: { workflowId: FridayCrossBorderWorkflowId; enabled: boolean }) =>
      crossBorderPackApi.setWorkflowPresetEnabled(input.workflowId, {
        enabled: input.enabled,
        ...(input.enabled ? { timezone: resolveBrowserTimezone() } : {}),
      }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["cross-border-pack"] });
    },
    onSuccess: async (_snapshot, variables) => {
      syncSnapshotCaches(_snapshot);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["home", "snapshot", "task-first"] }),
        queryClient.invalidateQueries({ queryKey: ["assistant-inbox", "snapshot"] }),
      ]);
      toast.success(
        variables.enabled
          ? localize(locale, "流程已恢复自动运行。", "The workflow automation has resumed.")
          : localize(locale, "流程已暂停自动运行。", "The workflow automation has been paused."),
      );
    },
    onError: (error, variables) => {
      toast.error(
        error instanceof Error
          ? error.message
          : variables.enabled
            ? localize(locale, "恢复流程失败", "Failed to resume the workflow")
            : localize(locale, "暂停流程失败", "Failed to pause the workflow"),
      );
    },
  });

  return {
    applyDefaultWorkflows: (workflowIds?: FridayCrossBorderWorkflowId[]) => applyMutation.mutate(workflowIds),
    setWorkflowEnabled: (workflowId: FridayCrossBorderWorkflowId, enabled: boolean) =>
      toggleMutation.mutate({ workflowId, enabled }),
    isApplyingDefaultWorkflows: applyMutation.isPending,
    togglingWorkflowId: toggleMutation.variables?.workflowId ?? null,
  };
}
