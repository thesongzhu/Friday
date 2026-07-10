import { WifiOff } from "lucide-react";
import { SplashShell, type SplashShellProps } from "./shell";

/**
 * Rendered when the API is unreachable. Callers should supply a Retry action.
 */
export function NetworkErrorSplash(props: Omit<SplashShellProps, "visual">) {
  return (
    <SplashShell
      accentColor="var(--color-text-danger)"
      visual={
        <span
          aria-hidden="true"
          className="inline-flex h-10 w-10 items-center justify-center rounded-full"
          style={{ background: "var(--color-bg-danger-subtle)", color: "var(--color-text-danger)" }}
        >
          <WifiOff className="h-5 w-5" />
        </span>
      }
      {...props}
    />
  );
}
