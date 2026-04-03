import * as React from "react";
import { authStorage } from "@/lib/storage/auth-storage";
import { fetchBootstrapStatus, fetchMe, login, logout, type LoginInput } from "@/lib/api/auth";
import { healthApi } from "@/lib/api/health";
import type { FridayUser } from "@/lib/api/types";

// ─── Context shape ───

interface AuthContextValue {
  user: FridayUser | null;
  scopes: string[];
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (input: LoginInput) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

// ─── Provider ───

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<FridayUser | null>(authStorage.getUser());
  const [scopes, setScopes] = React.useState<string[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);

  // Bootstrap: verify stored token, then attempt passwordless local auto-login if allowed.
  React.useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      const token = authStorage.getAccessToken();
      if (token) {
        try {
          const me = await fetchMe();
          if (cancelled) return;
          setUser(me.user);
          setScopes(me.scopes);
          authStorage.setUser(me.user);
        } catch {
          if (cancelled) return;
          setUser(null);
          setScopes([]);
          authStorage.clear();
        } finally {
          if (!cancelled) setIsLoading(false);
        }
        return;
      }

      // No token: clear stale client auth state before probing auto-login.
      authStorage.clear();
      setUser(null);
      setScopes([]);

      try {
        const status = await fetchBootstrapStatus();
        if (cancelled) return;

        const localBootstrapAllowed = status.allowLocalBypassLogin || status.allowPasswordlessLocalLogin;
        if (!localBootstrapAllowed) {
          setIsLoading(false);
          return;
        }

        const response = await login({ local: true });
        if (cancelled) return;
        setUser(response.user);
        setScopes([]);
        setIsLoading(false);
        return;
      } catch {
        // Fall through to compatibility probe and regular login page.
      }

      try {
        const health = await healthApi.getHealth();
        if (cancelled) return;

        const authCapabilities = health.capabilities?.auth;
        const localBootstrapAllowed = authCapabilities?.allowLocalBypassLogin
          || authCapabilities?.allowPasswordlessLocalLogin;
        if (localBootstrapAllowed) {
          try {
            const response = await login({ local: true });
            if (cancelled) return;
            setUser(response.user);
            setScopes([]);
            setIsLoading(false);
            return;
          } catch {
            // Continue to login screen fallback.
          }
        }
      } catch {
        // Best-effort probe only.
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogin = React.useCallback(async (input: LoginInput) => {
    const response = await login(input);
    setUser(response.user);
    setScopes([]);
  }, []);

  const handleLogout = React.useCallback(async () => {
    await logout();
    setUser(null);
    setScopes([]);
  }, []);

  const value = React.useMemo<AuthContextValue>(
    () => ({
      user,
      scopes,
      isAuthenticated: user !== null,
      isLoading,
      login: handleLogin,
      logout: handleLogout,
    }),
    [user, scopes, isLoading, handleLogin, handleLogout],
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
