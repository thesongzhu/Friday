import { useCallback, useEffect, useMemo, useRef } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useUixPreferences } from "@/hooks/use-uix-preferences";
import {
  loadCustomPackInputs,
  normalizeCustomPackInputs,
  writeCustomPackInputsToStorage,
  type CustomPackInput,
} from "@/lib/packs/pack-registry";

const CUSTOM_PACKS_PREFERENCE_KEY = "packs.customInputs";

export interface UseCustomPacksResult {
  customPackInputs: CustomPackInput[];
  createCustomPack: (input: CustomPackInput) => void;
  removeCustomPack: (index: number) => void;
}

export function useCustomPacks(): UseCustomPacksResult {
  const { isAuthenticated } = useAuth();
  const { values, isLoading, setPreference } = useUixPreferences();
  const migratedLegacyRef = useRef(false);

  const remoteInputs = useMemo(
    () => normalizeCustomPackInputs(values[CUSTOM_PACKS_PREFERENCE_KEY]),
    [values],
  );
  const legacyInputs = useMemo(() => loadCustomPackInputs(), [remoteInputs]);
  const customPackInputs = isAuthenticated && !isLoading
    ? remoteInputs
    : legacyInputs;

  useEffect(() => {
    writeCustomPackInputsToStorage(customPackInputs);
  }, [customPackInputs]);

  useEffect(() => {
    if (!isAuthenticated || isLoading || migratedLegacyRef.current) {
      return;
    }
    if (remoteInputs.length > 0 || legacyInputs.length === 0) {
      migratedLegacyRef.current = true;
      return;
    }
    migratedLegacyRef.current = true;
    setPreference(CUSTOM_PACKS_PREFERENCE_KEY, legacyInputs);
  }, [isAuthenticated, isLoading, legacyInputs, remoteInputs, setPreference]);

  const createCustomPack = useCallback((input: CustomPackInput) => {
    const next = [...customPackInputs, input];
    writeCustomPackInputsToStorage(next);
    setPreference(CUSTOM_PACKS_PREFERENCE_KEY, next);
  }, [customPackInputs, setPreference]);

  const removeCustomPack = useCallback((index: number) => {
    const next = customPackInputs.filter((_, currentIndex) => currentIndex !== index);
    writeCustomPackInputsToStorage(next);
    setPreference(CUSTOM_PACKS_PREFERENCE_KEY, next);
  }, [customPackInputs, setPreference]);

  return {
    customPackInputs,
    createCustomPack,
    removeCustomPack,
  };
}
