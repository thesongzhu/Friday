import { Component, type ErrorInfo, type ReactNode } from "react";
import { recordClientRenderError } from "@/lib/diagnostics/client-stability";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  hasError: boolean;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  override state: AppErrorBoundaryState = {
    hasError: false,
  };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    recordClientRenderError({
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    });
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-[color:var(--color-bg-base)] px-6">
          <div className="w-full max-w-lg rounded-[28px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-6 shadow-[var(--shadow-floating)]">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
              Friday
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-[color:var(--color-text-primary)]">
              Something went wrong
            </h1>
            <p className="mt-3 text-sm leading-6 text-[color:var(--color-text-secondary)]">
              Friday hit a client-side error before the current page finished rendering. Reload once. If it happens again,
              export the local diagnostics buffer and inspect the last route transition or API error.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-5 inline-flex min-h-[44px] items-center rounded-full bg-[color:var(--color-text-primary)] px-4 text-sm font-medium text-[color:var(--color-bg-base)]"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
