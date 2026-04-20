import { ConsoleShell } from "@/components/console/shell";

/**
 * Router entry point. All shell concerns live inside <ConsoleShell>; this
 * module exists so `router.tsx` can keep importing AppShell unchanged.
 */
export function AppShell() {
  return <ConsoleShell />;
}
