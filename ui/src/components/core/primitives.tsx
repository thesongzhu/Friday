import { type ButtonHTMLAttributes, type ReactNode, useState } from "react";
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
        "inline-flex min-h-[30px] items-center rounded-[var(--radius-sm)] border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] transition-colors",
        props.tone === "success" && "border-[color:var(--color-border-success)] bg-[color:var(--color-bg-success-subtle)] text-[color:var(--color-text-success)]",
        props.tone === "warning" && "border-[color:var(--color-border-warning)] bg-[color:var(--color-bg-warning-subtle)] text-[color:var(--color-text-warning)]",
        props.tone === "danger" && "border-[color:var(--color-border-danger)] bg-[color:var(--color-bg-danger-subtle)] text-[color:var(--color-text-danger)]",
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
        "inline-flex min-h-[40px] items-center justify-center rounded-[var(--radius-md)] border px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
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

/* ── Skeleton primitives ── */

export function SkeletonLine(props: { width?: string; className?: string }) {
  return (
    <div
      className={cn("skeleton skeleton-line", props.className)}
      style={props.width ? { width: props.width } : undefined}
    />
  );
}

export function SkeletonCard(props: { lines?: number; className?: string }) {
  const lineCount = props.lines ?? 3;
  const widths = ["100%", "85%", "60%", "75%", "50%"];
  return (
    <div className={cn("skeleton-card", props.className)}>
      <div className="skeleton skeleton-title" />
      {Array.from({ length: lineCount }, (_, i) => (
        <div
          key={i}
          className="skeleton skeleton-line"
          style={{ width: widths[i % widths.length] }}
        />
      ))}
    </div>
  );
}

export function SkeletonList(props: { rows?: number; className?: string }) {
  const rowCount = props.rows ?? 4;
  return (
    <div className={cn("space-y-3", props.className)}>
      {Array.from({ length: rowCount }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="skeleton skeleton-circle" />
          <div className="flex-1 space-y-2">
            <div className="skeleton skeleton-line" style={{ width: "65%" }} />
            <div className="skeleton skeleton-line" style={{ width: "40%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-1" aria-label="Processing">
      <span className="thinking-dot" />
      <span className="thinking-dot" />
      <span className="thinking-dot" />
    </span>
  );
}

/* ── Confirm Dialog ── */

export function ConfirmDialog(props: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  loading?: boolean;
}) {
  if (!props.open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal="true" aria-label={props.title}>
      <div className="fixed inset-0 bg-black/30 backdrop-blur-sm" onClick={props.onCancel} />
      <div className="relative z-10 mx-4 w-full max-w-sm rounded-[28px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-elevated)] p-6 shadow-[var(--shadow-card-strong)]">
        <h3 className="text-base font-semibold text-[color:var(--color-text-primary)]">{props.title}</h3>
        {props.description && (
          <p className="mt-2 text-sm leading-6 text-[color:var(--color-text-secondary)]">{props.description}</p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <ActionButton tone="secondary" onClick={props.onCancel} disabled={props.loading}>
            {props.cancelLabel ?? "Cancel"}
          </ActionButton>
          <ActionButton tone={props.tone ?? "danger"} onClick={props.onConfirm} disabled={props.loading}>
            {props.confirmLabel ?? "Confirm"}
          </ActionButton>
        </div>
      </div>
    </div>
  );
}

/* ── Empty State ── */

export function EmptyState(props: {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center py-12 text-center", props.className)}>
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[color:var(--color-bg-subtle)]">
        <svg className="h-5 w-5 text-[color:var(--color-text-faint)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25-2.25M12 13.875V7.5m0 0H9m3 0h3" />
        </svg>
      </div>
      <h3 className="text-sm font-medium text-[color:var(--color-text-primary)]">{props.title}</h3>
      {props.description && (
        <p className="mt-1 max-w-xs text-xs leading-5 text-[color:var(--color-text-tertiary)]">{props.description}</p>
      )}
      {props.action && <div className="mt-4">{props.action}</div>}
    </div>
  );
}
