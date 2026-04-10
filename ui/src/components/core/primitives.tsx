import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export function ShellCard(props: {
  title?: ReactNode;
  eyebrow?: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const { title, eyebrow, aside, children, className } = props;
  return (
    <section className={cn("agent-card", className)}>
      {(title || eyebrow || aside) && (
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            {eyebrow ? <p className="agent-eyebrow">{eyebrow}</p> : null}
            {title ? <h2 className="agent-card-title">{title}</h2> : null}
          </div>
          {aside}
        </header>
      )}
      {children}
    </section>
  );
}

export function StatusPill(props: {
  tone?: "neutral" | "success" | "warning" | "danger";
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-h-[32px] items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
        props.tone === "success" && "border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-text-primary)]",
        props.tone === "warning" && "border-[color:var(--color-border-strong)] bg-[color:var(--color-accent-muted)] text-[color:var(--color-text-primary)]",
        props.tone === "danger" && "border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] text-[color:var(--color-text-primary)]",
        (!props.tone || props.tone === "neutral") && "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] text-[color:var(--color-text-secondary)]",
        props.className,
      )}
    >
      {props.children}
    </span>
  );
}

export function ActionButton(
  props: ButtonHTMLAttributes<HTMLButtonElement> & {
    children: ReactNode;
    tone?: "primary" | "secondary" | "danger";
  },
) {
  const { children, tone, className, type, ...buttonProps } = props;

  return (
    <button
      type={type ?? "button"}
      className={cn(
        "inline-flex min-h-[44px] items-center justify-center rounded-2xl border px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        tone === "danger" && "border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent-muted)]",
        tone === "secondary" && "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] text-[color:var(--color-text-secondary)] hover:border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg-surface-strong)] hover:text-[color:var(--color-text-primary)]",
        (!tone || tone === "primary") && "border-[color:var(--color-accent)] bg-[color:var(--color-accent)] text-[color:var(--color-bg-base)] hover:opacity-90",
        className,
      )}
      {...buttonProps}
    >
      {children}
    </button>
  );
}

export function FieldLabel(props: { label: string; hint?: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-[color:var(--color-text-primary)]">{props.label}</span>
      {props.hint ? <span className="text-xs text-[color:var(--color-text-tertiary)]">{props.hint}</span> : null}
    </label>
  );
}

export function LiveIndicator(props: { label: string; active?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs text-[color:var(--color-text-secondary)]", props.className)}>
      <span
        className={cn(
          "inline-block h-2 w-2 rounded-full",
          props.active
            ? "bg-[color:var(--color-live)] shadow-[0_0_6px_rgba(52,199,89,0.4)] animate-pulse"
            : "bg-[color:var(--color-text-faint)]",
        )}
      />
      {props.label}
    </span>
  );
}
