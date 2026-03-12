import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export function ShellCard(props: {
  title?: string;
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
        "inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
        props.tone === "success" && "border-emerald-400/30 bg-emerald-400/10 text-emerald-100",
        props.tone === "warning" && "border-amber-300/30 bg-amber-300/10 text-amber-100",
        props.tone === "danger" && "border-rose-400/30 bg-rose-400/10 text-rose-100",
        (!props.tone || props.tone === "neutral") && "border-white/[0.14] bg-white/10 text-white/70",
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
        "inline-flex items-center justify-center rounded-2xl px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        tone === "danger" && "bg-rose-500 text-white hover:bg-rose-400",
        tone === "secondary" && "bg-white/10 text-white hover:bg-white/[0.14]",
        (!tone || tone === "primary") && "bg-[var(--accent-strong)] text-slate-950 hover:bg-[var(--accent-soft)]",
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
      <span className="font-medium text-white">{props.label}</span>
      {props.hint ? <span className="text-xs text-white/50">{props.hint}</span> : null}
    </label>
  );
}
