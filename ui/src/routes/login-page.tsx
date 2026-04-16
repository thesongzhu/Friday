import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Lock, ShieldCheck } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { fetchBootstrapStatus } from "@/lib/api/auth";
import { useAuth } from "@/hooks/use-auth";
import { ActionButton, ShellCard, StatusPill } from "@/components/core/primitives";

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { isAuthenticated, login, isLoading } = useAuth();
  const [localPassphrase, setLocalPassphrase] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const redirectTo =
    typeof location.state === "object"
    && location.state !== null
    && "redirectTo" in location.state
    && typeof (location.state as { redirectTo?: unknown }).redirectTo === "string"
      ? (location.state as { redirectTo: string }).redirectTo
      : "/";

  const { data: bootstrap } = useQuery({
    queryKey: ["login", "bootstrap-status"],
    queryFn: () => fetchBootstrapStatus(),
    retry: 0,
  });

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      navigate(redirectTo, { replace: true });
    }
  }, [isAuthenticated, isLoading, navigate, redirectTo]);

  async function submitLocal(): Promise<void> {
    setSubmitting(true);
    try {
      await login(localPassphrase.trim().length > 0
        ? { local: true, localPassphrase: localPassphrase.trim() }
        : { local: true });
      navigate(redirectTo, { replace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Local login failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitPassword(): Promise<void> {
    if (!email.trim() || !password.trim()) {
      toast.error("Email and password are required");
      return;
    }
    setSubmitting(true);
    try {
      await login({ email: email.trim(), password });
      navigate(redirectTo, { replace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[color:var(--color-bg-base)] px-4 py-8 text-[color:var(--color-text-primary)]">
      <div className="pointer-events-none absolute inset-0">
        <div className="agent-grid absolute inset-0 opacity-30" />
        <div className="agent-orb agent-orb-left" />
        <div className="agent-orb agent-orb-right" />
      </div>

      <div className="relative grid w-full max-w-[1120px] gap-4 lg:grid-cols-[0.95fr_1.05fr]">
        <ShellCard className="h-full">
          <p className="agent-eyebrow">Friday Agent OS</p>
          <h1 className="font-[var(--font-display)] text-4xl font-semibold tracking-tight text-[color:var(--color-text-primary)]">
            Enter the operator shell
          </h1>
          <p className="mt-4 max-w-xl text-base leading-7 text-[color:var(--color-text-secondary)]">
            This rebuilt UI is focused on system truth: live run control, approval surfaces,
            and local machine orchestration above macOS.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <StatusPill tone={bootstrap?.allowLocalBypassLogin ? "success" : "neutral"}>
              Local bypass {bootstrap?.allowLocalBypassLogin ? "enabled" : "disabled"}
            </StatusPill>
            <StatusPill tone={bootstrap?.allowPasswordlessLocalLogin ? "success" : "neutral"}>
              Passwordless {bootstrap?.allowPasswordlessLocalLogin ? "enabled" : "disabled"}
            </StatusPill>
          </div>
        </ShellCard>

        <div className="space-y-4">
          <ShellCard eyebrow="Local Access" title="Fast operator login">
            <div className="space-y-4">
              <label htmlFor="login-local-passphrase" className="sr-only">Local passphrase</label>
              <input
                id="login-local-passphrase"
                value={localPassphrase}
                onChange={(event) => setLocalPassphrase(event.target.value)}
                type="password"
                className="agent-input"
                placeholder="Local passphrase (optional)"
              />
              <ActionButton onClick={() => void submitLocal()} disabled={submitting}>
                <ShieldCheck className="mr-2 h-4 w-4" />
                Continue locally
              </ActionButton>
            </div>
          </ShellCard>

          <ShellCard eyebrow="Credential Login" title="Email and password">
            <div className="space-y-4">
              <label htmlFor="login-email" className="sr-only">Email</label>
              <input
                id="login-email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="agent-input"
                placeholder="Email"
              />
              <label htmlFor="login-password" className="sr-only">Password</label>
              <input
                id="login-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                className="agent-input"
                placeholder="Password"
              />
              <ActionButton onClick={() => void submitPassword()} disabled={submitting}>
                <Lock className="mr-2 h-4 w-4" />
                Sign in
              </ActionButton>
            </div>
          </ShellCard>

          <div className="rounded-[28px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-5 py-4 text-sm text-[color:var(--color-text-secondary)]">
            Login routes are unchanged. Only the operator interface has been replaced.
            <ArrowRight className="ml-2 inline h-4 w-4" />
          </div>
        </div>
      </div>
    </div>
  );
}
