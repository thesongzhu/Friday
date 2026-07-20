import * as React from "react";
import { authStorage } from "@/lib/storage/auth-storage";
import {
  deviceKeyLogin,
  fetchMe,
  login as loginRequest,
  logout,
  postBootstrapChallenge,
  postDeviceClaim,
  type LoginInput,
} from "@/lib/api/auth";
import { getDeviceKeyProvider } from "@/lib/auth/device-key";
import { runDeviceOwnerBootstrap } from "@/lib/auth/device-owner-bootstrap";
import type { FridayUser } from "@/lib/api/types";

// ─── Context shape ───

interface AuthContextValue {
  user: FridayUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  authError: Error | null;
  login: (input: LoginInput) => Promise<void>;
  /**
   * SEC-SETUP-BOOTSTRAP-001 (CR-1): device-bound owner first-run. Generates a real
   * device key, claims the owner slot, and logs in by proving key possession.
   * Rejects (fails closed) if the device-key capability is unavailable OR if the
   * backend refuses to mint (device authority disabled) — the caller must NOT
   * silently fall back to a fabricated identity.
   */
  deviceOwnerLogin: () => Promise<void>;
  /** Whether the device-key capability is available in this context (fail-closed). */
  deviceKeyAvailable: boolean;
  logout: () => Promise<void>;
  retryLocalSession: () => Promise<void>;
}

/** Stable per-install id used to bind device-claim challenge context. */
function resolveInstallId(): string {
  const KEY = "friday.device.install-id";
  try {
    const existing = window.localStorage.getItem(KEY);
    if (existing) return existing;
    const generated =
      typeof window.crypto?.randomUUID === "function"
        ? window.crypto.randomUUID()
        : `install-${String(Date.now())}`;
    window.localStorage.setItem(KEY, generated);
    return generated;
  } catch {
    return "install-local";
  }
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

function normalizeAuthError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("Failed to restore the Friday session.");
}

// ─── Provider ───

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<FridayUser | null>(authStorage.getUser());
  const [isLoading, setIsLoading] = React.useState(true);
  const [authError, setAuthError] = React.useState<Error | null>(null);

  const restoreExistingSession = React.useCallback(async () => {
    const me = await fetchMe();
    setUser(me.user);
    authStorage.setUser(me.user);
    setAuthError(null);
  }, []);

  const retryLocalSession = React.useCallback(async () => {
    setIsLoading(true);
    try {
      await restoreExistingSession();
    } catch (error) {
      authStorage.clear();
      setUser(null);
      setAuthError(normalizeAuthError(error));
    } finally {
      setIsLoading(false);
    }
  }, [restoreExistingSession]);

  React.useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      setIsLoading(true);
      setAuthError(null);

      try {
        const token = authStorage.getAccessToken();
        if (token) {
          try {
            const me = await fetchMe();
            if (cancelled) return;
            setUser(me.user);
            authStorage.setUser(me.user);
            setAuthError(null);
            return;
          } catch {
            if (cancelled) return;
            authStorage.clear();
            setUser(null);
          }
        } else {
          authStorage.clear();
          setUser(null);
        }

        if (cancelled) return;
        setAuthError(null);
      } catch (error) {
        if (cancelled) return;
        authStorage.clear();
        setUser(null);
        setAuthError(normalizeAuthError(error));
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogin = React.useCallback(async (input: LoginInput) => {
    const response = await loginRequest(input);
    setUser(response.user);
    setAuthError(null);
  }, []);

  const handleDeviceOwnerLogin = React.useCallback(async () => {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const response = await runDeviceOwnerBootstrap(
      getDeviceKeyProvider(),
      { issueChallenge: postBootstrapChallenge, claim: postDeviceClaim, login: deviceKeyLogin },
      { origin, installId: resolveInstallId(), osUser: "ui" },
    );
    setUser(response.user);
    setAuthError(null);
  }, []);

  const handleLogout = React.useCallback(async () => {
    await logout();
    setUser(null);
    setAuthError(null);
  }, []);

  const value = React.useMemo<AuthContextValue>(
    () => ({
      user,
      isAuthenticated: user !== null,
      isLoading,
      authError,
      login: handleLogin,
      deviceOwnerLogin: handleDeviceOwnerLogin,
      deviceKeyAvailable: getDeviceKeyProvider().isAvailable(),
      logout: handleLogout,
      retryLocalSession,
    }),
    [user, isLoading, authError, handleLogin, handleDeviceOwnerLogin, handleLogout, retryLocalSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ─── Hook ───

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
