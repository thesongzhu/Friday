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
      accentColor="var(--rust-500)"
      visual={
        <span
          aria-hidden="true"
          className="inline-flex h-10 w-10 items-center justify-center rounded-full"
          style={{ background: "rgba(176, 80, 58, 0.14)", color: "var(--rust-500)" }}
        >
          <ShieldAlert className="h-5 w-5" />
        </span>
      }
      {...props}
    />
  );
}
