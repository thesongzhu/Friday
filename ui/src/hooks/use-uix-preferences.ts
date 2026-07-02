import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { uixPreferencesApi, type UixPreferenceRecord } from "@/lib/api/uix-preferences";

const UIX_PREFERENCES_QUERY_KEY = ["uix", "preferences", "uix"] as const;
const UIX_PREFERENCES_STORAGE_KEY = "friday.uix.preferences.v1";

type UixPreferenceMap = Record<string, unknown>;

const EMPTY_RECORDS: UixPreferenceRecord[] = [];

function readFallbackPreferences(): UixPreferenceMap {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(UIX_PREFERENCES_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as UixPreferenceMap) : {};
  } catch {
    return {};
  }
}

function writeFallbackPreferences(data: UixPreferenceMap): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(UIX_PREFERENCES_STORAGE_KEY, JSON.stringify(data));
  }
}

function mapRecordsToValues(items: UixPreferenceRecord[]): UixPreferenceMap {
  return items.reduce<UixPreferenceMap>((result, item) => {
    result[item.key] = item.value;
    return result;
  }, {});
}

function mergePreferenceMaps(current: UixPreferenceMap, patch: UixPreferenceMap): UixPreferenceMap {
  return {
    ...current,
    ...patch,
  };
}

export interface UseUixPreferencesResult {
  values: UixPreferenceMap;
  isLoading: boolean;
  setPreference: (key: string, value: unknown) => void;
  setPreferences: (patch: UixPreferenceMap) => void;
}

export function useUixPreferences(): UseUixPreferencesResult {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const pendingPatchRef = useRef<UixPreferenceMap>({});
  const flushTimerRef = useRef<number | null>(null);
  const isAuthenticatedRef = useRef(isAuthenticated);
  isAuthenticatedRef.current = isAuthenticated;

  const preferencesQuery = useQuery({
    queryKey: UIX_PREFERENCES_QUERY_KEY,
    queryFn: async () => {
      try {
        return await uixPreferencesApi.list();
      } catch {
        return EMPTY_RECORDS;
      }
    },
    enabled: isAuthenticated && !authLoading,
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const values = useMemo<UixPreferenceMap>(() => {
    const remoteValues = mapRecordsToValues(preferencesQuery.data ?? []);
    return mergePreferenceMaps(readFallbackPreferences(), remoteValues);
  }, [preferencesQuery.data]);

  const flushPendingPreferences = useCallback(async () => {
    const patch = pendingPatchRef.current;
    pendingPatchRef.current = {};
    const entries = Object.entries(patch);
    if (entries.length === 0 || !isAuthenticatedRef.current) {
      return;
    }
    try {
      await uixPreferencesApi.update(
        entries.map(([key, value]) => ({
          category: "uix" as const,
          key,
          value,
        })),
      );
    } catch {
      // Local fallback already applied.
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    if (typeof window === "undefined" || flushTimerRef.current !== null) {
      return;
    }
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      void flushPendingPreferences();
    }, 240);
  }, [flushPendingPreferences]);

  useEffect(() => () => {
    if (flushTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  // Use refs for the write path so setPreferences/setPreference are stable across renders.
  const queryDataRef = useRef(preferencesQuery.data);
  queryDataRef.current = preferencesQuery.data;
  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;
  const scheduleFlushRef = useRef(scheduleFlush);
  scheduleFlushRef.current = scheduleFlush;

  const setPreferences = useCallback((patch: UixPreferenceMap) => {
    const current = mergePreferenceMaps(readFallbackPreferences(), mapRecordsToValues(queryDataRef.current ?? []));
    const next = mergePreferenceMaps(current, patch);
    writeFallbackPreferences(next);

    queryClientRef.current.setQueryData<UixPreferenceRecord[]>(
      UIX_PREFERENCES_QUERY_KEY,
      (existing = []) => {
        const byKey = new Map(existing.map((item) => [item.key, item] as const));
        for (const [key, value] of Object.entries(patch)) {
          const currentRecord = byKey.get(key);
          byKey.set(key, {
            id: currentRecord?.id ?? `local-${key}`,
            category: "uix",
            key,
            value,
            createdAt: currentRecord?.createdAt,
            updatedAt: new Date().toISOString(),
          });
        }
        return [...byKey.values()];
      },
    );

    pendingPatchRef.current = mergePreferenceMaps(pendingPatchRef.current, patch);
    scheduleFlushRef.current();
  }, []);

  const setPreference = useCallback((key: string, value: unknown) => {
    setPreferences({ [key]: value });
  }, [setPreferences]);

  return useMemo(() => ({
    values,
    isLoading: preferencesQuery.isLoading,
    setPreference,
    setPreferences,
  }), [preferencesQuery.isLoading, values]);
}
