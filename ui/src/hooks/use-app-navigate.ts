import { startTransition, useCallback } from "react";
import { type NavigateOptions, useNavigate } from "react-router-dom";
import { beginClientRouteTransition } from "@/lib/diagnostics/client-stability";

export function useAppNavigate() {
  const navigate = useNavigate();

  return useCallback((to: string, options?: NavigateOptions) => {
    beginClientRouteTransition(to);
    startTransition(() => {
      navigate(to, options);
    });
  }, [navigate]);
}
