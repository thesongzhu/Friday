import * as React from "react";
import { authStorage } from "@/lib/storage/auth-storage";
import { fetchMe, login as loginRequest, logout, type LoginInput } from "@/lib/api/auth";
import type { FridayUser } from "@/lib/api/types";

// ─── Context shape ───

interface AuthContextValue {
  user: FridayUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  authError: Error | null;
  login: (input: LoginInput) => Promise<void>;
  logout: () => Promise<void>;
  retryLocalSession: () => Promise<void>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

function normalizeAuthError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("Failed to establish the local Friday session.");
}

// ─── Provider ───

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<FridayUser | null>(authStorage.getUser());
  const [isLoading, setIsLoading] = React.useState(true);
  const [authError, setAuthError] = React.useState<Error | null>(null);

  const establishLocalSession = React.useCallback(async () => {
    try {
      const me = await fetchMe();
      setUser(me.user);
      authStorage.setUser(me.user);
      setAuthError(null);
      return;
    } catch {
      // Fall back to legacy local login for older backends or remote deployments
      // that have not enabled no-sign-in localhost identity.
    }

    const response = await loginRequest({ local: true });
    setUser(response.user);
    authStorage.setUser(response.user);
    setAuthError(null);
  }, []);

  const retryLocalSession = React.useCallback(async () => {
    setIsLoading(true);
    try {
      await establishLocalSession();
    } catch (error) {
      authStorage.clear();
      setUser(null);
      setAuthError(normalizeAuthError(error));
    } finally {
      setIsLoading(false);
    }
  }, [establishLocalSession]);

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

        try {
          const me = await fetchMe();
          if (cancelled) return;
          setUser(me.user);
          authStorage.setUser(me.user);
          setAuthError(null);
        } catch {
          const response = await loginRequest({ local: true });
          if (cancelled) return;
          setUser(response.user);
          authStorage.setUser(response.user);
          setAuthError(null);
        }
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
      logout: handleLogout,
      retryLocalSession,
    }),
    [user, isLoading, authError, handleLogin, handleLogout, retryLocalSession],
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
