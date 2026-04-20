import { Loader2 } from "lucide-react";
import { SplashShell, type SplashShellProps } from "./shell";

/**
 * Cold-start / route-suspense splash. Matches FullscreenMessage's contract so
 * a future wiring pass can swap router.tsx's inline FullscreenMessage for
 * <LoadingSplash /> without changing caller code.
 */
export function LoadingSplash(props: Omit<SplashShellProps, "visual"> & { eyebrow?: string }) {
  const { eyebrow = "Friday", ...rest } = props;
  return (
    <SplashShell
      eyebrow={eyebrow}
      visual={
        <span
          aria-hidden="true"
          className="inline-flex h-10 w-10 items-center justify-center rounded-full"
          style={{ background: "var(--amber-100)", color: "var(--amber-600)" }}
        >
          <Loader2 className="h-5 w-5 animate-spin" />
        </span>
      }
      {...rest}
    />
  );
}
