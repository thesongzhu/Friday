import { FormEvent, useMemo, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { KeyRound } from "lucide-react";
import { ActionButton } from "@/components/core/primitives";
import { useAuth } from "@/hooks/use-auth";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";

function resolveNextPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/home";
  }
  return value;
}

export function LoginPage() {
  const { locale } = useAppLocale();
  const { isAuthenticated, login } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const nextPath = useMemo(() => resolveNextPath(searchParams.get("next")), [searchParams]);
  const [localPassphrase, setLocalPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (isAuthenticated) {
    return <Navigate to={nextPath} replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = localPassphrase.trim();
    if (!trimmed) {
      setError(localize(locale, "请输入本地口令。", "Enter the local passphrase."));
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      await login({ localPassphrase: trimmed });
      navigate(nextPath, { replace: true });
    } catch {
      setError(localize(locale, "本地口令未通过。", "The local passphrase was not accepted."));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-[color:var(--color-bg-base)] px-6 py-10 text-[color:var(--color-text-primary)]">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-[420px] flex-col justify-center">
        <div className="mb-8 flex items-center gap-3">
          <span
            aria-hidden="true"
            className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-[color:var(--color-accent-muted)] text-[color:var(--color-accent)]"
          >
            <KeyRound className="h-5 w-5" />
          </span>
          <div>
            <p className="agent-eyebrow">Friday</p>
            <h1 className="text-2xl font-semibold text-[color:var(--color-text-primary)]">
              {localize(locale, "解锁本机 Friday", "Unlock local Friday")}
            </h1>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <label className="flex flex-col gap-2 text-sm font-medium text-[color:var(--color-text-primary)]">
            {localize(locale, "本地口令", "Local passphrase")}
            <input
              id="login-local-passphrase"
              type="password"
              autoComplete="current-password"
              value={localPassphrase}
              onChange={(event) => setLocalPassphrase(event.target.value)}
              className="min-h-[46px] rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 text-base outline-none transition focus:border-[color:var(--color-accent)] focus:ring-2 focus:ring-[color:var(--color-accent-muted)]"
            />
          </label>

          {error ? (
            <p role="alert" className="text-sm text-[color:var(--color-text-danger)]">
              {error}
            </p>
          ) : null}

          <ActionButton type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting
              ? localize(locale, "正在继续", "Continuing")
              : localize(locale, "继续本机模式", "Continue locally")}
          </ActionButton>
        </form>
      </div>
    </main>
  );
}
