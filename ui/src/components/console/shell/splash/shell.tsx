import type { ReactNode } from "react";
import { toSafeHref } from "@/lib/security/safe-url";

export interface SplashAction {
  label: string;
  onClick?: () => void;
  href?: string;
  tone?: "primary" | "secondary";
}

export interface SplashPill {
  label: string;
  tone?: "neutral" | "amber" | "jade" | "rust";
}

export interface SplashStep {
  label: string;
  status?: "done" | "active" | "todo";
}

export interface SplashShellProps {
  eyebrow?: string;
  title: string;
  body?: string;
  pills?: SplashPill[];
  steps?: SplashStep[];
  actions?: SplashAction[];
  children?: ReactNode;
  visual?: ReactNode;
  accentColor?: string;
}

const PILL_STYLE: Record<NonNullable<SplashPill["tone"]>, { background: string; color: string }> = {
  neutral: { background: "var(--surface-2)", color: "var(--ink-700)" },
  amber: { background: "var(--accent-soft)", color: "var(--accent)" },
  jade: { background: "rgba(79, 122, 92, 0.14)", color: "var(--ok)" },
  rust: { background: "rgba(176, 80, 58, 0.14)", color: "var(--rust-500)" },
};

const STEP_DOT: Record<NonNullable<SplashStep["status"]>, string> = {
  done: "var(--ok)",
  active: "var(--accent)",
  todo: "var(--ink-300)",
};

export function SplashShell(props: SplashShellProps) {
  const { eyebrow, title, body, pills, steps, actions, children, visual, accentColor } = props;

  return (
    <div
      className="flex min-h-screen items-center justify-center px-6"
      style={{ background: "var(--surface-0)" }}
    >
      <div className="w-full max-w-xl text-center">
        {visual ? <div className="mb-4 flex justify-center">{visual}</div> : null}

        {eyebrow ? (
          <p
            className="text-[11px] font-semibold uppercase tracking-[0.18em]"
            style={{ color: accentColor ?? "var(--accent)" }}
          >
            {eyebrow}
          </p>
        ) : null}

        <h1
          className="mt-3 text-2xl font-semibold tracking-tight"
          style={{ color: "var(--ink-900)", fontFamily: "var(--font-serif-sc)" }}
        >
          {title}
        </h1>

        {body ? (
          <p className="mt-3 text-sm leading-6" style={{ color: "var(--ink-500)" }}>
            {body}
          </p>
        ) : null}

        {pills && pills.length > 0 ? (
          <ul className="mt-5 flex flex-wrap justify-center gap-2">
            {pills.map((pill) => {
              const style = PILL_STYLE[pill.tone ?? "neutral"];
              return (
                <li
                  key={pill.label}
                  className="rounded-full px-3 py-1 text-xs font-medium"
                  style={style}
                >
                  {pill.label}
                </li>
              );
            })}
          </ul>
        ) : null}

        {steps && steps.length > 0 ? (
          <ol className="mt-6 flex flex-col items-start gap-3 text-left">
            {steps.map((step) => (
              <li key={step.label} className="flex items-start gap-3 text-sm" style={{ color: "var(--ink-700)" }}>
                <span
                  aria-hidden="true"
                  className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                  style={{ background: STEP_DOT[step.status ?? "todo"] }}
                />
                <span>{step.label}</span>
              </li>
            ))}
          </ol>
        ) : null}

        {children ? <div className="mt-6">{children}</div> : null}

        {actions && actions.length > 0 ? (
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            {actions.map((action) => {
              const isPrimary = action.tone !== "secondary";
              const style = isPrimary
                ? { background: accentColor ?? "var(--accent)", color: "var(--surface-2)" }
                : {
                    background: "transparent",
                    color: "var(--ink-700)",
                    border: "1px solid rgba(15, 125, 140, 0.22)",
                  };
              const className = "inline-flex min-h-[40px] items-center gap-2 rounded-[var(--radius-md)] px-4 text-sm font-medium transition-opacity hover:opacity-90";
              if (action.href) {
                const safeHref = toSafeHref(action.href, { allowRelative: true });
                if (!safeHref) return null;
                return (
                  <a key={action.label} href={safeHref} className={className} style={style}>
                    {action.label}
                  </a>
                );
              }
              return (
                <button
                  key={action.label}
                  type="button"
                  onClick={action.onClick}
                  className={className}
                  style={style}
                >
                  {action.label}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
