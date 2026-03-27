import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export type UserProfileType = "beginner" | "developer" | "creator" | "business";

interface UserProfileResponse {
  profileType: UserProfileType | null;
  onboardedAt: string | null;
}

const USER_PROFILE_KEY = ["uix", "user-profile"] as const;

const FALLBACK_STORAGE_KEY = "friday.uix.user-profile";

function readFallbackProfile(): UserProfileResponse {
  if (typeof window === "undefined") {
    return { profileType: null, onboardedAt: null };
  }
  try {
    const raw = window.localStorage.getItem(FALLBACK_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as UserProfileResponse) : { profileType: null, onboardedAt: null };
  } catch {
    return { profileType: null, onboardedAt: null };
  }
}

function writeFallbackProfile(data: UserProfileResponse) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(data));
  }
}

export interface UseUserProfileResult {
  profileType: UserProfileType;
  isFirstVisit: boolean;
  isLoading: boolean;
  setProfileType: (type: UserProfileType) => void;
  markOnboarded: () => void;
}

export function useUserProfile(): UseUserProfileResult {
  const queryClient = useQueryClient();

  const profileQuery = useQuery({
    queryKey: USER_PROFILE_KEY,
    queryFn: async (): Promise<UserProfileResponse> => {
      try {
        return await apiClient.get<UserProfileResponse>("/v1/uix/user-profile");
      } catch {
        return readFallbackProfile();
      }
    },
    staleTime: 60_000,
  });

  const updateMutation = useMutation({
    mutationFn: async (input: Partial<UserProfileResponse>) => {
      try {
        await apiClient.put<Partial<UserProfileResponse>, UserProfileResponse>("/v1/uix/user-profile", input);
      } catch {
        // Fallback to localStorage if endpoint not yet available
        const current = readFallbackProfile();
        const updated = { ...current, ...input };
        writeFallbackProfile(updated);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: USER_PROFILE_KEY });
    },
  });

  const profileType = profileQuery.data?.profileType ?? readFallbackProfile().profileType ?? "beginner";
  const onboardedAt = profileQuery.data?.onboardedAt ?? readFallbackProfile().onboardedAt;

  const setProfileType = useCallback(
    (type: UserProfileType) => {
      writeFallbackProfile({ profileType: type, onboardedAt: readFallbackProfile().onboardedAt });
      updateMutation.mutate({ profileType: type });
    },
    [updateMutation],
  );

  const markOnboarded = useCallback(() => {
    const now = new Date().toISOString();
    const current = readFallbackProfile();
    writeFallbackProfile({ ...current, onboardedAt: now });
    updateMutation.mutate({ onboardedAt: now });
  }, [updateMutation]);

  return useMemo(
    () => ({
      profileType: profileType as UserProfileType,
      isFirstVisit: !onboardedAt,
      isLoading: profileQuery.isLoading,
      setProfileType,
      markOnboarded,
    }),
    [profileType, onboardedAt, profileQuery.isLoading, setProfileType, markOnboarded],
  );
}
