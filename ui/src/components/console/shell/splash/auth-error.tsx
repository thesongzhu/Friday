import { ShieldAlert } from "lucide-react";
import { SplashShell, type SplashShellProps } from "./shell";

/**
 * Rendered when the session expired or auth was rejected. Callers pass a
 * primary action (usually "Sign in again") which the shell renders as a
 * filled rust-toned button.
 */
export function AuthErrorSplash(props: Omit<SplashShellProps, "visual">) {
  return (
    <SplashShell
      accentColor="var(--color-text-danger)"
      visual={
        <span
          aria-hidden="true"
          className="inline-flex h-10 w-10 items-center justify-center rounded-full"
          style={{ background: "var(--color-bg-danger-subtle)", color: "var(--color-text-danger)" }}
        >
          <ShieldAlert className="h-5 w-5" />
        </span>
      }
      {...props}
    />
  );
}
