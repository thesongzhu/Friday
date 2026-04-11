import { useEffect } from "react";
import { RouterProvider } from "react-router-dom";
import { Toaster } from "sonner";
import { AppErrorBoundary } from "@/components/core/app-error-boundary";
import { installClientStabilityDiagnostics } from "@/lib/diagnostics/client-stability";
import { AuthProvider } from "@/providers/auth-provider";
import { LocaleProvider } from "@/providers/locale-provider";
import { QueryProvider } from "@/providers/query-provider";
import { router } from "./router";

export default function App() {
  useEffect(() => {
    installClientStabilityDiagnostics();
  }, []);

  return (
    <QueryProvider>
      <AuthProvider>
        <AppErrorBoundary>
          <LocaleProvider>
            <RouterProvider router={router} />
            <Toaster position="bottom-right" />
          </LocaleProvider>
        </AppErrorBoundary>
      </AuthProvider>
    </QueryProvider>
  );
}
