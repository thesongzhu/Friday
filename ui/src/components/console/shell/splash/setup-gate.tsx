import { Wrench } from "lucide-react";
import { SplashShell, type SplashShellProps } from "./shell";

/**
 * Rendered when setup is pending or the user needs to finish a bootstrap step.
 * The `steps` prop is first-class so this variant never shows a blank shell —
 * even if the caller only knows the title, we show a minimum step list shape.
 */
export function SetupGateSplash(props: Omit<SplashShellProps, "visual">) {
  return (
    <SplashShell
      accentColor="var(--color-accent)"
      visual={
        <span
          aria-hidden="true"
          className="inline-flex h-10 w-10 items-center justify-center rounded-full"
          style={{ background: "var(--color-accent-soft)", color: "var(--color-accent)" }}
        >
          <Wrench className="h-5 w-5" />
        </span>
      }
      {...props}
    />
  );
}
