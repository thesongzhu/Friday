import { useCallback, useMemo } from "react";
import type { UserProfileType } from "@/hooks/use-user-profile";
import { getDefaultPinnedPackIds, getDefaultVisibleWidgets, getDefaultWidgetOrder, sortPacksByStoredOrder, type HomeWidgetId } from "@/lib/packs/pack-registry";
import { useUixPreferences } from "@/hooks/use-uix-preferences";

function moveItem<T>(items: T[], item: T, direction: "up" | "down"): T[] {
  const currentIndex = items.indexOf(item);
  if (currentIndex < 0) {
    return items;
  }
  const nextIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
  if (nextIndex < 0 || nextIndex >= items.length) {
    return items;
  }
  const result = [...items];
  const [removed] = result.splice(currentIndex, 1);
  result.splice(nextIndex, 0, removed);
  return result;
}

function asStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}

function asWidgetArray(value: unknown): HomeWidgetId[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value as HomeWidgetId[]
    : null;
}

export interface UseHomeSurfacePreferencesResult {
  pinnedPackIds: string[];
  widgetOrder: HomeWidgetId[];
  visibleWidgets: HomeWidgetId[];
  pinPack: (packId: string) => void;
  unpinPack: (packId: string) => void;
  movePack: (packId: string, direction: "up" | "down") => void;
  moveWidget: (widgetId: HomeWidgetId, direction: "up" | "down") => void;
  toggleWidget: (widgetId: HomeWidgetId) => void;
  rememberPrimarySurface: (surface: "home" | "chat" | "packs" | "assistant") => void;
  lastPrimarySurface: "home" | "chat" | "packs" | "assistant" | null;
}

export function useHomeSurfacePreferences(profileType: UserProfileType): UseHomeSurfacePreferencesResult {
  const { values, setPreferences, setPreference } = useUixPreferences();
  const defaultPinnedPackIds = getDefaultPinnedPackIds(profileType);
  const storedPinnedPackIds = asStringArray(values["home.pinnedPackIds"]) ?? defaultPinnedPackIds;
  const storedPackOrder = asStringArray(values["home.packOrder"]) ?? storedPinnedPackIds;
  const storedWidgetOrder = asWidgetArray(values["home.widgetOrder"]) ?? getDefaultWidgetOrder();
  const storedVisibleWidgets = asWidgetArray(values["home.visibleWidgets"]) ?? getDefaultVisibleWidgets();

  const pinnedPackIds = useMemo(
    () => sortPacksByStoredOrder(storedPinnedPackIds, storedPackOrder),
    [storedPackOrder, storedPinnedPackIds],
  );

  const pinPack = useCallback((packId: string) => {
    if (storedPinnedPackIds.includes(packId)) {
      return;
    }
    const next = [...storedPinnedPackIds, packId];
    setPreferences({
      "home.pinnedPackIds": next,
      "home.packOrder": next,
    });
  }, [setPreferences, storedPinnedPackIds]);

  const unpinPack = useCallback((packId: string) => {
    const next = storedPinnedPackIds.filter((id) => id !== packId);
    setPreferences({
      "home.pinnedPackIds": next,
      "home.packOrder": storedPackOrder.filter((id) => id !== packId),
    });
  }, [setPreferences, storedPackOrder, storedPinnedPackIds]);

  const movePack = useCallback((packId: string, direction: "up" | "down") => {
    const nextOrder = moveItem(pinnedPackIds, packId, direction);
    setPreferences({
      "home.pinnedPackIds": nextOrder,
      "home.packOrder": nextOrder,
    });
  }, [pinnedPackIds, setPreferences]);

  const moveWidget = useCallback((widgetId: HomeWidgetId, direction: "up" | "down") => {
    setPreference("home.widgetOrder", moveItem(storedWidgetOrder, widgetId, direction));
  }, [setPreference, storedWidgetOrder]);

  const toggleWidget = useCallback((widgetId: HomeWidgetId) => {
    const nextVisibleWidgets = storedVisibleWidgets.includes(widgetId)
      ? storedVisibleWidgets.filter((item) => item !== widgetId)
      : [...storedVisibleWidgets, widgetId];
    setPreference("home.visibleWidgets", nextVisibleWidgets);
  }, [setPreference, storedVisibleWidgets]);

  const rememberPrimarySurface = useCallback((surface: "home" | "chat" | "packs" | "assistant") => {
    setPreference("navigation.lastPrimarySurface", surface);
  }, [setPreference]);

  const lastPrimarySurface = values["navigation.lastPrimarySurface"];

  return useMemo(() => ({
    pinnedPackIds,
    widgetOrder: storedWidgetOrder,
    visibleWidgets: storedVisibleWidgets,
    pinPack,
    unpinPack,
    movePack,
    moveWidget,
    toggleWidget,
    rememberPrimarySurface,
    lastPrimarySurface:
      lastPrimarySurface === "home"
      || lastPrimarySurface === "chat"
      || lastPrimarySurface === "packs"
      || lastPrimarySurface === "assistant"
        ? lastPrimarySurface
        : null,
  }), [
    pinnedPackIds,
    storedWidgetOrder,
    storedVisibleWidgets,
    pinPack,
    unpinPack,
    movePack,
    moveWidget,
    toggleWidget,
    rememberPrimarySurface,
    lastPrimarySurface,
  ]);
}
